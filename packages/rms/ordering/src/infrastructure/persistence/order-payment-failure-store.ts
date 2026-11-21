import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parseOrderPaymentFailureRecord,
  parsePaymentFailedEnvelope,
  createPaymentOutcomeEventBinding,
  OrderPaymentOutcomeError,
} from "../../application/order-payment-outcome.js";
import type { OrderPaymentOutcomeConsumerPorts } from "../../application/ports/order-payment-outcome-ports.js";
import { parseOrderingReference } from "../../domain/cart.js";

/** Owner read port; caller must authorize the event and retain its consumer transaction. */
export function createPostgresOrderPaymentFailureReader(scope: {
  brandReference: string;
  storeReference: string;
}): Pick<OrderPaymentOutcomeConsumerPorts["outcomes"], "loadByPaymentEvent"> {
  const brand = parseOrderingReference(scope.brandReference);
  const store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async loadByPaymentEvent(input: {
      paymentEventReference: string;
      transaction: ConsumerTransaction;
    }) {
      const event = parseOrderingReference(input.paymentEventReference);
      await input.transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const result = await input.transaction.query(
        'SELECT failure_record_id AS "failureRecordReference", brand_id AS "brandReference", ' +
          'store_id AS "storeReference", order_id AS "orderReference", ' +
          'payment_transaction_id AS "paymentTransactionReference", payment_intent_id AS "paymentIntentReference", ' +
          'payment_attempt_id AS "paymentAttemptReference", payment_event_id AS "paymentEventReference", ' +
          'reason, retry_disposition AS "retryDisposition", terminal_occurred_at AS "terminalOccurredAt", ' +
          'event_digest AS "eventDigest" FROM rms_ordering.order_payment_failure_record ' +
          "WHERE brand_id=$1 AND store_id=$2 AND payment_event_id=$3",
        [brand, store, event],
      );
      if (result.rows.length === 0) return null;
      if (result.rows.length !== 1) throw new Error("order payment failure source unavailable");
      const row = result.rows[0];
      const instant = row?.terminalOccurredAt;
      const record = parseOrderPaymentFailureRecord({
        ...row,
        terminalOccurredAt: instant instanceof Date ? instant.toISOString() : instant,
      });
      return Object.freeze({ record, orderConfirmedEvent: null });
    },
  });
}

/** Failure branch only. The successful disposition writer must be composed separately. */
export function createPostgresOrderPaymentFailureStore(options: {
  brandReference: string;
  storeReference: string;
  sha256(value: string): string;
  audit(input: { orderReference: string; correlationReference: string }): Promise<unknown>;
}): Pick<OrderPaymentOutcomeConsumerPorts["outcomes"], "loadByPaymentEvent" | "commitFailed"> {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const reader = createPostgresOrderPaymentFailureReader(options);
  function conflict(): never {
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_CONFLICT");
  }
  return Object.freeze({
    ...reader,
    async commitFailed(input) {
      const event = parsePaymentFailedEnvelope(input.sourceEvent);
      const record = parseOrderPaymentFailureRecord(input.failure);
      if (
        event.tenantId !== brand ||
        event.storeId !== store ||
        record.brandReference !== brand ||
        record.storeReference !== store ||
        record.paymentEventReference !== event.eventId ||
        record.orderReference !== event.payload.orderReference ||
        record.paymentTransactionReference !== event.payload.paymentTransactionReference ||
        record.paymentIntentReference !== event.payload.paymentIntentReference ||
        record.paymentAttemptReference !== event.payload.paymentAttemptReference ||
        record.reason !== event.payload.reason ||
        record.retryDisposition !== event.payload.retryDisposition ||
        record.terminalOccurredAt !== event.payload.terminalOccurredAt ||
        record.eventDigest !== options.sha256(createPaymentOutcomeEventBinding(event))
      )
        return conflict();
      const tx = input.transaction;
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingPaymentFailure:" + brand + ":" + store + ":" + event.eventId,
      ]);
      const existing = await reader.loadByPaymentEvent({
        paymentEventReference: record.paymentEventReference,
        transaction: tx,
      });
      if (existing) {
        const prior = parseOrderPaymentFailureRecord(existing.record);
        for (const key of Object.keys(record) as (keyof typeof record)[]) {
          if (key !== "failureRecordReference" && record[key] !== prior[key]) return conflict();
        }
        return { status: "AlreadyCommitted", effect: existing };
      }
      const audit = validateAuditRecord(
        await options.audit({
          orderReference: record.orderReference,
          correlationReference: event.correlationId,
        }),
      );
      if (
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.actor.type !== "System" ||
        audit.targetType !== "Order" ||
        audit.targetId !== record.orderReference ||
        audit.actionCode !== "ORDER_PAYMENT_FAILURE_RECORDED" ||
        audit.correlationId !== event.correlationId ||
        audit.beforeSummary !== undefined ||
        JSON.stringify(audit.afterSummary) !== JSON.stringify({ outcome: "PaymentFailed" }) ||
        audit.dataClassification !== "Restricted"
      )
        return conflict();
      const result = await tx.query(
        "INSERT INTO rms_ordering.order_payment_failure_record " +
          "(failure_record_id,brand_id,store_id,order_id,payment_transaction_id,payment_intent_id," +
          "payment_attempt_id,payment_event_id,reason,retry_disposition,terminal_occurred_at,event_digest) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
        [
          record.failureRecordReference,
          brand,
          store,
          record.orderReference,
          record.paymentTransactionReference,
          record.paymentIntentReference,
          record.paymentAttemptReference,
          record.paymentEventReference,
          record.reason,
          record.retryDisposition,
          record.terminalOccurredAt,
          record.eventDigest,
        ],
      );
      if (result.rowCount !== 1) return conflict();
      await appendAuditRecordInTransaction(tx, audit);
      return { status: "Created", effect: { record, orderConfirmedEvent: null } };
    },
  });
}
