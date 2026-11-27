import { isProxy } from "node:util/types";

import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  kitchenStaleTicketCloseReasons,
  kitchenStaleTicketFoodMade,
  parseKitchenBusinessDate,
  type KitchenStaleTicketCloseReason,
  type KitchenTicketClosedEnvelope,
  type KitchenTicketClosedPayload,
  type KitchenTicketClosedWorkItem,
} from "../contracts/kitchen-stale-ticket.js";
import { KitchenWorkLifecycleEventError } from "../contracts/kitchen-work-lifecycle-events.js";
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

const quantity = (value: unknown, minimum: number) => {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > 999)
    return invalid();
  return Number(value);
};

function parseWorkItem(value: unknown): KitchenTicketClosedWorkItem {
  const raw = exact(value, [
    "kitchenWorkItemReference",
    "orderItemReference",
    "status",
    "requiredQuantity",
    "completedQuantity",
  ]);
  if (!["Queued", "Held", "In Progress", "Completed"].includes(String(raw.status)))
    return invalid();
  const requiredQuantity = quantity(raw.requiredQuantity, 1);
  const completedQuantity = quantity(raw.completedQuantity, 0);
  if (completedQuantity > requiredQuantity) return invalid();
  return Object.freeze({
    kitchenWorkItemReference: parseKitchenTicketReference(raw.kitchenWorkItemReference),
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    status: raw.status as KitchenTicketClosedWorkItem["status"],
    requiredQuantity,
    completedQuantity,
  });
}

function parsePayload(value: unknown): KitchenTicketClosedPayload {
  const raw = exact(value, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "reasonCode",
    "foodMade",
    "orderBusinessDate",
    "ticketVersion",
    "openWorkItems",
    "closedAt",
  ]);
  if (!kitchenStaleTicketCloseReasons.includes(raw.reasonCode as KitchenStaleTicketCloseReason))
    return invalid();
  const reasonCode = raw.reasonCode as KitchenStaleTicketCloseReason;
  if (
    raw.foodMade !== kitchenStaleTicketFoodMade(reasonCode) ||
    typeof raw.ticketVersion !== "string" ||
    !/^[1-9][0-9]{0,18}$/u.test(raw.ticketVersion) ||
    !Array.isArray(raw.openWorkItems) ||
    raw.openWorkItems.length > 100
  )
    return invalid();
  const openWorkItems = Object.freeze(raw.openWorkItems.map(parseWorkItem));
  if (
    new Set(openWorkItems.map((item) => item.kitchenWorkItemReference)).size !==
    openWorkItems.length
  )
    return invalid();
  let orderBusinessDate: string;
  try {
    orderBusinessDate = parseKitchenBusinessDate(raw.orderBusinessDate);
  } catch {
    return invalid();
  }
  return Object.freeze({
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    reasonCode,
    foodMade: raw.foodMade,
    orderBusinessDate,
    ticketVersion: raw.ticketVersion,
    openWorkItems,
    closedAt: parseKitchenTicketInstant(raw.closedAt),
  });
}

/**
 * Strict parser for the `KitchenTicketClosed` v1 outbox event (DEC-KITCHEN-STALE-TICKETS). The
 * Kitchen queue refreshes on it; Inventory records the ingredients of the open work as used when
 * the food was made (`foodMade`), exactly as a completed dish would.
 */
export function parseKitchenTicketClosedEnvelope(value: unknown): KitchenTicketClosedEnvelope {
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
      raw.eventType !== "KitchenTicketClosed" ||
      raw.schemaVersion !== 1 ||
      raw.producerModule !== "@rms/kitchen" ||
      raw.aggregateType !== "KitchenTicket" ||
      raw.redactionClassification !== "personal" ||
      actor.type !== "Actor" ||
      replayMetadata.replaySafe !== true ||
      typeof raw.aggregateVersion !== "bigint"
    )
      return invalid();
    const payload = parsePayload(raw.payload);
    const candidate = Object.freeze({
      eventId: parseKitchenTicketReference(raw.eventId),
      eventType: "KitchenTicketClosed" as const,
      schemaVersion: 1 as const,
      occurredAt: parseKitchenTicketInstant(raw.occurredAt),
      producerModule: "@rms/kitchen" as const,
      tenantId: parseKitchenTicketReference(raw.tenantId),
      storeId: parseKitchenTicketReference(raw.storeId),
      aggregateType: "KitchenTicket" as const,
      aggregateId: parseKitchenTicketReference(raw.aggregateId),
      aggregateVersion: raw.aggregateVersion,
      correlationId: parseKitchenTicketReference(raw.correlationId),
      causationId: parseKitchenTicketReference(raw.causationId),
      actor: Object.freeze({
        type: "Actor" as const,
        actorId: parseKitchenTicketReference(actor.actorId),
      }),
      payload,
      redactionClassification: "personal" as const,
      replayMetadata: Object.freeze({ replaySafe: true as const }),
    }) satisfies KitchenTicketClosedEnvelope;
    validateDomainEventEnvelope(candidate);
    if (
      candidate.aggregateId !== payload.kitchenTicketReference ||
      candidate.aggregateVersion.toString(10) !== payload.ticketVersion ||
      candidate.occurredAt !== payload.closedAt ||
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

export function createKitchenTicketClosedEnvelope(input: {
  readonly eventReference: string;
  readonly closureReference: string;
  readonly correlationReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly payload: KitchenTicketClosedPayload;
}): KitchenTicketClosedEnvelope {
  return parseKitchenTicketClosedEnvelope({
    eventId: input.eventReference,
    eventType: "KitchenTicketClosed",
    schemaVersion: 1,
    occurredAt: input.payload.closedAt,
    producerModule: "@rms/kitchen",
    tenantId: input.brandReference,
    storeId: input.storeReference,
    aggregateType: "KitchenTicket",
    aggregateId: input.payload.kitchenTicketReference,
    aggregateVersion: BigInt(input.payload.ticketVersion),
    correlationId: input.correlationReference,
    causationId: input.closureReference,
    actor: { type: "Actor", actorId: input.actorReference },
    payload: input.payload,
    redactionClassification: "personal",
    replayMetadata: { replaySafe: true },
  });
}
