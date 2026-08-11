import { isProxy } from "node:util/types";

import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  KitchenReadyEventError,
  type KitchenItemReadyEnvelope,
  type KitchenItemReadyPayload,
  type KitchenOrderReadyEnvelope,
  type KitchenOrderReadyPayload,
  type KitchenReadyEnvelope,
  type KitchenReadyEventBundle,
} from "../contracts/kitchen-ready-events.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";

const postgresqlBigintMaximum = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new KitchenReadyEventError();
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
    if (error instanceof KitchenReadyEventError) throw error;
    return invalid();
  }
}

function count(value: unknown, maximum = 100): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function version(value: unknown): bigint {
  if (typeof value !== "bigint" || value < 1n || value > postgresqlBigintMaximum) return invalid();
  return value;
}

function parseItemPayload(value: unknown): KitchenItemReadyPayload {
  const raw = exact(value, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "readyResultReference",
    "readyQuantity",
    "requiredQuantity",
    "readyAt",
  ]);
  const requiredQuantity = count(raw.requiredQuantity, 999);
  const readyQuantity = count(raw.readyQuantity, requiredQuantity);
  if (readyQuantity !== requiredQuantity) return invalid();
  return Object.freeze({
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    readyResultReference: parseKitchenTicketReference(raw.readyResultReference),
    readyQuantity,
    requiredQuantity,
    readyAt: parseKitchenTicketInstant(raw.readyAt),
  });
}

function parseOrderPayload(value: unknown): KitchenOrderReadyPayload {
  const raw = exact(value, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "readyItemCount",
    "itemCount",
    "readyAt",
  ]);
  const itemCount = count(raw.itemCount);
  const readyItemCount = count(raw.readyItemCount, itemCount);
  if (readyItemCount !== itemCount) return invalid();
  return Object.freeze({
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    readyItemCount,
    itemCount,
    readyAt: parseKitchenTicketInstant(raw.readyAt),
  });
}

export function parseKitchenReadyEnvelope(value: unknown): KitchenReadyEnvelope {
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
    const replayMetadata = exact(raw.replayMetadata, ["replaySafe"]);
    if (actor.type !== "System" || replayMetadata.replaySafe !== true) return invalid();
    const payload =
      raw.eventType === "KitchenItemReady"
        ? parseItemPayload(raw.payload)
        : raw.eventType === "KitchenOrderReady"
          ? parseOrderPayload(raw.payload)
          : invalid();
    const candidate = Object.freeze({
      eventId: parseKitchenTicketReference(raw.eventId),
      eventType: raw.eventType,
      schemaVersion: raw.schemaVersion,
      occurredAt: parseKitchenTicketInstant(raw.occurredAt),
      producerModule: raw.producerModule,
      tenantId: parseKitchenTicketReference(raw.tenantId),
      storeId: parseKitchenTicketReference(raw.storeId),
      aggregateType: raw.aggregateType,
      aggregateId: parseKitchenTicketReference(raw.aggregateId),
      aggregateVersion: version(raw.aggregateVersion),
      correlationId: parseKitchenTicketReference(raw.correlationId),
      causationId: parseKitchenTicketReference(raw.causationId),
      actor: Object.freeze({ type: "System" as const }),
      payload,
      redactionClassification: raw.redactionClassification,
      replayMetadata: Object.freeze({ replaySafe: true as const }),
    }) as KitchenReadyEnvelope;
    validateDomainEventEnvelope(candidate);
    const commonInvalid =
      candidate.schemaVersion !== 1 ||
      candidate.producerModule !== "@rms/kitchen" ||
      candidate.occurredAt !== candidate.payload.readyAt ||
      candidate.redactionClassification !== "indirect_identifier";
    if (commonInvalid) return invalid();
    if (candidate.eventType === "KitchenItemReady") {
      if (
        candidate.aggregateType !== "KitchenOrderItemReadyResult" ||
        candidate.aggregateId !== candidate.payload.readyResultReference ||
        candidate.aggregateVersion !== 1n
      )
        return invalid();
    } else if (
      candidate.aggregateType !== "KitchenTicket" ||
      candidate.aggregateId !== candidate.payload.kitchenTicketReference
    )
      return invalid();
    const observedReferences = [
      candidate.tenantId,
      candidate.storeId,
      candidate.correlationId,
      candidate.causationId,
      candidate.payload.kitchenTicketReference,
      candidate.payload.orderReference,
      candidate.payload.orderBatchReference,
      ...(candidate.eventType === "KitchenItemReady"
        ? [candidate.payload.orderItemReference, candidate.payload.readyResultReference]
        : []),
    ];
    if (
      new Set(observedReferences).size !== observedReferences.length ||
      observedReferences.includes(candidate.eventId)
    )
      return invalid();
    return candidate;
  } catch (error) {
    if (error instanceof KitchenReadyEventError) throw error;
    return invalid();
  }
}

export function parseKitchenItemReadyEnvelope(value: unknown): KitchenItemReadyEnvelope {
  const event = parseKitchenReadyEnvelope(value);
  if (event.eventType !== "KitchenItemReady") return invalid();
  return event;
}

export function parseKitchenOrderReadyEnvelope(value: unknown): KitchenOrderReadyEnvelope {
  const event = parseKitchenReadyEnvelope(value);
  if (event.eventType !== "KitchenOrderReady") return invalid();
  return event;
}

export function createKitchenReadyEventSemanticBinding(value: unknown): string {
  const event = parseKitchenReadyEnvelope(value);
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
    replayMetadata: { replaySafe: event.replayMetadata.replaySafe },
  });
}

export function createKitchenReadyEventBundle(input: unknown): KitchenReadyEventBundle {
  const raw = exact(input, [
    "itemEventReference",
    "orderEventReference",
    "brandReference",
    "storeReference",
    "ticketReference",
    "ticketVersion",
    "orderReference",
    "orderBatchReference",
    "orderItemReference",
    "readyResultReference",
    "readyQuantity",
    "requiredQuantity",
    "readyAt",
    "correlationReference",
    "causationReference",
    "readiness",
  ]);
  if (!Array.isArray(raw.readiness) || raw.readiness.length < 1 || raw.readiness.length > 100)
    return invalid();
  const readiness = raw.readiness.map((value) => {
    const entry = exact(value, [
      "orderItemReference",
      "requiredQuantity",
      "readyResultReference",
      "readyQuantity",
      "readyAt",
    ]);
    const requiredQuantity = count(entry.requiredQuantity, 999);
    const readyResultReference =
      entry.readyResultReference === null
        ? null
        : parseKitchenTicketReference(entry.readyResultReference);
    const readyQuantity = entry.readyQuantity === null ? null : count(entry.readyQuantity, 999);
    const readyAt = entry.readyAt === null ? null : parseKitchenTicketInstant(entry.readyAt);
    if (
      (readyResultReference === null) !== (readyQuantity === null) ||
      (readyResultReference === null) !== (readyAt === null) ||
      (readyQuantity !== null && readyQuantity !== requiredQuantity)
    )
      return invalid();
    return Object.freeze({
      orderItemReference: parseKitchenTicketReference(entry.orderItemReference),
      requiredQuantity,
      readyResultReference,
      readyQuantity,
      readyAt,
    });
  });
  const orderItems = readiness.map((entry) => entry.orderItemReference);
  if (
    new Set(orderItems).size !== orderItems.length ||
    orderItems.some((value, index) => index > 0 && value <= (orderItems[index - 1] as string))
  )
    return invalid();
  const current = readiness.find((entry) => entry.orderItemReference === raw.orderItemReference);
  if (
    current === undefined ||
    current.readyResultReference !== raw.readyResultReference ||
    current.requiredQuantity !== raw.requiredQuantity ||
    current.readyQuantity !== raw.readyQuantity ||
    current.readyAt !== raw.readyAt
  )
    return invalid();
  const itemEvent = parseKitchenItemReadyEnvelope({
    eventId: raw.itemEventReference,
    eventType: "KitchenItemReady",
    schemaVersion: 1,
    occurredAt: raw.readyAt,
    producerModule: "@rms/kitchen",
    tenantId: raw.brandReference,
    storeId: raw.storeReference,
    aggregateType: "KitchenOrderItemReadyResult",
    aggregateId: raw.readyResultReference,
    aggregateVersion: 1n,
    correlationId: raw.correlationReference,
    causationId: raw.causationReference,
    actor: { type: "System" },
    payload: {
      kitchenTicketReference: raw.ticketReference,
      orderReference: raw.orderReference,
      orderBatchReference: raw.orderBatchReference,
      orderItemReference: raw.orderItemReference,
      readyResultReference: raw.readyResultReference,
      readyQuantity: raw.readyQuantity,
      requiredQuantity: raw.requiredQuantity,
      readyAt: raw.readyAt,
    },
    redactionClassification: "indirect_identifier",
    replayMetadata: { replaySafe: true },
  });
  const allReady = readiness.every((entry) => entry.readyResultReference !== null);
  if (allReady !== (raw.orderEventReference !== null)) return invalid();
  const orderEvent =
    raw.orderEventReference === null
      ? null
      : parseKitchenOrderReadyEnvelope({
          eventId: raw.orderEventReference,
          eventType: "KitchenOrderReady",
          schemaVersion: 1,
          occurredAt: raw.readyAt,
          producerModule: "@rms/kitchen",
          tenantId: raw.brandReference,
          storeId: raw.storeReference,
          aggregateType: "KitchenTicket",
          aggregateId: raw.ticketReference,
          aggregateVersion: raw.ticketVersion,
          correlationId: raw.correlationReference,
          causationId: raw.causationReference,
          actor: { type: "System" },
          payload: {
            kitchenTicketReference: raw.ticketReference,
            orderReference: raw.orderReference,
            orderBatchReference: raw.orderBatchReference,
            readyItemCount: readiness.length,
            itemCount: readiness.length,
            readyAt: raw.readyAt,
          },
          redactionClassification: "indirect_identifier",
          replayMetadata: { replaySafe: true },
        });
  if (orderEvent !== null && orderEvent.eventId === itemEvent.eventId) return invalid();
  return Object.freeze({ itemEvent, orderEvent });
}
