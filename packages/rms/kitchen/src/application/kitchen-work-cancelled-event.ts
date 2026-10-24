import { isProxy } from "node:util/types";

import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  kitchenWorkCancellationReasonCode,
  type KitchenWorkCancelledEnvelope,
  type KitchenWorkCancelledItem,
  type KitchenWorkCancelledPayload,
} from "../contracts/kitchen-work-cancellation.js";
import { KitchenWorkLifecycleEventError } from "../contracts/kitchen-work-lifecycle-events.js";
import {
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";

const postgresqlBigintMaximum = 9_223_372_036_854_775_807n;

function invalid(): never {
  throw new KitchenWorkLifecycleEventError();
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
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    const result: Record<string, unknown> = {};
    for (const field of fields) {
      const descriptor = descriptors[field];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      result[field] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleEventError) throw error;
    return invalid();
  }
}

function version(value: unknown): string {
  if (typeof value !== "string" || !/^[1-9][0-9]{0,18}$/.test(value)) return invalid();
  if (BigInt(value) > postgresqlBigintMaximum) return invalid();
  return value;
}

function parseItems(value: unknown): readonly KitchenWorkCancelledItem[] {
  if (!Array.isArray(value) || isProxy(value) || value.length < 1 || value.length > 100)
    return invalid();
  const items = value.map((entry) => {
    const raw = exact(entry, [
      "kitchenWorkItemReference",
      "orderItemReference",
      "fromStatus",
      "toStatus",
      "workItemVersion",
    ]);
    if ((raw.fromStatus !== "Queued" && raw.fromStatus !== "Held") || raw.toStatus !== "Cancelled")
      return invalid();
    return Object.freeze({
      kitchenWorkItemReference: parseKitchenTicketReference(raw.kitchenWorkItemReference),
      orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
      fromStatus: raw.fromStatus,
      toStatus: "Cancelled" as const,
      workItemVersion: version(raw.workItemVersion),
    }) satisfies KitchenWorkCancelledItem;
  });
  const references = items.map((item) => item.kitchenWorkItemReference);
  if (new Set(references).size !== references.length) return invalid();
  return Object.freeze(items);
}

function parsePayload(value: unknown): KitchenWorkCancelledPayload {
  const raw = exact(value, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "orderCancellationReference",
    "ticketVersion",
    "reasonCode",
    "workItems",
    "cancelledAt",
  ]);
  if (raw.reasonCode !== kitchenWorkCancellationReasonCode) return invalid();
  return Object.freeze({
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    orderCancellationReference: parseKitchenTicketReference(raw.orderCancellationReference),
    ticketVersion: version(raw.ticketVersion),
    reasonCode: kitchenWorkCancellationReasonCode,
    workItems: parseItems(raw.workItems),
    cancelledAt: parseKitchenTicketInstant(raw.cancelledAt),
  });
}

/** Strict parser for the one-per-batch `KitchenWorkCancelled` v1 outbox event. */
export function parseKitchenWorkCancelledEnvelope(value: unknown): KitchenWorkCancelledEnvelope {
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
      raw.eventType !== "KitchenWorkCancelled" ||
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
      eventType: "KitchenWorkCancelled" as const,
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
    }) satisfies KitchenWorkCancelledEnvelope;
    validateDomainEventEnvelope(candidate);
    if (
      candidate.aggregateId !== payload.kitchenTicketReference ||
      candidate.aggregateVersion !== BigInt(payload.ticketVersion) ||
      candidate.occurredAt !== payload.cancelledAt ||
      candidate.correlationId !== payload.orderCancellationReference
    )
      return invalid();
    const generated = [candidate.eventId, candidate.causationId];
    const observed = [
      candidate.tenantId,
      candidate.storeId,
      candidate.aggregateId,
      candidate.actor.actorId,
      payload.orderReference,
      payload.orderBatchReference,
      candidate.correlationId,
      ...payload.workItems.flatMap((item) => [
        item.kitchenWorkItemReference,
        item.orderItemReference,
      ]),
    ];
    if (
      candidate.eventId === candidate.causationId ||
      generated.some((reference) => observed.includes(reference))
    )
      return invalid();
    return candidate;
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleEventError) throw error;
    return invalid();
  }
}

export function createKitchenWorkCancelledEnvelope(input: {
  readonly eventReference: string;
  readonly operationReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly payload: KitchenWorkCancelledPayload;
}): KitchenWorkCancelledEnvelope {
  return parseKitchenWorkCancelledEnvelope({
    eventId: input.eventReference,
    eventType: "KitchenWorkCancelled",
    schemaVersion: 1,
    occurredAt: input.payload.cancelledAt,
    producerModule: "@rms/kitchen",
    tenantId: input.brandReference,
    storeId: input.storeReference,
    aggregateType: "KitchenTicket",
    aggregateId: input.payload.kitchenTicketReference,
    aggregateVersion: BigInt(input.payload.ticketVersion),
    correlationId: input.payload.orderCancellationReference,
    causationId: input.operationReference,
    actor: { type: "Actor", actorId: input.actorReference },
    payload: input.payload,
    redactionClassification: "personal",
    replayMetadata: { replaySafe: true },
  });
}
