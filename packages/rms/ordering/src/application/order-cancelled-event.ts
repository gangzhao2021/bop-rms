import { readClosedRecord } from "@bop/identity";
import {
  validateDomainEventEnvelope,
  type DomainEventEnvelope,
  type JsonObject,
} from "@bop/eventing";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";

/**
 * WP-2423 (Handoff Section 48.4.4 / 52.16 `rms.ordering.OrderCancelled.v1`): Ordering cancelled
 * part of an Order. The pilot publishes it for an unpaid dine-in round the System cancelled when its
 * payment window ended (its payment failed, or no payment was ever started). Nothing was charged
 * for the round; its reserved stock was released in the same transaction.
 */
export const orderCancelledReasonCodes = [
  "CHECKOUT_DEADLINE_REACHED",
  "PAYMENT_NOT_STARTED",
  // WP-2423 abandoned payment: the online payment was never finished (cancelled at the Provider at
  // the deadline), or a manager cancelled the unpaid round before its deadline.
  "PAYMENT_NOT_COMPLETED",
  "STAFF_CANCELLED_UNPAID",
] as const;
export type OrderCancelledReasonCode = (typeof orderCancelledReasonCodes)[number];

export interface OrderCancelledPayload extends JsonObject {
  readonly orderReference: string;
  readonly orderBatchReference: string;
  readonly cancellationReference: string;
  readonly cancellationScope: "Batch";
  readonly reasonCode: OrderCancelledReasonCode;
  readonly itemCount: number;
  readonly cancelledAt: string;
  /** sha256 of the canonical append-only cancellation record. */
  readonly sourceDigest: string;
}
export type OrderCancelledEnvelope = DomainEventEnvelope<OrderCancelledPayload>;

const invalid = (): never => {
  throw new Error("ORDER_CANCELLED_EVENT_INVALID");
};

export function parseOrderCancelledEnvelope(value: unknown): OrderCancelledEnvelope {
  try {
    const envelope = validateDomainEventEnvelope(value as OrderCancelledEnvelope);
    const raw = readClosedRecord(envelope.payload, [
      "orderReference",
      "orderBatchReference",
      "cancellationReference",
      "cancellationScope",
      "reasonCode",
      "itemCount",
      "cancelledAt",
      "sourceDigest",
    ]);
    if (
      raw.cancellationScope !== "Batch" ||
      !orderCancelledReasonCodes.includes(raw.reasonCode as OrderCancelledReasonCode) ||
      typeof raw.itemCount !== "number" ||
      !Number.isSafeInteger(raw.itemCount) ||
      raw.itemCount < 1 ||
      raw.itemCount > 100
    )
      return invalid();
    const payload = Object.freeze({
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      cancellationReference: parseOrderingReference(raw.cancellationReference),
      cancellationScope: "Batch" as const,
      reasonCode: raw.reasonCode as OrderCancelledReasonCode,
      itemCount: raw.itemCount,
      cancelledAt: parseOrderingInstant(raw.cancelledAt),
      sourceDigest: parseOrderingHash(raw.sourceDigest),
    });
    if (
      envelope.eventType !== "OrderCancelled" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/ordering" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== "Order" ||
      envelope.aggregateId !== payload.orderReference ||
      envelope.occurredAt !== payload.cancelledAt ||
      envelope.aggregateVersion < 2n ||
      envelope.aggregateVersion > 2147483647n ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "indirect_identifier" ||
      envelope.replayMetadata.replaySafe !== true ||
      Object.keys(envelope.replayMetadata).length !== 1 ||
      envelope.eventId === payload.cancellationReference
    )
      return invalid();
    return Object.freeze({ ...envelope, payload }) as OrderCancelledEnvelope;
  } catch {
    return invalid();
  }
}

/** The one event of a System batch cancellation, written in the cancellation's transaction. */
export function createOrderCancelledEnvelope(input: {
  readonly eventReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly operationReference: string;
  readonly cancelledOrderVersion: number;
  readonly payload: OrderCancelledPayload;
}): OrderCancelledEnvelope {
  return parseOrderCancelledEnvelope({
    eventId: input.eventReference,
    eventType: "OrderCancelled",
    schemaVersion: 1,
    occurredAt: input.payload.cancelledAt,
    producerModule: "@rms/ordering",
    tenantId: input.brandReference,
    storeId: input.storeReference,
    aggregateType: "Order",
    aggregateId: input.payload.orderReference,
    aggregateVersion: BigInt(input.cancelledOrderVersion),
    correlationId: input.operationReference,
    causationId: input.payload.cancellationReference,
    actor: { type: "System" },
    payload: { ...input.payload },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
}
