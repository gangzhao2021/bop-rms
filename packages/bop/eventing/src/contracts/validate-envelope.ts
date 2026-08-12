import type { DomainEventEnvelope, JsonObject, JsonValue } from "./domain-event-envelope.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const pascalCase = /^[A-Z][A-Za-z0-9]*$/u;
const producerModule = /^@(bop|rms)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const classifications = new Set([
  "none",
  "indirect_identifier",
  "personal",
  "sensitive_personal",
  "payment",
  "health",
  "credential",
]);
const envelopeFields = new Set([
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

export class InvalidDomainEventEnvelopeError extends Error {
  readonly code = "INVALID_DOMAIN_EVENT_ENVELOPE";

  constructor(readonly field: string) {
    super(`invalid Domain Event Envelope field: ${field}`);
    this.name = "InvalidDomainEventEnvelopeError";
  }
}

function isJsonValue(value: unknown, seen: Set<object>): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  const valid = Array.isArray(value)
    ? value.every((item) => isJsonValue(item, seen))
    : Object.getPrototypeOf(value) === Object.prototype &&
      Object.values(value).every((item) => isJsonValue(item, seen));
  seen.delete(value);
  return valid;
}

function isJsonObject(value: unknown): value is JsonObject {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    isJsonValue(value, new Set())
  );
}

function requireUuidV7(field: string, value: unknown): void {
  if (typeof value !== "string" || !uuidV7.test(value))
    throw new InvalidDomainEventEnvelopeError(field);
}

function requireUtcInstant(field: string, value: unknown): void {
  if (
    typeof value !== "string" ||
    !value.endsWith("Z") ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    throw new InvalidDomainEventEnvelopeError(field);
}

export function validateDomainEventEnvelope(envelope: DomainEventEnvelope): DomainEventEnvelope {
  if (
    envelope === null ||
    typeof envelope !== "object" ||
    Array.isArray(envelope) ||
    Object.getPrototypeOf(envelope) !== Object.prototype ||
    Reflect.ownKeys(envelope).some((key) => typeof key !== "string" || !envelopeFields.has(key))
  )
    throw new InvalidDomainEventEnvelopeError("envelope");
  requireUuidV7("eventId", envelope.eventId);
  if (!pascalCase.test(envelope.eventType)) throw new InvalidDomainEventEnvelopeError("eventType");
  if (!Number.isSafeInteger(envelope.schemaVersion) || envelope.schemaVersion <= 0)
    throw new InvalidDomainEventEnvelopeError("schemaVersion");
  requireUtcInstant("occurredAt", envelope.occurredAt);
  if (!producerModule.test(envelope.producerModule))
    throw new InvalidDomainEventEnvelopeError("producerModule");
  requireUuidV7("tenantId", envelope.tenantId);
  if (envelope.storeId !== undefined) requireUuidV7("storeId", envelope.storeId);
  if (!pascalCase.test(envelope.aggregateType))
    throw new InvalidDomainEventEnvelopeError("aggregateType");
  requireUuidV7("aggregateId", envelope.aggregateId);
  if (typeof envelope.aggregateVersion !== "bigint" || envelope.aggregateVersion <= 0n)
    throw new InvalidDomainEventEnvelopeError("aggregateVersion");
  requireUuidV7("correlationId", envelope.correlationId);
  if (envelope.causationId !== undefined) requireUuidV7("causationId", envelope.causationId);
  if (
    !envelope.actor ||
    typeof envelope.actor !== "object" ||
    Array.isArray(envelope.actor) ||
    Object.getPrototypeOf(envelope.actor) !== Object.prototype ||
    (envelope.actor.type === "Actor"
      ? Reflect.ownKeys(envelope.actor).length !== 2 || !Object.hasOwn(envelope.actor, "actorId")
      : Reflect.ownKeys(envelope.actor).length !== 1)
  )
    throw new InvalidDomainEventEnvelopeError("actor");
  if (envelope.actor.type === "Actor") requireUuidV7("actor.actorId", envelope.actor.actorId);
  else if (envelope.actor.type !== "System")
    throw new InvalidDomainEventEnvelopeError("actor.type");
  if (!isJsonObject(envelope.payload)) throw new InvalidDomainEventEnvelopeError("payload");
  if (!classifications.has(envelope.redactionClassification))
    throw new InvalidDomainEventEnvelopeError("redactionClassification");
  if (!isJsonObject(envelope.replayMetadata))
    throw new InvalidDomainEventEnvelopeError("replayMetadata");
  return envelope;
}
