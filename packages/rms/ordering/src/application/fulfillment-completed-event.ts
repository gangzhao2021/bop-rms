import { validateDomainEventEnvelope } from "@bop/eventing";

import type {
  FulfillmentCompletedEnvelope,
  FulfillmentCompletedPayload,
} from "../contracts/fulfillment-completed-event.js";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";

export class OrderingFulfillmentCompletedEventError extends Error {
  readonly code = "ORDERING_FULFILLMENT_COMPLETED_EVENT_INVALID" as const;
  constructor() {
    super("fulfillment completion event is invalid");
    this.name = "OrderingFulfillmentCompletedEventError";
  }
}
function invalid(): never {
  throw new OrderingFulfillmentCompletedEventError();
}
function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
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
    keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
    fields.some((field) => {
      const descriptor = descriptors[field];
      return (
        !descriptor ||
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
}
function payload(value: unknown): FulfillmentCompletedPayload {
  const raw = exact(value, [
    "fulfillmentReference",
    "orderReference",
    "handoffRecordReference",
    "storeReference",
    "verificationMethod",
    "completedAt",
  ]);
  if (raw.verificationMethod !== "Opaque" && raw.verificationMethod !== "HumanCode")
    return invalid();
  return Object.freeze({
    fulfillmentReference: parseOrderingReference(raw.fulfillmentReference),
    orderReference: parseOrderingReference(raw.orderReference),
    handoffRecordReference: parseOrderingReference(raw.handoffRecordReference),
    storeReference: parseOrderingReference(raw.storeReference),
    verificationMethod: raw.verificationMethod,
    completedAt: parseOrderingInstant(raw.completedAt),
  });
}
export function parseFulfillmentCompletedEnvelope(value: unknown): FulfillmentCompletedEnvelope {
  try {
    const envelope = validateDomainEventEnvelope(value as FulfillmentCompletedEnvelope);
    const parsedPayload = payload(envelope.payload);
    if (
      envelope.eventType !== "FulfillmentCompleted" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/fulfillment" ||
      envelope.storeId === undefined ||
      envelope.aggregateType !== "Fulfillment" ||
      envelope.aggregateId !== parsedPayload.fulfillmentReference ||
      envelope.storeId !== parsedPayload.storeReference ||
      envelope.occurredAt !== parsedPayload.completedAt ||
      envelope.actor.type !== "System" ||
      envelope.redactionClassification !== "indirect_identifier" ||
      envelope.replayMetadata.replaySafe !== true ||
      Object.keys(envelope.replayMetadata).length !== 1
    )
      return invalid();
    return Object.freeze({ ...envelope, payload: parsedPayload }) as FulfillmentCompletedEnvelope;
  } catch (error) {
    if (error instanceof OrderingFulfillmentCompletedEventError) throw error;
    return invalid();
  }
}
