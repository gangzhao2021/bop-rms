import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import { parseOrderPaymentAcceptanceWait } from "../../application/order-payment-acceptance-wait.js";
import {
  parsePaymentSucceededEnvelope,
  OrderPaymentOutcomeError,
} from "../../application/order-payment-outcome.js";
import { parseOrderingReference } from "../../domain/cart.js";
type Waiting = ReturnType<typeof parseOrderPaymentAcceptanceWait>;
/** Immutable normal-business waiting work. Terminal outcome remains in its existing owner store. */
export function createPostgresOrderPaymentAcceptanceWaitStore(options: {
  brandReference: string;
  storeReference: string;
  sha256(value: string): string;
  authorize(
    tx: ConsumerTransaction,
    action: "RecordPaymentWait" | "ListPaymentWaits" | "ReadPaymentWait",
  ): Promise<boolean>;
  validateCurrent(tx: ConsumerTransaction, waiting: Waiting): Promise<boolean>;
  audit(waiting: Waiting): Promise<unknown>;
}) {
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  const denied = (): never => {
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_PERMISSION_DENIED");
  };
  const unavailable = (): never => {
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
  };
  const scope = async (
    tx: ConsumerTransaction,
    action: "RecordPaymentWait" | "ListPaymentWaits" | "ReadPaymentWait",
  ) => {
    if (!(await options.authorize(tx, action))) return denied();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store,
    ]);
  };
  return Object.freeze({
    async load(tx: ConsumerTransaction, eventValue: unknown) {
      const event = parsePaymentSucceededEnvelope(eventValue);
      if (event.tenantId !== brand || event.storeId !== store) return denied();
      await scope(tx, "ReadPaymentWait");
      const found = await tx.query(
        "SELECT record_json FROM rms_ordering.order_payment_acceptance_wait WHERE brand_id=$1 AND store_id=$2 AND payment_event_id=$3",
        [brand, store, event.eventId],
      );
      if (found.rows.length > 1) return unavailable();
      if (!(await options.authorize(tx, "ReadPaymentWait"))) return denied();
      return found.rows[0]
        ? parseOrderPaymentAcceptanceWait(event, found.rows[0].record_json, options.sha256).record
        : null;
    },
    async record(tx: ConsumerTransaction, eventValue: unknown, recordValue: unknown) {
      const waiting = parseOrderPaymentAcceptanceWait(eventValue, recordValue, options.sha256),
        r = waiting.record;
      if (r.brandReference !== brand || r.storeReference !== store) return denied();
      await scope(tx, "RecordPaymentWait");
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingPaymentWait:" + brand + ":" + store + ":" + r.paymentEventReference,
      ]);
      const prior = await tx.query(
        "SELECT record_json FROM rms_ordering.order_payment_acceptance_wait WHERE brand_id=$1 AND store_id=$2 AND payment_event_id=$3",
        [brand, store, r.paymentEventReference],
      );
      if (prior.rows.length > 1) return unavailable();
      if (prior.rows[0]) {
        const existing = parseOrderPaymentAcceptanceWait(
          waiting.event,
          prior.rows[0].record_json,
          options.sha256,
        );
        if (!(await options.authorize(tx, "RecordPaymentWait"))) return denied();
        return { status: "Existing" as const, record: existing.record };
      }
      if (!(await options.validateCurrent(tx, waiting))) return unavailable();
      const audit = validateAuditRecord(await options.audit(waiting));
      if (
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.actionCode !== "ORDER_PAYMENT_WAIT_RECORDED" ||
        audit.targetType !== "OrderPaymentWait" ||
        audit.targetId !== r.dispositionReference ||
        audit.correlationId !== waiting.event.correlationId ||
        audit.occurredAt !== r.evaluatedAt
      )
        return unavailable();
      if (!(await options.authorize(tx, "RecordPaymentWait"))) return denied();
      const inserted = await tx.query(
        "INSERT INTO rms_ordering.order_payment_acceptance_wait (wait_id,brand_id,store_id,order_id,order_batch_id,submission_id,payment_event_id,source_digest,evaluated_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb) RETURNING wait_id",
        [
          r.dispositionReference,
          brand,
          store,
          r.orderReference,
          r.orderBatchReference,
          r.submissionReference,
          r.paymentEventReference,
          r.sourceDigest,
          r.evaluatedAt,
          JSON.stringify(r),
        ],
      );
      if (inserted.rowCount !== 1) return unavailable();
      await appendAuditRecordInTransaction(tx, audit);
      return { status: "Created" as const, record: r };
    },
    async listUnresolved(
      tx: ConsumerTransaction,
      limit: number,
      afterEventReference: string | null = null,
    ) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) return unavailable();
      const after =
        afterEventReference === null ? null : parseOrderingReference(afterEventReference);
      await scope(tx, "ListPaymentWaits");
      const found = await tx.query(
        "SELECT w.payment_event_id FROM rms_ordering.order_payment_acceptance_wait w WHERE w.brand_id=$1 AND w.store_id=$2 AND NOT EXISTS (SELECT 1 FROM rms_ordering.order_payment_disposition_record d WHERE d.brand_id=w.brand_id AND d.store_id=w.store_id AND d.payment_event_id=w.payment_event_id) AND ($4::uuid IS NULL OR w.payment_event_id>$4::uuid) ORDER BY w.payment_event_id LIMIT $3",
        [brand, store, limit, after],
      );
      if (found.rows.length > limit) return unavailable();
      const events = found.rows.map((row) => parseOrderingReference(row.payment_event_id));
      if (!(await options.authorize(tx, "ListPaymentWaits"))) return denied();
      return Object.freeze(events);
    },
  });
}
