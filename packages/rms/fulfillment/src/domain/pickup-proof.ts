import {
  evaluatePickupProof,
  parseCanonicalInstant,
  parsePickupProofCapability,
  parsePublicCapabilitySelectorHash,
  regeneratePickupProof,
  type PickupProofCapability,
} from "@bop/public-capability";

export type PickupProofReference = string & { readonly __pickupProofReference: unique symbol };
export type PickupProofInstant = string & { readonly __pickupProofInstant: unique symbol };

export interface PickupProofItemSource {
  readonly fulfillmentItemReference: PickupProofReference;
  readonly orderedQuantity: number;
  readonly readyQuantity: number;
  readonly handedOverQuantity: 0;
  readonly state: "Ready";
}

export interface PickupProofSource {
  readonly fulfillmentReference: PickupProofReference;
  readonly brandReference: PickupProofReference;
  readonly storeReference: PickupProofReference;
  readonly fulfillmentType: "Pickup";
  readonly canonicalPhase: "Ready";
  readonly aggregateVersion: bigint;
  readonly readyAt: PickupProofInstant;
  readonly currentProofGeneration: number | null;
  readonly currentProofCapabilityReference: PickupProofReference | null;
  readonly lockedAt: PickupProofInstant;
  readonly items: readonly PickupProofItemSource[];
}

export interface PickupProofGenerationRecord {
  readonly capabilityReference: PickupProofReference;
  readonly fulfillmentReference: PickupProofReference;
  readonly brandReference: PickupProofReference;
  readonly storeReference: PickupProofReference;
  readonly kind: "Opaque" | "HumanCode";
  readonly publicOrderReference: string;
  readonly selectorHash: string;
  readonly pepperVersion: number;
  readonly generation: number;
  readonly readyAt: PickupProofInstant;
  readonly expiresAt: PickupProofInstant;
  readonly issuedAt: PickupProofInstant;
}

export interface PickupProofInvalidationRecord {
  readonly invalidationReference: PickupProofReference;
  readonly fulfillmentReference: PickupProofReference;
  readonly priorCapabilityReference: PickupProofReference;
  readonly replacementCapabilityReference: PickupProofReference;
  readonly priorGeneration: number;
  readonly replacementGeneration: number;
  readonly invalidatedAt: PickupProofInstant;
  readonly reason: "Regenerated";
}

export interface PickupProofIssueOperation {
  readonly operationReference: PickupProofReference;
  readonly idempotencyReference: PickupProofReference;
  readonly correlationReference: PickupProofReference;
  readonly fulfillmentReference: PickupProofReference;
  readonly brandReference: PickupProofReference;
  readonly storeReference: PickupProofReference;
  readonly operationKind: "Issue" | "Regenerate";
  readonly capabilityReference: PickupProofReference;
  readonly generation: number;
  readonly aggregateVersionBefore: bigint;
  readonly aggregateVersionAfter: bigint;
  readonly occurredAt: PickupProofInstant;
}

export interface PickupProofIssueEffect {
  readonly generation: PickupProofGenerationRecord;
  readonly invalidation: PickupProofInvalidationRecord | null;
  readonly operation: PickupProofIssueOperation;
}

export interface PickupProofVerificationRecord {
  readonly verificationReference: PickupProofReference;
  readonly operationReference: PickupProofReference;
  readonly idempotencyReference: PickupProofReference;
  readonly correlationReference: PickupProofReference;
  readonly fulfillmentReference: PickupProofReference;
  readonly brandReference: PickupProofReference;
  readonly storeReference: PickupProofReference;
  readonly capabilityReference: PickupProofReference;
  readonly generation: number;
  readonly verificationMethod: "Opaque" | "HumanCode";
  readonly validationStatus: "Validated";
  readonly verifiedAt: PickupProofInstant;
  readonly grantsCompletionAuthority: false;
}

export const pickupProofErrorCodes = [
  "PICKUP_PROOF_INPUT_INVALID",
  "PICKUP_PROOF_NOT_READY",
  "PICKUP_PROOF_VERSION_CONFLICT",
  "PICKUP_PROOF_UNAVAILABLE",
] as const;

export class PickupProofError extends Error {
  constructor(readonly code: (typeof pickupProofErrorCodes)[number]) {
    super("pickup proof is unavailable");
    this.name = "PickupProofError";
  }
}

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const maximumBigint = 9_223_372_036_854_775_807n;

function fail(code: (typeof pickupProofErrorCodes)[number]): never {
  throw new PickupProofError(code);
}

function invalid(): never {
  return fail("PICKUP_PROOF_INPUT_INVALID");
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
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    if (
      keys.length !== fields.length ||
      fields.some((field) => !keys.includes(field)) ||
      keys.some((key) => typeof key !== "string" || !fields.includes(key))
    )
      return invalid();
    return Object.freeze(
      Object.fromEntries(
        fields.map((field) => {
          const descriptor = descriptors[field];
          if (
            descriptor === undefined ||
            !("value" in descriptor) ||
            descriptor.get !== undefined ||
            descriptor.set !== undefined ||
            !descriptor.enumerable
          )
            return invalid();
          return [field, descriptor.value];
        }),
      ),
    );
  } catch (error) {
    if (error instanceof PickupProofError) throw error;
    return invalid();
  }
}

function list(value: unknown): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value) as unknown as Record<
    string,
    PropertyDescriptor
  >;
  const length = descriptors["length"]?.value;
  if (!Number.isSafeInteger(length) || length < 1 || length > 100) return invalid();
  const expected = new Set(["length", ...Array.from({ length }, (_, index) => String(index))]);
  if (Reflect.ownKeys(descriptors).some((key) => typeof key !== "string" || !expected.has(key)))
    return invalid();
  return Object.freeze(
    Array.from({ length }, (_, index) => {
      const descriptor = descriptors[String(index)];
      if (
        descriptor === undefined ||
        !("value" in descriptor) ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined ||
        !descriptor.enumerable
      )
        return invalid();
      return descriptor.value;
    }),
  );
}

export function parsePickupProofReference(value: unknown): PickupProofReference {
  if (typeof value !== "string" || !referencePattern.test(value)) return invalid();
  return value as PickupProofReference;
}

export function parsePickupProofInstant(value: unknown): PickupProofInstant {
  try {
    return parseCanonicalInstant(value) as unknown as PickupProofInstant;
  } catch {
    return invalid();
  }
}

function positive(value: unknown, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum)
    return invalid();
  return value as number;
}

function sourceItem(value: unknown): PickupProofItemSource {
  const raw = exact(value, [
    "fulfillmentItemReference",
    "orderedQuantity",
    "readyQuantity",
    "handedOverQuantity",
    "state",
  ]);
  const orderedQuantity = positive(raw.orderedQuantity, 999);
  if (
    raw.readyQuantity !== orderedQuantity ||
    raw.handedOverQuantity !== 0 ||
    raw.state !== "Ready"
  )
    return fail("PICKUP_PROOF_NOT_READY");
  return Object.freeze({
    fulfillmentItemReference: parsePickupProofReference(raw.fulfillmentItemReference),
    orderedQuantity,
    readyQuantity: orderedQuantity,
    handedOverQuantity: 0,
    state: "Ready",
  });
}

export function parsePickupProofSource(value: unknown): PickupProofSource {
  const raw = exact(value, [
    "fulfillmentReference",
    "brandReference",
    "storeReference",
    "fulfillmentType",
    "canonicalPhase",
    "aggregateVersion",
    "readyAt",
    "currentProofGeneration",
    "currentProofCapabilityReference",
    "lockedAt",
    "items",
  ]);
  if (raw.fulfillmentType !== "Pickup" || raw.canonicalPhase !== "Ready")
    return fail("PICKUP_PROOF_NOT_READY");
  if (
    typeof raw.aggregateVersion !== "bigint" ||
    raw.aggregateVersion < 1n ||
    raw.aggregateVersion > maximumBigint
  )
    return invalid();
  const items = list(raw.items).map(sourceItem);
  if (new Set(items.map((item) => item.fulfillmentItemReference)).size !== items.length)
    return invalid();
  const currentProofGeneration =
    raw.currentProofGeneration === null ? null : positive(raw.currentProofGeneration);
  const currentProofCapabilityReference =
    raw.currentProofCapabilityReference === null
      ? null
      : parsePickupProofReference(raw.currentProofCapabilityReference);
  if ((currentProofGeneration === null) !== (currentProofCapabilityReference === null))
    return invalid();
  return Object.freeze({
    fulfillmentReference: parsePickupProofReference(raw.fulfillmentReference),
    brandReference: parsePickupProofReference(raw.brandReference),
    storeReference: parsePickupProofReference(raw.storeReference),
    fulfillmentType: "Pickup",
    canonicalPhase: "Ready",
    aggregateVersion: raw.aggregateVersion,
    readyAt: parsePickupProofInstant(raw.readyAt),
    currentProofGeneration,
    currentProofCapabilityReference,
    lockedAt: parsePickupProofInstant(raw.lockedAt),
    items: Object.freeze(items),
  });
}

function capability(value: unknown): PickupProofCapability {
  try {
    return parsePickupProofCapability(value);
  } catch {
    return invalid();
  }
}

function validateCandidate(
  source: PickupProofSource,
  candidate: PickupProofCapability,
  observedAt: PickupProofInstant,
): void {
  if (
    candidate.status !== "Active" ||
    candidate.version !== 1 ||
    String(candidate.storeReference) !== source.storeReference ||
    String(candidate.fulfillmentReference) !== source.fulfillmentReference ||
    Date.parse(candidate.readyAt) < Date.parse(source.readyAt) ||
    Date.parse(candidate.expiresAt) > Date.parse(source.readyAt) + 60 * 60 * 1000 ||
    Date.parse(observedAt) < Date.parse(source.readyAt) ||
    Date.parse(observedAt) >= Date.parse(candidate.expiresAt)
  )
    return fail("PICKUP_PROOF_UNAVAILABLE");
}

function generationRecord(
  source: PickupProofSource,
  candidate: PickupProofCapability,
  observedAt: PickupProofInstant,
): PickupProofGenerationRecord {
  return Object.freeze({
    capabilityReference: parsePickupProofReference(candidate.capabilityReference),
    fulfillmentReference: source.fulfillmentReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    kind: candidate.kind,
    publicOrderReference: candidate.publicOrderReference,
    selectorHash: candidate.selectorHash,
    pepperVersion: candidate.pepperVersion,
    generation: candidate.generation,
    readyAt: parsePickupProofInstant(candidate.readyAt),
    expiresAt: parsePickupProofInstant(candidate.expiresAt),
    issuedAt: observedAt,
  });
}

export function planPickupProofIssue(value: unknown): PickupProofIssueEffect {
  const raw = exact(value, [
    "source",
    "candidate",
    "previous",
    "expectedAggregateVersion",
    "observedAt",
    "operationReference",
    "invalidationReference",
    "idempotencyReference",
    "correlationReference",
  ]);
  const source = parsePickupProofSource(raw.source);
  if (raw.expectedAggregateVersion !== source.aggregateVersion)
    return fail("PICKUP_PROOF_VERSION_CONFLICT");
  const observedAt = parsePickupProofInstant(raw.observedAt);
  const candidate = capability(raw.candidate);
  validateCandidate(source, candidate, observedAt);

  let invalidation: PickupProofInvalidationRecord | null = null;
  let operationKind: "Issue" | "Regenerate";
  if (source.currentProofGeneration === null) {
    if (
      raw.previous !== null ||
      raw.invalidationReference !== null ||
      candidate.generation !== 1 ||
      String(candidate.readyAt) !== source.readyAt
    )
      return fail("PICKUP_PROOF_UNAVAILABLE");
    operationKind = "Issue";
  } else {
    if (raw.previous === null || raw.invalidationReference === null)
      return fail("PICKUP_PROOF_UNAVAILABLE");
    const previous = capability(raw.previous);
    if (
      String(previous.capabilityReference) !== source.currentProofCapabilityReference ||
      previous.generation !== source.currentProofGeneration
    )
      return fail("PICKUP_PROOF_UNAVAILABLE");
    try {
      regeneratePickupProof({ previous, replacement: candidate, observedAt });
    } catch {
      return fail("PICKUP_PROOF_UNAVAILABLE");
    }
    invalidation = Object.freeze({
      invalidationReference: parsePickupProofReference(raw.invalidationReference),
      fulfillmentReference: source.fulfillmentReference,
      priorCapabilityReference: parsePickupProofReference(previous.capabilityReference),
      replacementCapabilityReference: parsePickupProofReference(candidate.capabilityReference),
      priorGeneration: previous.generation,
      replacementGeneration: candidate.generation,
      invalidatedAt: observedAt,
      reason: "Regenerated",
    });
    operationKind = "Regenerate";
  }

  const operationReference = parsePickupProofReference(raw.operationReference);
  const idempotencyReference = parsePickupProofReference(raw.idempotencyReference);
  const correlationReference = parsePickupProofReference(raw.correlationReference);
  if (
    operationReference === idempotencyReference ||
    operationReference === correlationReference ||
    idempotencyReference === correlationReference
  )
    return invalid();
  return Object.freeze({
    generation: generationRecord(source, candidate, observedAt),
    invalidation,
    operation: Object.freeze({
      operationReference,
      idempotencyReference,
      correlationReference,
      fulfillmentReference: source.fulfillmentReference,
      brandReference: source.brandReference,
      storeReference: source.storeReference,
      operationKind,
      capabilityReference: parsePickupProofReference(candidate.capabilityReference),
      generation: candidate.generation,
      aggregateVersionBefore: source.aggregateVersion,
      aggregateVersionAfter: source.aggregateVersion + 1n,
      occurredAt: observedAt,
    }),
  });
}

export function validatePickupProof(value: unknown): PickupProofVerificationRecord {
  const raw = exact(value, [
    "source",
    "capability",
    "selectorHash",
    "generation",
    "expectedCapabilityVersion",
    "observedAt",
    "verificationReference",
    "operationReference",
    "idempotencyReference",
    "correlationReference",
  ]);
  const source = parsePickupProofSource(raw.source);
  const candidate = capability(raw.capability);
  const observedAt = parsePickupProofInstant(raw.observedAt);
  if (
    source.currentProofGeneration === null ||
    source.currentProofCapabilityReference !== String(candidate.capabilityReference) ||
    source.currentProofGeneration !== candidate.generation ||
    Date.parse(candidate.readyAt) < Date.parse(source.readyAt) ||
    Date.parse(candidate.expiresAt) > Date.parse(source.readyAt) + 60 * 60 * 1000
  )
    return fail("PICKUP_PROOF_UNAVAILABLE");
  let decision;
  try {
    decision = evaluatePickupProof({
      capability: candidate,
      fulfillmentState: "Ready",
      storeReference: source.storeReference,
      fulfillmentReference: source.fulfillmentReference,
      generation: raw.generation,
      selectorHash: parsePublicCapabilitySelectorHash(raw.selectorHash),
      observedAt,
      expectedVersion: raw.expectedCapabilityVersion,
    });
  } catch {
    return fail("PICKUP_PROOF_UNAVAILABLE");
  }
  if (decision.decision !== "Allowed") return fail("PICKUP_PROOF_UNAVAILABLE");
  const verificationReference = parsePickupProofReference(raw.verificationReference);
  const operationReference = parsePickupProofReference(raw.operationReference);
  const idempotencyReference = parsePickupProofReference(raw.idempotencyReference);
  const correlationReference = parsePickupProofReference(raw.correlationReference);
  if (
    new Set([verificationReference, operationReference, idempotencyReference, correlationReference])
      .size !== 4
  )
    return invalid();
  return Object.freeze({
    verificationReference,
    operationReference,
    idempotencyReference,
    correlationReference,
    fulfillmentReference: source.fulfillmentReference,
    brandReference: source.brandReference,
    storeReference: source.storeReference,
    capabilityReference: parsePickupProofReference(candidate.capabilityReference),
    generation: candidate.generation,
    verificationMethod: candidate.kind,
    validationStatus: "Validated",
    verifiedAt: observedAt,
    grantsCompletionAuthority: false,
  });
}
