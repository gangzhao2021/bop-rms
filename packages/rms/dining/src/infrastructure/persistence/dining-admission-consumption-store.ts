import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  type AppendAuditRecordInput,
} from "@bop/audit";
import {
  DiningSessionError,
  parseDiningHash,
  parseDiningInstant,
  parseDiningReference,
  parseDiningSession,
  parseDiningTableStartEvidence,
} from "../../domain/dining-session.js";
import { createDiningTable } from "../../domain/dining-table.js";
import { consumeDiningIdentityAdmission } from "../../domain/dining-admission.js";
import {
  closedAdmissionData as closed,
  parseDiningAdmissionConsumptionRecord,
  parseDiningAdmissionSnapshot,
  sameAdmissionData as same,
} from "../../application/dining-admission-record.js";
import {
  captureSessionData,
  sessionDependency,
} from "../../application/dining-session-snapshot.js";
import type {
  DiningAdmissionConsumptionPorts,
  DiningAdmissionSnapshot,
} from "../../application/ports/dining-admission-ports.js";
import type { DiningCredentialPort } from "../../application/ports/dining-session-ports.js";
import type {
  DiningTableStoreScope,
  DiningTableTransaction,
  DiningTableTransactionRunner,
} from "./dining-table-store.js";

export type DiningAdmissionConsumptionStore = DiningAdmissionConsumptionPorts["store"];
export type DiningAdmissionConsumptionAuditFactory = (
  descriptor: Readonly<{
    operationReference: string;
    admissionReference: string;
    diningSessionReference: string;
    brandReference: string;
    storeReference: string;
    occurredAt: string;
  }>,
) => AppendAuditRecordInput;
function rows(value: unknown): readonly unknown[] {
  if (value === null || typeof value !== "object") return sessionDependency();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (!descriptor || !("value" in descriptor)) return sessionDependency();
  const copy = captureSessionData(descriptor.value);
  if (!Array.isArray(copy) || copy.length > 1) return sessionDependency();
  return copy;
}
function changed(value: unknown) {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getOwnPropertyDescriptor(value, "rowCount")?.value !== 1
  )
    return sessionDependency();
}
function conflict(): never {
  throw new DiningSessionError("DINING_SESSION_VERSION_CONFLICT");
}
function idempotency(): never {
  throw new DiningSessionError("DINING_SESSION_IDEMPOTENCY_CONFLICT");
}
function failed(error: unknown): never {
  if (
    error instanceof DiningSessionError &&
    (error.code === "DINING_SESSION_VERSION_CONFLICT" ||
      error.code === "DINING_SESSION_IDEMPOTENCY_CONFLICT")
  )
    throw new DiningSessionError(error.code);
  return sessionDependency();
}
/** Owner transaction. The application service must first authorize the current exact Guest. */
export function createPostgresDiningAdmissionConsumptionStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  credentials: Pick<DiningCredentialPort, "hashOperationIntent" | "equals">,
  auditFactory: DiningAdmissionConsumptionAuditFactory,
): DiningAdmissionConsumptionStore {
  let tenant;
  let brand;
  let store;
  try {
    const raw = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
    tenant = parseDiningReference(raw.tenantReference);
    brand = parseDiningReference(raw.brandReference);
    store = parseDiningReference(raw.storeReference);
  } catch {
    throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
  }
  const digest = (value: string) => parseDiningHash(credentials.hashOperationIntent(value));
  const currentScope = (snapshot: DiningAdmissionSnapshot) => {
    if (
      snapshot.session.brandReference !== brand ||
      snapshot.session.storeReference !== store ||
      snapshot.table.brandReference !== brand ||
      snapshot.table.storeReference !== store ||
      credentials.equals(
        digest(
          `Join:${snapshot.joinedGuestSessionReference}:${snapshot.join.capability.capabilityReference}`,
        ),
        snapshot.join.operationIntentHash,
      ) !== true
    )
      return sessionDependency();
  };
  const context = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const original = async (tx: DiningTableTransaction, operation: string) => {
    const found = rows(
      await tx.query(
        "SELECT record_json AS record FROM rms_dining.dining_admission_consumption_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND operation_id=$4",
        [tenant, brand, store, operation],
      ),
    );
    if (!found.length) return null;
    const record = parseDiningAdmissionConsumptionRecord(closed(found[0], ["record"]).record);
    if (
      record.operationReference !== operation ||
      record.admission.storeReference !== store ||
      credentials.equals(
        digest(
          `ConsumeDiningAdmission:${record.guestSessionReference}:${record.admission.admissionReference}`,
        ),
        record.operationIntentHash,
      ) !== true
    )
      return sessionDependency();
    return record;
  };
  const current = async (
    tx: DiningTableTransaction,
    admissionReference: string,
    observedAt: string,
  ) => {
    const found = rows(
      await tx.query(
        'SELECT s.session_snapshot AS session,p.participant_snapshot AS participant,a.admission_snapshot AS admission,t.table_snapshot AS table,j.record_json AS "join",j.guest_session_id AS "joinedGuestSessionReference" FROM rms_dining.dining_identity_admission a JOIN rms_dining.dining_session s ON s.tenant_id=a.tenant_id AND s.brand_id=a.brand_id AND s.store_id=a.store_id AND s.session_id=a.session_id JOIN rms_dining.dining_participant p ON p.tenant_id=a.tenant_id AND p.brand_id=a.brand_id AND p.store_id=a.store_id AND p.session_id=a.session_id AND p.participant_id=a.participant_id JOIN rms_dining.dining_table t ON t.tenant_id=s.tenant_id AND t.brand_id=s.brand_id AND t.store_id=s.store_id AND t.table_id=s.table_id JOIN rms_dining.dining_session_join_operation j ON j.tenant_id=a.tenant_id AND j.brand_id=a.brand_id AND j.store_id=a.store_id AND j.session_id=a.session_id AND j.participant_id=a.participant_id AND j.admission_id=a.admission_id WHERE a.tenant_id=$1 AND a.brand_id=$2 AND a.store_id=$3 AND a.admission_id=$4',
        [tenant, brand, store, admissionReference],
      ),
    );
    if (!found.length) return null;
    const raw = closed(found[0], [
      "session",
      "participant",
      "admission",
      "table",
      "join",
      "joinedGuestSessionReference",
    ]);
    const table = createDiningTable(raw.table);
    const session = parseDiningSession(raw.session);
    if (
      table.tenantReference !== tenant ||
      table.brandReference !== brand ||
      table.storeReference !== store ||
      table.tableReference !== session.tableReference
    )
      return sessionDependency();
    if (table.observedAt > observedAt) return null;
    const snapshot = parseDiningAdmissionSnapshot({
      ...raw,
      table: parseDiningTableStartEvidence({
        brandReference: table.brandReference,
        storeReference: table.storeReference,
        tableReference: table.tableReference,
        assignmentVersion: session.tableAssignmentVersion,
        tableState:
          table.lifecycle === "Published" && table.operationalState === "Available"
            ? "Eligible"
            : "Unavailable",
        activeDiningSessionReference: table.activeDiningSessionReference,
        observedAt,
      }),
    });
    currentScope(snapshot);
    if (snapshot.admission.admissionReference !== admissionReference) return sessionDependency();
    return snapshot;
  };
  return Object.freeze({
    async readCurrent(value) {
      let admissionReference;
      let observedAt;
      try {
        const raw = closed(value, ["admissionReference", "observedAt"]);
        admissionReference = parseDiningReference(raw.admissionReference);
        observedAt = parseDiningInstant(raw.observedAt);
      } catch {
        throw new DiningSessionError("DINING_SESSION_INPUT_INVALID");
      }
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          return current(tx, admissionReference, observedAt);
        });
      } catch {
        return sessionDependency();
      }
    },
    async resolveOperation(value) {
      const operation = parseDiningReference(value);
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          return original(tx, operation);
        });
      } catch {
        return sessionDependency();
      }
    },
    async consume(value) {
      let snapshot;
      let record;
      let observedAt;
      try {
        const raw = closed(value, ["snapshot", "record"]);
        snapshot = parseDiningAdmissionSnapshot(raw.snapshot);
        record = parseDiningAdmissionConsumptionRecord(raw.record);
        observedAt = record.admission.consumedAt;
        currentScope(snapshot);
        if (
          observedAt === null ||
          record.guestSessionReference !== snapshot.joinedGuestSessionReference ||
          credentials.equals(
            digest(
              `ConsumeDiningAdmission:${record.guestSessionReference}:${record.admission.admissionReference}`,
            ),
            record.operationIntentHash,
          ) !== true ||
          !same(
            record.admission,
            consumeDiningIdentityAdmission({
              admission: snapshot.admission,
              session: snapshot.session,
              participant: snapshot.participant,
              table: snapshot.table,
              expectedAdmissionVersion: 1,
              expectedSessionVersion: snapshot.session.version,
              observedAt,
            }),
          )
        )
          return sessionDependency();
      } catch {
        return sessionDependency();
      }
      const command = Object.freeze({ snapshot, record, observedAt });
      try {
        return await runner.run(async (tx) => {
          await context(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningAdmissionConsume:${tenant}:${brand}:${store}:${command.record.operationReference}`,
          ]);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            `DiningTable:${tenant}:${brand}:${store}:${command.snapshot.session.tableReference}`,
          ]);
          const locks = [
            [
              "SELECT table_id AS reference FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
              command.snapshot.session.tableReference,
            ],
            [
              "SELECT session_id AS reference FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
              command.snapshot.session.diningSessionReference,
            ],
            [
              "SELECT participant_id AS reference FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND participant_id=$4 FOR UPDATE",
              command.snapshot.participant.participantReference,
            ],
            [
              "SELECT admission_id AS reference FROM rms_dining.dining_identity_admission WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND admission_id=$4 FOR UPDATE",
              command.snapshot.admission.admissionReference,
            ],
          ] as const;
          for (const [sql, reference] of locks) {
            const found = rows(await tx.query(sql, [tenant, brand, store, reference]));
            if (!found.length) return conflict();
            if (closed(found[0], ["reference"]).reference !== reference) return sessionDependency();
          }
          const actual = await current(
            tx,
            command.snapshot.admission.admissionReference,
            command.observedAt,
          );
          if (
            actual === null ||
            !same(actual.session, command.snapshot.session) ||
            !same(actual.participant, command.snapshot.participant) ||
            !same(actual.table, command.snapshot.table) ||
            !same(actual.join, command.snapshot.join) ||
            actual.joinedGuestSessionReference !== command.record.guestSessionReference
          )
            return conflict();
          let transition;
          try {
            transition = consumeDiningIdentityAdmission({
              admission: actual.join.admission,
              session: actual.session,
              participant: actual.participant,
              table: actual.table,
              expectedAdmissionVersion: 1,
              expectedSessionVersion: actual.session.version,
              observedAt: command.observedAt,
            });
          } catch {
            return conflict();
          }
          if (!same(transition, command.record.admission)) return conflict();
          const prior = await original(tx, command.record.operationReference);
          if (prior !== null) {
            if (
              prior.guestSessionReference !== command.record.guestSessionReference ||
              credentials.equals(prior.operationIntentHash, command.record.operationIntentHash) !==
                true ||
              !same(
                { ...prior.admission, consumedAt: command.observedAt },
                command.record.admission,
              )
            )
              return idempotency();
            if (
              prior.admission.consumedAt === null ||
              prior.admission.consumedAt > command.observedAt ||
              !same(actual.admission, prior.admission)
            )
              return conflict();
            return Object.freeze({ status: "AlreadyApplied" as const, record: prior });
          }
          if (
            actual.admission.status !== "Active" ||
            !same(actual.admission, command.snapshot.admission)
          )
            return conflict();
          const descriptor = Object.freeze({
            operationReference: command.record.operationReference,
            admissionReference: actual.admission.admissionReference,
            diningSessionReference: actual.session.diningSessionReference,
            brandReference: brand,
            storeReference: store,
            occurredAt: command.observedAt,
          });
          const audit = validateAuditRecord(
            captureSessionData(auditFactory(descriptor)),
            Date.parse(command.observedAt),
          );
          if (
            audit.brandId !== brand ||
            audit.storeId !== store ||
            audit.actor.type !== "System" ||
            audit.actionCode !== "DINING_IDENTITY_ADMISSION_CONSUME" ||
            audit.targetType !== "DiningIdentityAdmission" ||
            audit.targetId !== descriptor.admissionReference ||
            audit.reasonCode !== "AUTHORIZED_DINING_ADMISSION_CONSUMPTION" ||
            audit.occurredAt !== command.observedAt ||
            audit.sourceChannel !== "CUSTOMER_PWA" ||
            audit.dataClassification !== "Restricted" ||
            audit.beforeSummary !== undefined ||
            audit.afterSummary !== undefined
          )
            return sessionDependency();
          changed(
            await tx.query(
              "UPDATE rms_dining.dining_identity_admission SET version=2,status='Consumed',admission_snapshot=$5::jsonb WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND admission_id=$4 AND version=1 AND status='Active'",
              [
                tenant,
                brand,
                store,
                actual.admission.admissionReference,
                JSON.stringify(command.record.admission),
              ],
            ),
          );
          changed(
            await tx.query(
              "INSERT INTO rms_dining.dining_admission_consumption_operation (operation_id,tenant_id,brand_id,store_id,session_id,participant_id,admission_id,guest_session_id,join_operation_id,intent_hash,record_json,consumed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)",
              [
                command.record.operationReference,
                tenant,
                brand,
                store,
                actual.session.diningSessionReference,
                actual.participant.participantReference,
                actual.admission.admissionReference,
                command.record.guestSessionReference,
                actual.join.operationReference,
                command.record.operationIntentHash,
                JSON.stringify(command.record),
                command.observedAt,
              ],
            ),
          );
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({ status: "Applied" as const, record: command.record });
        });
      } catch (error) {
        return failed(error);
      }
    },
  });
}
