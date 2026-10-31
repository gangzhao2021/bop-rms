import {
  parseCanonicalInstant,
  parsePublicCapabilityReference,
  parsePublicCapabilityScopeReference,
  parsePublicCapabilitySelectorHash,
  PublicCapabilityError,
  readClosedCapabilityRecord,
  type CanonicalInstant,
  type PublicCapabilityReference,
  type PublicCapabilityScopeReference,
  type PublicCapabilitySelectorHash,
} from "./public-capability-policy.js";

export const diningJoinMaximumLifetimeMs = 15 * 60 * 1000;
export const diningJoinSessionFailureBudget = Object.freeze({
  failures: 5,
  windowMs: 10 * 60 * 1000,
});
export const diningJoinNetworkDeviceFailureBudget = Object.freeze({
  failures: 20,
  windowMs: 10 * 60 * 1000,
});

export type DiningJoinInvitationCredential = string & {
  readonly __diningJoinInvitationCredential: unique symbol;
};
export type DiningJoinHumanCode = string & {
  readonly __diningJoinHumanCode: unique symbol;
};
export type DiningJoinCapabilityKind = "Invitation" | "HumanCode";
export type DiningJoinCapabilityStatus = "Active" | "Consumed" | "Revoked" | "Expired";
export type DiningJoinAbuseDecision = "Admitted" | "Cooldown";

export interface DiningJoinCapability {
  readonly capabilityReference: PublicCapabilityReference;
  readonly purpose: "DiningJoin";
  readonly kind: DiningJoinCapabilityKind;
  readonly storeReference: PublicCapabilityScopeReference;
  readonly tableReference: PublicCapabilityScopeReference;
  readonly diningSessionReference: PublicCapabilityScopeReference;
  readonly selectorHash: PublicCapabilitySelectorHash;
  readonly pepperVersion: number;
  readonly assignmentVersion: number;
  readonly generation: number;
  readonly status: DiningJoinCapabilityStatus;
  readonly version: number;
  readonly issuedAt: CanonicalInstant;
  readonly expiresAt: CanonicalInstant;
  readonly consumedAt: CanonicalInstant | null;
  readonly revokedAt: CanonicalInstant | null;
}

const base64UrlPattern = /^[A-Za-z0-9_-]+$/u;
const humanCodePattern = /^\d{6}$/u;

function invalid(): never {
  throw new PublicCapabilityError("PUBLIC_CAPABILITY_INPUT_INVALID");
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as number;
}

function nullableInstant(value: unknown): CanonicalInstant | null {
  return value === null ? null : parseCanonicalInstant(value);
}

export function parseDiningJoinInvitationCredential(
  value: unknown,
): DiningJoinInvitationCredential {
  if (typeof value !== "string" || !base64UrlPattern.test(value)) return invalid();
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length !== 16 || decoded.toString("base64url") !== value) return invalid();
  return value as DiningJoinInvitationCredential;
}

export function parseDiningJoinHumanCode(value: unknown): DiningJoinHumanCode {
  if (typeof value !== "string" || !humanCodePattern.test(value)) return invalid();
  return value as DiningJoinHumanCode;
}

export function parseDiningJoinCapability(value: unknown): DiningJoinCapability {
  const raw = readClosedCapabilityRecord(value, [
    "capabilityReference",
    "purpose",
    "kind",
    "storeReference",
    "tableReference",
    "diningSessionReference",
    "selectorHash",
    "pepperVersion",
    "assignmentVersion",
    "generation",
    "status",
    "version",
    "issuedAt",
    "expiresAt",
    "consumedAt",
    "revokedAt",
  ]);
  if (
    raw.purpose !== "DiningJoin" ||
    (raw.kind !== "Invitation" && raw.kind !== "HumanCode") ||
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
  if (
    lifetime <= 0 ||
    lifetime > diningJoinMaximumLifetimeMs ||
    ((raw.status === "Active" || raw.status === "Expired") &&
      (consumedAt !== null || revokedAt !== null)) ||
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
    purpose: "DiningJoin",
    kind: raw.kind,
    storeReference: parsePublicCapabilityScopeReference(raw.storeReference),
    tableReference: parsePublicCapabilityScopeReference(raw.tableReference),
    diningSessionReference: parsePublicCapabilityScopeReference(raw.diningSessionReference),
    selectorHash: parsePublicCapabilitySelectorHash(raw.selectorHash),
    pepperVersion: positiveInteger(raw.pepperVersion),
    assignmentVersion: positiveInteger(raw.assignmentVersion),
    generation: positiveInteger(raw.generation),
    status: raw.status,
    version: positiveInteger(raw.version),
    issuedAt,
    expiresAt,
    consumedAt,
    revokedAt,
  });
}

export const diningJoinUnavailableReasons = [
  "StatusUnavailable",
  "SessionUnavailable",
  "Cooldown",
  "Expired",
  "VersionMismatch",
  "ScopeMismatch",
  "AssignmentMismatch",
  "GenerationMismatch",
  "SelectorMismatch",
] as const;
export type DiningJoinUnavailableReason = (typeof diningJoinUnavailableReasons)[number];
export type DiningJoinDecision =
  | { readonly decision: "Allowed"; readonly capability: DiningJoinCapability }
  | { readonly decision: "Unavailable"; readonly reason: DiningJoinUnavailableReason };

const unavailable = (reason: DiningJoinUnavailableReason): DiningJoinDecision =>
  Object.freeze({ decision: "Unavailable", reason });

export function diningJoinSiblingScope(value: unknown): Readonly<{
  purpose: "DiningJoin";
  storeReference: string;
  tableReference: string;
  diningSessionReference: string;
}> {
  const capability = parseDiningJoinCapability(value);
  return Object.freeze({
    purpose: "DiningJoin",
    storeReference: capability.storeReference,
    tableReference: capability.tableReference,
    diningSessionReference: capability.diningSessionReference,
  });
}

export function evaluateDiningJoin(value: unknown): DiningJoinDecision {
  const raw = readClosedCapabilityRecord(value, [
    "capability",
    "purpose",
    "storeReference",
    "tableReference",
    "diningSessionReference",
    "assignmentVersion",
    "generation",
    "selectorHash",
    "sessionPhase",
    "abuseDecision",
    "observedAt",
    "expectedVersion",
  ]);
  const capability = parseDiningJoinCapability(raw.capability);
  const observedAt = parseCanonicalInstant(raw.observedAt);
  if (capability.status !== "Active") return unavailable("StatusUnavailable");
  if (raw.sessionPhase !== "Active") return unavailable("SessionUnavailable");
  if (raw.abuseDecision === "Cooldown") return unavailable("Cooldown");
  if (raw.abuseDecision !== "Admitted") return invalid();
  if (Date.parse(observedAt) < Date.parse(capability.issuedAt)) {
    return unavailable("StatusUnavailable");
  }
  if (Date.parse(observedAt) >= Date.parse(capability.expiresAt)) {
    return unavailable("Expired");
  }
  if (!Number.isSafeInteger(raw.expectedVersion) || raw.expectedVersion !== capability.version) {
    return unavailable("VersionMismatch");
  }
  if (
    raw.purpose !== "DiningJoin" ||
    parsePublicCapabilityScopeReference(raw.storeReference) !== capability.storeReference ||
    parsePublicCapabilityScopeReference(raw.tableReference) !== capability.tableReference ||
    parsePublicCapabilityScopeReference(raw.diningSessionReference) !==
      capability.diningSessionReference
  ) {
    return unavailable("ScopeMismatch");
  }
  if (
    !Number.isSafeInteger(raw.assignmentVersion) ||
    raw.assignmentVersion !== capability.assignmentVersion
  ) {
    return unavailable("AssignmentMismatch");
  }
  if (!Number.isSafeInteger(raw.generation) || raw.generation !== capability.generation) {
    return unavailable("GenerationMismatch");
  }
  if (parsePublicCapabilitySelectorHash(raw.selectorHash) !== capability.selectorHash) {
    return unavailable("SelectorMismatch");
  }
  return Object.freeze({
    decision: "Allowed",
    capability: parseDiningJoinCapability({
      ...capability,
      status: "Consumed",
      version: capability.version + 1,
      consumedAt: observedAt,
    }),
  });
}

export function regenerateDiningJoinCapability(value: unknown): Readonly<{
  previous: DiningJoinCapability;
  current: DiningJoinCapability;
}> {
  const raw = readClosedCapabilityRecord(value, ["previous", "replacement", "observedAt"]);
  const previous = parseDiningJoinCapability(raw.previous);
  const replacement = parseDiningJoinCapability(raw.replacement);
  const observedAt = parseCanonicalInstant(raw.observedAt);
  if (
    previous.status === "Revoked" ||
    (previous.status === "Consumed" &&
      (previous.consumedAt === null || previous.consumedAt > observedAt)) ||
    (previous.status === "Expired" && previous.expiresAt > observedAt) ||
    replacement.status !== "Active" ||
    replacement.version !== 1 ||
    replacement.kind !== previous.kind ||
    replacement.storeReference !== previous.storeReference ||
    replacement.tableReference !== previous.tableReference ||
    replacement.diningSessionReference !== previous.diningSessionReference ||
    replacement.assignmentVersion !== previous.assignmentVersion ||
    replacement.generation !== previous.generation + 1 ||
    replacement.capabilityReference === previous.capabilityReference ||
    replacement.selectorHash === previous.selectorHash ||
    Date.parse(observedAt) < Date.parse(previous.issuedAt) ||
    Date.parse(replacement.issuedAt) < Date.parse(observedAt)
  ) {
    throw new PublicCapabilityError("PUBLIC_CAPABILITY_STATE_INVALID");
  }
  return Object.freeze({
    previous:
      previous.status === "Active"
        ? parseDiningJoinCapability({
            ...previous,
            status: "Revoked",
            version: previous.version + 1,
            revokedAt: observedAt,
          })
        : previous,
    current: replacement,
  });
}
