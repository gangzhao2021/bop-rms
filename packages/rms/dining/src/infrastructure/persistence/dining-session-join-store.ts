import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { evaluateDiningJoin, parseDiningJoinCapability } from "@bop/public-capability";
import {
  DiningSessionError,
  parseDiningHash,
  parseDiningReference,
  parseDiningSession,
} from "../../contracts/dining-session.js";
import { createDiningTable } from "../../domain/dining-table.js";
import { parseDiningJoinRecord } from "../../application/dining-join-record.js";
import {
  captureSessionData,
  sessionDependency,
} from "../../application/dining-session-snapshot.js";
import type {
  DiningCredentialPort,
  DiningSessionStorePort,
  DiningJoinRecord,
} from "../../application/ports/dining-session-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";
export type DiningSessionJoinStore = Pick<
  DiningSessionStorePort,
  "resolveJoinState" | "resolveJoinOperation" | "join"
>;
export type DiningJoinAuditFactory = (
  descriptor: Readonly<{
    operationReference: string;
    diningSessionReference: string;
    brandReference: string;
    storeReference: string;
    occurredAt: string;
  }>,
) => AppendAuditRecordInput;
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
function rows(value: unknown, maximum = 1): readonly unknown[] {
  if (value === null || typeof value !== "object") return sessionDependency();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return sessionDependency();
  const copied = captureSessionData(descriptor.value);
  if (!Array.isArray(copied) || copied.length > maximum) return sessionDependency();
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

/** Internal owner transaction. The Session service must admit current Guest context and abuse first. */
export function createPostgresDiningSessionJoinStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  credentials: Pick<DiningCredentialPort, "hashOperationIntent" | "equals">,
  auditFactory: DiningJoinAuditFactory,
): DiningSessionJoinStore {
  const scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = reference(scope.tenantReference),
    brand = reference(scope.brandReference),
    store = reference(scope.storeReference);
  const hash = credentials.hashOperationIntent.bind(credentials),
    equals = credentials.equals.bind(credentials);
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const conflict = (): never => {
    throw new DiningSessionError("DINING_SESSION_VERSION_CONFLICT");
  };
  const validate = (value: unknown, guest: string): DiningJoinRecord => {
    try {
      const raw = closed(value, [
        "session",
        "participant",
        "admission",
        "capability",
        "operationReference",
        "operationIntentHash",
      ]);
      const session = parseDiningSession(raw.session),
        capability = parseDiningJoinCapability(raw.capability);
      if (session.brandReference !== brand || session.storeReference !== store)
        return sessionDependency();
      const record = parseDiningJoinRecord(raw, {
        operationReference: reference(raw.operationReference),
        session,
        consumedCapability: capability,
        maximumSessionVersion: session.version,
        exactConsumedAt: true,
        observedAt: capability.consumedAt ?? "",
      });
      if (
        String(capability.diningSessionReference) !== session.diningSessionReference ||
        String(capability.storeReference) !== store ||
        String(capability.tableReference) !== session.tableReference ||
        capability.assignmentVersion !== session.tableAssignmentVersion ||
        capability.version !== 2 ||
        String(capability.issuedAt) < session.startedAt
      )
        return sessionDependency();
      const digest = parseDiningHash(hash(`Join:${guest}:${capability.capabilityReference}`));
      if (equals(digest, record.operationIntentHash) !== true) return sessionDependency();
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
        'SELECT record_json AS record,guest_session_id AS "guestSessionReference" FROM rms_dining.dining_session_join_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4',
        [tenant, brand, store, operation],
      ),
    );
    if (!found.length) return null;
    const raw = closed(found[0], ["record", "guestSessionReference"]),
      guest = reference(raw.guestSessionReference),
      record = validate(raw.record, guest);
    if (record.operationReference !== operation) return sessionDependency();
    return { record, guest };
  };
  return Object.freeze({
    async resolveJoinOperation(value) {
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
    async resolveJoinState(value) {
      let selector;
      try {
        selector = parseDiningHash(value);
      } catch {
        throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
      }
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          const found = rows(
            await tx.query(
              "SELECT s.session_snapshot AS session,c.capability_snapshot AS capability FROM rms_dining.dining_join_capability c JOIN rms_dining.dining_session s ON s.tenant_id=c.tenant_id AND s.brand_id=c.brand_id AND s.store_id=c.store_id AND s.session_id=c.session_id WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.store_id=$3 AND c.capability_snapshot->>'selectorHash'=$4 AND s.phase='Active' LIMIT 2",
              [tenant, brand, store, selector],
            ),
            2,
          );
          if (found.length !== 1) return null;
          const raw = closed(found[0], ["session", "capability"]),
            session = parseDiningSession(raw.session),
            capability = parseDiningJoinCapability(raw.capability);
          if (
            session.brandReference !== brand ||
            session.storeReference !== store ||
            String(capability.selectorHash) !== selector ||
            String(capability.storeReference) !== store ||
            String(capability.diningSessionReference) !== session.diningSessionReference
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
    async join(value) {
      let accepted, guest, sessionVersion, capabilityVersion, audit;
      try {
        const raw = closed(value, [
          "record",
          "expectedSessionVersion",
          "expectedCapabilityVersion",
          "guestSessionReference",
        ]);
        guest = reference(raw.guestSessionReference);
        accepted = validate(raw.record, guest);
        sessionVersion = raw.expectedSessionVersion;
        capabilityVersion = raw.expectedCapabilityVersion;
        if (
          !Number.isSafeInteger(sessionVersion) ||
          Number(sessionVersion) < 1 ||
          Number(sessionVersion) + 1 !== accepted.session.version ||
          capabilityVersion !== 1
        )
          return sessionDependency();
        const descriptor = Object.freeze({
          operationReference: accepted.operationReference,
          diningSessionReference: accepted.session.diningSessionReference,
          brandReference: brand,
          storeReference: store,
          occurredAt: accepted.participant.joinedAt,
        });
        audit = validateAuditRecord(
          captureSessionData(auditFactory(descriptor)),
          Date.parse(descriptor.occurredAt),
        );
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "DINING_SESSION_JOIN" ||
          audit.targetType !== "DiningSession" ||
          audit.targetId !== accepted.session.diningSessionReference ||
          audit.reasonCode !== "AUTHORIZED_DINING_JOIN" ||
          audit.occurredAt !== accepted.participant.joinedAt ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined
        )
          return sessionDependency();
      } catch {
        return sessionDependency();
      }
      const record = accepted,
        guestReference = guest,
        expectedSessionVersion = sessionVersion,
        expectedCapabilityVersion = capabilityVersion,
        acceptedAudit = audit;
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningSessionJoin:${tenant}:${brand}:${store}:${record.operationReference}`,
          ]);
          const prior = await original(tx, record.operationReference);
          if (prior) {
            if (
              prior.guest !== guestReference ||
              equals(prior.record.operationIntentHash, record.operationIntentHash) !== true
            )
              throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
            return prior.record;
          }
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTable:${tenant}:${brand}:${store}:${record.session.tableReference}`,
          ]);
          const tables = rows(
            await tx.query(
              "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
              [tenant, brand, store, record.session.tableReference],
            ),
          );
          if (!tables.length) return conflict();
          const table = createDiningTable(closed(tables[0], ["table"]).table);
          if (
            table.tenantReference !== tenant ||
            table.brandReference !== brand ||
            table.storeReference !== store ||
            table.tableReference !== record.session.tableReference
          )
            return sessionDependency();
          if (
            table.lifecycle !== "Published" ||
            table.operationalState !== "Available" ||
            table.activeDiningSessionReference !== record.session.diningSessionReference ||
            table.observedAt > record.participant.joinedAt
          )
            return conflict();
          const sessions = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
              [tenant, brand, store, record.session.diningSessionReference],
            ),
          );
          if (!sessions.length) return conflict();
          const current = parseDiningSession(closed(sessions[0], ["session"]).session);
          if (
            current.phase !== "Active" ||
            current.version !== expectedSessionVersion ||
            !same(
              parseDiningSession({
                ...current,
                version: current.version + 1,
                hostParticipantReference:
                  current.hostParticipantReference ?? record.participant.participantReference,
              }),
              record.session,
            )
          )
            return conflict();
          const duplicates = rows(
            await tx.query(
              "SELECT operation_id FROM rms_dining.dining_session_join_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND guest_session_id=$5 LIMIT 1",
              [tenant, brand, store, current.diningSessionReference, guestReference],
            ),
          );
          if (duplicates.length) return conflict();
          const caps = rows(
            await tx.query(
              "SELECT capability_snapshot AS capability FROM rms_dining.dining_join_capability WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND capability_id=$5 FOR UPDATE",
              [
                tenant,
                brand,
                store,
                current.diningSessionReference,
                record.capability.capabilityReference,
              ],
            ),
          );
          if (!caps.length) return conflict();
          const cap = parseDiningJoinCapability(closed(caps[0], ["capability"]).capability);
          const decision = evaluateDiningJoin({
            capability: cap,
            purpose: "DiningJoin",
            storeReference: store,
            tableReference: current.tableReference,
            diningSessionReference: current.diningSessionReference,
            assignmentVersion: current.tableAssignmentVersion,
            generation: cap.generation,
            selectorHash: record.capability.selectorHash,
            sessionPhase: current.phase,
            abuseDecision: "Admitted",
            observedAt: record.participant.joinedAt,
            expectedVersion: expectedCapabilityVersion,
          });
          if (decision.decision !== "Allowed" || !same(decision.capability, record.capability))
            return conflict();
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_join_capability SET version=2,status='Consumed',capability_snapshot=$6::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND capability_id=$4 AND version=$5",
              [
                tenant,
                brand,
                store,
                cap.capabilityReference,
                expectedCapabilityVersion,
                JSON.stringify(record.capability),
              ],
            ),
          );
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_session SET version=$6,session_snapshot=$7::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND version=$5",
              [
                tenant,
                brand,
                store,
                current.diningSessionReference,
                expectedSessionVersion,
                record.session.version,
                JSON.stringify(record.session),
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_participant (participant_id,tenant_id,brand_id,store_id,session_id,version,status,participant_snapshot) VALUES ($1,$2,$3,$4,$5,1,'Active',$6::jsonb)",
              [
                record.participant.participantReference,
                tenant,
                brand,
                store,
                current.diningSessionReference,
                JSON.stringify(record.participant),
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_identity_admission (admission_id,tenant_id,brand_id,store_id,session_id,participant_id,version,status,admission_snapshot) VALUES ($1,$2,$3,$4,$5,$6,1,'Active',$7::jsonb)",
              [
                record.admission.admissionReference,
                tenant,
                brand,
                store,
                current.diningSessionReference,
                record.participant.participantReference,
                JSON.stringify(record.admission),
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_session_join_operation (operation_id,tenant_id,brand_id,store_id,session_id,guest_session_id,participant_id,admission_id,capability_id,intent_hash,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
              [
                record.operationReference,
                tenant,
                brand,
                store,
                current.diningSessionReference,
                guestReference,
                record.participant.participantReference,
                record.admission.admissionReference,
                record.capability.capabilityReference,
                record.operationIntentHash,
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
