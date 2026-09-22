import { assertDiningCheckoutCommitmentUsable } from "../../domain/dining-checkout-commitment.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import {
  DiningCheckoutCommitmentError,
  parseDiningCheckoutCommitment,
  prepareDiningCheckoutCommitment,
  sealDiningCheckoutCommitment,
  expireDiningCheckoutCommitment,
  type DiningCheckoutCommitment,
} from "../../domain/dining-checkout-commitment.js";
import {
  parseDiningReference,
  parseDiningInstant,
  parseDiningSession,
  parseDiningParticipant,
} from "../../domain/dining-session.js";
import { createDiningTable } from "../../domain/dining-table.js";
import { captureSessionData } from "../../application/dining-session-snapshot.js";
import type {
  DiningTableTransaction,
  DiningTableTransactionRunner,
  DiningTableStoreScope,
} from "./dining-table-store.js";

export class DiningCheckoutStoreError extends Error {
  constructor(
    readonly code:
      | "DINING_CHECKOUT_STORE_INVALID"
      | "DINING_CHECKOUT_STORE_CONFLICT"
      | "DINING_CHECKOUT_STORE_UNAVAILABLE",
  ) {
    super("dining checkout storage is unavailable");
    this.name = "DiningCheckoutStoreError";
  }
}
const fail = (
  code: DiningCheckoutStoreError["code"] = "DINING_CHECKOUT_STORE_UNAVAILABLE",
): never => {
  throw new DiningCheckoutStoreError(code);
};
function closed(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((k) => typeof k !== "string" || !fields.includes(k))
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of fields) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function rows(value: unknown, limit = 1): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d)) return fail();
  const result = captureSessionData(d.value);
  if (!Array.isArray(result) || result.length > limit) return fail();
  return result;
}
function normalize(error: unknown): never {
  if (error instanceof DiningCheckoutStoreError || error instanceof DiningCheckoutCommitmentError)
    throw error;
  return fail();
}
const same = (left: DiningCheckoutCommitment, right: DiningCheckoutCommitment) =>
  JSON.stringify(left) === JSON.stringify(right);
function link(record: DiningCheckoutCommitment) {
  return {
    commitmentReference: record.commitmentReference,
    brandReference: record.brandReference,
    storeReference: record.storeReference,
    submissionReference: record.submissionReference,
    orderReference: record.orderReference,
    orderBatchReference: record.orderBatchReference,
    cartReference: record.cartReference,
    cartVersion: record.cartVersion,
    quoteReference: record.quoteReference,
    paymentOperationReference: record.paymentOperationReference,
    guestSessionReference: record.guestSessionReference,
    intentHash: record.intentHash,
    acknowledgedAt: record.orderingLinkedAt,
  };
}
const preparation = (record: DiningCheckoutCommitment) =>
  Object.fromEntries(
    Object.entries(record).filter(
      ([key]) =>
        !["state", "orderingLinkedAt", "paymentRequestedAt", "capacityExpiresAt"].includes(key),
    ),
  );

/** Owner-only adapter. Current Guest authorization and acknowledged Ordering linkage are application prerequisites. */
export function createPostgresDiningCheckoutCommitmentStore(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
  clock: { now(): string },
) {
  const scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const tenant = parseDiningReference(scope.tenantReference),
    brand = parseDiningReference(scope.brandReference),
    store = parseDiningReference(scope.storeReference);
  const scoped = (record: DiningCheckoutCommitment) => {
    if (record.brandReference !== brand || record.storeReference !== store)
      return fail("DINING_CHECKOUT_STORE_CONFLICT");
  };
  const setContext = (tx: DiningTableTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  function now(previous?: string) {
    const value = parseDiningInstant(clock.now());
    if (previous !== undefined && value < previous) return fail();
    return value;
  }
  async function history(tx: DiningTableTransaction, reference: string) {
    const found = rows(
      await tx.query(
        "SELECT record_json AS record,version::text AS version FROM rms_dining.dining_checkout_commitment WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND commitment_id=$4 ORDER BY version",
        [tenant, brand, store, reference],
      ),
      3,
    );
    const records: DiningCheckoutCommitment[] = [];
    for (const [index, value] of found.entries()) {
      const row = closed(value, ["record", "version"]),
        record = parseDiningCheckoutCommitment(row.record);
      scoped(record);
      if (record.commitmentReference !== reference || row.version !== String(index + 1))
        return fail();
      const prior = records[index - 1];
      if (prior === undefined) {
        if (record.state !== "Prepared") return fail();
      } else {
        if (JSON.stringify(preparation(prior)) !== JSON.stringify(preparation(record)))
          return fail();
        if (prior.state === "Expired" || record.state === "Prepared") return fail();
        if (record.state === "PaymentPending" && prior.state !== "Prepared") return fail();
        if (
          record.state === "Expired" &&
          !same(record, parseDiningCheckoutCommitment({ ...prior, state: "Expired" }))
        )
          return fail();
      }
      records.push(record);
    }
    return records;
  }
  async function current(tx: DiningTableTransaction, record: DiningCheckoutCommitment, at: string) {
    // Match Move's table-before-session order; only Dining's own current rows are locked.
    const tables = rows(
      await tx.query(
        "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
        [tenant, brand, store, record.tableReference],
      ),
    );
    if (tables.length !== 1) return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const table = createDiningTable(closed(tables[0], ["table"]).table);
    if (
      table.tenantReference !== tenant ||
      table.brandReference !== brand ||
      table.storeReference !== store ||
      table.tableReference !== record.tableReference ||
      table.activeDiningSessionReference !== record.diningSessionReference ||
      table.lifecycle !== "Published" ||
      table.operationalState !== "Available" ||
      table.observedAt > at
    )
      return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const sessions = rows(
      await tx.query(
        "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
        [tenant, brand, store, record.diningSessionReference],
      ),
    );
    const participants = rows(
      await tx.query(
        "SELECT participant_snapshot AS participant FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5 FOR UPDATE",
        [tenant, brand, store, record.diningSessionReference, record.participantReference],
      ),
    );
    if (sessions.length !== 1 || participants.length !== 1)
      return fail("DINING_CHECKOUT_STORE_CONFLICT");
    return {
      session: closed(sessions[0], ["session"]).session,
      participant: closed(participants[0], ["participant"]).participant,
    };
  }
  return Object.freeze({
    /** Historical recovery is never current permission to submit or pay. */
    async load(referenceValue: unknown) {
      try {
        const reference = parseDiningReference(referenceValue);
        return await runner.run(async (tx) => {
          await setContext(tx);
          const records = await history(tx, reference);
          return records.at(-1) ?? null;
        });
      } catch (error) {
        return normalize(error);
      }
    },
    /** Current owner facts only; does not grant Payment or fulfillment eligibility. */
    async withCurrentFacts<T>(
      referenceValue: unknown,
      work: (
        transaction: DiningTableTransaction,
        facts: Readonly<{
          commitment: DiningCheckoutCommitment;
          session: ReturnType<typeof parseDiningSession>;
          participant: ReturnType<typeof parseDiningParticipant>;
        }>,
      ) => Promise<T>,
    ): Promise<T | null> {
      try {
        const reference = parseDiningReference(referenceValue);
        return await runner.run(async (tx) => {
          await setContext(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "DiningCheckout:" + tenant + ":" + brand + ":" + store + ":" + reference,
          ]);
          const commitment = (await history(tx, reference)).at(-1);
          if (commitment === undefined) return null;
          const observedAt = now();
          const context = await current(tx, commitment, observedAt);
          const session = parseDiningSession(context.session);
          const participant = parseDiningParticipant(context.participant);
          if (
            session.brandReference !== brand ||
            session.storeReference !== store ||
            session.diningSessionReference !== commitment.diningSessionReference ||
            participant.diningSessionReference !== session.diningSessionReference ||
            participant.participantReference !== commitment.participantReference ||
            session.startedAt > observedAt ||
            participant.joinedAt > observedAt
          )
            return fail("DINING_CHECKOUT_STORE_CONFLICT");
          return work(tx, Object.freeze({ commitment, session, participant }));
        });
      } catch (error) {
        return normalize(error);
      }
    },
    /** Current payment eligibility with commitment and Dining context locked through caller work. */
    async withPaymentPending<T>(
      referenceValue: unknown,
      work: (transaction: DiningTableTransaction, record: DiningCheckoutCommitment) => Promise<T>,
    ): Promise<T | null> {
      try {
        const reference = parseDiningReference(referenceValue);
        return await runner.run(async (tx) => {
          await setContext(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "DiningCheckout:" + tenant + ":" + brand + ":" + store + ":" + reference,
          ]);
          const record = (await history(tx, reference)).at(-1);
          if (record === undefined) return null;
          const observedAt = now();
          const context = await current(tx, record, observedAt);
          const eligible = assertDiningCheckoutCommitmentUsable(record, context, now(observedAt));
          const result = await work(tx, eligible);
          assertDiningCheckoutCommitmentUsable(record, context, now(observedAt));
          return result;
        });
      } catch (error) {
        return normalize(error);
      }
    },
    /** Recover the original server IDs by the scoped unique submission key. */
    async loadSubmission(referenceValue: unknown) {
      try {
        const reference = parseDiningReference(referenceValue);
        return await runner.run(async (tx) => {
          await setContext(tx);
          const found = rows(
            await tx.query(
              "SELECT commitment_id::text AS reference FROM rms_dining.dining_checkout_commitment WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND submission_id=$4 AND version=1",
              [tenant, brand, store, reference],
            ),
          );
          if (found.length === 0) return null;
          const commitment = parseDiningReference(closed(found[0], ["reference"]).reference);
          const records = await history(tx, commitment);
          const latest = records.at(-1);
          if (latest === undefined || latest.submissionReference !== reference) return fail();
          return latest;
        });
      } catch (error) {
        return normalize(error);
      }
    },
    async append(value: unknown) {
      try {
        // Freeze the entire request before the first asynchronous boundary.
        const raw = closed(captureSessionData(value), ["record", "expectedVersion", "audit"]);
        const record = parseDiningCheckoutCommitment(raw.record);
        scoped(record);
        if (
          !Number.isSafeInteger(raw.expectedVersion) ||
          (raw.expectedVersion as number) < 0 ||
          (raw.expectedVersion as number) > 2
        )
          return fail("DINING_CHECKOUT_STORE_INVALID");
        const expectedVersion = raw.expectedVersion as number;
        let observedAt = now();
        const audit = validateAuditRecord(raw.audit as never, Date.parse(observedAt));
        const action =
          record.state === "Prepared"
            ? "PREPARE"
            : record.state === "PaymentPending"
              ? "SEAL"
              : "EXPIRE";
        if (
          audit.brandId !== brand ||
          audit.storeId !== store ||
          audit.actor.type !== "System" ||
          audit.actionCode !== "DINING_CHECKOUT_" + action ||
          audit.targetType !== "DiningCheckoutCommitment" ||
          audit.targetId !== record.commitmentReference ||
          audit.reasonCode !== "AUTHORIZED_DINING_CHECKOUT" ||
          audit.sourceChannel !== "CUSTOMER_PWA" ||
          audit.dataClassification !== "Restricted" ||
          audit.beforeSummary !== undefined ||
          audit.afterSummary !== undefined ||
          audit.occurredAt < record.preparedAt ||
          audit.occurredAt > observedAt
        )
          return fail("DINING_CHECKOUT_STORE_INVALID");
        return await runner.run(async (tx) => {
          await setContext(tx);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "DiningCheckout:" +
              tenant +
              ":" +
              brand +
              ":" +
              store +
              ":" +
              record.commitmentReference,
          ]);
          const prior = await history(tx, record.commitmentReference);
          const original = prior.find((r) => r.state === record.state);
          if (original !== undefined) {
            if (prior.indexOf(original) !== expectedVersion || !same(original, record))
              return fail("DINING_CHECKOUT_STORE_CONFLICT");
            return Object.freeze({
              status: "Existing" as const,
              record: original,
              version: expectedVersion + 1,
            });
          }
          if (prior.length !== expectedVersion) return fail("DINING_CHECKOUT_STORE_CONFLICT");
          observedAt = now(observedAt);
          let result: DiningCheckoutCommitment;
          const latest = prior.at(-1);
          if (record.state === "Expired") {
            if (latest === undefined) return fail("DINING_CHECKOUT_STORE_CONFLICT");
            result = expireDiningCheckoutCommitment(latest, observedAt);
          } else {
            const context = await current(tx, record, observedAt);
            observedAt = now(observedAt);
            if (record.state === "Prepared") {
              if (latest !== undefined || record.preparedAt > observedAt)
                return fail("DINING_CHECKOUT_STORE_CONFLICT");
              result = prepareDiningCheckoutCommitment(preparation(record), context);
            } else {
              if (latest === undefined || latest.state !== "Prepared")
                return fail("DINING_CHECKOUT_STORE_CONFLICT");
              result = sealDiningCheckoutCommitment(
                latest,
                context,
                link(record),
                record.paymentRequestedAt,
                observedAt,
              );
            }
          }
          if (!same(result, record)) return fail("DINING_CHECKOUT_STORE_CONFLICT");
          const fresh = () => {
            observedAt = now(observedAt);
            if (record.state !== "Expired" && observedAt >= record.preparationValidUntil)
              throw new DiningCheckoutCommitmentError("DINING_CHECKOUT_EXPIRED");
          };
          fresh();
          const inserted = await tx.query(
            "INSERT INTO rms_dining.dining_checkout_commitment (tenant_id,brand_id,store_id,commitment_id,session_id,submission_id,payment_operation_id,version,previous_version,state,recorded_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)",
            [
              tenant,
              brand,
              store,
              record.commitmentReference,
              record.diningSessionReference,
              record.submissionReference,
              record.paymentOperationReference,
              expectedVersion + 1,
              expectedVersion === 0 ? null : expectedVersion,
              record.state,
              observedAt,
              JSON.stringify(record),
            ],
          );
          if (
            inserted === null ||
            typeof inserted !== "object" ||
            Object.getOwnPropertyDescriptor(inserted, "rowCount")?.value !== 1
          )
            return fail();
          await appendAuditRecordInTransaction(tx, audit);
          fresh(); // Audit-chain waits cannot make an expired preparation appear committed live.
          return Object.freeze({
            status: "Created" as const,
            record,
            version: expectedVersion + 1,
          });
        });
      } catch (error) {
        return normalize(error);
      }
    },
  });
}
