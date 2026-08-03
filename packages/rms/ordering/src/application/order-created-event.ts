import { validateDomainEventEnvelope } from "@bop/eventing";

import type {
  OrderCreatedEnvelope,
  OrderCreatedPayload,
} from "../contracts/order-created-event.js";
import { parseOrderingHash, parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";
import type { OrderCreationRecord } from "../domain/order-creation.js";

export class OrderCreatedEventError extends Error {
  readonly code = "ORDER_CREATED_EVENT_INVALID" as const;

  constructor() {
    super("order created event is invalid");
    this.name = "OrderCreatedEventError";
  }
}

function invalid(): never {
  throw new OrderCreatedEventError();
}

function payload(value: unknown): OrderCreatedPayload {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const fields = [
      "orderReference",
      "orderBatchReference",
      "submissionReference",
      "businessDate",
      "sourceSnapshotDigest",
      "itemCount",
    ] as const;
    if (
      Reflect.ownKeys(value).length !== fields.length ||
      Reflect.ownKeys(value).some(
        (key) => typeof key !== "string" || !fields.includes(key as never),
      )
    )
      return invalid();
    const raw = value as Record<(typeof fields)[number], unknown>;
    const orderReference = parseOrderingReference(raw.orderReference);
    const orderBatchReference = parseOrderingReference(raw.orderBatchReference);
    const submissionReference = parseOrderingReference(raw.submissionReference);
    const sourceSnapshotDigest = parseOrderingHash(raw.sourceSnapshotDigest);
    if (
      typeof raw.businessDate !== "string" ||
      !/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/u.test(raw.businessDate) ||
      !Number.isSafeInteger(raw.itemCount) ||
      (raw.itemCount as number) < 1 ||
      (raw.itemCount as number) > 100
    )
      return invalid();
    return Object.freeze({
      orderReference,
      orderBatchReference,
      submissionReference,
      businessDate: raw.businessDate,
      sourceSnapshotDigest,
      itemCount: raw.itemCount as number,
    });
  } catch (error) {
    if (error instanceof OrderCreatedEventError) throw error;
    return invalid();
  }
}

export function parseOrderCreatedEnvelope(value: unknown): OrderCreatedEnvelope {
  try {
    const envelope = validateDomainEventEnvelope(value as OrderCreatedEnvelope);
    const parsedPayload = payload(envelope.payload);
    if (
      envelope.eventType !== "OrderCreated" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/ordering" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== "Order" ||
      envelope.aggregateId !== parsedPayload.orderReference ||
      envelope.aggregateVersion !== 1n ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "indirect_identifier" ||
      envelope.replayMetadata.replaySafe !== true ||
      Object.keys(envelope.replayMetadata).length !== 1
    )
      return invalid();
    return Object.freeze({ ...envelope, payload: parsedPayload }) as OrderCreatedEnvelope;
  } catch (error) {
    if (error instanceof OrderCreatedEventError) throw error;
    return invalid();
  }
}

export function createOrderCreatedEnvelope(input: {
  readonly eventReference: unknown;
  readonly correlationReference: unknown;
  readonly sourceSnapshotDigest: unknown;
  readonly businessDate: unknown;
  readonly record: Omit<OrderCreationRecord, "orderNumberAllocation">;
}): OrderCreatedEnvelope {
  try {
    const order = input.record.order;
    const batch = order.batches[0];
    if (
      batch === undefined ||
      batch.submissionReference !== input.record.submissionReference ||
      batch.items.length !== input.record.items.length ||
      order.createdAt !== input.record.createdAt
    )
      return invalid();
    return parseOrderCreatedEnvelope({
      eventId: parseOrderingReference(input.eventReference),
      eventType: "OrderCreated",
      schemaVersion: 1,
      occurredAt: parseOrderingInstant(input.record.createdAt),
      producerModule: "@rms/ordering",
      tenantId: order.brandReference,
      storeId: order.storeReference,
      aggregateType: "Order",
      aggregateId: order.orderReference,
      aggregateVersion: BigInt(order.aggregateVersion),
      correlationId: parseOrderingReference(input.correlationReference),
      causationId: input.record.submissionReference,
      actor: { type: "System" },
      payload: {
        orderReference: order.orderReference,
        orderBatchReference: batch.orderBatchReference,
        submissionReference: input.record.submissionReference,
        businessDate: input.businessDate,
        sourceSnapshotDigest: parseOrderingHash(input.sourceSnapshotDigest),
        itemCount: input.record.items.length,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
  } catch (error) {
    if (error instanceof OrderCreatedEventError) throw error;
    return invalid();
  }
}
