import {
  assertDiningCheckoutCommitmentUsable,
  DiningCheckoutHeldError,
  diningCheckoutHeldUntil,
  isDiningCheckoutHeld,
} from "../../domain/dining-checkout-commitment.js";
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
      | "DINING_CHECKOUT_STORE_UNAVAILABLE"
      /**
       * WP-2423 (table-move-payment review, 2026-11-06): staff moved the party off the table this
       * round is being sent from after it was prepared. The round cannot be sent from the old table;
       * the guest starts checkout again at the table the party sits at now.
       */
      | "DINING_CHECKOUT_STORE_TABLE_MOVED",
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
  if (
    error instanceof DiningCheckoutStoreError ||
    error instanceof DiningCheckoutCommitmentError ||
    isDiningCheckoutHeld(error)
  )
    throw error;
  return fail();
}
/**
 * DEC-DINING-ANY-PARTICIPANT-SUBMIT: the latest deadline among other participants' commitments
 * that still hold this exact Cart version for checkout, or null. Each commitment is read at its
 * latest version; the caller supplies scope context and any locks it needs.
 * WP-2423 (table-move-send): `seated` is the table the party sits at now. A round still being
 * prepared at a table staff moved the party off can never be sent from there, so it holds nothing
 * (a round already sent follows its party and still holds). Ordering clears the Cart and moves its
 * version on in the Order's own transaction, so a Cart version already ordered is never current
 * again and cannot be checked out twice whatever this says.
 */
async function heldUntil(
  tx: DiningTableTransaction,
  ids: Readonly<{ tenant: string; brand: string; store: string }>,
  input: Readonly<{
    diningSessionReference: string;
    cartReference: string;
    cartVersion: number;
    participantReference: string;
    observedAt: string;
  }>,
  seated: Readonly<{ tableReference: string; tableAssignmentVersion: number }> | null,
): Promise<string | null> {
  const found = rows(
    await tx.query(
      "SELECT DISTINCT ON (commitment_id) record_json AS record FROM rms_dining.dining_checkout_commitment WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND record_json->>'cartReference'=$5 AND record_json->'cartVersion'=to_jsonb($6::bigint) ORDER BY commitment_id,version DESC LIMIT 101",
      [
        ids.tenant,
        ids.brand,
        ids.store,
        input.diningSessionReference,
        input.cartReference,
        input.cartVersion,
      ],
    ),
    100,
  );
  let latest: string | null = null;
  for (const value of found) {
    const record = parseDiningCheckoutCommitment(closed(value, ["record"]).record);
    if (
      record.brandReference !== ids.brand ||
      record.storeReference !== ids.store ||
      record.diningSessionReference !== input.diningSessionReference ||
      record.cartReference !== input.cartReference ||
      record.cartVersion !== input.cartVersion
    )
      return fail();
    if (record.participantReference === input.participantReference) continue;
    if (
      record.state === "Prepared" &&
      seated !== null &&
      (record.tableReference !== seated.tableReference ||
        record.tableAssignmentVersion !== seated.tableAssignmentVersion)
    )
      continue;
    const until = diningCheckoutHeldUntil(record, input.observedAt);
    if (until !== null && (latest === null || until > latest)) latest = until;
  }
  return latest;
}
function seatedOf(value: unknown) {
  const session = parseDiningSession(value);
  return session.phase === "Active"
    ? Object.freeze({
        tableReference: session.tableReference,
        tableAssignmentVersion: session.tableAssignmentVersion,
      })
    : null;
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
        "SELECT record_json AS record,version::text AS version FROM rms_dining.dining_checkout_commitment WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND commitment_id=$4 ORDER BY dining_checkout_commitment.version",
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
  /** Dining recorded a Move of this session off the round's table since the round was prepared. */
  async function movedOff(tx: DiningTableTransaction, record: DiningCheckoutCommitment) {
    return (
      rows(
        await tx.query(
          "SELECT 1 AS moved FROM rms_dining.dining_session_move_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND source_table_id=$5 AND occurred_at>=$6::timestamptz LIMIT 1",
          [
            tenant,
            brand,
            store,
            record.diningSessionReference,
            record.tableReference,
            record.preparedAt,
          ],
        ),
      ).length === 1
    );
  }
  async function current(tx: DiningTableTransaction, record: DiningCheckoutCommitment, at: string) {
    // Match Move's table-before-session order; only Dining's own current rows are locked.
    // WP-2423 M68 lock order: the table key before the table row, as every table command.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningTable:${tenant}:${brand}:${store}:${record.tableReference}`,
    ]);
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
      return fail(
        (await movedOff(tx, record))
          ? "DINING_CHECKOUT_STORE_TABLE_MOVED"
          : "DINING_CHECKOUT_STORE_CONFLICT",
      );
    const sessions = rows(
      await tx.query(
        "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
        [tenant, brand, store, record.diningSessionReference],
      ),
    );
    // Moved away and seated back at the same table since the round was prepared (A to B to A).
    if (sessions.length === 1) {
      const seated = parseDiningSession(closed(sessions[0], ["session"]).session);
      if (
        (seated.tableReference !== record.tableReference ||
          seated.tableAssignmentVersion !== record.tableAssignmentVersion) &&
        (await movedOff(tx, record))
      )
        return fail("DINING_CHECKOUT_STORE_TABLE_MOVED");
    }
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
  /**
   * WP-2423 M04 and table-move-payment (2026-11-06): the Dining context of a round already sent,
   * wherever its party sits now. Staff may move a party to another table after it sent or paid a
   * round; the round goes with the party. The session's current table is locked before the session
   * (Move's table-before-session order). The party counts as moved when it sits at another table or
   * was seated again at the same one (A to B and back to A); it is then followed only when Dining
   * recorded a Move of this session off the round's table after the round was prepared (a party
   * leaves a table only by a recorded Move; a Merge is refused while a round is paid or being paid).
   * A table assignment number belongs to a table, so it is never compared across tables.
   */
  async function followedCurrent(
    tx: DiningTableTransaction,
    record: DiningCheckoutCommitment,
    at: string,
  ) {
    // A Move landing between the unlocked read and the locks is followed by reading again in this
    // transaction (the Move has committed once its session lock is released), at the clock's next
    // reading; after three tries the caller gets a conflict. A caller whose clock is fixed (the
    // payment admission at its request time) cannot follow a Move made after that time: it is
    // refused and the guest's next confirm, retry or resume (or the worker's next pass) follows it.
    // Each try runs under a savepoint. A try that finds the party moved again gives back its table
    // and session locks before the next try locks the table the party sits at now: a Move locks
    // its tables before the session, so holding the session while waiting for a table could
    // deadlock with a Move in progress.
    let observedAt = at;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      if (attempt > 0) observedAt = now(observedAt);
      await tx.query("SAVEPOINT dining_checkout_follow_party", []);
      const found = await followedOnce(tx, record, observedAt);
      if (found !== null) {
        await tx.query("RELEASE SAVEPOINT dining_checkout_follow_party", []);
        return found;
      }
      await tx.query("ROLLBACK TO SAVEPOINT dining_checkout_follow_party", []);
      await tx.query("RELEASE SAVEPOINT dining_checkout_follow_party", []);
    }
    return fail("DINING_CHECKOUT_STORE_CONFLICT");
  }
  async function followedOnce(
    tx: DiningTableTransaction,
    record: DiningCheckoutCommitment,
    at: string,
  ) {
    const seen = rows(
      await tx.query(
        "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
        [tenant, brand, store, record.diningSessionReference],
      ),
    );
    if (seen.length !== 1) return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const before = parseDiningSession(closed(seen[0], ["session"]).session);
    if (
      before.brandReference !== brand ||
      before.storeReference !== store ||
      before.diningSessionReference !== record.diningSessionReference
    )
      return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const tableReference = before.tableReference;
    // WP-2423 M68 lock order: the table key before the table row, as every table command.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      `DiningTable:${tenant}:${brand}:${store}:${tableReference}`,
    ]);
    const tables = rows(
      await tx.query(
        "SELECT table_snapshot AS table FROM rms_dining.dining_table WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND table_id=$4 FOR UPDATE",
        [tenant, brand, store, tableReference],
      ),
    );
    if (tables.length !== 1) return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const table = createDiningTable(closed(tables[0], ["table"]).table);
    const sessions = rows(
      await tx.query(
        "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 FOR UPDATE",
        [tenant, brand, store, record.diningSessionReference],
      ),
    );
    if (sessions.length !== 1) return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const session = closed(sessions[0], ["session"]).session;
    const locked = parseDiningSession(session);
    // Moved again between the unlocked read and the locks: read again.
    if (
      locked.tableReference !== tableReference ||
      locked.tableAssignmentVersion !== before.tableAssignmentVersion
    )
      return null;
    if (
      table.tenantReference !== tenant ||
      table.brandReference !== brand ||
      table.storeReference !== store ||
      table.tableReference !== tableReference ||
      table.activeDiningSessionReference !== record.diningSessionReference ||
      table.lifecycle !== "Published" ||
      table.operationalState !== "Available" ||
      table.observedAt > at
    )
      return fail("DINING_CHECKOUT_STORE_CONFLICT");
    const participants = rows(
      await tx.query(
        "SELECT participant_snapshot AS participant FROM rms_dining.dining_participant WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND participant_id=$5 FOR UPDATE",
        [tenant, brand, store, record.diningSessionReference, record.participantReference],
      ),
    );
    if (participants.length !== 1) return fail("DINING_CHECKOUT_STORE_CONFLICT");
    let followedMove: Readonly<{ fromTableReference: string; movedAt: string }> | null = null;
    if (
      tableReference !== record.tableReference ||
      locked.tableAssignmentVersion !== record.tableAssignmentVersion
    ) {
      const moved = rows(
        await tx.query(
          "SELECT to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS moved_at FROM rms_dining.dining_session_move_operation WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4 AND source_table_id=$5 AND occurred_at>=$6::timestamptz ORDER BY occurred_at LIMIT 1",
          [
            tenant,
            brand,
            store,
            record.diningSessionReference,
            record.tableReference,
            record.preparedAt,
          ],
        ),
      );
      if (moved.length !== 1) return fail("DINING_CHECKOUT_STORE_CONFLICT");
      followedMove = Object.freeze({
        fromTableReference: record.tableReference,
        movedAt: parseDiningInstant(closed(moved[0], ["moved_at"]).moved_at),
      });
    }
    return {
      session,
      participant: closed(participants[0], ["participant"]).participant,
      followedMove,
    };
  }
  /** One locked latest commitment and its parsed Dining context (shared by the current reads). */
  async function withFacts<T>(
    referenceValue: unknown,
    locate: (
      tx: DiningTableTransaction,
      record: DiningCheckoutCommitment,
      at: string,
    ) => Promise<{ readonly session: unknown; readonly participant: unknown }>,
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
        const context = await locate(tx, commitment, observedAt);
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
      return withFacts(referenceValue, current, work);
    },
    /**
     * Paid-round history only (WP-2423 M04): the party may have moved to another table since it
     * paid. Never permission to prepare, seal or start a payment (`withCurrentFacts` holds a round
     * to the table it is being sent from; `withPaymentPending` checks payment eligibility).
     */
    async withPaidFacts<T>(
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
      return withFacts(referenceValue, followedCurrent, work);
    },
    /**
     * Current payment eligibility with commitment and Dining context locked through caller work.
     * WP-2423 (table-move-payment): a party staff moved keeps paying the rounds it sent before the
     * move, for the amount they were sent at; closing the table or the participant leaving stops it.
     */
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
          const context = await followedCurrent(tx, record, observedAt);
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
              // One checkout of a table Cart version at a time: the table and Session rows are
              // locked above, so a concurrent preparation by another participant waits and sees it.
              const held = await heldUntil(
                tx,
                { tenant, brand, store },
                {
                  diningSessionReference: record.diningSessionReference,
                  cartReference: record.cartReference,
                  cartVersion: record.cartVersion,
                  participantReference: record.participantReference,
                  observedAt,
                },
                // The locked current session: the new round is prepared at its table.
                seatedOf(context.session),
              );
              if (held !== null) throw new DiningCheckoutHeldError(parseDiningInstant(held));
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

/**
 * DEC-DINING-ANY-PARTICIPANT-SUBMIT public read: whether another participant's checkout currently
 * holds this table Cart version, and until when. Advisory for Cart edits and quotes (the
 * commitment preparation re-checks under its locks). Grants nothing and reads only Dining facts.
 */
export function createPostgresDiningCheckoutHoldSource(
  runner: DiningTableTransactionRunner,
  scopeInput: DiningTableStoreScope,
) {
  const scope = closed(scopeInput, ["tenantReference", "brandReference", "storeReference"]);
  const ids = Object.freeze({
    tenant: parseDiningReference(scope.tenantReference),
    brand: parseDiningReference(scope.brandReference),
    store: parseDiningReference(scope.storeReference),
  });
  return Object.freeze({
    async read(value: unknown): Promise<Readonly<{ heldUntil: string }> | null> {
      try {
        const raw = closed(captureSessionData(value), [
          "diningSessionReference",
          "cartReference",
          "cartVersion",
          "participantReference",
          "observedAt",
        ]);
        if (
          typeof raw.cartVersion !== "number" ||
          !Number.isSafeInteger(raw.cartVersion) ||
          raw.cartVersion < 1
        )
          return fail("DINING_CHECKOUT_STORE_INVALID");
        const input = Object.freeze({
          diningSessionReference: parseDiningReference(raw.diningSessionReference),
          cartReference: parseDiningReference(raw.cartReference),
          cartVersion: raw.cartVersion,
          participantReference: parseDiningReference(raw.participantReference),
          observedAt: parseDiningInstant(raw.observedAt),
        });
        const held = await runner.run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
            [ids.brand, ids.store],
          );
          const sessions = rows(
            await tx.query(
              "SELECT session_snapshot AS session FROM rms_dining.dining_session WHERE tenant_id=$1 AND brand_id=$2 AND store_id=$3 AND session_id=$4",
              [ids.tenant, ids.brand, ids.store, input.diningSessionReference],
            ),
          );
          return heldUntil(
            tx,
            ids,
            input,
            sessions.length === 1 ? seatedOf(closed(sessions[0], ["session"]).session) : null,
          );
        });
        return held === null ? null : Object.freeze({ heldUntil: held });
      } catch (error) {
        return normalize(error);
      }
    },
  });
}
