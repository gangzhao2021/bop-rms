import { isProxy } from "node:util/types";

import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  kitchenReworkCancelReasons,
  kitchenReworkReasons,
  type KitchenReworkCancelledEnvelope,
  type KitchenReworkCancelledPayload,
  type KitchenReworkCancelReason,
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

function parsePayload(value: unknown): KitchenReworkCancelledPayload {
  const raw = exact(value, [
    "kitchenReworkItemReference",
    "kitchenTicketReference",
    "originalKitchenWorkItemReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "reasonCode",
    "cancelReasonCode",
    "quantity",
    "wasteApplies",
    "createdEventReference",
    "cancelledAt",
  ]);
  if (
    !kitchenReworkReasons.includes(raw.reasonCode as KitchenReworkReason) ||
    !kitchenReworkCancelReasons.includes(raw.cancelReasonCode as KitchenReworkCancelReason)
  )
    return invalid();
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
    cancelReasonCode: raw.cancelReasonCode as KitchenReworkCancelReason,
    quantity: Number(raw.quantity),
    wasteApplies: raw.wasteApplies,
    createdEventReference: parseKitchenTicketReference(raw.createdEventReference),
    cancelledAt: parseKitchenTicketInstant(raw.cancelledAt),
  });
}

/**
 * Strict parser for the `KitchenReworkCancelled` v1 outbox event (DEC-KITCHEN-REWORK cancel). The
 * aggregate version is the cancelled remake's version (2 or 3). Inventory reads the cancel reason
 * and the creation event to decide whether the remake's waste is voided.
 */
export function parseKitchenReworkCancelledEnvelope(
  value: unknown,
): KitchenReworkCancelledEnvelope {
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
      raw.eventType !== "KitchenReworkCancelled" ||
      raw.schemaVersion !== 1 ||
      raw.producerModule !== "@rms/kitchen" ||
      raw.aggregateType !== "KitchenReworkItem" ||
      raw.redactionClassification !== "personal" ||
      actor.type !== "Actor" ||
      replayMetadata.replaySafe !== true ||
      (raw.aggregateVersion !== 2n && raw.aggregateVersion !== 3n)
    )
      return invalid();
    const payload = parsePayload(raw.payload);
    const candidate = Object.freeze({
      eventId: parseKitchenTicketReference(raw.eventId),
      eventType: "KitchenReworkCancelled" as const,
      schemaVersion: 1 as const,
      occurredAt: parseKitchenTicketInstant(raw.occurredAt),
      producerModule: "@rms/kitchen" as const,
      tenantId: parseKitchenTicketReference(raw.tenantId),
      storeId: parseKitchenTicketReference(raw.storeId),
      aggregateType: "KitchenReworkItem" as const,
      aggregateId: parseKitchenTicketReference(raw.aggregateId),
      aggregateVersion: raw.aggregateVersion as bigint,
      correlationId: parseKitchenTicketReference(raw.correlationId),
      causationId: parseKitchenTicketReference(raw.causationId),
      actor: Object.freeze({
        type: "Actor" as const,
        actorId: parseKitchenTicketReference(actor.actorId),
      }),
      payload,
      redactionClassification: "personal" as const,
      replayMetadata: Object.freeze({ replaySafe: true as const }),
    }) satisfies KitchenReworkCancelledEnvelope;
    validateDomainEventEnvelope(candidate);
    if (
      candidate.aggregateId !== payload.kitchenReworkItemReference ||
      candidate.occurredAt !== payload.cancelledAt ||
      candidate.eventId === candidate.causationId ||
      candidate.eventId === candidate.aggregateId ||
      candidate.eventId === payload.createdEventReference
    )
      return invalid();
    return candidate;
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleEventError) throw error;
    return invalid();
  }
}

export function createKitchenReworkCancelledEnvelope(input: {
  readonly eventReference: string;
  readonly operationReference: string;
  readonly correlationReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly version: number;
  readonly payload: KitchenReworkCancelledPayload;
}): KitchenReworkCancelledEnvelope {
  return parseKitchenReworkCancelledEnvelope({
    eventId: input.eventReference,
    eventType: "KitchenReworkCancelled",
    schemaVersion: 1,
    occurredAt: input.payload.cancelledAt,
    producerModule: "@rms/kitchen",
    tenantId: input.brandReference,
    storeId: input.storeReference,
    aggregateType: "KitchenReworkItem",
    aggregateId: input.payload.kitchenReworkItemReference,
    aggregateVersion: BigInt(input.version),
    correlationId: input.correlationReference,
    causationId: input.operationReference,
    actor: { type: "Actor", actorId: input.actorReference },
    payload: input.payload,
    redactionClassification: "personal",
    replayMetadata: { replaySafe: true },
  });
}
