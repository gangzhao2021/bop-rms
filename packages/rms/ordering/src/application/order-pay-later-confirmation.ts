import type { OrderConfirmedEnvelope } from "../contracts/order-confirmed-event.js";
import {
  parseOrderingHash,
  parseOrderingInstant,
  parseOrderingReference,
  type OrderingHash,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import { parseOrderConfirmedEnvelope } from "./order-confirmed-event.js";

/**
 * WP-2423 DEC-DINE-IN-PAY-LATER: a round of a table opened "pay later", sent to the kitchen when it
 * was submitted. It names the automatic acceptance it went with (the kitchen's checkpoint) and its
 * OrderConfirmed event. It is not a payment: the round is still owed until the table is settled.
 */
export interface OrderPayLaterConfirmation {
  readonly confirmationReference: OrderingReference;
  readonly brandReference: OrderingReference;
  readonly storeReference: OrderingReference;
  readonly orderReference: OrderingReference;
  readonly orderBatchReference: OrderingReference;
  readonly submissionReference: OrderingReference;
  readonly diningSessionReference: OrderingReference;
  readonly acceptanceReference: OrderingReference;
  readonly acceptedOrderVersion: number;
  readonly operationReference: OrderingReference;
  readonly sourceSnapshotDigest: OrderingHash;
  readonly orderConfirmedEventReference: OrderingReference;
  readonly confirmedAt: OrderingInstant;
}

export class OrderPayLaterConfirmationError extends Error {
  constructor(
    readonly code:
      | "ORDER_PAY_LATER_INVALID"
      | "ORDER_PAY_LATER_NOT_PAY_LATER"
      | "ORDER_PAY_LATER_CONFLICT"
      | "ORDER_PAY_LATER_UNAVAILABLE",
  ) {
    super("pay-later confirmation is unavailable");
    this.name = "OrderPayLaterConfirmationError";
  }
}

const fields = [
  "confirmationReference",
  "brandReference",
  "storeReference",
  "orderReference",
  "orderBatchReference",
  "submissionReference",
  "diningSessionReference",
  "acceptanceReference",
  "acceptedOrderVersion",
  "operationReference",
  "sourceSnapshotDigest",
  "orderConfirmedEventReference",
  "confirmedAt",
] as const;

export function parseOrderPayLaterConfirmation(value: unknown): OrderPayLaterConfirmation {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      throw new OrderPayLaterConfirmationError("ORDER_PAY_LATER_INVALID");
    const raw = value as Record<string, unknown>;
    const keys = Object.keys(raw);
    if (
      keys.length !== fields.length ||
      keys.some((key) => !(fields as readonly string[]).includes(key))
    )
      throw new OrderPayLaterConfirmationError("ORDER_PAY_LATER_INVALID");
    const version = raw.acceptedOrderVersion;
    if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 2)
      throw new OrderPayLaterConfirmationError("ORDER_PAY_LATER_INVALID");
    return Object.freeze({
      confirmationReference: parseOrderingReference(raw.confirmationReference),
      brandReference: parseOrderingReference(raw.brandReference),
      storeReference: parseOrderingReference(raw.storeReference),
      orderReference: parseOrderingReference(raw.orderReference),
      orderBatchReference: parseOrderingReference(raw.orderBatchReference),
      submissionReference: parseOrderingReference(raw.submissionReference),
      diningSessionReference: parseOrderingReference(raw.diningSessionReference),
      acceptanceReference: parseOrderingReference(raw.acceptanceReference),
      acceptedOrderVersion: version,
      operationReference: parseOrderingReference(raw.operationReference),
      sourceSnapshotDigest: parseOrderingHash(raw.sourceSnapshotDigest),
      orderConfirmedEventReference: parseOrderingReference(raw.orderConfirmedEventReference),
      confirmedAt: parseOrderingInstant(raw.confirmedAt),
    });
  } catch (error) {
    if (error instanceof OrderPayLaterConfirmationError) throw error;
    throw new OrderPayLaterConfirmationError("ORDER_PAY_LATER_INVALID");
  }
}

/**
 * The same OrderConfirmed the kitchen takes from a paid round, caused here by the automatic
 * acceptance instead of a payment; its version is the Order's version after that acceptance.
 */
export function createPayLaterOrderConfirmedEnvelope(input: {
  readonly confirmation: OrderPayLaterConfirmation;
  readonly correlationReference: string;
}): OrderConfirmedEnvelope {
  const confirmation = parseOrderPayLaterConfirmation(input.confirmation);
  return parseOrderConfirmedEnvelope({
    eventId: confirmation.orderConfirmedEventReference,
    eventType: "OrderConfirmed",
    schemaVersion: 1,
    occurredAt: confirmation.confirmedAt,
    producerModule: "@rms/ordering",
    tenantId: confirmation.brandReference,
    storeId: confirmation.storeReference,
    aggregateType: "Order",
    aggregateId: confirmation.orderReference,
    aggregateVersion: BigInt(confirmation.acceptedOrderVersion),
    correlationId: parseOrderingReference(input.correlationReference),
    causationId: confirmation.acceptanceReference,
    actor: { type: "System" },
    payload: {
      confirmationReference: confirmation.confirmationReference,
      orderReference: confirmation.orderReference,
      orderBatchReference: confirmation.orderBatchReference,
      sourceSnapshotDigest: confirmation.sourceSnapshotDigest,
      confirmedAt: confirmation.confirmedAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
}
