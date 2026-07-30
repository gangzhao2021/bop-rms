export const orderResumeMaximumLifetimeMs = 30 * 60 * 1000;
export const orderResumeMaximumActiveSiblings = 2;
export const pickupProofMaximumLifetimeMs = 60 * 60 * 1000;

export type PublicOrderReference = string & {
  readonly __publicOrderReference: unique symbol;
};
export type OrderResumeRawCredential = string & {
  readonly __orderResumeRawCredential: unique symbol;
};
export type PickupOpaqueRawCredential = string & {
  readonly __pickupOpaqueRawCredential: unique symbol;
};
export type PickupHumanCode = string & { readonly __pickupHumanCode: unique symbol };
export type PublicCapabilitySelectorHash = string & {
  readonly __publicCapabilitySelectorHash: unique symbol;
};
export type PublicCapabilityReference = string & {
  readonly __publicCapabilityReference: unique symbol;
};
export type PublicCapabilityScopeReference = string & {
  readonly __publicCapabilityScopeReference: unique symbol;
};
export type CanonicalInstant = string & { readonly __canonicalInstant: unique symbol };
export type OrderResumeCapabilityStatus = "Active" | "Consumed" | "Revoked" | "Expired";
export type PickupProofCapabilityStatus = "Active" | "Revoked";
export type PickupProofKind = "Opaque" | "HumanCode";

export const publicCapabilityErrorCodes = [
  "PUBLIC_CAPABILITY_INPUT_INVALID",
  "PUBLIC_CAPABILITY_STATE_INVALID",
] as const;
export type PublicCapabilityErrorCode = (typeof publicCapabilityErrorCodes)[number];

export class PublicCapabilityError extends Error {
  readonly code: PublicCapabilityErrorCode;

  constructor(code: PublicCapabilityErrorCode) {
    super(
      code === "PUBLIC_CAPABILITY_INPUT_INVALID"
        ? "capability input is invalid"
        : "capability state is invalid",
    );
    this.name = "PublicCapabilityError";
    this.code = code;
  }
}

export interface OrderResumeCapability {
  readonly capabilityReference: PublicCapabilityReference;
  readonly purpose: "OrderResume";
  readonly storeReference: PublicCapabilityScopeReference;
  readonly orderReference: PublicCapabilityScopeReference;
  readonly publicOrderReference: PublicOrderReference;
  readonly selectorHash: PublicCapabilitySelectorHash;
  readonly pepperVersion: number;
  readonly status: OrderResumeCapabilityStatus;
  readonly version: number;
  readonly issuedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly consumedAt: CanonicalInstant | null;
  readonly revokedAt: CanonicalInstant | null;
}

export interface PickupProofCapability {
  readonly capabilityReference: PublicCapabilityReference;
  readonly purpose: "PickupHandoff";
  readonly kind: PickupProofKind;
  readonly storeReference: PublicCapabilityScopeReference;
  readonly fulfillmentReference: PublicCapabilityScopeReference;
  readonly publicOrderReference: PublicOrderReference;
  readonly selectorHash: PublicCapabilitySelectorHash;
  readonly pepperVersion: number;
  readonly generation: number;
  readonly status: PickupProofCapabilityStatus;
  readonly version: number;
  readonly readyAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly revokedAt: CanonicalInstant | null;
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const selectorHashPattern = /^[0-9a-f]{64}$/u;
const humanCodePattern = /^\d{6}$/u;
const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function invalid(): never {
  throw new PublicCapabilityError("PUBLIC_CAPABILITY_INPUT_INVALID");
}

export function readClosedCapabilityRecord(
  value: unknown,
  keys: readonly string[],
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return invalid();
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !keys.includes(key))
    ) {
      return invalid();
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (
        descriptor === undefined ||
        !Object.hasOwn(descriptor, "value") ||
        descriptor.get !== undefined ||
        descriptor.set !== undefined
      ) {
        return invalid();
      }
    }
    return value as Readonly<Record<string, unknown>>;
  } catch (error) {
    if (error instanceof PublicCapabilityError) throw error;
    return invalid();
  }
}

function base64UrlBytes<T extends string>(value: unknown, bytes: number): T {
  if (typeof value !== "string" || !base64UrlPattern.test(value)) return invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== bytes || decoded.toString("base64url") !== value) return invalid();
  return value as T;
}

export const parsePublicOrderReference = (value: unknown): PublicOrderReference =>
  base64UrlBytes<PublicOrderReference>(value, 16);
export const parseOrderResumeRawCredential = (value: unknown): OrderResumeRawCredential =>
  base64UrlBytes<OrderResumeRawCredential>(value, 32);
export const parsePickupOpaqueRawCredential = (value: unknown): PickupOpaqueRawCredential =>
  base64UrlBytes<PickupOpaqueRawCredential>(value, 16);
export const parsePickupHumanCode = (value: unknown): PickupHumanCode => {
  if (typeof value !== "string" || !humanCodePattern.test(value)) return invalid();
  return value as PickupHumanCode;
};
export const parsePublicCapabilitySelectorHash = (value: unknown): PublicCapabilitySelectorHash => {
  if (typeof value !== "string" || !selectorHashPattern.test(value)) return invalid();
  return value as PublicCapabilitySelectorHash;
};
export const parsePublicCapabilityReference = (value: unknown): PublicCapabilityReference => {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) return invalid();
  return value as PublicCapabilityReference;
};
export const parsePublicCapabilityScopeReference = (
  value: unknown,
): PublicCapabilityScopeReference => {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) return invalid();
  return value as PublicCapabilityScopeReference;
};
export const parseCanonicalInstant = (value: unknown): CanonicalInstant => {
  if (typeof value !== "string" || !canonicalInstantPattern.test(value)) return invalid();
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    return invalid();
  }
  return value as CanonicalInstant;
};

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function nullableInstant(value: unknown): CanonicalInstant | null {
  return value === null ? null : parseCanonicalInstant(value);
}

export function parseOrderResumeCapability(value: unknown): OrderResumeCapability {
  const raw = readClosedCapabilityRecord(value, [
    "capabilityReference",
    "purpose",
    "storeReference",
    "orderReference",
    "publicOrderReference",
    "selectorHash",
    "pepperVersion",
    "status",
    "version",
    "issuedAt",
    "expiresAt",
    "consumedAt",
    "revokedAt",
  ]);
  if (
    raw.purpose !== "OrderResume" ||
    (raw.status !== "Active" &&
      raw.status !== "Consumed" &&
      raw.status !== "Revoked" &&
      raw.status !== "Expired")
  ) {
    return invalid();
  }
  const issuedAt = parseCanonicalInstant(raw.issuedAt);
  const expiresAt = parseCanonicalInstant(raw.expiresAt);
  const consumedAt = nullableInstant(raw.consumedAt);
  const revokedAt = nullableInstant(raw.revokedAt);
  const lifetime = Date.parse(expiresAt) - Date.parse(issuedAt);
  if (lifetime <= 0 || lifetime > orderResumeMaximumLifetimeMs) return invalid();
  if (
    (raw.status === "Active" && (consumedAt !== null || revokedAt !== null)) ||
    (raw.status === "Expired" && (consumedAt !== null || revokedAt !== null)) ||
    (raw.status === "Consumed" &&
      (consumedAt === null ||
        revokedAt !== null ||
        Date.parse(consumedAt) < Date.parse(issuedAt) ||
        Date.parse(consumedAt) >= Date.parse(expiresAt))) ||
    (raw.status === "Revoked" &&
      (revokedAt === null || consumedAt !== null || Date.parse(revokedAt) < Date.parse(issuedAt)))
  ) {
    return invalid();
  }
  return Object.freeze({
    capabilityReference: parsePublicCapabilityReference(raw.capabilityReference),
    purpose: "OrderResume",
    storeReference: parsePublicCapabilityScopeReference(raw.storeReference),
    orderReference: parsePublicCapabilityScopeReference(raw.orderReference),
    publicOrderReference: parsePublicOrderReference(raw.publicOrderReference),
    selectorHash: parsePublicCapabilitySelectorHash(raw.selectorHash),
    pepperVersion: positiveInteger(raw.pepperVersion),
    status: raw.status,
    version: positiveInteger(raw.version),
    issuedAt,
    expiresAt,
    consumedAt,
    revokedAt,
  });
}

export function parsePickupProofCapability(value: unknown): PickupProofCapability {
  const raw = readClosedCapabilityRecord(value, [
    "capabilityReference",
    "purpose",
    "kind",
    "storeReference",
    "fulfillmentReference",
    "publicOrderReference",
    "selectorHash",
    "pepperVersion",
    "generation",
    "status",
    "version",
    "readyAt",
    "expiresAt",
    "revokedAt",
  ]);
  if (
    raw.purpose !== "PickupHandoff" ||
    (raw.kind !== "Opaque" && raw.kind !== "HumanCode") ||
    (raw.status !== "Active" && raw.status !== "Revoked")
  ) {
    return invalid();
  }
  const readyAt = parseCanonicalInstant(raw.readyAt);
  const expiresAt = parseCanonicalInstant(raw.expiresAt);
  const revokedAt = nullableInstant(raw.revokedAt);
  const lifetime = Date.parse(expiresAt) - Date.parse(readyAt);
  if (
    lifetime <= 0 ||
    lifetime > pickupProofMaximumLifetimeMs ||
    (raw.status === "Active" && revokedAt !== null) ||
    (raw.status === "Revoked" &&
      (revokedAt === null || Date.parse(revokedAt) < Date.parse(readyAt)))
  ) {
    return invalid();
  }
  return Object.freeze({
    capabilityReference: parsePublicCapabilityReference(raw.capabilityReference),
    purpose: "PickupHandoff",
    kind: raw.kind,
    storeReference: parsePublicCapabilityScopeReference(raw.storeReference),
    fulfillmentReference: parsePublicCapabilityScopeReference(raw.fulfillmentReference),
    publicOrderReference: parsePublicOrderReference(raw.publicOrderReference),
    selectorHash: parsePublicCapabilitySelectorHash(raw.selectorHash),
    pepperVersion: positiveInteger(raw.pepperVersion),
    generation: positiveInteger(raw.generation),
    status: raw.status,
    version: positiveInteger(raw.version),
    readyAt,
    expiresAt,
    revokedAt,
  });
}

export const orderResumeUnavailableReasons = [
  "StatusUnavailable",
  "Expired",
  "VersionMismatch",
  "ScopeMismatch",
  "SelectorMismatch",
] as const;
export type OrderResumeUnavailableReason = (typeof orderResumeUnavailableReasons)[number];
export const pickupProofUnavailableReasons = [
  "StatusUnavailable",
  "NotReady",
  "Expired",
  "VersionMismatch",
  "ScopeMismatch",
  "GenerationMismatch",
  "SelectorMismatch",
] as const;
export type PickupProofUnavailableReason = (typeof pickupProofUnavailableReasons)[number];

export type OrderResumeDecision =
  | {
      readonly decision: "Allowed";
      readonly capability: OrderResumeCapability;
      readonly redirectPath: string;
    }
  | { readonly decision: "Unavailable"; readonly reason: OrderResumeUnavailableReason };

export type PickupProofDecision =
  | {
      readonly decision: "Allowed";
      readonly capabilityReference: string;
      readonly generation: number;
    }
  | { readonly decision: "Unavailable"; readonly reason: PickupProofUnavailableReason };

const unavailableResume = (reason: OrderResumeUnavailableReason): OrderResumeDecision =>
  Object.freeze({ decision: "Unavailable", reason });
const unavailablePickup = (reason: PickupProofUnavailableReason): PickupProofDecision =>
  Object.freeze({ decision: "Unavailable", reason });

export function orderResumeSiblingScope(value: unknown): Readonly<{
  purpose: "OrderResume";
  storeReference: string;
  orderReference: string;
}> {
  const capability = parseOrderResumeCapability(value);
  return Object.freeze({
    purpose: "OrderResume",
    storeReference: capability.storeReference,
    orderReference: capability.orderReference,
  });
}

export function evaluateOrderResume(value: unknown): OrderResumeDecision {
  const raw = readClosedCapabilityRecord(value, [
    "capability",
    "purpose",
    "storeReference",
    "orderReference",
    "publicOrderReference",
    "selectorHash",
    "observedAt",
    "expectedVersion",
  ]);
  const capability = parseOrderResumeCapability(raw.capability);
  const observedAt = parseCanonicalInstant(raw.observedAt);
  if (capability.status !== "Active") return unavailableResume("StatusUnavailable");
  if (Date.parse(observedAt) < Date.parse(capability.issuedAt)) {
    return unavailableResume("StatusUnavailable");
  }
  if (Date.parse(observedAt) >= Date.parse(capability.expiresAt)) {
    return unavailableResume("Expired");
  }
  if (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion !== capability.version) {
    return unavailableResume("VersionMismatch");
  }
  if (
    raw.purpose !== "OrderResume" ||
    parsePublicCapabilityScopeReference(raw.storeReference) !== capability.storeReference ||
    parsePublicCapabilityScopeReference(raw.orderReference) !== capability.orderReference ||
    parsePublicOrderReference(raw.publicOrderReference) !== capability.publicOrderReference
  ) {
    return unavailableResume("ScopeMismatch");
  }
  if (parsePublicCapabilitySelectorHash(raw.selectorHash) !== capability.selectorHash) {
    return unavailableResume("SelectorMismatch");
  }
  const consumed = parseOrderResumeCapability({
    ...capability,
    status: "Consumed",
    version: capability.version + 1,
    consumedAt: observedAt,
  });
  return Object.freeze({
    decision: "Allowed",
    capability: consumed,
    redirectPath: `/orders/${capability.publicOrderReference}`,
  });
}

export function evaluatePickupProof(value: unknown): PickupProofDecision {
  const raw = readClosedCapabilityRecord(value, [
    "capability",
    "storeReference",
    "fulfillmentReference",
    "generation",
    "selectorHash",
    "fulfillmentState",
    "observedAt",
    "expectedVersion",
  ]);
  const capability = parsePickupProofCapability(raw.capability);
  const observedAt = parseCanonicalInstant(raw.observedAt);
  if (capability.status !== "Active") return unavailablePickup("StatusUnavailable");
  if (raw.fulfillmentState !== "Ready" || Date.parse(observedAt) < Date.parse(capability.readyAt)) {
    return unavailablePickup("NotReady");
  }
  if (Date.parse(observedAt) >= Date.parse(capability.expiresAt)) {
    return unavailablePickup("Expired");
  }
  if (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion !== capability.version) {
    return unavailablePickup("VersionMismatch");
  }
  if (
    parsePublicCapabilityScopeReference(raw.storeReference) !== capability.storeReference ||
    parsePublicCapabilityScopeReference(raw.fulfillmentReference) !==
      capability.fulfillmentReference
  ) {
    return unavailablePickup("ScopeMismatch");
  }
  if (!Number.isSafeInteger(raw.generation) || raw.generation !== capability.generation) {
    return unavailablePickup("GenerationMismatch");
  }
  if (parsePublicCapabilitySelectorHash(raw.selectorHash) !== capability.selectorHash) {
    return unavailablePickup("SelectorMismatch");
  }
  return Object.freeze({
    decision: "Allowed",
    capabilityReference: capability.capabilityReference,
    generation: capability.generation,
  });
}

export function regeneratePickupProof(value: unknown): Readonly<{
  previous: PickupProofCapability;
  current: PickupProofCapability;
}> {
  const raw = readClosedCapabilityRecord(value, ["previous", "replacement", "observedAt"]);
  const previous = parsePickupProofCapability(raw.previous);
  const replacement = parsePickupProofCapability(raw.replacement);
  const observedAt = parseCanonicalInstant(raw.observedAt);
  if (
    previous.status !== "Active" ||
    replacement.status !== "Active" ||
    replacement.storeReference !== previous.storeReference ||
    replacement.fulfillmentReference !== previous.fulfillmentReference ||
    replacement.publicOrderReference !== previous.publicOrderReference ||
    replacement.kind !== previous.kind ||
    replacement.generation !== previous.generation + 1 ||
    replacement.capabilityReference === previous.capabilityReference ||
    replacement.selectorHash === previous.selectorHash ||
    Date.parse(observedAt) < Date.parse(previous.readyAt) ||
    Date.parse(observedAt) >= Date.parse(previous.expiresAt) ||
    Date.parse(replacement.readyAt) < Date.parse(observedAt)
  ) {
    throw new PublicCapabilityError("PUBLIC_CAPABILITY_STATE_INVALID");
  }
  const revoked = parsePickupProofCapability({
    ...previous,
    status: "Revoked",
    version: previous.version + 1,
    revokedAt: observedAt,
  });
  return Object.freeze({ previous: revoked, current: replacement });
}
