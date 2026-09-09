import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  DiningClosingError,
  exactObject,
  parseDiningClosingOperationRecord,
  parsePositiveDiningVersion,
} from "../../contracts/dining-closing.js";
import {
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  type DiningSession,
} from "../../contracts/dining-session.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import type {
  DiningClosingHashPort,
  DiningClosingStorePort,
} from "../../application/ports/dining-closing-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

function unavailable(): never {
  throw new DiningClosingError("DINING_CLOSING_DEPENDENCY_UNAVAILABLE");
}
function failure(error: unknown): never {
  if (
    error instanceof DiningClosingError &&
    (error.code === "DINING_CLOSING_VERSION_CONFLICT" ||
      error.code === "DINING_CLOSING_IDEMPOTENCY_CONFLICT")
  )
    throw new DiningClosingError(error.code);
  return unavailable();
}
function closed(value: unknown, keys: readonly string[]) {
  return exactObject(captureSessionData(value), keys);
}
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return unavailable();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > 1) return unavailable();
  return copied;
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return unavailable();
}
function reference(value: unknown) {
  try {
    return parseDiningReference(value);
  } catch {
    throw new DiningClosingError("DINING_CLOSING_INPUT_INVALID");
  }
}
function sameSession(left: DiningSession, right: DiningSession) {
  return (Object.keys(left) as (keyof DiningSession)[]).every((key) => left[key] === right[key]);
}

/** Internal owning storage. Current Staff/Host authorization remains mandatory in the service. */
export function createPostgresDiningClosingStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  hashes: DiningClosingHashPort,
): DiningClosingStorePort {
  let scope;
  try {
    scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  } catch {
    throw new DiningClosingError("DINING_CLOSING_INPUT_INVALID");
  }
  const tenant = reference(scope.tenantReference);
  const brand = reference(scope.brandReference);
  const store = reference(scope.storeReference);
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const session = (value: unknown, expectedReference?: string) => {
    const parsed = parseDiningSession(value);
    if (
      parsed.brandReference !== brand ||
      parsed.storeReference !== store ||
      (expectedReference !== undefined && parsed.diningSessionReference !== expectedReference)
    )
      return unavailable();
    return parsed;
  };
  const validate = (value: unknown, expectedValue: unknown, timeValue: unknown) => {
    const record = parseDiningClosingOperationRecord(value);
    const expectedVersion = parsePositiveDiningVersion(expectedValue);
    const occurredAt = parseDiningInstant(timeValue);
    session(record.session);
    if (
      record.session.version !== expectedVersion + 1 ||
      record.session.startedAt > occurredAt ||
      record.session.phase !==
        ({ Begin: "Closing", Cancel: "Active", Finalize: "Closed" } as const)[record.action] ||
      (record.action === "Finalize"
        ? record.closureEvidenceDigest === null
        : record.closureEvidenceDigest !== null || record.taskReferences.length !== 0)
    )
      return unavailable();
    const canonical = parseDiningHash(
      hashes.hashIntent(
        `${record.action}:${record.session.diningSessionReference}:${expectedVersion}:${occurredAt}`,
      ),
    );
    if (hashes.equals(record.operationIntentHash, canonical) !== true) return unavailable();
    return Object.freeze({ record, expectedVersion, occurredAt });
  };
  const original = async (tx: DiningTableTransaction, operation: string) => {
    const selected = rows(
      await tx.query(
        "SELECT record_json AS record,expected_version::text AS expected_version,requested_at AS requested_at FROM rms_dining.dining_closing_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operation],
      ),
    );
    if (selected.length === 0) return null;
    const raw = closed(selected[0], ["record", "expected_version", "requested_at"]);
    if (typeof raw.expected_version !== "string" || !/^[1-9][0-9]*$/u.test(raw.expected_version))
      return unavailable();
    const validated = validate(raw.record, Number(raw.expected_version), raw.requested_at);
    if (validated.record.operationReference !== operation) return unavailable();
    return validated;
  };
  return Object.freeze({
    async load(value: Parameters<DiningClosingStorePort["load"]>[0]) {
      const requested = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          const selected = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
              [tenant, brand, store, requested],
            ),
          );
          return selected.length === 0
            ? null
            : session(closed(selected[0], ["session"]).session, requested);
        });
      } catch {
        return unavailable();
      }
    },
    async resolveOperation(value: Parameters<DiningClosingStorePort["resolveOperation"]>[0]) {
      const operation = reference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          return (await original(tx, operation))?.record ?? null;
        });
      } catch {
        return unavailable();
      }
    },
    async commit(value: Parameters<DiningClosingStorePort["commit"]>[0]) {
      let accepted;
      let audit;
      try {
        const input = closed(value, ["record", "expectedSessionVersion", "audit"]);
        const auditInput = captureSessionData(input.audit);
        const auditTime = (auditInput as { occurredAt?: unknown }).occurredAt;
        accepted = validate(input.record, input.expectedSessionVersion, auditTime);
        audit = validateAuditRecord(auditInput, Date.parse(accepted.occurredAt));
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.targetType !== "DiningSession" ||
          audit.targetId !== accepted.record.session.diningSessionReference ||
          audit.actionCode !== `DINING_SESSION_CLOSING_${accepted.record.action.toUpperCase()}` ||
          audit.actor.type === "Service" ||
          (audit.actor.type === "System" &&
            (audit.sourceChannel !== "CUSTOMER_PWA" ||
              audit.dataClassification !== "Restricted" ||
              Object.keys(audit.beforeSummary ?? {}).length !== 0 ||
              Object.keys(audit.afterSummary ?? {}).length !== 0))
        )
          return unavailable();
      } catch {
        return unavailable();
      }
      const { record, expectedVersion, occurredAt } = accepted;
      const acceptedAudit = audit;
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningClosing:${tenant}:${brand}:${store}:${record.operationReference}`,
          ]);
          const prior = await original(tx, record.operationReference);
          if (prior !== null) {
            if (
              hashes.equals(prior.record.operationIntentHash, record.operationIntentHash) !==
                true ||
              prior.expectedVersion !== expectedVersion ||
              prior.occurredAt !== occurredAt ||
              prior.record.action !== record.action ||
              !sameSession(prior.record.session, record.session) ||
              prior.record.closureEvidenceDigest !== record.closureEvidenceDigest ||
              prior.record.taskReferences.length !== record.taskReferences.length ||
              prior.record.taskReferences.some((ref, index) => ref !== record.taskReferences[index])
            )
              throw new DiningClosingError("DINING_CLOSING_IDEMPOTENCY_CONFLICT");
            return prior.record;
          }
          const selected = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
              [tenant, brand, store, record.session.diningSessionReference],
            ),
          );
          if (selected.length !== 1) return unavailable();
          const current = session(
            closed(selected[0], ["session"]).session,
            record.session.diningSessionReference,
          );
          if (current.version !== expectedVersion)
            throw new DiningClosingError("DINING_CLOSING_VERSION_CONFLICT");
          if (
            current.phase !== (record.action === "Begin" ? "Active" : "Closing") ||
            !sameSession(
              { ...current, phase: record.session.phase, version: current.version + 1 },
              record.session,
            )
          )
            return unavailable();
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_session SET phase=$5,version=$6,session_snapshot=$7::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND version=$8 AND phase=$9",
              [
                tenant,
                brand,
                store,
                current.diningSessionReference,
                record.session.phase,
                record.session.version,
                JSON.stringify(record.session),
                expectedVersion,
                current.phase,
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_closing_operation (operation_id,tenant_id,brand_id,store_id,session_id,action,expected_version,intent_hash,requested_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)",
              [
                record.operationReference,
                tenant,
                brand,
                store,
                current.diningSessionReference,
                record.action,
                expectedVersion,
                record.operationIntentHash,
                occurredAt,
                JSON.stringify(record),
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
