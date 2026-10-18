import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { parseDiningJoinCapability, regenerateDiningJoinCapability } from "@bop/public-capability";
import {
  DiningSessionError,
  parseDiningReference,
  parseDiningSession,
} from "../../contracts/dining-session.js";
import { createDiningTable } from "../../domain/dining-table.js";
import { parseStaffRegenerationRecord } from "../../application/dining-staff-record.js";
import {
  captureSessionData,
  sessionDependency,
} from "../../application/dining-session-snapshot.js";
import type {
  DiningCredentialPort,
  DiningSessionStorePort,
  DiningRegenerationRecord,
} from "../../application/ports/dining-session-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";
export type DiningJoinRegenerationStore = Pick<
  DiningSessionStorePort,
  "resolveActiveJoin" | "resolveRegenerationOperation" | "regenerate"
>;
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

/** Owner storage only; current Staff permission is checked by the public Session service. */
export function createPostgresDiningJoinRegenerationStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  credentials: Pick<DiningCredentialPort, "hashOperationIntent" | "equals">,
): DiningJoinRegenerationStore {
  const scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = reference(scope.tenantReference),
    brand = reference(scope.brandReference),
    store = reference(scope.storeReference);
  const hash = credentials.hashOperationIntent.bind(credentials),
    equals = credentials.equals.bind(credentials);
  const validate = (value: unknown): DiningRegenerationRecord => {
    try {
      const raw = closed(value, ["capability", "operationReference", "operationIntentHash"]);
      const cap = parseDiningJoinCapability(raw.capability);
      const record = parseStaffRegenerationRecord(raw, {
        operationReference: reference(raw.operationReference),
        brandReference: brand,
        storeReference: store,
        tableReference: cap.tableReference,
        assignmentVersion: cap.assignmentVersion,
        diningSessionReference: cap.diningSessionReference,
        observedAt: cap.issuedAt,
      });
      const digest = hash(
        `Regenerate:${cap.diningSessionReference}:${cap.tableReference}:${cap.assignmentVersion}`,
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
    const found = rows(
      await tx.query(
        'SELECT record_json AS record, actor_id AS "actorReference" FROM rms_dining.dining_join_regeneration_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4',
        [tenant, brand, store, operation],
      ),
    );
    if (found.length === 0) return null;
    const raw = closed(found[0], ["record", "actorReference"]),
      record = validate(raw.record),
      actor = reference(raw.actorReference);
    if (record.operationReference !== operation) return sessionDependency();
    return { record, actor };
  };
  const conflict = (): never => {
    throw new DiningSessionError("DINING_SESSION_VERSION_CONFLICT");
  };
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  return Object.freeze({
    async resolveRegenerationOperation(value) {
      const operation = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          return (await original(tx, operation))?.record ?? null;
        });
      } catch {
        return sessionDependency();
      }
    },
    async resolveActiveJoin(value) {
      const sessionId = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          const found = rows(
            await tx.query(
              "SELECT s.session_snapshot AS session,c.capability_snapshot AS capability FROM rms_dining.dining_session s JOIN LATERAL (SELECT capability_snapshot FROM rms_dining.dining_join_capability WHERE tenant_id=s.tenant_id AND brand_id=s.brand_id AND store_id=s.store_id AND session_id=s.session_id ORDER BY (capability_snapshot->>'generation')::numeric DESC LIMIT 1) c ON true WHERE s.tenant_id=$1 AND s.brand_id=$2 AND s.store_id=$3 AND s.session_id=$4 AND s.phase='Active'",
              [tenant, brand, store, sessionId],
            ),
          );
          if (found.length === 0) return null;
          const raw = closed(found[0], ["session", "capability"]),
            session = parseDiningSession(raw.session),
            capability = parseDiningJoinCapability(raw.capability);
          if (
            session.diningSessionReference !== sessionId ||
            session.brandReference !== brand ||
            session.storeReference !== store ||
            String(capability.storeReference) !== store ||
            String(capability.diningSessionReference) !== sessionId
          )
            return sessionDependency();
          if (
            session.phase !== "Active" ||
            session.tableReference !== String(capability.tableReference) ||
            session.tableAssignmentVersion !== capability.assignmentVersion
          )
            return null;
          return Object.freeze({ session, capability });
        });
      } catch {
        return sessionDependency();
      }
    },
    async regenerate(value) {
      let session, previous, accepted, audit, expected;
      try {
        const raw = closed(value, [
          "session",
          "previous",
          "replacement",
          "expectedCapabilityVersion",
          "operationReference",
          "operationIntentHash",
          "audit",
        ]);
        session = parseDiningSession(raw.session);
        previous = parseDiningJoinCapability(raw.previous);
        accepted = validate({
          capability: raw.replacement,
          operationReference: raw.operationReference,
          operationIntentHash: raw.operationIntentHash,
        });
        const cap = accepted.capability;
        expected = raw.expectedCapabilityVersion;
        if (
          !Number.isSafeInteger(expected) ||
          Number(expected) < 1 ||
          session.phase !== "Active" ||
          session.brandReference !== brand ||
          session.storeReference !== store ||
          String(cap.diningSessionReference) !== session.diningSessionReference ||
          String(cap.tableReference) !== session.tableReference ||
          cap.assignmentVersion !== session.tableAssignmentVersion ||
          String(cap.issuedAt) < session.startedAt ||
          previous.storeReference !== cap.storeReference ||
          previous.tableReference !== cap.tableReference ||
          previous.diningSessionReference !== cap.diningSessionReference ||
          previous.assignmentVersion !== cap.assignmentVersion ||
          previous.kind !== cap.kind ||
          previous.generation + 1 !== cap.generation ||
          previous.capabilityReference === cap.capabilityReference ||
          previous.selectorHash === cap.selectorHash ||
          previous.status === "Active" ||
          previous.version !== Number(expected) + (previous.status === "Revoked" ? 1 : 0)
        )
          return sessionDependency();
        audit = validateAuditRecord(raw.audit, Date.parse(cap.issuedAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "User" ||
          audit.actionCode !== "DINING_JOIN_CREDENTIAL_REGENERATE" ||
          audit.targetType !== "DiningTable" ||
          audit.targetId !== session.tableReference ||
          audit.occurredAt !== String(cap.issuedAt)
        )
          return sessionDependency();
      } catch {
        return sessionDependency();
      }
      const target = session,
        old = previous,
        record = accepted,
        acceptedAudit = audit,
        expectedVersion = expected;
      if (acceptedAudit.actor.type !== "User") return sessionDependency();
      const actorReference = acceptedAudit.actor.reference;
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningJoinRegeneration:${tenant}:${brand}:${store}:${record.operationReference}`,
          ]);
          const prior = await original(tx, record.operationReference);
          if (prior) {
            if (
              equals(prior.record.operationIntentHash, record.operationIntentHash) !== true ||
              prior.actor !== actorReference
            )
              throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
            return prior.record;
          }
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTable:${tenant}:${brand}:${store}:${target.tableReference}`,
          ]);
          const tableRows = rows(
            await tx.query(
              "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
              [tenant, brand, store, target.tableReference],
            ),
          );
          if (!tableRows.length) return conflict();
          const table = createDiningTable(closed(tableRows[0], ["table"]).table);
          if (
            table.tenantReference !== tenant ||
            table.brandReference !== brand ||
            table.storeReference !== store ||
            table.tableReference !== target.tableReference
          )
            return sessionDependency();
          if (
            table.lifecycle !== "Published" ||
            table.operationalState !== "Available" ||
            table.activeDiningSessionReference !== target.diningSessionReference ||
            table.observedAt > String(record.capability.issuedAt)
          )
            return conflict();
          const sessions = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
              [tenant, brand, store, target.diningSessionReference],
            ),
          );
          if (
            !sessions.length ||
            !same(parseDiningSession(closed(sessions[0], ["session"]).session), target)
          )
            return conflict();
          const caps = rows(
            await tx.query(
              "SELECT capability_snapshot AS capability FROM rms_dining.dining_join_capability WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 ORDER BY (capability_snapshot->>'generation')::numeric DESC LIMIT 1 FOR UPDATE",
              [tenant, brand, store, target.diningSessionReference],
            ),
          );
          if (!caps.length) return conflict();
          const current = parseDiningJoinCapability(closed(caps[0], ["capability"]).capability);
          if (
            current.capabilityReference !== old.capabilityReference ||
            current.version !== expectedVersion
          )
            return conflict();
          let transition;
          try {
            transition = regenerateDiningJoinCapability({
              previous: current,
              replacement: record.capability,
              observedAt: record.capability.issuedAt,
            });
          } catch {
            return conflict();
          }
          if (!same(transition.previous, old) || !same(transition.current, record.capability))
            return conflict();
          if (current.status === "Active")
            changed(
              await tx.query(
                "UPDATE rms_dining.dining_join_capability SET version=$6,status=$7,capability_snapshot=$8::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND capability_id=$4 AND version=$5",
                [
                  tenant,
                  brand,
                  store,
                  current.capabilityReference,
                  current.version,
                  old.version,
                  old.status,
                  JSON.stringify(old),
                ],
              ),
            );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_join_capability (capability_id,tenant_id,brand_id,store_id,session_id,version,status,capability_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
              [
                record.capability.capabilityReference,
                tenant,
                brand,
                store,
                target.diningSessionReference,
                JSON.stringify(record.capability),
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_join_regeneration_operation (operation_id,tenant_id,brand_id,store_id,session_id,capability_id,actor_id,intent_hash,record_json,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)",
              [
                record.operationReference,
                tenant,
                brand,
                store,
                target.diningSessionReference,
                record.capability.capabilityReference,
                actorReference,
                record.operationIntentHash,
                JSON.stringify(record),
                record.capability.issuedAt,
              ],
            ),
          );
          await appendAuditRecordInTransaction(tx, acceptedAudit);
          return record;
        });
      } catch (error) {
        return failure(error);
      }
    },
  });
}
