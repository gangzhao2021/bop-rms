import { appendAuditRecordInTransaction, type AuditTransaction } from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";

import {
  CardMachinePaymentError,
  cardMachinePaymentTakenMinor,
  createCardMachinePaymentEnvelope,
  parseCardMachinePaymentRecord,
  parseCardMachineRefundRecord,
  reviveCardMachinePreparation,
  serializeCardMachinePreparation,
  type CardMachinePaymentErrorCode,
  type CardMachinePaymentRecord,
  type CardMachineRefundRecord,
} from "../../application/card-machine-payment.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";

const fail = (code: CardMachinePaymentErrorCode = "CARD_MACHINE_UNAVAILABLE"): never => {
  throw new CardMachinePaymentError(code);
};
const instant = (column: string) =>
  `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const paymentColumns = `jsonb_build_object(
 'tenantReference',p.tenant_id,'brandReference',p.brand_id,'storeReference',p.store_id,
 'cardMachinePaymentReference',p.card_machine_payment_id,'paymentIntentReference',p.payment_intent_id,
 'paymentAttemptReference',p.payment_attempt_id,'paymentOperationReference',p.payment_operation_id,
 'operationReference',p.operation_id,'intentDigest',p.intent_digest,'orderReference',p.order_id,
 'orderBatchReference',p.order_batch_id,'submissionReference',p.submission_id,
 'preparation',p.preparation_json,'environment',p.payment_environment,'slipReference',p.slip_reference,
 'recordingReason',p.recording_reason,'takenAt',${instant("p.taken_at")},
 'recordedAt',${instant("p.recorded_at")},'actorReference',p.actor_id,'eventReference',p.event_id,
 'auditReference',p.audit_id,'tender',p.tender,'roundingMinor',p.rounding_minor::text,
 'tenderedMinor',p.tendered_minor::text,'changeMinor',p.change_minor::text) AS record`;
const selectPayment = `SELECT ${paymentColumns} FROM rms_payment.card_machine_payment p
 WHERE p.brand_id=$1 AND p.store_id=$2`;
const refundColumns = `jsonb_build_object(
 'tenantReference',r.tenant_id,'brandReference',r.brand_id,'storeReference',r.store_id,
 'cardMachineRefundReference',r.card_machine_refund_id,'cardMachinePaymentReference',r.card_machine_payment_id,
 'orderReference',r.order_id,'operationReference',r.operation_id,'intentDigest',r.intent_digest,
 'sourceKind',r.source_kind,'sourceReference',r.source_id,'amountMinor',r.amount_minor::text,
 'slipReference',r.slip_reference,'refundedAt',${instant("r.refunded_at")},
 'recordedAt',${instant("r.recorded_at")},'actorReference',r.actor_id,'auditReference',r.audit_id) AS record`;
const selectRefund = `SELECT ${refundColumns} FROM rms_payment.card_machine_refund r
 WHERE r.brand_id=$1 AND r.store_id=$2`;

function rows(result: unknown): readonly Record<string, unknown>[] {
  const value = (result as { rows?: unknown } | null)?.rows;
  if (!Array.isArray(value)) return fail();
  return value as Record<string, unknown>[];
}
function count(result: unknown): number {
  const value = (result as { rowCount?: unknown } | null)?.rowCount;
  if (typeof value !== "number") return fail();
  return value;
}
const minor = (value: unknown) => {
  if (typeof value !== "string" || !/^-?(0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
  return BigInt(value);
};
function paymentFrom(row: Record<string, unknown>): CardMachinePaymentRecord {
  const raw = row.record as Record<string, unknown>;
  if (raw === null || typeof raw !== "object") return fail();
  const { tender, roundingMinor, tenderedMinor, changeMinor, ...rest } = raw;
  // WP-2423 M52: a counter payment taken in cash carries its rounding, tender and change.
  if (tender !== "CardMachine" && tender !== "Cash") return fail();
  if (tender === "CardMachine" && (roundingMinor !== "0" || tenderedMinor !== null)) return fail();
  return parseCardMachinePaymentRecord({
    ...rest,
    preparation: reviveCardMachinePreparation(raw.preparation),
    ...(tender === "Cash"
      ? {
          cash: {
            roundingMinor: minor(roundingMinor),
            tenderedMinor: minor(tenderedMinor),
            changeMinor: minor(changeMinor),
          },
        }
      : {}),
  });
}
function refundFrom(row: Record<string, unknown>): CardMachineRefundRecord {
  const raw = row.record as Record<string, unknown>;
  if (raw === null || typeof raw !== "object" || typeof raw.amountMinor !== "string") return fail();
  return parseCardMachineRefundRecord({ ...raw, amountMinor: BigInt(raw.amountMinor) });
}
function samePayment(left: CardMachinePaymentRecord, right: CardMachinePaymentRecord) {
  return (
    left.operationReference === right.operationReference &&
    left.intentDigest === right.intentDigest &&
    left.orderReference === right.orderReference &&
    left.orderBatchReference === right.orderBatchReference &&
    left.actorReference === right.actorReference &&
    left.cash?.tenderedMinor === right.cash?.tenderedMinor &&
    left.cash?.roundingMinor === right.cash?.roundingMinor
  );
}

/**
 * WP-2423 M160: whether the Store has a payment taken before an instant: an online payment
 * prepared, a card-machine payment taken at the counter, or a table paid (card machine, cash, or
 * a guest's phone payment once captured, which is recorded as the table's settlement). One
 * entered after an outage carries the earlier time it was taken. The sales reports and the
 * settlement begin at the Store's first business day; a payment before that day would fall
 * outside every day, so the reads refuse instead of leaving it out. Staff entry refuses such a
 * time (merchant card-machine payment, table checkout), so only a record made outside the
 * product can trip this. Read in the caller's transaction, under its Store scope.
 */
export async function readStorePaymentTakenBefore(
  tx: { query(sql: string, values: readonly unknown[]): Promise<unknown> },
  scope: { readonly brandReference: string; readonly storeReference: string },
  before: string,
): Promise<boolean> {
  const brandReference = parsePaymentReference(scope.brandReference);
  const storeReference = parsePaymentReference(scope.storeReference);
  const at = parsePaymentInstant(before);
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    brandReference,
    storeReference,
  ]);
  // A card-machine or table payment is recorded at most 72 hours after it was taken (table
  // checks), so each is found from its recorded time by index.
  const found = rows(
    await tx.query(
      "SELECT EXISTS (SELECT 1 FROM rms_payment.payment_intent WHERE brand_id=$1 AND store_id=$2 AND prepared_at < $3) OR EXISTS (SELECT 1 FROM rms_payment.card_machine_payment WHERE brand_id=$1 AND store_id=$2 AND recorded_at < $3::timestamptz + interval '72 hours' AND taken_at < $3) OR EXISTS (SELECT 1 FROM rms_payment.dining_table_settlement WHERE brand_id=$1 AND store_id=$2 AND recorded_at < $3::timestamptz + interval '72 hours' AND taken_at < $3) AS found",
      [brandReference, storeReference, at],
    ),
  );
  if (found.length !== 1 || typeof found[0]?.found !== "boolean") return fail();
  return found[0].found;
}

/**
 * WP-2423 Q7: Payment-owned card-machine payments and refunds. The caller holds the transaction,
 * authorizes the staff member and the Store, and supplies server-resolved facts only.
 */
export function createPostgresCardMachinePaymentStore(options: {
  /** The Tenant is required to record or summarize; owner reads by Brand and Store alone. */
  scope: { tenantReference?: string; brandReference: string; storeReference: string };
  authorize(transaction: AuditTransaction, input: { orderReference: string }): Promise<boolean>;
}) {
  const tenantScope =
    options.scope.tenantReference === undefined
      ? null
      : String(parsePaymentReference(options.scope.tenantReference));
  const requireTenant = () => tenantScope ?? fail("CARD_MACHINE_PERMISSION_DENIED");
  const brand = String(parsePaymentReference(options.scope.brandReference));
  const store = String(parsePaymentReference(options.scope.storeReference));
  const context = (tx: AuditTransaction) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  const allowed = async (tx: AuditTransaction, orderReference: string) => {
    if ((await options.authorize(tx, { orderReference })) !== true)
      return fail("CARD_MACHINE_PERMISSION_DENIED");
  };
  const one = async (
    tx: AuditTransaction,
    where: string,
    values: readonly unknown[],
  ): Promise<CardMachinePaymentRecord | null> => {
    await context(tx);
    const found = rows(await tx.query(`${selectPayment} AND ${where}`, [brand, store, ...values]));
    if (found.length > 1) return fail();
    if (found.length === 0) return null;
    const record = paymentFrom(found[0] as Record<string, unknown>);
    if (record.brandReference !== brand || record.storeReference !== store) return fail();
    if (tenantScope !== null && record.tenantReference !== tenantScope) return fail();
    await allowed(tx, record.orderReference);
    return record;
  };
  const refundsOf = async (tx: AuditTransaction, payment: string) => {
    await context(tx);
    return rows(
      await tx.query(
        `${selectRefund} AND r.card_machine_payment_id=$3 ORDER BY r.recorded_at,r.card_machine_refund_id`,
        [brand, store, payment],
      ),
    ).map((row) => refundFrom(row));
  };
  /**
   * DEC-PAPER-SEND-IDEMPOTENT (b11): a paper payment of the Store recorded with this slip reference
   * (spaces and letter case aside) and taken within the back-entry window of `takenAt`, other
   * than one of `exceptBatch`. Only the order it is recorded with is named, so the caller (already
   * allowed at this Store) can tell staff where it is. The slip's lock is held to the end of the
   * caller's transaction, so two sends of the same slip never both record it.
   */
  const findPaperSlip = async (
    tx: AuditTransaction,
    slipReference: string,
    takenAt: string,
    exceptBatch: string | null,
  ) => {
    const slip = slipReference.replace(/\s+/gu, "").toUpperCase();
    if (slip.length === 0) return null;
    await context(tx);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "CardMachinePaperSlip:" + brand + ":" + store + ":" + slip,
    ]);
    const found = rows(
      await tx.query(
        `SELECT p.order_id::text AS "orderReference",p.order_batch_id::text AS "orderBatchReference",
 p.operation_id::text AS "operationReference" FROM rms_payment.card_machine_payment p
 WHERE p.brand_id=$1 AND p.store_id=$2 AND p.recording_reason='RecordedAfterOutage'
  AND p.slip_reference IS NOT NULL AND upper(regexp_replace(p.slip_reference,'\\s+','','g'))=$3
  AND p.recorded_at > $4::timestamptz - interval '72 hours'
  AND p.taken_at > $4::timestamptz - interval '72 hours' AND p.taken_at < $4::timestamptz + interval '72 hours'
  AND ($5::uuid IS NULL OR p.order_batch_id<>$5::uuid)
 ORDER BY p.recorded_at,p.card_machine_payment_id LIMIT 1`,
        [brand, store, slip, String(parsePaymentInstant(takenAt)), exceptBatch],
      ),
    );
    const row = found[0];
    if (row === undefined) return null;
    return Object.freeze({
      orderReference: String(parsePaymentReference(row.orderReference)),
      orderBatchReference: String(parsePaymentReference(row.orderBatchReference)),
      operationReference: String(parsePaymentReference(row.operationReference)),
    });
  };
  return Object.freeze({
    findPaperSlip: (tx: AuditTransaction, slipReference: string, takenAt: string) =>
      findPaperSlip(tx, slipReference, takenAt, null),
    loadByOperation: (tx: AuditTransaction, operationReference: string) =>
      one(tx, "p.operation_id=$3", [String(parsePaymentReference(operationReference))]),
    loadByPaymentOperation: (tx: AuditTransaction, paymentOperationReference: string) =>
      one(tx, "p.payment_operation_id=$3", [
        String(parsePaymentReference(paymentOperationReference)),
      ]),
    loadByIntent: (tx: AuditTransaction, paymentIntentReference: string) =>
      one(tx, "p.payment_intent_id=$3", [String(parsePaymentReference(paymentIntentReference))]),
    /**
     * WP-2423 M127: the batch's payment as recording it would see it, with the same batch lock
     * recording takes, held to the end of the caller's transaction. A cancellation of the unpaid
     * order reads this before it commits, so a payment and the cancellation never both succeed.
     */
    async lockAndLoadByBatch(
      tx: AuditTransaction,
      orderReference: string,
      orderBatchReference: string,
    ): Promise<CardMachinePaymentRecord | null> {
      const order = String(parsePaymentReference(orderReference));
      const batch = String(parsePaymentReference(orderBatchReference));
      await allowed(tx, order);
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CardMachineBatch:" + brand + ":" + store + ":" + batch,
      ]);
      return one(tx, "p.order_id=$3 AND p.order_batch_id=$4", [order, batch]);
    },
    loadByBatch: (tx: AuditTransaction, orderReference: string, orderBatchReference: string) =>
      one(tx, "p.order_id=$3 AND p.order_batch_id=$4", [
        String(parsePaymentReference(orderReference)),
        String(parsePaymentReference(orderBatchReference)),
      ]),
    /**
     * WP-2423: the card-machine payments of these Order batches, keyed by batch, in one read (a
     * screen listing many rounds asks once, not once per round).
     */
    async listByBatches(
      tx: AuditTransaction,
      batches: readonly { orderReference: string; orderBatchReference: string }[],
    ): Promise<ReadonlyMap<string, CardMachinePaymentRecord>> {
      const result = new Map<string, CardMachinePaymentRecord>();
      if (batches.length === 0) return result;
      if (batches.length > 1000) return fail();
      const orders = batches.map((b) => String(parsePaymentReference(b.orderReference)));
      const ids = batches.map((b) => String(parsePaymentReference(b.orderBatchReference)));
      for (const order of new Set(orders)) await allowed(tx, order);
      await context(tx);
      const found = rows(
        await tx.query(
          `${selectPayment} AND (p.order_id,p.order_batch_id) IN
 (SELECT q.order_id,q.order_batch_id FROM unnest($3::uuid[],$4::uuid[]) AS q(order_id,order_batch_id))`,
          [brand, store, orders, ids],
        ),
      );
      for (const row of found) {
        const record = paymentFrom(row);
        if (record.brandReference !== brand || record.storeReference !== store) return fail();
        if (tenantScope !== null && record.tenantReference !== tenantScope) return fail();
        if (result.has(record.orderBatchReference)) return fail();
        result.set(String(record.orderBatchReference), record);
      }
      return result;
    },
    /**
     * WP-2423: every card-machine payment of these Orders with its refunds (oldest first), keyed
     * by Order, in two reads whatever the number of Orders.
     */
    async listByOrders(tx: AuditTransaction, orderReferences: readonly string[]) {
      const result = new Map<
        string,
        { payment: CardMachinePaymentRecord; refunds: CardMachineRefundRecord[] }[]
      >();
      if (orderReferences.length === 0) return result;
      if (orderReferences.length > 1000) return fail();
      const orders = [...new Set(orderReferences.map((o) => String(parsePaymentReference(o))))];
      for (const order of orders) await allowed(tx, order);
      await context(tx);
      const payments = rows(
        await tx.query(
          `${selectPayment} AND p.order_id=ANY($3::uuid[]) ORDER BY p.recorded_at,p.order_batch_id`,
          [brand, store, orders],
        ),
      ).map((row) => paymentFrom(row));
      const byPayment = new Map<string, CardMachineRefundRecord[]>();
      for (const payment of payments) {
        if (payment.brandReference !== brand || payment.storeReference !== store) return fail();
        if (tenantScope !== null && payment.tenantReference !== tenantScope) return fail();
        const refunds: CardMachineRefundRecord[] = [];
        byPayment.set(String(payment.cardMachinePaymentReference), refunds);
        const order = String(payment.orderReference);
        result.set(order, [...(result.get(order) ?? []), { payment, refunds }]);
      }
      if (payments.length > 0)
        for (const refund of rows(
          await tx.query(
            `${selectRefund} AND r.card_machine_payment_id=ANY($3::uuid[])
 ORDER BY r.recorded_at,r.card_machine_refund_id`,
            [brand, store, [...byPayment.keys()]],
          ),
        ).map((row) => refundFrom(row)))
          (byPayment.get(String(refund.cardMachinePaymentReference)) ?? fail()).push(refund);
      return result;
    },
    /** Every card-machine payment of an Order with its refunds, oldest first. */
    async listByOrder(tx: AuditTransaction, orderReference: string) {
      const order = String(parsePaymentReference(orderReference));
      await allowed(tx, order);
      await context(tx);
      const payments = rows(
        await tx.query(
          `${selectPayment} AND p.order_id=$3 ORDER BY p.recorded_at,p.order_batch_id`,
          [brand, store, order],
        ),
      ).map((row) => paymentFrom(row));
      const result = [];
      for (const payment of payments) {
        if (tenantScope !== null && payment.tenantReference !== tenantScope) return fail();
        result.push(
          Object.freeze({
            payment,
            refunds: await refundsOf(tx, payment.cardMachinePaymentReference),
          }),
        );
      }
      return Object.freeze(result);
    },
    async loadRefundByOperation(tx: AuditTransaction, operationReference: string) {
      await context(tx);
      const found = rows(
        await tx.query(`${selectRefund} AND r.operation_id=$3`, [
          brand,
          store,
          String(parsePaymentReference(operationReference)),
        ]),
      );
      if (found.length === 0) return null;
      const refund = refundFrom(found[0] as Record<string, unknown>);
      await allowed(tx, refund.orderReference);
      return refund;
    },
    async loadRefundBySource(
      tx: AuditTransaction,
      sourceKind: CardMachineRefundRecord["sourceKind"],
      sourceReference: string,
    ) {
      await context(tx);
      const found = rows(
        await tx.query(`${selectRefund} AND r.source_kind=$3 AND r.source_id=$4`, [
          brand,
          store,
          sourceKind,
          String(parsePaymentReference(sourceReference)),
        ]),
      );
      if (found.length === 0) return null;
      const refund = refundFrom(found[0] as Record<string, unknown>);
      await allowed(tx, refund.orderReference);
      return refund;
    },
    /**
     * Records a payment taken on the card machine with its PaymentSucceeded event and audit in the
     * caller's transaction. The same operation replays its original record; a different payment of
     * the same Batch is refused.
     */
    async record(tx: AuditTransaction, value: CardMachinePaymentRecord) {
      const record = parseCardMachinePaymentRecord(value);
      const tenant = requireTenant();
      if (
        record.tenantReference !== tenant ||
        record.brandReference !== brand ||
        record.storeReference !== store
      )
        return fail("CARD_MACHINE_PERMISSION_DENIED");
      await allowed(tx, record.orderReference);
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CardMachineBatch:" + brand + ":" + store + ":" + record.orderBatchReference,
      ]);
      const prior = await one(tx, "p.operation_id=$3", [record.operationReference]);
      if (prior !== null) {
        if (!samePayment(prior, record)) return fail("CARD_MACHINE_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, record: prior });
      }
      const paid = await one(tx, "p.order_id=$3 AND p.order_batch_id=$4", [
        record.orderReference,
        record.orderBatchReference,
      ]);
      if (paid !== null) return fail("CARD_MACHINE_ALREADY_PAID");
      // DEC-PAPER-SEND-IDEMPOTENT (b11): a paper slip is recorded once, on one order or round.
      if (
        record.recordingReason === "RecordedAfterOutage" &&
        record.slipReference !== null &&
        (await findPaperSlip(
          tx,
          record.slipReference,
          record.takenAt,
          record.orderBatchReference,
        )) !== null
      )
        return fail("CARD_MACHINE_SLIP_ALREADY_RECORDED");
      const event = createCardMachinePaymentEnvelope(record);
      count(
        await tx.query(
          `INSERT INTO rms_payment.card_machine_payment (tenant_id,brand_id,store_id,card_machine_payment_id,
 payment_intent_id,payment_attempt_id,payment_operation_id,operation_id,intent_digest,order_id,order_batch_id,
 submission_id,preparation_json,order_allocation_minor,tip_minor,total_minor,currency_code,payment_environment,
 slip_reference,recording_reason,taken_at,recorded_at,actor_id,event_id,audit_id,
 tender,rounding_minor,tendered_minor,change_minor)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'CAD',$17,$18,$19,$20,$21,$22,$23,$24,
 $25,$26,$27,$28)`,
          [
            tenant,
            brand,
            store,
            record.cardMachinePaymentReference,
            record.paymentIntentReference,
            record.paymentAttemptReference,
            record.paymentOperationReference,
            record.operationReference,
            record.intentDigest,
            record.orderReference,
            record.orderBatchReference,
            record.submissionReference,
            serializeCardMachinePreparation(record.preparation),
            record.preparation.orderAllocation.amountMinor.toString(),
            record.preparation.tip.amountMinor.toString(),
            record.preparation.total.amountMinor.toString(),
            record.environment,
            record.slipReference,
            record.recordingReason,
            record.takenAt,
            record.recordedAt,
            record.actorReference,
            record.eventReference,
            record.auditReference,
            record.cash === undefined ? "CardMachine" : "Cash",
            (record.cash?.roundingMinor ?? 0n).toString(),
            record.cash?.tenderedMinor.toString() ?? null,
            record.cash?.changeMinor.toString() ?? null,
          ],
        ),
      );
      // WP-2423 M52: every cash sale at the counter is recorded and attributed like a card one.
      await appendAuditRecordInTransaction(tx, {
        auditId: record.auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: record.actorReference },
        actionCode:
          record.cash === undefined
            ? "PAYMENT_CARD_MACHINE_RECORDED"
            : "PAYMENT_COUNTER_CASH_RECORDED",
        targetType: "PaymentIntent",
        targetId: record.paymentIntentReference,
        afterSummary: {
          amountMinor: record.preparation.total.amountMinor.toString(),
          recordingReason: record.recordingReason,
          ...(record.cash === undefined
            ? {}
            : {
                roundingMinor: record.cash.roundingMinor.toString(),
                cashTakenMinor: cardMachinePaymentTakenMinor(record).toString(),
              }),
        },
        reasonCode:
          record.recordingReason !== "AtCounter"
            ? "RECORDED_AFTER_OUTAGE"
            : record.cash === undefined
              ? "CARD_MACHINE_APPROVED"
              : "CASH_RECEIVED",
        correlationId: record.paymentOperationReference,
        occurredAt: record.recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      await appendEventInTransaction(
        { query: async (sql, values) => ({ rowCount: count(await tx.query(sql, values)) }) },
        event,
      );
      const saved = await one(tx, "p.operation_id=$3", [record.operationReference]);
      if (saved === null || !samePayment(saved, record)) return fail();
      return Object.freeze({ status: "Created" as const, record: saved });
    },
    refunds: refundsOf,
    /** Records a refund the staff member made on the card machine; never calls a Provider. */
    async recordRefund(tx: AuditTransaction, value: CardMachineRefundRecord) {
      const refund = parseCardMachineRefundRecord(value);
      const tenant = requireTenant();
      if (
        refund.tenantReference !== tenant ||
        refund.brandReference !== brand ||
        refund.storeReference !== store
      )
        return fail("CARD_MACHINE_PERMISSION_DENIED");
      await allowed(tx, refund.orderReference);
      await context(tx);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "CardMachineRefund:" + brand + ":" + store + ":" + refund.cardMachinePaymentReference,
      ]);
      const prior = rows(
        await tx.query(
          `${selectRefund} AND (r.operation_id=$3 OR (r.source_kind=$4 AND r.source_id=$5))`,
          [brand, store, refund.operationReference, refund.sourceKind, refund.sourceReference],
        ),
      ).map((row) => refundFrom(row));
      if (prior.length > 0) {
        const same = prior[0] as CardMachineRefundRecord;
        if (
          prior.length !== 1 ||
          same.operationReference !== refund.operationReference ||
          same.intentDigest !== refund.intentDigest ||
          same.actorReference !== refund.actorReference
        )
          return fail("CARD_MACHINE_IDEMPOTENCY_CONFLICT");
        return Object.freeze({ status: "AlreadyRecorded" as const, refund: same });
      }
      const payment = await one(tx, "p.card_machine_payment_id=$3", [
        refund.cardMachinePaymentReference,
      ]);
      if (payment === null || payment.orderReference !== refund.orderReference)
        return fail("CARD_MACHINE_NOT_FOUND");
      if (refund.refundedAt < payment.takenAt) return fail("CARD_MACHINE_INPUT_INVALID");
      // WP-2423 M52/M131: cash goes back in whole nickels, with no card-machine slip.
      if (
        payment.cash !== undefined &&
        (refund.amountMinor % 5n !== 0n || refund.slipReference !== null)
      )
        return fail("CARD_MACHINE_INPUT_INVALID");
      const refunded = (await refundsOf(tx, payment.cardMachinePaymentReference)).reduce(
        (sum, item) => sum + item.amountMinor,
        0n,
      );
      if (refunded + refund.amountMinor > cardMachinePaymentTakenMinor(payment))
        return fail("CARD_MACHINE_REFUND_EXCEEDS_PAYMENT");
      count(
        await tx.query(
          `INSERT INTO rms_payment.card_machine_refund (tenant_id,brand_id,store_id,card_machine_refund_id,
 card_machine_payment_id,order_id,operation_id,intent_digest,source_kind,source_id,amount_minor,currency_code,
 slip_reference,refunded_at,recorded_at,actor_id,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CAD',$12,$13,$14,$15,$16)`,
          [
            tenant,
            brand,
            store,
            refund.cardMachineRefundReference,
            refund.cardMachinePaymentReference,
            refund.orderReference,
            refund.operationReference,
            refund.intentDigest,
            refund.sourceKind,
            refund.sourceReference,
            refund.amountMinor.toString(),
            refund.slipReference,
            refund.refundedAt,
            refund.recordedAt,
            refund.actorReference,
            refund.auditReference,
          ],
        ),
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: refund.auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: refund.actorReference },
        actionCode: "PAYMENT_CARD_MACHINE_REFUND_RECORDED",
        targetType: "PaymentIntent",
        targetId: payment.paymentIntentReference,
        afterSummary: {
          amountMinor: refund.amountMinor.toString(),
          sourceKind: refund.sourceKind,
          ...(payment.cash === undefined ? {} : { tender: "Cash" }),
        },
        reasonCode: payment.cash === undefined ? "REFUNDED_ON_CARD_MACHINE" : "CASH_GIVEN_BACK",
        correlationId: refund.operationReference,
        occurredAt: refund.recordedAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      });
      const saved = (await refundsOf(tx, payment.cardMachinePaymentReference)).find(
        (item) => item.cardMachineRefundReference === refund.cardMachineRefundReference,
      );
      if (saved === undefined || saved.amountMinor !== refund.amountMinor) return fail();
      return Object.freeze({ status: "Created" as const, refund: saved });
    },
    /**
     * Card-machine takings and refunds recorded in [from, to) (the Store's business-day window), for
     * the day-end page; kept apart from online (Provider) takings so staff can match the machine's
     * own batch total.
     */
    async summarize(tx: AuditTransaction, window: { from: string; to: string }) {
      const from = parsePaymentInstant(window.from),
        to = parsePaymentInstant(window.to);
      if (to <= from) return fail("CARD_MACHINE_INPUT_INVALID");
      const tenant = requireTenant();
      await context(tx);
      // WP-2423 M52: by how the counter took it — the card machine (matched against the machine's
      // own batch total) and cash (in the drawer, rounding included).
      const payments = rows(
        await tx.query(
          `SELECT tender,count(*)::text AS count,COALESCE(sum(total_minor+rounding_minor),0)::text AS total,
 COALESCE(sum(tip_minor),0)::text AS tip,COALESCE(sum(rounding_minor),0)::text AS rounding,
 count(*) FILTER (WHERE recording_reason='RecordedAfterOutage')::text AS back_entered
 FROM rms_payment.card_machine_payment WHERE brand_id=$1 AND store_id=$2 AND tenant_id=$3
 AND taken_at>=$4::timestamptz AND taken_at<$5::timestamptz GROUP BY tender`,
          [brand, store, tenant, from, to],
        ),
      );
      const refunds = rows(
        await tx.query(
          `SELECT p.tender,count(*)::text AS count,COALESCE(sum(r.amount_minor),0)::text AS total
 FROM rms_payment.card_machine_refund r JOIN rms_payment.card_machine_payment p
 ON p.brand_id=r.brand_id AND p.store_id=r.store_id AND p.card_machine_payment_id=r.card_machine_payment_id
 WHERE r.brand_id=$1 AND r.store_id=$2 AND r.tenant_id=$3
 AND r.refunded_at>=$4::timestamptz AND r.refunded_at<$5::timestamptz GROUP BY p.tender`,
          [brand, store, tenant, from, to],
        ),
      );
      const integer = (value: unknown) => {
        if (typeof value !== "string" || !/^-?(0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
        return BigInt(value);
      };
      const of = (tender: "CardMachine" | "Cash") => {
        const taken = payments.filter((row) => row.tender === tender);
        const back = refunds.filter((row) => row.tender === tender);
        if (taken.length > 1 || back.length > 1) return fail();
        const [paid] = taken,
          [given] = back;
        return Object.freeze({
          paymentCount: paid === undefined ? 0 : Number(integer(paid.count)),
          backEnteredCount: paid === undefined ? 0 : Number(integer(paid.back_entered)),
          takenMinor: paid === undefined ? 0n : integer(paid.total),
          tipMinor: paid === undefined ? 0n : integer(paid.tip),
          roundingMinor: paid === undefined ? 0n : integer(paid.rounding),
          refundCount: given === undefined ? 0 : Number(integer(given.count)),
          refundedMinor: given === undefined ? 0n : integer(given.total),
        });
      };
      if (
        payments.some((row) => row.tender !== "CardMachine" && row.tender !== "Cash") ||
        refunds.some((row) => row.tender !== "CardMachine" && row.tender !== "Cash")
      )
        return fail();
      const card = of("CardMachine");
      return Object.freeze({
        paymentCount: card.paymentCount,
        backEnteredCount: card.backEnteredCount,
        takenMinor: card.takenMinor,
        tipMinor: card.tipMinor,
        refundCount: card.refundCount,
        refundedMinor: card.refundedMinor,
        /** WP-2423 M52: counter orders paid in cash (taken includes the cash rounding). */
        cash: of("Cash"),
      });
    },
    /**
     * WP-2423 Q14 (store reports): the payments taken in the window and every refund made before its
     * end, with the payments those refunds belong to — the same `taken_at`/`refunded_at` rules as
     * `summarize`, so a report built from these records agrees with the day-end settlement.
     */
    async listWindow(tx: AuditTransaction, window: { from: string; to: string }) {
      const from = parsePaymentInstant(window.from),
        to = parsePaymentInstant(window.to);
      if (to <= from) return fail("CARD_MACHINE_INPUT_INVALID");
      const tenant = requireTenant();
      await context(tx);
      const payments = rows(
        await tx.query(
          `${selectPayment} AND p.tenant_id=$3 AND ((p.taken_at>=$4::timestamptz AND p.taken_at<$5::timestamptz)
 OR p.card_machine_payment_id IN (SELECT x.card_machine_payment_id FROM rms_payment.card_machine_refund x
 WHERE x.brand_id=$1 AND x.store_id=$2 AND x.tenant_id=$3 AND x.refunded_at<$5::timestamptz))
 ORDER BY p.taken_at,p.card_machine_payment_id LIMIT 100001`,
          [brand, store, tenant, from, to],
        ),
      ).map((row) => paymentFrom(row));
      const refunds = rows(
        await tx.query(
          `${selectRefund} AND r.tenant_id=$3 AND r.refunded_at<$4::timestamptz
 ORDER BY r.refunded_at,r.card_machine_refund_id LIMIT 100001`,
          [brand, store, tenant, to],
        ),
      ).map((row) => refundFrom(row));
      if (payments.length > 100000 || refunds.length > 100000) return fail();
      const known = new Set(payments.map((payment) => payment.cardMachinePaymentReference));
      for (const payment of payments)
        if (
          payment.tenantReference !== tenant ||
          payment.brandReference !== brand ||
          payment.storeReference !== store
        )
          return fail();
      for (const refund of refunds)
        if (
          refund.tenantReference !== tenant ||
          !known.has(refund.cardMachinePaymentReference) ||
          refund.refundedAt >= to
        )
          return fail();
      return Object.freeze({ payments: Object.freeze(payments), refunds: Object.freeze(refunds) });
    },
  });
}
