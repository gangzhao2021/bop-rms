import { parseOrderConfirmedEnvelope, type OrderConfirmedEnvelope } from "@rms/ordering";

import {
  confirmedOrderConsumerName,
  confirmedOrderConsumerVersion,
  ConfirmedOrderIntakeError,
  type ConfirmedOrderIntakeReceipt,
  type KitchenDigest,
  type KitchenInstant,
  type KitchenReference,
} from "../contracts/confirmed-order-intake.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;

function invalid(): never {
  throw new ConfirmedOrderIntakeError("KITCHEN_CONFIRMED_ORDER_INPUT_INVALID");
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
}

export function parseKitchenReference(value: unknown): KitchenReference {
  if (typeof value !== "string" || !uuidV7.test(value)) return invalid();
  return value as KitchenReference;
}

export function parseKitchenInstant(value: unknown): KitchenInstant {
  if (typeof value !== "string" || !instant.test(value) || new Date(value).toISOString() !== value)
    return invalid();
  return value as KitchenInstant;
}

export function parseKitchenDigest(value: unknown): KitchenDigest {
  if (typeof value !== "string" || !digest.test(value)) return invalid();
  return value as KitchenDigest;
}

export function parseConfirmedOrderSourceEvent(value: unknown): OrderConfirmedEnvelope {
  try {
    return parseOrderConfirmedEnvelope(value);
  } catch {
    return invalid();
  }
}

export function createConfirmedOrderSemanticEventBinding(value: unknown): string {
  const event = parseConfirmedOrderSourceEvent(value);
  return JSON.stringify({
    consumerName: confirmedOrderConsumerName,
    consumerVersion: confirmedOrderConsumerVersion,
    sourceEventWithoutEventId: {
      eventType: event.eventType,
      schemaVersion: event.schemaVersion,
      occurredAt: event.occurredAt,
      producerModule: event.producerModule,
      tenantId: event.tenantId,
      storeId: event.storeId,
      aggregateType: event.aggregateType,
      aggregateId: event.aggregateId,
      aggregateVersion: String(event.aggregateVersion),
      correlationId: event.correlationId,
      causationId: event.causationId,
      actor: { type: "System" },
      payload: {
        confirmationReference: event.payload.confirmationReference,
        orderReference: event.payload.orderReference,
        orderBatchReference: event.payload.orderBatchReference,
        sourceSnapshotDigest: event.payload.sourceSnapshotDigest,
        confirmedAt: event.payload.confirmedAt,
      },
      redactionClassification: event.redactionClassification,
      replayMetadata: { replaySafe: true },
    },
  });
}

export function createConfirmedOrderIntakeReceipt(input: {
  readonly sourceEvent: unknown;
  readonly semanticEventBindingDigest: unknown;
}): ConfirmedOrderIntakeReceipt {
  try {
    const raw = exact(input, ["sourceEvent", "semanticEventBindingDigest"]);
    const event = parseConfirmedOrderSourceEvent(raw.sourceEvent);
    return Object.freeze({
      consumerName: confirmedOrderConsumerName,
      consumerVersion: confirmedOrderConsumerVersion,
      sourceEventReference: parseKitchenReference(event.eventId),
      brandReference: parseKitchenReference(event.tenantId),
      storeReference: parseKitchenReference(event.storeId),
      orderReference: parseKitchenReference(event.payload.orderReference),
      orderBatchReference: parseKitchenReference(event.payload.orderBatchReference),
      confirmationReference: parseKitchenReference(event.payload.confirmationReference),
      sourceAggregateVersion: event.aggregateVersion,
      sourceSnapshotDigest: parseKitchenDigest(event.payload.sourceSnapshotDigest),
      confirmedAt: parseKitchenInstant(event.payload.confirmedAt),
      correlationReference: parseKitchenReference(event.correlationId),
      semanticEventBindingDigest: parseKitchenDigest(raw.semanticEventBindingDigest),
    });
  } catch (error) {
    if (error instanceof ConfirmedOrderIntakeError) throw error;
    return invalid();
  }
}

export function parseConfirmedOrderIntakeReceipt(value: unknown): ConfirmedOrderIntakeReceipt {
  try {
    const raw = exact(value, [
      "consumerName",
      "consumerVersion",
      "sourceEventReference",
      "brandReference",
      "storeReference",
      "orderReference",
      "orderBatchReference",
      "confirmationReference",
      "sourceAggregateVersion",
      "sourceSnapshotDigest",
      "confirmedAt",
      "correlationReference",
      "semanticEventBindingDigest",
    ]);
    if (
      raw.consumerName !== confirmedOrderConsumerName ||
      raw.consumerVersion !== confirmedOrderConsumerVersion ||
      typeof raw.sourceAggregateVersion !== "bigint" ||
      raw.sourceAggregateVersion <= 0n
    )
      return invalid();
    return Object.freeze({
      consumerName: confirmedOrderConsumerName,
      consumerVersion: confirmedOrderConsumerVersion,
      sourceEventReference: parseKitchenReference(raw.sourceEventReference),
      brandReference: parseKitchenReference(raw.brandReference),
      storeReference: parseKitchenReference(raw.storeReference),
      orderReference: parseKitchenReference(raw.orderReference),
      orderBatchReference: parseKitchenReference(raw.orderBatchReference),
      confirmationReference: parseKitchenReference(raw.confirmationReference),
      sourceAggregateVersion: raw.sourceAggregateVersion,
      sourceSnapshotDigest: parseKitchenDigest(raw.sourceSnapshotDigest),
      confirmedAt: parseKitchenInstant(raw.confirmedAt),
      correlationReference: parseKitchenReference(raw.correlationReference),
      semanticEventBindingDigest: parseKitchenDigest(raw.semanticEventBindingDigest),
    });
  } catch (error) {
    if (error instanceof ConfirmedOrderIntakeError) throw error;
    return invalid();
  }
}

export function confirmedOrderReceiptsMatchExact(
  left: ConfirmedOrderIntakeReceipt,
  right: ConfirmedOrderIntakeReceipt,
): boolean {
  return (
    left.consumerName === right.consumerName &&
    left.consumerVersion === right.consumerVersion &&
    left.sourceEventReference === right.sourceEventReference &&
    confirmedOrderReceiptsMatchSemantic(left, right)
  );
}

export function confirmedOrderReceiptsMatchSemantic(
  left: ConfirmedOrderIntakeReceipt,
  right: ConfirmedOrderIntakeReceipt,
): boolean {
  return (
    left.consumerName === right.consumerName &&
    left.consumerVersion === right.consumerVersion &&
    left.brandReference === right.brandReference &&
    left.storeReference === right.storeReference &&
    left.orderReference === right.orderReference &&
    left.orderBatchReference === right.orderBatchReference &&
    left.confirmationReference === right.confirmationReference &&
    left.sourceAggregateVersion === right.sourceAggregateVersion &&
    left.sourceSnapshotDigest === right.sourceSnapshotDigest &&
    left.confirmedAt === right.confirmedAt &&
    left.correlationReference === right.correlationReference &&
    left.semanticEventBindingDigest === right.semanticEventBindingDigest
  );
}
