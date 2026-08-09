import { validateDomainEventEnvelope } from "@bop/eventing";

import {
  KitchenWorkCreatedEventError,
  type KitchenWorkCreatedEnvelope,
  type KitchenWorkCreatedPayload,
} from "../contracts/kitchen-work-created-event.js";
import type { KitchenTicket } from "../contracts/kitchen-ticket.js";
import {
  parseKitchenTicket,
  parseKitchenTicketInstant,
  parseKitchenTicketReference,
} from "../domain/kitchen-ticket.js";

function invalid(): never {
  throw new KitchenWorkCreatedEventError();
}

function exact(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  try {
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
    if (error instanceof KitchenWorkCreatedEventError) throw error;
    return invalid();
  }
}

function payload(value: unknown): KitchenWorkCreatedPayload {
  const raw = exact(value, [
    "kitchenTicketReference",
    "orderReference",
    "orderBatchReference",
    "confirmationReference",
    "workItemCount",
    "aggregateVersion",
    "createdAt",
  ]);
  if (
    !Number.isSafeInteger(raw.workItemCount) ||
    (raw.workItemCount as number) < 1 ||
    (raw.workItemCount as number) > 100 ||
    raw.aggregateVersion !== 1
  )
    return invalid();
  return Object.freeze({
    kitchenTicketReference: parseKitchenTicketReference(raw.kitchenTicketReference),
    orderReference: parseKitchenTicketReference(raw.orderReference),
    orderBatchReference: parseKitchenTicketReference(raw.orderBatchReference),
    confirmationReference: parseKitchenTicketReference(raw.confirmationReference),
    workItemCount: raw.workItemCount as number,
    aggregateVersion: 1,
    createdAt: parseKitchenTicketInstant(raw.createdAt),
  });
}

export function parseKitchenWorkCreatedEnvelope(value: unknown): KitchenWorkCreatedEnvelope {
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
    const parsedPayload = payload(raw.payload);
    const safeActor = Object.freeze({ type: "System" as const });
    const safeReplayMetadata = Object.freeze({ replaySafe: true as const });
    const candidate = {
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
      actor: safeActor,
      payload: parsedPayload,
      redactionClassification: raw.redactionClassification,
      replayMetadata: safeReplayMetadata,
    } as KitchenWorkCreatedEnvelope;
    const envelope = validateDomainEventEnvelope(candidate);
    if (
      envelope.eventType !== "KitchenWorkCreated" ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/kitchen" ||
      envelope.aggregateType !== "KitchenTicket" ||
      envelope.aggregateId !== parsedPayload.kitchenTicketReference ||
      envelope.aggregateVersion !== 1n ||
      envelope.occurredAt !== parsedPayload.createdAt ||
      envelope.redactionClassification !== "indirect_identifier" ||
      parsedPayload.aggregateVersion !== 1
    )
      return invalid();
    return Object.freeze(candidate);
  } catch (error) {
    if (error instanceof KitchenWorkCreatedEventError) throw error;
    return invalid();
  }
}

export function createKitchenWorkCreatedEnvelope(input: {
  readonly eventReference: unknown;
  readonly ticket: KitchenTicket;
}): KitchenWorkCreatedEnvelope {
  try {
    const raw = exact(input, ["eventReference", "ticket"]);
    const ticket = parseKitchenTicket(raw.ticket);
    return parseKitchenWorkCreatedEnvelope({
      eventId: parseKitchenTicketReference(raw.eventReference),
      eventType: "KitchenWorkCreated",
      schemaVersion: 1,
      occurredAt: ticket.createdAt,
      producerModule: "@rms/kitchen",
      tenantId: ticket.brandReference,
      storeId: ticket.storeReference,
      aggregateType: "KitchenTicket",
      aggregateId: ticket.ticketReference,
      aggregateVersion: ticket.aggregateVersion,
      correlationId: ticket.correlationReference,
      causationId: ticket.sourceEventReference,
      actor: { type: "System" },
      payload: {
        kitchenTicketReference: ticket.ticketReference,
        orderReference: ticket.orderReference,
        orderBatchReference: ticket.orderBatchReference,
        confirmationReference: ticket.confirmationReference,
        workItemCount: ticket.workItems.length,
        aggregateVersion: 1,
        createdAt: ticket.createdAt,
      },
      redactionClassification: "indirect_identifier",
      replayMetadata: { replaySafe: true },
    });
  } catch (error) {
    if (error instanceof KitchenWorkCreatedEventError) throw error;
    return invalid();
  }
}
