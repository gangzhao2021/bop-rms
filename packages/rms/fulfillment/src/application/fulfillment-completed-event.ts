import { isProxy } from "node:util/types";
import { validateDomainEventEnvelope } from "@bop/eventing";
import {
  FulfillmentCompletedEventError,
  type FulfillmentCompletedEnvelope,
  type FulfillmentCompletedPayload,
  type FulfillmentCompletionPublication,
} from "../contracts/fulfillment-completed-event.js";
import { parsePickupProofInstant, parsePickupProofReference } from "../domain/pickup-proof.js";

const maximumBigint = 9_223_372_036_854_775_807n;
function invalid(): never {
  throw new FulfillmentCompletedEventError();
}
function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      value === null ||
      typeof value !== "object" ||
      isProxy(value) ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      return invalid();
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key)) ||
      fields.some((field) => {
        const descriptor = descriptors[field];
        return (
          descriptor === undefined ||
          !("value" in descriptor) ||
          descriptor.get !== undefined ||
          descriptor.set !== undefined ||
          !descriptor.enumerable
        );
      })
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(fields.map((field) => [field, descriptors[field]?.value])),
    );
  } catch (error) {
    if (error instanceof FulfillmentCompletedEventError) throw error;
    return invalid();
  }
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
    fulfillmentReference: parsePickupProofReference(raw.fulfillmentReference),
    orderReference: parsePickupProofReference(raw.orderReference),
    handoffRecordReference: parsePickupProofReference(raw.handoffRecordReference),
    storeReference: parsePickupProofReference(raw.storeReference),
    verificationMethod: raw.verificationMethod,
    completedAt: parsePickupProofInstant(raw.completedAt),
  });
}

export function parseFulfillmentCompletedEnvelope(value: unknown): FulfillmentCompletedEnvelope {
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
    if (
      typeof raw.aggregateVersion !== "bigint" ||
      raw.aggregateVersion < 1n ||
      raw.aggregateVersion > maximumBigint
    )
      return invalid();
    const candidate = Object.freeze({
      eventId: parsePickupProofReference(raw.eventId),
      eventType: raw.eventType,
      schemaVersion: raw.schemaVersion,
      occurredAt: parsePickupProofInstant(raw.occurredAt),
      producerModule: raw.producerModule,
      tenantId: parsePickupProofReference(raw.tenantId),
      storeId: parsePickupProofReference(raw.storeId),
      aggregateType: raw.aggregateType,
      aggregateId: parsePickupProofReference(raw.aggregateId),
      aggregateVersion: raw.aggregateVersion,
      correlationId: parsePickupProofReference(raw.correlationId),
      causationId: parsePickupProofReference(raw.causationId),
      actor: Object.freeze({ type: actor.type }),
      payload: parsedPayload,
      redactionClassification: raw.redactionClassification,
      replayMetadata: Object.freeze({ replaySafe: replay.replaySafe }),
    }) as FulfillmentCompletedEnvelope;
    validateDomainEventEnvelope(candidate);
    if (
      candidate.eventType !== "FulfillmentCompleted" ||
      candidate.schemaVersion !== 1 ||
      candidate.producerModule !== "@rms/fulfillment" ||
      candidate.aggregateType !== "Fulfillment" ||
      candidate.aggregateId !== candidate.payload.fulfillmentReference ||
      candidate.storeId !== candidate.payload.storeReference ||
      candidate.occurredAt !== candidate.payload.completedAt ||
      candidate.actor.type !== "System" ||
      candidate.redactionClassification !== "indirect_identifier" ||
      candidate.replayMetadata.replaySafe !== true
    )
      return invalid();
    const identities = [
      candidate.eventId,
      candidate.tenantId,
      candidate.storeId,
      candidate.aggregateId,
      candidate.payload.orderReference,
      candidate.payload.handoffRecordReference,
      candidate.correlationId,
      candidate.causationId,
    ];
    if (new Set(identities).size !== identities.length) return invalid();
    return candidate;
  } catch (error) {
    if (error instanceof FulfillmentCompletedEventError) throw error;
    return invalid();
  }
}

export function fulfillmentCompletedSemanticBinding(value: unknown): string {
  const event = parseFulfillmentCompletedEnvelope(value);
  return JSON.stringify({
    eventId: event.eventId,
    eventType: event.eventType,
    schemaVersion: event.schemaVersion,
    occurredAt: event.occurredAt,
    producerModule: event.producerModule,
    tenantId: event.tenantId,
    storeId: event.storeId,
    aggregateType: event.aggregateType,
    aggregateId: event.aggregateId,
    aggregateVersion: event.aggregateVersion.toString(10),
    correlationId: event.correlationId,
    causationId: event.causationId,
    actor: { type: event.actor.type },
    payload: event.payload,
    redactionClassification: event.redactionClassification,
    replayMetadata: { replaySafe: true },
  });
}

export function createFulfillmentCompletionPublication(
  input: unknown,
): FulfillmentCompletionPublication {
  const raw = exact(input, [
    "publicationReference",
    "eventReference",
    "brandReference",
    "storeReference",
    "fulfillmentReference",
    "orderReference",
    "aggregateVersion",
    "handoffRecordReference",
    "verificationMethod",
    "completedAt",
    "correlationReference",
    "causationReference",
    "completionPhase",
  ]);
  if (raw.completionPhase !== "Completed") return invalid();
  const event = parseFulfillmentCompletedEnvelope({
    eventId: raw.eventReference,
    eventType: "FulfillmentCompleted",
    schemaVersion: 1,
    occurredAt: raw.completedAt,
    producerModule: "@rms/fulfillment",
    tenantId: raw.brandReference,
    storeId: raw.storeReference,
    aggregateType: "Fulfillment",
    aggregateId: raw.fulfillmentReference,
    aggregateVersion: raw.aggregateVersion,
    correlationId: raw.correlationReference,
    causationId: raw.causationReference,
    actor: { type: "System" },
    payload: {
      fulfillmentReference: raw.fulfillmentReference,
      orderReference: raw.orderReference,
      handoffRecordReference: raw.handoffRecordReference,
      storeReference: raw.storeReference,
      verificationMethod: raw.verificationMethod,
      completedAt: raw.completedAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
  const publicationReference = parsePickupProofReference(raw.publicationReference);
  if (
    [event.eventId, event.aggregateId, event.payload.handoffRecordReference].includes(
      publicationReference,
    )
  )
    return invalid();
  return Object.freeze({
    publicationReference,
    event,
    semanticBinding: fulfillmentCompletedSemanticBinding(event),
  });
}
