import { createPostgresOrderPaymentFailureStore } from "./order-payment-failure-store.js";
import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import { appendEventInTransaction, type ConsumerTransaction } from "@bop/eventing";
import type { OrderPaymentOutcomeConsumerPorts } from "../../application/ports/order-payment-outcome-ports.js";
import {
  parseOrderPaymentOutcomeDisposition,
  parsePaymentSucceededEnvelope,
  parsePaymentFailedEnvelope,
  createOrderPaymentDispositionBinding,
  OrderPaymentOutcomeError,
} from "../../application/order-payment-outcome.js";
import {
  parseOrderConfirmedEnvelope,
  createOrderConfirmedEnvelope,
} from "../../application/order-confirmed-event.js";
import { parseOrderingReference } from "../../domain/cart.js";

const columns = {
  disposition_id: "dispositionReference",
  brand_id: "brandReference",
  store_id: "storeReference",
  order_id: "orderReference",
  order_batch_id: "orderBatchReference",
  submission_id: "submissionReference",
  payment_transaction_id: "paymentTransactionReference",
  payment_intent_id: "paymentIntentReference",
  payment_attempt_id: "paymentAttemptReference",
  payment_event_id: "paymentEventReference",
  source_version: "sourceVersion",
  source_checkpoint: "sourceCheckpoint",
  source_digest: "sourceDigest",
  evaluated_at: "evaluatedAt",
  disposition: "disposition",
  confirmation_id: "confirmationReference",
  source_snapshot_digest: "sourceSnapshotDigest",
  confirmed_at: "confirmedAt",
  order_confirmed_event_id: "eventReference",
  correlation_id: "correlationReference",
  reason: "reason",
  kitchen_release_disposition: "kitchenReleaseDisposition",
} as const;
const select =
  "SELECT " +
  Object.entries(columns)
    .map(([column, alias]) => column + ' AS "' + alias + '"')
    .join(",") +
  " FROM rms_ordering.order_payment_disposition_record WHERE brand_id=$1 AND store_id=$2 AND payment_event_id=$3";
const instant = (value: unknown) => (value instanceof Date ? value.toISOString() : value);

/** Read immutable original effects in the caller's authorized Ordering transaction. */
export function createPostgresOrderPaymentDispositionReader(scope: {
  brandReference: string;
  storeReference: string;
}): Pick<OrderPaymentOutcomeConsumerPorts["outcomes"], "loadByPaymentEvent"> {
  const brand = parseOrderingReference(scope.brandReference),
    store = parseOrderingReference(scope.storeReference);
  return Object.freeze({
    async loadByPaymentEvent(input) {
      const eventId = parseOrderingReference(input.paymentEventReference);
      await input.transaction.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      const rows = (await input.transaction.query(select, [brand, store, eventId])).rows;
      if (!rows.length) return null;
      if (rows.length !== 1 || !rows[0])
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
      const row = rows[0];
      const common = Object.fromEntries(
        Object.values(columns)
          .filter(
            (key) =>
              ![
                "confirmationReference",
                "sourceSnapshotDigest",
                "confirmedAt",
                "eventReference",
                "correlationReference",
                "reason",
                "kitchenReleaseDisposition",
              ].includes(key),
          )
          .map((key) => [key, key === "evaluatedAt" ? instant(row[key]) : row[key]]),
      );
      const record = parseOrderPaymentOutcomeDisposition({
        ...common,
        ...(row.disposition === "Confirmed"
          ? {
              confirmationReference: row.confirmationReference,
              sourceSnapshotDigest: row.sourceSnapshotDigest,
              confirmedAt: instant(row.confirmedAt),
            }
          : { reason: row.reason, kitchenReleaseDisposition: row.kitchenReleaseDisposition }),
      });
      if (record.disposition !== "Confirmed") {
        if (record.disposition !== "PaidWithoutFulfillableOrder" || row.eventReference !== null)
          throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
        return { record, orderConfirmedEvent: null };
      }
      const orderConfirmedEvent = parseOrderConfirmedEnvelope({
        eventId: row.eventReference,
        eventType: "OrderConfirmed",
        schemaVersion: 1,
        occurredAt: record.confirmedAt,
        producerModule: "@rms/ordering",
        tenantId: brand,
        storeId: store,
        aggregateType: "Order",
        aggregateId: record.orderReference,
        aggregateVersion: BigInt(record.sourceVersion),
        correlationId: row.correlationReference,
        causationId: record.paymentEventReference,
        actor: { type: "System" },
        payload: {
          confirmationReference: record.confirmationReference,
          orderReference: record.orderReference,
          orderBatchReference: record.orderBatchReference,
          sourceSnapshotDigest: record.sourceSnapshotDigest,
          confirmedAt: record.confirmedAt,
        },
        redactionClassification: "indirect_identifier",
        replayMetadata: { replaySafe: true },
      });
      return { record, orderConfirmedEvent };
    },
  });
}

const canonical = (value: unknown) =>
  JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item,
  );

/** Source must already be authorized and fenced by the caller's Ordering transaction. */
export function createPostgresOrderPaymentDispositionStore(options: {
  brandReference: string;
  storeReference: string;
  sha256(value: string): string;
  audit(input: {
    orderReference: string;
    correlationReference: string;
    outcome: string;
  }): Promise<unknown>;
}): Pick<OrderPaymentOutcomeConsumerPorts["outcomes"], "loadByPaymentEvent" | "commitSucceeded"> {
  const reader = createPostgresOrderPaymentDispositionReader(options);
  const brand = parseOrderingReference(options.brandReference),
    store = parseOrderingReference(options.storeReference);
  function conflict(): never {
    throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_CONFLICT");
  }
  return Object.freeze({
    ...reader,
    async commitSucceeded(input) {
      const event = parsePaymentSucceededEnvelope(input.sourceEvent);
      const record = parseOrderPaymentOutcomeDisposition(input.disposition);
      if (
        record.disposition === "AwaitingAcceptance" ||
        event.tenantId !== brand ||
        event.storeId !== store ||
        record.brandReference !== brand ||
        record.storeReference !== store ||
        record.orderReference !== event.payload.orderReference ||
        record.paymentEventReference !== event.eventId ||
        record.paymentTransactionReference !== event.payload.paymentTransactionReference ||
        record.paymentIntentReference !== event.payload.paymentIntentReference ||
        record.paymentAttemptReference !== event.payload.paymentAttemptReference ||
        Date.parse(record.evaluatedAt) < Date.parse(event.occurredAt) ||
        record.sourceDigest !==
          options.sha256(createOrderPaymentDispositionBinding({ event, disposition: record }))
      )
        return conflict();
      const confirmation =
        input.orderConfirmedEvent === null
          ? null
          : parseOrderConfirmedEnvelope(input.orderConfirmedEvent);
      if (record.disposition === "Confirmed") {
        if (
          !confirmation ||
          canonical(confirmation) !==
            canonical(
              createOrderConfirmedEnvelope({
                eventReference: confirmation.eventId,
                sourceEvent: event,
                disposition: record,
              }),
            )
        )
          return conflict();
      } else if (confirmation !== null) return conflict();
      const tx = input.transaction;
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, store],
      );
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingOrderDisposition:" + brand + ":" + store + ":" + record.orderReference,
      ]);
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "OrderingPaymentDisposition:" +
          brand +
          ":" +
          store +
          ":" +
          record.paymentTransactionReference,
      ]);
      const existing = await reader.loadByPaymentEvent({
        transaction: tx,
        paymentEventReference: record.paymentEventReference,
      });
      if (existing) {
        if (canonical(existing.record) !== canonical(record)) return conflict();
        const prior = existing.orderConfirmedEvent;
        if ((prior === null) !== (confirmation === null)) return conflict();
        if (prior && confirmation) {
          const priorFields = Object.fromEntries(
            Object.entries(prior).filter(([key]) => key !== "eventId"),
          );
          const newFields = Object.fromEntries(
            Object.entries(confirmation).filter(([key]) => key !== "eventId"),
          );
          if (canonical(priorFields) !== canonical(newFields)) return conflict();
        }
        return { status: "AlreadyCommitted", effect: existing };
      }
      const source = await tx.query(
        "SELECT order_batch_id FROM rms_ordering.order_batch WHERE brand_id=$1 AND store_id=$2 " +
          "AND order_id=$3 AND order_batch_id=$4 AND submission_id=$5 FOR SHARE",
        [
          brand,
          store,
          record.orderReference,
          record.orderBatchReference,
          record.submissionReference,
        ],
      );
      if (source.rows.length !== 1) return conflict();
      const audit = validateAuditRecord(
        await options.audit({
          orderReference: record.orderReference,
          correlationReference: event.correlationId,
          outcome: record.disposition,
        }),
      );
      if (
        audit.brandId !== brand ||
        audit.storeId !== store ||
        audit.actor.type !== "System" ||
        audit.actionCode !== "ORDER_PAYMENT_DISPOSITION_RECORDED" ||
        audit.targetType !== "Order" ||
        audit.targetId !== record.orderReference ||
        audit.correlationId !== event.correlationId ||
        audit.beforeSummary !== undefined ||
        canonical(audit.afterSummary) !== canonical({ outcome: record.disposition }) ||
        audit.dataClassification !== "Restricted"
      )
        return conflict();
      const values: Record<string, unknown> = {
        ...record,
        eventReference: confirmation?.eventId ?? null,
        correlationReference: event.correlationId,
      };
      const entries = Object.entries(columns);
      const inserted = await tx.query(
        "INSERT INTO rms_ordering.order_payment_disposition_record (" +
          entries.map(([name]) => name).join(",") +
          ") VALUES (" +
          entries.map((_v, index) => "$" + (index + 1)).join(",") +
          ")",
        entries.map(([, alias]) => values[alias] ?? null),
      );
      if (inserted.rowCount !== 1) return conflict();
      await appendAuditRecordInTransaction(tx, audit);
      if (confirmation) await appendEventInTransaction(tx, confirmation);
      const effect = await reader.loadByPaymentEvent({
        transaction: tx,
        paymentEventReference: record.paymentEventReference,
      });
      if (!effect) return conflict();
      return { status: "Created", effect };
    },
  });
}

/** Complete owner repository with one event lock across success and failure branches. */
export function createPostgresOrderPaymentOutcomeStore(
  options: Parameters<typeof createPostgresOrderPaymentDispositionStore>[0],
): OrderPaymentOutcomeConsumerPorts["outcomes"] {
  const brand = parseOrderingReference(options.brandReference);
  const store = parseOrderingReference(options.storeReference);
  const success = createPostgresOrderPaymentDispositionStore({
    ...options,
    brandReference: brand,
    storeReference: store,
  });
  const failure = createPostgresOrderPaymentFailureStore({
    ...options,
    brandReference: brand,
    storeReference: store,
    audit: (input) => options.audit({ ...input, outcome: "PaymentFailed" }),
  });
  const read: OrderPaymentOutcomeConsumerPorts["outcomes"]["loadByPaymentEvent"] = async (
    input,
  ) => {
    const succeeded = await success.loadByPaymentEvent(input);
    const failed = await failure.loadByPaymentEvent(input);
    if (succeeded && failed) throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_CONFLICT");
    return succeeded ?? failed;
  };
  const lock = async (
    transaction: Parameters<typeof read>[0]["transaction"],
    source:
      | ReturnType<typeof parsePaymentSucceededEnvelope>
      | ReturnType<typeof parsePaymentFailedEnvelope>,
  ) => {
    if (source.tenantId !== brand || source.storeId !== store)
      throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_CONFLICT");
    const event = parseOrderingReference(source.eventId);
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingOrderDisposition:" + brand + ":" + store + ":" + source.payload.orderReference,
    ]);
    await transaction.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "OrderingPaymentOutcome:" + brand + ":" + store + ":" + event,
    ]);
    return read({ transaction, paymentEventReference: event });
  };
  return Object.freeze({
    loadByPaymentEvent: read,
    async commitSucceeded(input) {
      const existing = await lock(
        input.transaction,
        parsePaymentSucceededEnvelope(input.sourceEvent),
      );
      if (existing && !("disposition" in existing.record))
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_CONFLICT");
      return success.commitSucceeded(input);
    },
    async commitFailed(input) {
      const existing = await lock(input.transaction, parsePaymentFailedEnvelope(input.sourceEvent));
      if (existing && "disposition" in existing.record)
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_CONFLICT");
      return failure.commitFailed(input);
    },
  });
}

/** Bounded discovery of durable compensation work; callers repeat complete scans so
 * late commits are not lost. Completion and retry authority belong to Payment.
 */
export function createPostgresOrderCompensationCandidateReader(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly authorize: (
    transaction: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly purpose: "DiscoverPaidWithoutFulfillableOrder";
    },
  ) => Promise<boolean>;
}) {
  const brandReference = String(parseOrderingReference(options.scope.brandReference));
  const storeReference = String(parseOrderingReference(options.scope.storeReference));
  const reader = createPostgresOrderPaymentDispositionReader({ brandReference, storeReference });
  return async (
    transaction: ConsumerTransaction,
    input: {
      readonly afterDispositionReference: string | null;
      readonly limit: number;
    },
  ) => {
    if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 100)
      throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
    const after =
      input.afterDispositionReference === null
        ? null
        : String(parseOrderingReference(input.afterDispositionReference));
    const authorize = async () => {
      if (
        (await options.authorize(transaction, {
          brandReference,
          storeReference,
          purpose: "DiscoverPaidWithoutFulfillableOrder",
        })) !== true
      )
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
    };
    await authorize();
    await transaction.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brandReference, storeReference],
    );
    const page = await transaction.query(
      "SELECT disposition_id,payment_event_id FROM rms_ordering.order_payment_disposition_record " +
        "WHERE brand_id=$1 AND store_id=$2 AND disposition='PaidWithoutFulfillableOrder' " +
        "AND ($3::uuid IS NULL OR disposition_id>$3::uuid) ORDER BY disposition_id LIMIT $4",
      [brandReference, storeReference, after, input.limit],
    );
    if (page.rows.length > input.limit)
      throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
    const candidates = [];
    let cursor = after;
    for (const row of page.rows) {
      const reference = String(parseOrderingReference(row.disposition_id));
      if (cursor !== null && reference <= cursor)
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
      const record = await reader.loadByPaymentEvent({
        transaction,
        paymentEventReference: parseOrderingReference(row.payment_event_id),
      });
      if (
        !record ||
        !("disposition" in record.record) ||
        record.record.disposition !== "PaidWithoutFulfillableOrder" ||
        record.record.dispositionReference !== reference
      )
        throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
      candidates.push(record.record);
      cursor = reference;
    }
    await authorize();
    return Object.freeze({
      candidates: Object.freeze(candidates),
      nextAfterDispositionReference: page.rows.length === input.limit ? cursor : null,
    });
  };
}
