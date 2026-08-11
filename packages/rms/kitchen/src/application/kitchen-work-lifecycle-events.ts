import { isProxy } from "node:util/types";

import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  KitchenWorkLifecycleEventError,
  type KitchenItemCompletedEnvelope,
  type KitchenItemCompletedPayload,
  type KitchenItemProgressRecordedEnvelope,
  type KitchenItemProgressRecordedPayload,
  type KitchenWorkAcceptedEnvelope,
  type KitchenWorkAcceptedPayload,
  type KitchenWorkLifecycleEnvelope,
  type KitchenWorkStartedEnvelope,
  type KitchenWorkStartedPayload,
} from "../contracts/kitchen-work-lifecycle-events.js";
import {
  parseKitchenWorkLifecycleResult,
  type KitchenWorkLifecycleResult,
} from "../contracts/kitchen-work-lifecycle.js";
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
      fields.some((field) => !keys.includes(field)) ||
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
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return invalid();
  try {
    const parsed = BigInt(value);
    if (parsed <= 0n || parsed > postgresqlBigintMaximum) return invalid();
  } catch {
    return invalid();
  }
  return value;
}

function quantity(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return invalid();
  return value as number;
}

function commonPayload(raw: Readonly<Record<string, unknown>>) {
  return {
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    kitchenWorkItemReference: parseKitchenTicketReference(raw.kitchenWorkItemReference),
    orderItemReference: parseKitchenTicketReference(raw.orderItemReference),
    ticketVersion: version(raw.ticketVersion),
    workItemVersion: version(raw.workItemVersion),
  };
}

function parsePayload(eventType: unknown, value: unknown): KitchenWorkLifecycleEnvelope["payload"] {
  if (eventType === "KitchenWorkAccepted") {
    const raw = exact(value, [
      "kitchenTicketReference",
      "kitchenWorkItemReference",
      "orderItemReference",
      "ticketVersion",
      "workItemVersion",
      "workItemStatus",
      "acceptedAt",
    ]);
    if (raw.workItemStatus !== "Queued") return invalid();
    return Object.freeze({
      ...commonPayload(raw),
      workItemStatus: "Queued",
      acceptedAt: parseKitchenTicketInstant(raw.acceptedAt),
    }) satisfies KitchenWorkAcceptedPayload;
  }
  if (eventType === "KitchenWorkStarted") {
    const raw = exact(value, [
      "kitchenTicketReference",
      "kitchenWorkItemReference",
      "orderItemReference",
      "ticketVersion",
      "workItemVersion",
      "fromStatus",
      "toStatus",
      "startedAt",
    ]);
    if (raw.fromStatus !== "Queued" || raw.toStatus !== "In Progress") return invalid();
    return Object.freeze({
      ...commonPayload(raw),
      fromStatus: "Queued",
      toStatus: "In Progress",
      startedAt: parseKitchenTicketInstant(raw.startedAt),
    }) satisfies KitchenWorkStartedPayload;
  }
  if (eventType === "KitchenItemProgressRecorded" || eventType === "KitchenItemCompleted") {
    const instantField = eventType === "KitchenItemProgressRecorded" ? "recordedAt" : "completedAt";
    const raw = exact(value, [
      "kitchenTicketReference",
      "kitchenWorkItemReference",
      "orderItemReference",
      "ticketVersion",
      "workItemVersion",
      "quantityDelta",
      "completedQuantity",
      "requiredQuantity",
      "fromStatus",
      "toStatus",
      instantField,
    ]);
    const requiredQuantity = quantity(raw.requiredQuantity, 1, 999);
    const completedQuantity = quantity(raw.completedQuantity, 1, requiredQuantity);
    const quantityDelta = quantity(raw.quantityDelta, 1, requiredQuantity);
    if (raw.fromStatus !== "In Progress" || quantityDelta > completedQuantity) return invalid();
    if (eventType === "KitchenItemProgressRecorded") {
      if (raw.toStatus !== "In Progress" || completedQuantity >= requiredQuantity) return invalid();
      return Object.freeze({
        ...commonPayload(raw),
        quantityDelta,
        completedQuantity,
        requiredQuantity,
        fromStatus: "In Progress",
        toStatus: "In Progress",
        recordedAt: parseKitchenTicketInstant(raw.recordedAt),
      }) satisfies KitchenItemProgressRecordedPayload;
    }
    if (raw.toStatus !== "Completed" || completedQuantity !== requiredQuantity) return invalid();
    return Object.freeze({
      ...commonPayload(raw),
      quantityDelta,
      completedQuantity,
      requiredQuantity,
      fromStatus: "In Progress",
      toStatus: "Completed",
      completedAt: parseKitchenTicketInstant(raw.completedAt),
    }) satisfies KitchenItemCompletedPayload;
  }
  return invalid();
}

function payloadInstant(envelope: KitchenWorkLifecycleEnvelope): string {
  if (envelope.eventType === "KitchenWorkAccepted") return envelope.payload.acceptedAt;
  if (envelope.eventType === "KitchenWorkStarted") return envelope.payload.startedAt;
  if (envelope.eventType === "KitchenItemProgressRecorded") return envelope.payload.recordedAt;
  return envelope.payload.completedAt;
}

function semanticPayload(
  envelope: KitchenWorkLifecycleEnvelope,
): Readonly<Record<string, unknown>> {
  const common = {
    kitchenTicketReference: envelope.payload.kitchenTicketReference,
    kitchenWorkItemReference: envelope.payload.kitchenWorkItemReference,
    orderItemReference: envelope.payload.orderItemReference,
    ticketVersion: envelope.payload.ticketVersion,
    workItemVersion: envelope.payload.workItemVersion,
  };
  if (envelope.eventType === "KitchenWorkAccepted")
    return {
      ...common,
      workItemStatus: envelope.payload.workItemStatus,
      acceptedAt: envelope.payload.acceptedAt,
    };
  if (envelope.eventType === "KitchenWorkStarted")
    return {
      ...common,
      fromStatus: envelope.payload.fromStatus,
      toStatus: envelope.payload.toStatus,
      startedAt: envelope.payload.startedAt,
    };
  if (envelope.eventType === "KitchenItemProgressRecorded")
    return {
      ...common,
      quantityDelta: envelope.payload.quantityDelta,
      completedQuantity: envelope.payload.completedQuantity,
      requiredQuantity: envelope.payload.requiredQuantity,
      fromStatus: envelope.payload.fromStatus,
      toStatus: envelope.payload.toStatus,
      recordedAt: envelope.payload.recordedAt,
    };
  return {
    ...common,
    quantityDelta: envelope.payload.quantityDelta,
    completedQuantity: envelope.payload.completedQuantity,
    requiredQuantity: envelope.payload.requiredQuantity,
    fromStatus: envelope.payload.fromStatus,
    toStatus: envelope.payload.toStatus,
    completedAt: envelope.payload.completedAt,
  };
}

export function parseKitchenWorkLifecycleEnvelope(value: unknown): KitchenWorkLifecycleEnvelope {
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
    if (
      ![
        "KitchenWorkAccepted",
        "KitchenWorkStarted",
        "KitchenItemProgressRecorded",
        "KitchenItemCompleted",
      ].includes(typeof raw.eventType === "string" ? raw.eventType : "")
    )
      return invalid();
    const actor = exact(raw.actor, ["type", "actorId"]);
    const replayMetadata = exact(raw.replayMetadata, ["replaySafe"]);
    if (actor.type !== "Actor" || replayMetadata.replaySafe !== true) return invalid();
    const payload = parsePayload(raw.eventType, raw.payload);
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
      aggregateVersion: raw.aggregateVersion,
      correlationId: parseKitchenTicketReference(raw.correlationId),
      causationId: parseKitchenTicketReference(raw.causationId),
      actor: Object.freeze({
        type: "Actor" as const,
        actorId: parseKitchenTicketReference(actor.actorId),
      }),
      payload,
      redactionClassification: raw.redactionClassification,
      replayMetadata: Object.freeze({ replaySafe: true as const }),
    }) as KitchenWorkLifecycleEnvelope;
    validateDomainEventEnvelope(candidate);
    if (
      candidate.schemaVersion !== 1 ||
      candidate.producerModule !== "@rms/kitchen" ||
      candidate.aggregateType !== "KitchenTicket" ||
      candidate.aggregateId !== candidate.payload.kitchenTicketReference ||
      candidate.aggregateVersion !== BigInt(candidate.payload.ticketVersion) ||
      candidate.occurredAt !== payloadInstant(candidate) ||
      candidate.redactionClassification !== "personal"
    )
      return invalid();
    const generated = [candidate.eventId, candidate.causationId];
    const observed = [
      candidate.tenantId,
      candidate.storeId,
      candidate.aggregateId,
      candidate.actor.actorId,
      candidate.payload.kitchenWorkItemReference,
      candidate.payload.orderItemReference,
      candidate.correlationId,
    ];
    if (
      new Set([...generated, candidate.correlationId]).size !== 3 ||
      generated.some((reference) => observed.includes(reference))
    )
      return invalid();
    return candidate;
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleEventError) throw error;
    return invalid();
  }
}

export function parseKitchenWorkAcceptedEnvelope(value: unknown): KitchenWorkAcceptedEnvelope {
  const envelope = parseKitchenWorkLifecycleEnvelope(value);
  if (envelope.eventType !== "KitchenWorkAccepted") return invalid();
  return envelope;
}

export function parseKitchenWorkStartedEnvelope(value: unknown): KitchenWorkStartedEnvelope {
  const envelope = parseKitchenWorkLifecycleEnvelope(value);
  if (envelope.eventType !== "KitchenWorkStarted") return invalid();
  return envelope;
}

export function parseKitchenItemProgressRecordedEnvelope(
  value: unknown,
): KitchenItemProgressRecordedEnvelope {
  const envelope = parseKitchenWorkLifecycleEnvelope(value);
  if (envelope.eventType !== "KitchenItemProgressRecorded") return invalid();
  return envelope;
}

export function parseKitchenItemCompletedEnvelope(value: unknown): KitchenItemCompletedEnvelope {
  const envelope = parseKitchenWorkLifecycleEnvelope(value);
  if (envelope.eventType !== "KitchenItemCompleted") return invalid();
  return envelope;
}

export function createKitchenWorkLifecycleEventSemanticBinding(value: unknown): string {
  const event = parseKitchenWorkLifecycleEnvelope(value);
  return JSON.stringify({
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
    actor: { type: event.actor.type, actorId: event.actor.actorId },
    payload: semanticPayload(event),
    redactionClassification: event.redactionClassification,
    replayMetadata: { replaySafe: event.replayMetadata.replaySafe },
  });
}

export function createKitchenWorkLifecycleEnvelope(input: {
  readonly eventReference: unknown;
  readonly operationReference: unknown;
  readonly actorReference: unknown;
  readonly correlationReference: unknown;
  readonly brandReference: unknown;
  readonly storeReference: unknown;
  readonly result: KitchenWorkLifecycleResult;
  readonly quantityDelta: number | null;
}): KitchenWorkLifecycleEnvelope {
  try {
    const raw = exact(input, [
      "eventReference",
      "operationReference",
      "actorReference",
      "correlationReference",
      "brandReference",
      "storeReference",
      "result",
      "quantityDelta",
    ]);
    const result = parseKitchenWorkLifecycleResult(raw.result);
    if (result.outcome === "OrderItemReady") return invalid();
    const operationReference = parseKitchenTicketReference(raw.operationReference);
    if (operationReference !== result.operationReference) return invalid();
    const common = {
      kitchenTicketReference: result.ticketReference,
      kitchenWorkItemReference: result.workItemReference,
      orderItemReference: result.orderItemReference,
      ticketVersion: result.ticketVersion,
      workItemVersion: result.workItemVersion,
    };
    const specific =
      result.outcome === "Accepted"
        ? {
            eventType: "KitchenWorkAccepted" as const,
            payload: {
              ...common,
              workItemStatus: "Queued" as const,
              acceptedAt: result.occurredAt,
            },
          }
        : result.outcome === "Started"
          ? {
              eventType: "KitchenWorkStarted" as const,
              payload: {
                ...common,
                fromStatus: "Queued" as const,
                toStatus: "In Progress" as const,
                startedAt: result.occurredAt,
              },
            }
          : result.outcome === "ProgressRecorded"
            ? {
                eventType: "KitchenItemProgressRecorded" as const,
                payload: {
                  ...common,
                  quantityDelta: quantity(raw.quantityDelta, 1, result.requiredQuantity),
                  completedQuantity: result.completedQuantity,
                  requiredQuantity: result.requiredQuantity,
                  fromStatus: "In Progress" as const,
                  toStatus: "In Progress" as const,
                  recordedAt: result.occurredAt,
                },
              }
            : {
                eventType: "KitchenItemCompleted" as const,
                payload: {
                  ...common,
                  quantityDelta: quantity(raw.quantityDelta, 1, result.requiredQuantity),
                  completedQuantity: result.completedQuantity,
                  requiredQuantity: result.requiredQuantity,
                  fromStatus: "In Progress" as const,
                  toStatus: "Completed" as const,
                  completedAt: result.occurredAt,
                },
              };
    if (
      (specific.eventType === "KitchenWorkAccepted" ||
        specific.eventType === "KitchenWorkStarted") &&
      raw.quantityDelta !== null
    )
      return invalid();
    return parseKitchenWorkLifecycleEnvelope({
      eventId: parseKitchenTicketReference(raw.eventReference),
      eventType: specific.eventType,
      schemaVersion: 1,
      occurredAt: result.occurredAt,
      producerModule: "@rms/kitchen",
      tenantId: parseKitchenTicketReference(raw.brandReference),
      storeId: parseKitchenTicketReference(raw.storeReference),
      aggregateType: "KitchenTicket",
      aggregateId: result.ticketReference,
      aggregateVersion: BigInt(result.ticketVersion),
      correlationId: parseKitchenTicketReference(raw.correlationReference),
      causationId: operationReference,
      actor: { type: "Actor", actorId: parseKitchenTicketReference(raw.actorReference) },
      payload: specific.payload,
      redactionClassification: "personal",
      replayMetadata: { replaySafe: true },
    });
  } catch (error) {
    if (error instanceof KitchenWorkLifecycleEventError) throw error;
    return invalid();
  }
}
