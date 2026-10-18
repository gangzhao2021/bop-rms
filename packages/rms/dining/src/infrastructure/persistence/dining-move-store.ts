import { appendAuditRecordInTransaction } from "@bop/audit";
import { parseDiningReference, parseDiningSession } from "../../contracts/dining-session.js";
import { createDiningTable, moveActiveDiningSession } from "../../domain/dining-table.js";
import { parseDiningSessionMoveRecord } from "../../application/dining-move-record.js";
import {
  closed,
  dependency,
  DiningTableWorkflowError,
  snapshot,
} from "../../application/dining-table-record.js";
import type { DiningTablePorts } from "../../application/ports/dining-table-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";
export type DiningSessionMoveStore = Pick<
  DiningTablePorts["repository"],
  "resolveMoveOperation" | "commitMove"
>;
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return dependency();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return dependency();
  const copied = snapshot(descriptor.value);
  if (!Array.isArray(copied) || copied.length > 1) return dependency();
  return copied;
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return dependency();
}
const same = (left: unknown, right: unknown) => JSON.stringify(left) === JSON.stringify(right);
function reference(value: unknown) {
  try {
    return parseDiningReference(value);
  } catch {
    throw new DiningTableWorkflowError("DINING_TABLE_INPUT_INVALID");
  }
}
function failure(error: unknown): never {
  if (
    error instanceof DiningTableWorkflowError &&
    (error.code === "DINING_TABLE_VERSION_CONFLICT" ||
      error.code === "DINING_TABLE_IDEMPOTENCY_CONFLICT")
  )
    throw new DiningTableWorkflowError(error.code);
  return dependency();
}
/** Internal owner transaction; the public service must establish current Staff authority. */
export function createPostgresDiningSessionMoveStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  hashes: DiningTablePorts["references"],
): DiningSessionMoveStore {
  const scope = closed(snapshot(scopeInput), [
    "tenantReference",
    "brandReference",
    "storeReference",
  ]);
  const tenant = reference(scope.tenantReference),
    brand = reference(scope.brandReference),
    store = reference(scope.storeReference);
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const validate = (value: unknown) => {
    const record = parseDiningSessionMoveRecord(value, hashes);
    if (
      record.sourceTable.tenantReference !== tenant ||
      record.sourceTable.brandReference !== brand ||
      record.sourceTable.storeReference !== store
    )
      return dependency();
    return record;
  };
  const original = async (tx: DiningTableTransaction, operation: string) => {
    const selected = rows(
      await tx.query(
        "SELECT record_json AS record FROM rms_dining.dining_session_move_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operation],
      ),
    );
    if (selected.length === 0) return null;
    const record = validate(closed(selected[0], ["record"]).record);
    if (record.operationReference !== operation) return dependency();
    return record;
  };
  return Object.freeze({
    async resolveMoveOperation(
      value: Parameters<DiningSessionMoveStore["resolveMoveOperation"]>[0],
    ) {
      const operation = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          return original(tx, operation);
        });
      } catch {
        return dependency();
      }
    },
    async commitMove(value: Parameters<DiningSessionMoveStore["commitMove"]>[0]) {
      let record;
      try {
        record = validate(value);
      } catch {
        return dependency();
      }
      const accepted = record;
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningSessionMove:${tenant}:${brand}:${store}:${accepted.operationReference}`,
          ]);
          const prior = await original(tx, accepted.operationReference);
          if (prior !== null) {
            if (
              hashes.equals(prior.intentDigest, accepted.intentDigest) !== true ||
              !same(prior.command, accepted.command) ||
              !same(prior.session, accepted.session) ||
              !same(prior.sourceTable, accepted.sourceTable) ||
              !same(prior.targetTable, accepted.targetTable) ||
              !same(prior.event, accepted.event) ||
              prior.audit.actor.type !== "User" ||
              accepted.audit.actor.type !== "User" ||
              prior.audit.actor.reference !== accepted.audit.actor.reference
            )
              throw new DiningTableWorkflowError("DINING_TABLE_IDEMPOTENCY_CONFLICT");
            return Object.freeze({ status: "AlreadyApplied" as const, record: prior });
          }
          const command = accepted.command;
          const references = [command.sourceTableReference, command.targetTableReference].sort();
          for (const ref of references)
            await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
              `DiningTable:${tenant}:${brand}:${store}:${ref}`,
            ]);
          const tables = new Map<string, ReturnType<typeof createDiningTable>>();
          for (const ref of references) {
            const selected = rows(
              await tx.query(
                "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
                [tenant, brand, store, ref],
              ),
            );
            if (selected.length !== 1) return dependency();
            const table = createDiningTable(closed(selected[0], ["table"]).table);
            if (
              table.tableReference !== ref ||
              table.tenantReference !== tenant ||
              table.brandReference !== brand ||
              table.storeReference !== store
            )
              return dependency();
            tables.set(ref, table);
          }
          const source = tables.get(command.sourceTableReference),
            target = tables.get(command.targetTableReference);
          if (!source || !target) return dependency();
          const selected = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
              [tenant, brand, store, command.diningSessionReference],
            ),
          );
          if (selected.length !== 1) return dependency();
          const session = parseDiningSession(closed(selected[0], ["session"]).session);
          if (
            session.diningSessionReference !== command.diningSessionReference ||
            session.brandReference !== brand ||
            session.storeReference !== store
          )
            return dependency();
          if (
            source.aggregateVersion !== command.expectedSourceTableVersion ||
            target.aggregateVersion !== command.expectedTargetTableVersion ||
            session.version !== command.expectedSessionVersion
          )
            throw new DiningTableWorkflowError("DINING_TABLE_VERSION_CONFLICT");
          if (source.observedAt > command.observedAt || target.observedAt > command.observedAt)
            return dependency();
          const expected = moveActiveDiningSession(
            session,
            source,
            target,
            command.partySize,
            command.observedAt,
          );
          if (
            !same(expected.session, accepted.session) ||
            !same(expected.sourceTable, accepted.sourceTable) ||
            !same(expected.targetTable, accepted.targetTable)
          )
            return dependency();
          for (const table of [accepted.sourceTable, accepted.targetTable])
            changed(
              await tx.query(
                "UPDATE rms_dining.dining_table SET version=$5,table_snapshot=$6::jsonb,observed_at=$7 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND version=$8",
                [
                  tenant,
                  brand,
                  store,
                  table.tableReference,
                  table.aggregateVersion,
                  JSON.stringify(table),
                  table.observedAt,
                  table.aggregateVersion - 1,
                ],
              ),
            );
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_session SET table_id=$5,version=$6,session_snapshot=$7::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND version=$8 AND phase='Active' AND table_id=$9",
              [
                tenant,
                brand,
                store,
                session.diningSessionReference,
                target.tableReference,
                accepted.session.version,
                JSON.stringify(accepted.session),
                command.expectedSessionVersion,
                source.tableReference,
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_session_move_operation (operation_id,tenant_id,brand_id,store_id,session_id,source_table_id,target_table_id,intent_digest,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
              [
                accepted.operationReference,
                tenant,
                brand,
                store,
                session.diningSessionReference,
                source.tableReference,
                target.tableReference,
                accepted.intentDigest,
                command.observedAt,
                JSON.stringify(accepted),
              ],
            ),
          );
          await appendAuditRecordInTransaction(tx, accepted.audit);
          return Object.freeze({ status: "Applied" as const, record: accepted });
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
