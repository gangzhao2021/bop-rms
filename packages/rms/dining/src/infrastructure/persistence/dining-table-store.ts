import { appendAuditRecordInTransaction } from "@bop/audit";
import { parseDiningReference, type DiningReference } from "../../contracts/dining-session.js";
import {
  createDiningTable,
  replaceDiningTableDraft,
  transitionDiningTable,
  type DiningTable,
} from "../../domain/dining-table.js";
import type {
  DiningTableOperationRecord,
  DiningTablePorts,
} from "../../application/ports/dining-table-ports.js";
import {
  DiningTableWorkflowError,
  closed,
  dependency,
  diningTableAction,
  diningTableCommandIntent,
  parseDiningTableOperationRecord,
  parseState,
  snapshot,
} from "../../application/dining-table-record.js";

export interface DiningTableTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
export interface DiningTableTransactionRunner {
  /** Own bounded transaction, commit/rollback and connection/context cleanup. Reads may be read-only. */
  run<T>(action: (transaction: DiningTableTransaction) => Promise<T>): Promise<T>;
}
export type DiningTableConfigurationStore = Pick<
  DiningTablePorts["repository"],
  "loadTable" | "resolveTableOperation" | "commitTable"
>;
export interface DiningTableStoreScope {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
}
function reference(value: unknown): DiningReference {
  try {
    return parseDiningReference(value);
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
  }
}
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return dependency();
  const field = Object.getOwnPropertyDescriptor(value, "rows");
  if (!field || !("value" in field)) return dependency();
  const result = snapshot(field.value);
  if (!Array.isArray(result) || result.length > 1) return dependency();
  return result;
}
function changed(value: unknown): void {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return dependency();
}
function failure(error: unknown): never {
  if (
    error instanceof DiningTableWorkflowError &&
    ["DINING_TABLE_VERSION_CONFLICT", "DINING_TABLE_IDEMPOTENCY_CONFLICT"].includes(error.code)
  )
    throw new DiningTableWorkflowError(error.code);
  return dependency();
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);

/** Internal owner storage only. Callers must establish current Staff authority through the service. */
export function createPostgresDiningTableStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  references: DiningTablePorts["references"],
): DiningTableConfigurationStore {
  const rawScope = closed(snapshot(scopeInput), [
    "tenantReference",
    "brandReference",
    "storeReference",
  ]);
  const tenant = reference(rawScope.tenantReference);
  const brand = reference(rawScope.brandReference);
  const store = reference(rawScope.storeReference);
  const hash = references.hashIntent.bind(references);
  const equals = references.equals.bind(references);
  const scoped = (table: DiningTable) => {
    if (
      table.tenantReference !== tenant ||
      table.brandReference !== brand ||
      table.storeReference !== store ||
      table.observedAt < table.createdAt
    )
      return dependency();
    return table;
  };
  const validate = (value: unknown) => {
    const record = parseDiningTableOperationRecord(value);
    const table = scoped(record.table);
    const action = diningTableAction(record);
    const canonical = hash(
      diningTableCommandIntent(
        action,
        record.operationReference,
        action === "CreateDraft" ? null : table.aggregateVersion - 1,
        table,
        table.observedAt,
      ),
    );
    if (
      !/^sha256:[0-9a-f]{64}$/u.test(canonical) ||
      equals(canonical, record.intentDigest) !== true
    )
      return dependency();
    return record;
  };
  const context = async (transaction: DiningTableTransaction) => {
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)",
      [brand, store],
    );
  };
  const load = async (
    transaction: DiningTableTransaction,
    tableReference: DiningReference,
    lock = false,
  ) => {
    const result = rows(
      await transaction.query(
        `SELECT table_snapshot AS "table" FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4${lock ? " FOR UPDATE" : ""}`,
        [tenant, brand, store, tableReference],
      ),
    );
    if (result.length === 0) return null;
    const table = scoped(createDiningTable(closed(result[0], ["table"]).table));
    if (table.tableReference !== tableReference) return dependency();
    return table;
  };
  const operation = async (
    transaction: DiningTableTransaction,
    operationReference: DiningReference,
  ) => {
    const result = rows(
      await transaction.query(
        "SELECT record_json AS record FROM rms_dining.dining_table_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operationReference],
      ),
    );
    if (result.length === 0) return null;
    const record = validate(closed(result[0], ["record"]).record);
    if (record.operationReference !== operationReference) return dependency();
    return record;
  };
  return Object.freeze({
    async loadTable(value: string) {
      const tableReference = reference(value);
      try {
        return await runner.run(async (transaction) => {
          await context(transaction);
          return load(transaction, tableReference);
        });
      } catch {
        return dependency();
      }
    },
    async resolveTableOperation(value: string) {
      const operationReference = reference(value);
      try {
        return await runner.run(async (transaction) => {
          await context(transaction);
          return operation(transaction, operationReference);
        });
      } catch {
        return dependency();
      }
    },
    async commitTable(value: DiningTableOperationRecord) {
      const record = parseState(() => validate(value));
      const table = record.table;
      try {
        await runner.run(async (transaction) => {
          await context(transaction);
          // All configuration writers lock operation, then Table, then its row. Future multi-Table
          // owners must acquire sorted Table locks before any Table row to preserve this order.
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTableOperation:${tenant}:${brand}:${store}:${record.operationReference}`,
          ]);
          const prior = await operation(transaction, record.operationReference);
          if (prior !== null) {
            if (
              equals(prior.intentDigest, record.intentDigest) !== true ||
              !same(prior.table, table) ||
              !same(prior.event, record.event) ||
              !same(prior.audit.actor, record.audit.actor)
            )
              throw new DiningTableWorkflowError("DINING_TABLE_IDEMPOTENCY_CONFLICT");
            return;
          }
          await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTable:${tenant}:${brand}:${store}:${table.tableReference}`,
          ]);
          const current = await load(transaction, table.tableReference, true);
          const action = diningTableAction(record);
          if (action === "CreateDraft") {
            if (current !== null)
              throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
          } else {
            if (current === null || current.aggregateVersion !== table.aggregateVersion - 1)
              throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
            if (table.observedAt < current.observedAt) return dependency();
            const expected =
              action === "ReplaceDraft"
                ? replaceDiningTableDraft(current, {
                    stableLabel: table.stableLabel,
                    areaReference: table.areaReference,
                    areaCode: table.areaCode,
                    capacity: table.capacity,
                    accessibilityAttributes: table.accessibilityAttributes,
                    observedAt: table.observedAt,
                  })
                : transitionDiningTable(
                    current,
                    action,
                    table.observedAt,
                    action === "SetBlock" ? table.blockReasonCode : null,
                  );
            if (!same(expected, table)) return dependency();
          }
          if (current === null) {
            changed(
              await transaction.query(
                "INSERT INTO rms_dining.dining_table (table_id,tenant_id,brand_id,store_id,version,table_snapshot,created_at,observed_at) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8)",
                [
                  table.tableReference,
                  tenant,
                  brand,
                  store,
                  table.aggregateVersion,
                  JSON.stringify(table),
                  table.createdAt,
                  table.observedAt,
                ],
              ),
            );
          } else {
            changed(
              await transaction.query(
                "UPDATE rms_dining.dining_table SET version=$5,table_snapshot=$6::jsonb,observed_at=$7 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND version=$8",
                [
                  tenant,
                  brand,
                  store,
                  table.tableReference,
                  table.aggregateVersion,
                  JSON.stringify(table),
                  table.observedAt,
                  current.aggregateVersion,
                ],
              ),
            );
          }
          changed(
            await transaction.query(
              "INSERT INTO rms_dining.dining_table_operation (operation_id,tenant_id,brand_id,store_id,table_id,result_version,intent_digest,record_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9)",
              [
                record.operationReference,
                tenant,
                brand,
                store,
                table.tableReference,
                table.aggregateVersion,
                record.intentDigest,
                JSON.stringify(record),
                table.observedAt,
              ],
            ),
          );
          await appendAuditRecordInTransaction(transaction, record.audit);
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
