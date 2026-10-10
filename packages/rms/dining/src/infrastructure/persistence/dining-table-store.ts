import { appendAuditRecordInTransaction } from "@bop/audit";
import {
  parseDiningInstant,
  parseDiningReference,
  type DiningReference,
} from "../../contracts/dining-session.js";
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
> & {
  listTables(input: {
    afterTableReference: string | null;
    limit: number;
    authorize(transaction: DiningTableTransaction): Promise<boolean>;
  }): Promise<{
    readonly items: readonly DiningTable[];
    readonly nextAfterTableReference: string | null;
  }>;
};
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
    async listTables(input) {
      const after =
        input.afterTableReference === null ? null : reference(input.afterTableReference);
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
        throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
      const limit = input.limit;
      try {
        return await runner.run(async (transaction) => {
          if ((await input.authorize(transaction)) !== true) return dependency();
          await context(transaction);
          const result = await transaction.query(
            'SELECT table_snapshot AS "table" FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND ($4::uuid IS NULL OR table_id>$4::uuid) ORDER BY table_id LIMIT $5',
            [tenant, brand, store, after, limit + 1],
          );
          if (!result || typeof result !== "object") return dependency();
          const raw = snapshot(Object.getOwnPropertyDescriptor(result, "rows")?.value);
          if (!Array.isArray(raw) || raw.length > limit + 1) return dependency();
          let previous: string | null = after;
          const tables = raw.map((row) => {
            const table = scoped(createDiningTable(closed(row, ["table"]).table));
            if (previous !== null && table.tableReference <= previous) return dependency();
            previous = table.tableReference;
            return table;
          });
          if ((await input.authorize(transaction)) !== true) return dependency();
          const items = Object.freeze(tables.slice(0, limit));
          return Object.freeze({
            items,
            nextAfterTableReference:
              tables.length > limit ? (items[items.length - 1]?.tableReference ?? null) : null,
          });
        });
      } catch {
        return dependency();
      }
    },
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

/** Restricted public fact query; never grants Staff permissions or discovers tables.
 * The caller must retain this transaction through the dependent operation and fence
 * authorization for the exact public mapping and purpose before/after this read.
 */
export function createPostgresDiningPublicTableReader(options: {
  transaction: DiningTableTransaction;
  scope: DiningTableStoreScope;
  authorize(
    transaction: DiningTableTransaction,
    request: Readonly<{
      tenantReference: string;
      brandReference: string;
      storeReference: string;
      tableReference: string;
      purpose: "CustomerEntry" | "GuestSessionBinding" | "DiningJoin" | "DiningAdmission";
      observedAt: string;
    }>,
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    tenantReference: reference(options.scope.tenantReference),
    brandReference: reference(options.scope.brandReference),
    storeReference: reference(options.scope.storeReference),
  });
  return Object.freeze({
    async read(input: {
      tableReference: string;
      purpose: "CustomerEntry" | "GuestSessionBinding" | "DiningJoin" | "DiningAdmission";
      observedAt: string;
    }) {
      try {
        const raw = closed(snapshot(input), ["tableReference", "purpose", "observedAt"]);
        const tableReference = reference(raw.tableReference);
        const observedAt = parseDiningInstant(raw.observedAt);
        if (
          !["CustomerEntry", "GuestSessionBinding", "DiningJoin", "DiningAdmission"].includes(
            String(raw.purpose),
          )
        )
          return null;
        const request = Object.freeze({
          ...scope,
          tableReference,
          observedAt,
          purpose: input.purpose,
        });
        const tx = options.transaction;
        if ((await options.authorize(tx, request)) !== true) return null;
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)",
          [scope.brandReference, scope.storeReference],
        );
        const result = rows(
          await tx.query(
            'SELECT table_snapshot AS "table" FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR SHARE',
            [scope.tenantReference, scope.brandReference, scope.storeReference, tableReference],
          ),
        );
        if (result.length !== 1) return null;
        const table = createDiningTable(closed(result[0], ["table"]).table);
        if (
          table.tenantReference !== scope.tenantReference ||
          table.brandReference !== scope.brandReference ||
          table.storeReference !== scope.storeReference ||
          table.tableReference !== tableReference ||
          table.lifecycle !== "Published" ||
          table.qrStatus !== "Active" ||
          table.observedAt > observedAt ||
          (await options.authorize(tx, request)) !== true
        )
          return null;
        return Object.freeze({
          ...scope,
          tableReference,
          qrVersion: table.qrVersion,
          aggregateVersion: table.aggregateVersion,
          operationalState: table.operationalState,
          activeDiningSessionReference: table.activeDiningSessionReference,
          observedAt,
        });
      } catch {
        return null;
      }
    },
  });
}

/**
 * WP-2423 Q2: the current table label of each dining session, for the kitchen's order label. A
 * session whose table cannot be read is omitted. Caller authorizes the Store and owns the
 * transaction.
 */
export async function listDiningSessionTableLabels(
  transaction: DiningTableTransaction,
  scope: { readonly brandReference: string; readonly storeReference: string },
  sessionReferences: readonly string[],
): Promise<ReadonlyMap<string, string>> {
  if (sessionReferences.length === 0) return new Map();
  if (sessionReferences.length > 200) throw new Error("DINING_TABLE_INPUT_INVALID");
  const brand = reference(scope.brandReference),
    store = reference(scope.storeReference),
    sessions = sessionReferences.map((value) => reference(value));
  await transaction.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [brand, store],
  );
  // Many sessions per read: the single-row helper does not apply here.
  const result = (await transaction.query(
    "SELECT s.session_id::text session_id,t.table_snapshot->>'stableLabel' label FROM rms_dining.dining_session s " +
      "JOIN rms_dining.dining_table t ON t.tenant_id=s.tenant_id AND t.brand_id=s.brand_id AND t.store_id=s.store_id AND t.table_id=s.table_id " +
      "WHERE s.brand_id=$1 AND s.store_id=$2 AND s.session_id=ANY($3::uuid[])",
    [brand, store, sessions],
  )) as { rows?: unknown } | null;
  const found = result?.rows;
  if (!Array.isArray(found) || found.length > sessions.length)
    throw new Error("DINING_TABLE_UNAVAILABLE");
  const labels = new Map<string, string>();
  for (const row of found) {
    const value = row as { session_id?: unknown; label?: unknown };
    const session = reference(value.session_id);
    if (!sessions.includes(session)) throw new Error("DINING_TABLE_UNAVAILABLE");
    if (
      typeof value.label === "string" &&
      /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u.test(value.label) &&
      value.label.trim() === value.label
    )
      labels.set(session, value.label);
  }
  return labels;
}
