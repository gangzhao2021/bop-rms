import { validateDomainEventEnvelope } from "@bop/eventing";

import type {
  OrderConfirmedEnvelope,
  OrderConfirmedPayload,
} from "../contracts/order-confirmed-event.js";
import type { ConfirmedOrderPaymentOutcomeDisposition } from "../contracts/order-payment-outcome.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import {
  parseOrderPaymentOutcomeDisposition,
  parsePaymentSucceededEnvelope,
} from "./order-payment-outcome.js";

export class OrderConfirmedEventError extends Error {
  readonly code = "ORDER_CONFIRMED_EVENT_INVALID" as const;

  constructor() {
    super("order confirmed event is invalid");
    this.name = "OrderConfirmedEventError";
  }
}

function invalid(): never {
  throw new OrderConfirmedEventError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const keys = Reflect.ownKeys(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          !descriptor.enumerable ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined
        );
      })
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof OrderConfirmedEventError) throw error;
    return invalid();
  }
}

function payload(value: unknown): OrderConfirmedPayload {
  const raw = exact(value, [
    "confirmationReference",
    "orderReference",
    "orderBatchReference",
    "sourceSnapshotDigest",
    "confirmedAt",
  ]);
  return Object.freeze({
    confirmationReference: parseOrderingReference(raw.confirmationReference),
    orderReference: parseOrderingReference(raw.orderReference),
    orderBatchReference: parseOrderingReference(raw.orderBatchReference),
    sourceSnapshotDigest: parseOrderingHash(raw.sourceSnapshotDigest),
    confirmedAt: parseOrderingInstant(raw.confirmedAt),
  });
}

export function parseOrderConfirmedEnvelope(value: unknown): OrderConfirmedEnvelope {
  try {
    const raw = exact(value, [
      "eventId",
      "eventType",
      "schemaVersion",
      "occurredAt",
      "producerModule",
      "tenantId",
      "storeId",
      "aggregateType",
      "aggregateId",
      "aggregateVersion",
      "correlationId",
      "causationId",
      "actor",
      "payload",
      "redactionClassification",
      "replayMetadata",
    ]);
    const actor = exact(raw.actor, ["type"]);
    const replay = exact(raw.replayMetadata, ["replaySafe"]);
    const parsedPayload = payload(raw.payload);
    if (actor.type !== "System" || replay.replaySafe !== true) return invalid();
    const candidate = {
      eventId: parseOrderingReference(raw.eventId),
      eventType: raw.eventType,
      schemaVersion: raw.schemaVersion,
      occurredAt: parseOrderingInstant(raw.occurredAt),
      producerModule: raw.producerModule,
      tenantId: parseOrderingReference(raw.tenantId),
      storeId: parseOrderingReference(raw.storeId),
      aggregateType: raw.aggregateType,
      aggregateId: parseOrderingReference(raw.aggregateId),
      aggregateVersion: raw.aggregateVersion,
      correlationId: parseOrderingReference(raw.correlationId),
      causationId: parseOrderingReference(raw.causationId),
      actor: Object.freeze({ type: "System" as const }),
      payload: parsedPayload,
      redactionClassification: raw.redactionClassification,
      replayMetadata: Object.freeze({ replaySafe: true as const }),
    };
    const envelope = validateDomainEventEnvelope(candidate as OrderConfirmedEnvelope);
    if (
      envelope.eventType !== "OrderConfirmed" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/ordering" ||
      envelope.aggregateType !== "Order" ||
      envelope.aggregateId !== parsedPayload.orderReference ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "indirect_identifier" ||
      envelope.occurredAt !== parsedPayload.confirmedAt
    )
      return invalid();
    return Object.freeze(candidate) as OrderConfirmedEnvelope;
  } catch (error) {
    if (error instanceof OrderConfirmedEventError) throw error;
    return invalid();
  }
}

export function createOrderConfirmedEnvelope(input: {
  readonly eventReference: unknown;
  readonly sourceEvent: unknown;
  readonly disposition: ConfirmedOrderPaymentOutcomeDisposition;
}): OrderConfirmedEnvelope {
  try {
    const sourceEvent = parsePaymentSucceededEnvelope(input.sourceEvent);
    const parsedDisposition = parseOrderPaymentOutcomeDisposition(input.disposition);
    if (
      parsedDisposition.disposition !== "Confirmed" ||
      parsedDisposition.brandReference !== sourceEvent.tenantId ||
      parsedDisposition.storeReference !== sourceEvent.storeId ||
      parsedDisposition.orderReference !== sourceEvent.payload.orderReference ||
      parsedDisposition.paymentTransactionReference !==
        sourceEvent.payload.paymentTransactionReference ||
      parsedDisposition.paymentIntentReference !== sourceEvent.payload.paymentIntentReference ||
      parsedDisposition.paymentAttemptReference !== sourceEvent.payload.paymentAttemptReference ||
      parsedDisposition.paymentEventReference !== sourceEvent.eventId ||
      Date.parse(parsedDisposition.confirmedAt) < Date.parse(sourceEvent.occurredAt) ||
      Date.parse(parsedDisposition.confirmedAt) > Date.parse(parsedDisposition.evaluatedAt)
    )
      return invalid();
    return parseOrderConfirmedEnvelope({
      eventId: parseOrderingReference(input.eventReference),
      eventType: "OrderConfirmed",
      schemaVersion: 1,
      occurredAt: parsedDisposition.confirmedAt,
      producerModule: "@rms/ordering",
      tenantId: parsedDisposition.brandReference,
      storeId: parsedDisposition.storeReference,
      aggregateType: "Order",
      aggregateId: parsedDisposition.orderReference,
      aggregateVersion: BigInt(parsedDisposition.sourceVersion),
      correlationId: sourceEvent.correlationId,
      causationId: sourceEvent.eventId,
      actor: { type: "System" },
      payload: {
        confirmationReference: parsedDisposition.confirmationReference,
        orderReference: parsedDisposition.orderReference,
        orderBatchReference: parsedDisposition.orderBatchReference,
        sourceSnapshotDigest: parsedDisposition.sourceSnapshotDigest,
        confirmedAt: parsedDisposition.confirmedAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
  } catch (error) {
    if (error instanceof OrderConfirmedEventError) throw error;
    return invalid();
  }
}
