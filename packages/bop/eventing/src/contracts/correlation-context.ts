import type { DomainEventEnvelope } from "./domain-event-envelope.js";

const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const contextFields = new Set(["correlationId", "causationId"]);

export interface CorrelationContext {
  readonly correlationId: string;
  readonly causationId?: string;
}

export type UuidV7Factory = () => string;

export class InvalidCorrelationContextError extends TypeError {
  readonly code = "INVALID_CORRELATION_CONTEXT";

  constructor(readonly field: "causationId" | "correlationId" | "context" | "factory") {
    super(`invalid Correlation / Causation Context field: ${field}`);
    this.name = "InvalidCorrelationContextError";
  }
}

function requireUuidV7(
  field: "causationId" | "correlationId",
  value: unknown,
): asserts value is string {
  if (typeof value !== "string" || !uuidV7.test(value))
    throw new InvalidCorrelationContextError(field);
}

function immutableContext(correlationId: string, causationId?: string): CorrelationContext {
  return Object.freeze({
    correlationId,
    ...(causationId === undefined ? {} : { causationId }),
  });
}

/**
 * Validates a context supplied by a trusted in-process server adapter.
 *
 * Browser, Provider, header, query, body, and other raw transport values must
 * not be passed directly to this boundary.
 */
export function continueTrustedCorrelationContext(value: unknown): CorrelationContext {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new InvalidCorrelationContextError("context");

  const record = value as Record<string, unknown>;
  if (
    !Object.hasOwn(record, "correlationId") ||
    Object.keys(record).some((field) => !contextFields.has(field))
  )
    throw new InvalidCorrelationContextError("context");

  requireUuidV7("correlationId", record.correlationId);
  if (Object.hasOwn(record, "causationId")) requireUuidV7("causationId", record.causationId);
  return immutableContext(record.correlationId, record.causationId as string | undefined);
}

export function createRootCorrelationContext(factory: UuidV7Factory): CorrelationContext {
  if (typeof factory !== "function") throw new InvalidCorrelationContextError("factory");
  const correlationId = factory();
  requireUuidV7("correlationId", correlationId);
  return immutableContext(correlationId);
}

export function deriveCorrelationContextFromCommand(
  parent: CorrelationContext,
  commandId: string,
): CorrelationContext {
  const continued = continueTrustedCorrelationContext(parent);
  requireUuidV7("causationId", commandId);
  return immutableContext(continued.correlationId, commandId);
}

export function deriveCorrelationContextFromEvent(
  source: Pick<DomainEventEnvelope, "correlationId" | "eventId">,
): CorrelationContext {
  const continued = continueTrustedCorrelationContext({
    correlationId: source.correlationId,
  });
  requireUuidV7("causationId", source.eventId);
  return immutableContext(continued.correlationId, source.eventId);
}

export function preserveEventCorrelationContext(
  source: Pick<DomainEventEnvelope, "causationId" | "correlationId">,
): CorrelationContext {
  return continueTrustedCorrelationContext({
    correlationId: source.correlationId,
    ...(source.causationId === undefined ? {} : { causationId: source.causationId }),
  });
}
