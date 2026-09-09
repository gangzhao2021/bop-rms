import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  DiningSessionError,
  parseDiningReference,
  parseDiningSession,
} from "../../contracts/dining-session.js";
import { assignStartedDiningSession, createDiningTable } from "../../domain/dining-table.js";
import { parseStaffStartRecord } from "../../application/dining-staff-record.js";
import {
  captureSessionData,
  sessionDependency,
} from "../../application/dining-session-snapshot.js";
import type {
  DiningCredentialPort,
  DiningSessionStorePort,
  DiningStartRecord,
} from "../../application/ports/dining-session-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

export type DiningSessionStartStore = Pick<
  DiningSessionStorePort,
  "resolveStartOperation" | "start"
> & {
  loadSession(reference: string): Promise<ReturnType<typeof parseDiningSession> | null>;
};
function closed(value: unknown, keys: readonly string[]) {
  const copied = captureSessionData(value);
  if (
    copied === null ||
    typeof copied !== "object" ||
    Array.isArray(copied) ||
    Object.keys(copied).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(copied, key))
  )
    return sessionDependency();
  return copied as Record<string, unknown>;
}
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return sessionDependency();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return sessionDependency();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > 1) return sessionDependency();
  return copied;
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return sessionDependency();
}
function reference(value: unknown) {
  try {
    return parseDiningReference(value);
  } catch {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
}
function failure(error: unknown): never {
  if (
    error instanceof DiningSessionError &&
    ["DINING_SESSION_VERSION_CONFLICT", "DINING_SESSION_IDEMPOTENCY_CONFLICT"].includes(error.code)
  )
    throw new DiningSessionError(error.code);
  return sessionDependency();
}

/** Internal owner storage; current Staff authorization is mandatory in the Session service. */
export function createPostgresDiningSessionStartStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  credentials: Pick<DiningCredentialPort, "hashOperationIntent" | "equals">,
): DiningSessionStartStore {
  const scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = reference(scope.tenantReference);
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  const hash = credentials.hashOperationIntent.bind(credentials);
  const equals = credentials.equals.bind(credentials);
  const validate = (value: unknown): DiningStartRecord => {
    try {
      const raw = closed(value, [
        "session",
        "capability",
        "operationReference",
        "operationIntentHash",
      ]);
      const session = parseDiningSession(raw.session);
      const record = parseStaffStartRecord(raw, {
        operationReference: reference(raw.operationReference),
        brandReference: brand,
        storeReference: store,
        tableReference: session.tableReference,
        assignmentVersion: session.tableAssignmentVersion,
        observedAt: session.startedAt,
        actorReference: session.startedByActorReference,
      });
      const digest = hash(
        `Start:${session.tableReference}:${session.tableAssignmentVersion}:${record.capability.kind}`,
      );
      if (!/^[0-9a-f]{64}$/u.test(digest) || equals(digest, record.operationIntentHash) !== true)
        return sessionDependency();
      return record;
    } catch {
      return sessionDependency();
    }
  };
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const original = async (tx: DiningTableTransaction, operation: string) => {
    const result = rows(
      await tx.query(
        "SELECT record_json AS record FROM rms_dining.dining_session_start_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operation],
      ),
    );
    if (result.length === 0) return null;
    const record = validate(closed(result[0], ["record"]).record);
    if (record.operationReference !== operation) return sessionDependency();
    return record;
  };
  return Object.freeze({
    async resolveStartOperation(value: string) {
      const operation = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          return original(tx, operation);
        });
      } catch {
        return sessionDependency();
      }
    },
    async loadSession(value: string) {
      const sessionReference = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          const result = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
              [tenant, brand, store, sessionReference],
            ),
          );
          if (result.length === 0) return null;
          const session = parseDiningSession(closed(result[0], ["session"]).session);
          if (
            session.diningSessionReference !== sessionReference ||
            session.brandReference !== brand ||
            session.storeReference !== store
          )
            return sessionDependency();
          return session;
        });
      } catch {
        return sessionDependency();
      }
    },
    async start(value) {
      let input;
      let record;
      let audit;
      try {
        input = closed(value, ["record", "expectedAssignmentVersion", "audit"]);
        record = validate(input.record);
        if (input.expectedAssignmentVersion !== record.session.tableAssignmentVersion)
          return sessionDependency();
        audit = validateAuditRecord(input.audit, Date.parse(record.session.startedAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "User" ||
          audit.actor.reference !== record.session.startedByActorReference ||
          audit.actionCode !== "DINING_SESSION_START" ||
          audit.targetType !== "DiningTable" ||
          audit.targetId !== record.session.tableReference ||
          audit.occurredAt !== record.session.startedAt
        )
          return sessionDependency();
      } catch {
        return sessionDependency();
      }
      const accepted = record;
      const acceptedAudit = audit;
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningSessionStart:${tenant}:${brand}:${store}:${accepted.operationReference}`,
          ]);
          const prior = await original(tx, accepted.operationReference);
          if (prior !== null) {
            if (
              equals(prior.operationIntentHash, accepted.operationIntentHash) !== true ||
              prior.session.startedByActorReference !== accepted.session.startedByActorReference
            )
              throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
            return prior;
          }
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTable:${tenant}:${brand}:${store}:${accepted.session.tableReference}`,
          ]);
          const found = rows(
            await tx.query(
              "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
              [tenant, brand, store, accepted.session.tableReference],
            ),
          );
          if (found.length === 0) throw new DiningSessionError("DINING_SESSION_VERSION_CONFLICT");
          const current = createDiningTable(closed(found[0], ["table"]).table);
          if (
            current.tenantReference !== tenant ||
            current.brandReference !== brand ||
            current.storeReference !== store ||
            current.tableReference !== accepted.session.tableReference
          )
            return sessionDependency();
          if (current.aggregateVersion !== accepted.session.tableAssignmentVersion)
            throw new DiningSessionError("DINING_SESSION_VERSION_CONFLICT");
          const occupied = assignStartedDiningSession(
            accepted.session,
            current,
            accepted.session.tableAssignmentVersion,
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_session (session_id,tenant_id,brand_id,store_id,table_id,version,phase,session_snapshot,started_at) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb,$7)",
              [
                accepted.session.diningSessionReference,
                tenant,
                brand,
                store,
                accepted.session.tableReference,
                JSON.stringify(accepted.session),
                accepted.session.startedAt,
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
              [
                accepted.capability.capabilityReference,
                tenant,
                brand,
                store,
                accepted.session.diningSessionReference,
                JSON.stringify(accepted.capability),
              ],
            ),
          );
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_table SET version=$5,table_snapshot=$6::jsonb,observed_at=$7 WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 AND version=$8",
              [
                tenant,
                brand,
                store,
                occupied.tableReference,
                occupied.aggregateVersion,
                JSON.stringify(occupied),
                occupied.observedAt,
                current.aggregateVersion,
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_session_start_operation (operation_id,tenant_id,brand_id,store_id,session_id,intent_hash,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb)",
              [
                accepted.operationReference,
                tenant,
                brand,
                store,
                accepted.session.diningSessionReference,
                accepted.operationIntentHash,
                JSON.stringify(accepted),
              ],
            ),
          );
          await appendAuditRecordInTransaction(tx, acceptedAudit);
          return accepted;
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
