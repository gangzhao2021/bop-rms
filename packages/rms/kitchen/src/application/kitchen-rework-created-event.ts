import { isProxy } from "node:util/types";

import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  kitchenReworkReasons,
  type KitchenReworkCreatedEnvelope,
  type KitchenReworkCreatedPayload,
  type KitchenReworkReason,
} from "../contracts/kitchen-rework.js";
import { KitchenWorkLifecycleEventError } from "../contracts/kitchen-work-lifecycle-events.js";
import { kitchenReworkWasteApplies } from "../domain/kitchen-rework.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";

function invalid(): never {
  throw new KitchenWorkLifecycleEventError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
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
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable)
      return invalid();
    result[field] = descriptor.value;
  }
  return Object.freeze(result);
}

function parsePayload(value: unknown): KitchenReworkCreatedPayload {
  const raw = exact(value, [
    "kitchenReworkItemReference",
    "kitchenTicketReference",
    "originalKitchenWorkItemReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "reasonCode",
    "quantity",
    "wasteApplies",
    "createdAt",
  ]);
  if (!kitchenReworkReasons.includes(raw.reasonCode as KitchenReworkReason)) return invalid();
  const reasonCode = raw.reasonCode as KitchenReworkReason;
  if (
    !Number.isSafeInteger(raw.quantity) ||
    Number(raw.quantity) < 1 ||
    Number(raw.quantity) > 999 ||
    raw.wasteApplies !== kitchenReworkWasteApplies(reasonCode)
  )
    return invalid();
  return Object.freeze({
    kitchenReworkItemReference: parseKitchenTicketReference(raw.kitchenReworkItemReference),
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    originalKitchenWorkItemReference: parseKitchenTicketReference(
      raw.originalKitchenWorkItemReference,
    ),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    reasonCode,
    quantity: Number(raw.quantity),
    wasteApplies: raw.wasteApplies,
    createdAt: parseKitchenTicketInstant(raw.createdAt),
  });
}

/**
 * Strict parser for the `KitchenReworkCreated` v1 outbox event (WP-2423 Q26). The payload carries
 * no staff note, customer or health fact; Inventory reads the reason to decide on waste.
 */
export function parseKitchenReworkCreatedEnvelope(value: unknown): KitchenReworkCreatedEnvelope {
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
    const actor = exact(raw.actor, ["type", "actorId"]);
    const replayMetadata = exact(raw.replayMetadata, ["replaySafe"]);
    if (
      raw.eventType !== "KitchenReworkCreated" ||
      raw.schemaVersion !== 1 ||
      raw.producerModule !== "@rms/kitchen" ||
      raw.aggregateType !== "KitchenReworkItem" ||
      raw.redactionClassification !== "personal" ||
      actor.type !== "Actor" ||
      replayMetadata.replaySafe !== true ||
      raw.aggregateVersion !== 1n
    )
      return invalid();
    const payload = parsePayload(raw.payload);
    const candidate = Object.freeze({
      eventId: parseKitchenTicketReference(raw.eventId),
      eventType: "KitchenReworkCreated" as const,
      schemaVersion: 1 as const,
      occurredAt: parseKitchenTicketInstant(raw.occurredAt),
      producerModule: "@rms/kitchen" as const,
      tenantId: parseKitchenTicketReference(raw.tenantId),
      storeId: parseKitchenTicketReference(raw.storeId),
      aggregateType: "KitchenReworkItem" as const,
      aggregateId: parseKitchenTicketReference(raw.aggregateId),
      aggregateVersion: 1n,
      correlationId: parseKitchenTicketReference(raw.correlationId),
      causationId: parseKitchenTicketReference(raw.causationId),
      actor: Object.freeze({
        type: "Actor" as const,
        actorId: parseKitchenTicketReference(actor.actorId),
      }),
      payload,
      redactionClassification: "personal" as const,
      replayMetadata: Object.freeze({ replaySafe: true as const }),
    }) satisfies KitchenReworkCreatedEnvelope;
    validateDomainEventEnvelope(candidate);
    if (
      candidate.aggregateId !== payload.kitchenReworkItemReference ||
      candidate.occurredAt !== payload.createdAt ||
      candidate.eventId === candidate.causationId ||
      candidate.eventId === candidate.aggregateId
    )
      return invalid();
    return candidate;
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleEventError) throw error;
    return invalid();
  }
}

export function createKitchenReworkCreatedEnvelope(input: {
  readonly eventReference: string;
  readonly operationReference: string;
  readonly correlationReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly payload: KitchenReworkCreatedPayload;
}): KitchenReworkCreatedEnvelope {
  return parseKitchenReworkCreatedEnvelope({
    eventId: input.eventReference,
    eventType: "KitchenReworkCreated",
    schemaVersion: 1,
    occurredAt: input.payload.createdAt,
    producerModule: "@rms/kitchen",
    tenantId: input.brandReference,
    storeId: input.storeReference,
    aggregateType: "KitchenReworkItem",
    aggregateId: input.payload.kitchenReworkItemReference,
    aggregateVersion: 1n,
    correlationId: input.correlationReference,
    causationId: input.operationReference,
    actor: { type: "Actor", actorId: input.actorReference },
    payload: input.payload,
    redactionClassification: "personal",
    replayMetadata: { replaySafe: true },
  });
}
