import { appendAuditRecordInTransaction, type AuditTransaction } from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";

import {
  CardMachinePaymentError,
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
 'auditReference',p.audit_id) AS record`;
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
function paymentFrom(row: Record<string, unknown>): CardMachinePaymentRecord {
  const raw = row.record as Record<string, unknown>;
  if (raw === null || typeof raw !== "object") return fail();
  return parseCardMachinePaymentRecord({
    ...raw,
    preparation: reviveCardMachinePreparation(raw.preparation),
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
    left.actorReference === right.actorReference
  );
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
  return Object.freeze({
    loadByOperation: (tx: AuditTransaction, operationReference: string) =>
      one(tx, "p.operation_id=$3", [String(parsePaymentReference(operationReference))]),
    loadByPaymentOperation: (tx: AuditTransaction, paymentOperationReference: string) =>
      one(tx, "p.payment_operation_id=$3", [
        String(parsePaymentReference(paymentOperationReference)),
      ]),
    loadByIntent: (tx: AuditTransaction, paymentIntentReference: string) =>
      one(tx, "p.payment_intent_id=$3", [String(parsePaymentReference(paymentIntentReference))]),
    loadByBatch: (tx: AuditTransaction, orderReference: string, orderBatchReference: string) =>
      one(tx, "p.order_id=$3 AND p.order_batch_id=$4", [
        String(parsePaymentReference(orderReference)),
        String(parsePaymentReference(orderBatchReference)),
      ]),
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
      const event = createCardMachinePaymentEnvelope(record);
      count(
        await tx.query(
          `INSERT INTO rms_payment.card_machine_payment (tenant_id,brand_id,store_id,card_machine_payment_id,
 payment_intent_id,payment_attempt_id,payment_operation_id,operation_id,intent_digest,order_id,order_batch_id,
 submission_id,preparation_json,order_allocation_minor,tip_minor,total_minor,currency_code,payment_environment,
 slip_reference,recording_reason,taken_at,recorded_at,actor_id,event_id,audit_id)
 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,'CAD',$17,$18,$19,$20,$21,$22,$23,$24)`,
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
          ],
        ),
      );
      await appendAuditRecordInTransaction(tx, {
        auditId: record.auditReference,
        brandId: brand,
        storeId: store,
        actor: { type: "User", reference: record.actorReference },
        actionCode: "PAYMENT_CARD_MACHINE_RECORDED",
        targetType: "PaymentIntent",
        targetId: record.paymentIntentReference,
        afterSummary: {
          amountMinor: record.preparation.total.amountMinor.toString(),
          recordingReason: record.recordingReason,
        },
        reasonCode:
          record.recordingReason === "AtCounter"
            ? "CARD_MACHINE_APPROVED"
            : "RECORDED_AFTER_OUTAGE",
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
      const refunded = (await refundsOf(tx, payment.cardMachinePaymentReference)).reduce(
        (sum, item) => sum + item.amountMinor,
        0n,
      );
      if (refunded + refund.amountMinor > payment.preparation.total.amountMinor)
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
        afterSummary: { amountMinor: refund.amountMinor.toString(), sourceKind: refund.sourceKind },
        reasonCode: "REFUNDED_ON_CARD_MACHINE",
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
      const payments = rows(
        await tx.query(
          `SELECT count(*)::text AS count,COALESCE(sum(total_minor),0)::text AS total,
 COALESCE(sum(tip_minor),0)::text AS tip,
 count(*) FILTER (WHERE recording_reason='RecordedAfterOutage')::text AS back_entered
 FROM rms_payment.card_machine_payment WHERE brand_id=$1 AND store_id=$2 AND tenant_id=$3
 AND taken_at>=$4::timestamptz AND taken_at<$5::timestamptz`,
          [brand, store, tenant, from, to],
        ),
      )[0];
      const refunds = rows(
        await tx.query(
          `SELECT count(*)::text AS count,COALESCE(sum(amount_minor),0)::text AS total
 FROM rms_payment.card_machine_refund WHERE brand_id=$1 AND store_id=$2 AND tenant_id=$3
 AND refunded_at>=$4::timestamptz AND refunded_at<$5::timestamptz`,
          [brand, store, tenant, from, to],
        ),
      )[0];
      if (!payments || !refunds) return fail();
      const integer = (value: unknown) => {
        if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,18})$/u.test(value)) return fail();
        return BigInt(value);
      };
      return Object.freeze({
        paymentCount: Number(integer(payments.count)),
        backEnteredCount: Number(integer(payments.back_entered)),
        takenMinor: integer(payments.total),
        tipMinor: integer(payments.tip),
        refundCount: Number(integer(refunds.count)),
        refundedMinor: integer(refunds.total),
      });
    },
  });
}
