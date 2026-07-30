import {
  IdentityContractError,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type CanonicalInstant,
} from "./identity-actor.js";

export const guestSessionErrorCodes = [
  "GUEST_SESSION_INPUT_INVALID",
  "GUEST_SESSION_UNAVAILABLE",
  "GUEST_SESSION_VERSION_CONFLICT",
  "GUEST_SESSION_IDEMPOTENCY_CONFLICT",
] as const;
export type GuestSessionErrorCode = (typeof guestSessionErrorCodes)[number];

export class GuestSessionError extends Error {
  readonly code: GuestSessionErrorCode;

  constructor(code: GuestSessionErrorCode) {
    super(
      code === "GUEST_SESSION_VERSION_CONFLICT"
        ? "guest session version conflict"
        : code === "GUEST_SESSION_IDEMPOTENCY_CONFLICT"
          ? "guest session operation conflict"
          : code === "GUEST_SESSION_INPUT_INVALID"
            ? "guest session request is invalid"
            : "guest session is unavailable",
    );
    this.name = "GuestSessionError";
    this.code = code;
  }
}

export type GuestSessionReference = string & {
  readonly __guestSessionReference: unique symbol;
};
export type GuestOperationReference = string & {
  readonly __guestOperationReference: unique symbol;
};
export type GuestEntryRequestReference = string & {
  readonly __guestEntryRequestReference: unique symbol;
};
export type GuestEvidenceReference = string & {
  readonly __guestEvidenceReference: unique symbol;
};
export type GuestBrandReference = string & { readonly __guestBrandReference: unique symbol };
export type GuestStoreReference = string & { readonly __guestStoreReference: unique symbol };
export type GuestPublicStoreReference = string & {
  readonly __guestPublicStoreReference: unique symbol;
};
export type GuestPublicTableReference = string & {
  readonly __guestPublicTableReference: unique symbol;
};
export type GuestQrReference = string & { readonly __guestQrReference: unique symbol };
export type GuestDiningAdmissionReference = string & {
  readonly __guestDiningAdmissionReference: unique symbol;
};
export type GuestDiningSessionReference = string & {
  readonly __guestDiningSessionReference: unique symbol;
};
export type GuestDiningParticipantReference = string & {
  readonly __guestDiningParticipantReference: unique symbol;
};
export type GuestRawCredential = string & { readonly __guestRawCredential: unique symbol };
export type GuestSelectorHash = string & { readonly __guestSelectorHash: unique symbol };
export type GuestLocale = string & { readonly __guestLocale: unique symbol };
export type GuestChannel = "DineIn" | "Pickup";
export type GuestSessionStatus = "Active" | "Revoked" | "Expired";
export type GuestDiningState = "ContextOnly" | "DiningBound";
export type GuestSessionRevocationReason =
  | "Rotated"
  | "BindingChanged"
  | "Logout"
  | "StoreUnavailable"
  | "QrRevoked"
  | "OrderClosed"
  | "DiningSessionClosed"
  | "RiskChanged"
  | "Administrative";

export interface GuestAdmissionEvidence {
  readonly decision: "Allowed";
  readonly evidenceReference: GuestEvidenceReference;
  readonly entryRequestReference: GuestEntryRequestReference;
  readonly brandReference: GuestBrandReference;
  readonly storeReference: GuestStoreReference;
  readonly publicStoreReference: GuestPublicStoreReference;
  readonly publicTableReference: GuestPublicTableReference | null;
  readonly channel: GuestChannel;
  readonly locale: GuestLocale;
  readonly qrReference: GuestQrReference;
  readonly qrRevocationVersion: number;
  readonly evaluatedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export interface GuestDiningAdmissionEvidence {
  readonly decision: "Allowed";
  readonly admissionReference: GuestDiningAdmissionReference;
  readonly operationReference: GuestOperationReference;
  readonly storeReference: GuestStoreReference;
  readonly publicTableReference: GuestPublicTableReference;
  readonly diningSessionReference: GuestDiningSessionReference;
  readonly diningParticipantReference: GuestDiningParticipantReference;
  readonly evaluatedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}

export interface GuestSession {
  readonly sessionReference: GuestSessionReference;
  readonly status: GuestSessionStatus;
  readonly version: number;
  readonly brandReference: GuestBrandReference;
  readonly storeReference: GuestStoreReference;
  readonly publicStoreReference: GuestPublicStoreReference;
  readonly publicTableReference: GuestPublicTableReference | null;
  readonly channel: GuestChannel;
  readonly locale: GuestLocale;
  readonly qrReference: GuestQrReference;
  readonly qrRevocationVersion: number;
  readonly diningState: GuestDiningState;
  readonly diningSessionReference: GuestDiningSessionReference | null;
  readonly diningParticipantReference: GuestDiningParticipantReference | null;
  readonly createdAt: CanonicalInstant;
  readonly lastSeenAt: CanonicalInstant;
  readonly idleExpiresAt: CanonicalInstant;
  readonly absoluteExpiresAt: CanonicalInstant;
  readonly orderClosedAt: CanonicalInstant | null;
  readonly closureExpiresAt: CanonicalInstant | null;
  readonly rotatedFromGuestSessionReference: GuestSessionReference | null;
  readonly revocationReason: GuestSessionRevocationReason | null;
  readonly revokedAt: CanonicalInstant | null;
}

export interface GuestSessionRecord {
  readonly session: GuestSession;
  readonly sessionSelectorHash: GuestSelectorHash;
  readonly csrfSelectorHash: GuestSelectorHash;
  readonly operationReference: GuestOperationReference;
  readonly operationIntentHash: GuestSelectorHash;
}

export interface GuestSessionCookieDescriptor {
  readonly name: "__Host-bop-guest";
  readonly secure: true;
  readonly httpOnly: true;
  readonly sameSite: "lax";
  readonly path: "/";
  readonly domain: null;
}

export const guestSessionCookie: GuestSessionCookieDescriptor = Object.freeze({
  name: "__Host-bop-guest",
  secure: true,
  httpOnly: true,
  sameSite: "lax",
  path: "/",
  domain: null,
});

const localePattern = /^[a-z]{2,3}(?:-[A-Z][a-z]{3})?(?:-[A-Z]{2}|\d{3})?$/u;
const rawCredentialPattern = /^[A-Za-z0-9_-]{43}$/u;
const selectorHashPattern = /^[0-9a-f]{64}$/u;
const uuid = <T extends string>(value: unknown): T => {
  try {
    return parseOpaqueUuidV7(value, "IDENTITY_INPUT_INVALID") as T;
  } catch {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
};
const instant = (value: unknown): CanonicalInstant => {
  try {
    return parseCanonicalInstant(value);
  } catch {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
};
const closed = (value: unknown, keys: readonly string[]) => {
  try {
    return readClosedRecord(value, keys);
  } catch (error) {
    if (error instanceof IdentityContractError) {
      throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
    }
    throw error;
  }
};

export const parseGuestSessionReference = (value: unknown): GuestSessionReference =>
  uuid<GuestSessionReference>(value);
export const parseGuestOperationReference = (value: unknown): GuestOperationReference =>
  uuid<GuestOperationReference>(value);
export const parseGuestEntryRequestReference = (value: unknown): GuestEntryRequestReference =>
  uuid<GuestEntryRequestReference>(value);
export const parseGuestDiningAdmissionReference = (value: unknown): GuestDiningAdmissionReference =>
  uuid<GuestDiningAdmissionReference>(value);
export const parseGuestRawCredential = (value: unknown): GuestRawCredential => {
  if (typeof value !== "string" || !rawCredentialPattern.test(value)) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  return value as GuestRawCredential;
};
export const parseGuestSelectorHash = (value: unknown): GuestSelectorHash => {
  if (typeof value !== "string" || !selectorHashPattern.test(value)) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  return value as GuestSelectorHash;
};

export function parseGuestAdmissionEvidence(value: unknown): GuestAdmissionEvidence {
  const raw = closed(value, [
    "decision",
    "evidenceReference",
    "entryRequestReference",
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "publicTableReference",
    "channel",
    "locale",
    "qrReference",
    "qrRevocationVersion",
    "evaluatedAt",
    "validUntil",
  ]);
  if (
    raw.decision !== "Allowed" ||
    (raw.channel !== "DineIn" && raw.channel !== "Pickup") ||
    typeof raw.locale !== "string" ||
    !localePattern.test(raw.locale) ||
    !Number.isSafeInteger(raw.qrRevocationVersion) ||
    (raw.qrRevocationVersion as number) < 1
  ) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const channel = raw.channel;
  const publicTableReference =
    raw.publicTableReference === null
      ? null
      : uuid<GuestPublicTableReference>(raw.publicTableReference);
  if ((channel === "DineIn") !== (publicTableReference !== null)) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const evaluatedAt = instant(raw.evaluatedAt);
  const validUntil = instant(raw.validUntil);
  if (Date.parse(evaluatedAt) >= Date.parse(validUntil)) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  return Object.freeze({
    decision: "Allowed",
    evidenceReference: uuid<GuestEvidenceReference>(raw.evidenceReference),
    entryRequestReference: uuid<GuestEntryRequestReference>(raw.entryRequestReference),
    brandReference: uuid<GuestBrandReference>(raw.brandReference),
    storeReference: uuid<GuestStoreReference>(raw.storeReference),
    publicStoreReference: uuid<GuestPublicStoreReference>(raw.publicStoreReference),
    publicTableReference,
    channel,
    locale: raw.locale as GuestLocale,
    qrReference: uuid<GuestQrReference>(raw.qrReference),
    qrRevocationVersion: raw.qrRevocationVersion as number,
    evaluatedAt,
    validUntil,
  });
}

export function parseGuestDiningAdmissionEvidence(value: unknown): GuestDiningAdmissionEvidence {
  const raw = closed(value, [
    "decision",
    "admissionReference",
    "operationReference",
    "storeReference",
    "publicTableReference",
    "diningSessionReference",
    "diningParticipantReference",
    "evaluatedAt",
    "validUntil",
  ]);
  if (raw.decision !== "Allowed") {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const evaluatedAt = instant(raw.evaluatedAt);
  const validUntil = instant(raw.validUntil);
  if (Date.parse(validUntil) <= Date.parse(evaluatedAt)) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  return Object.freeze({
    decision: "Allowed",
    admissionReference: uuid<GuestDiningAdmissionReference>(raw.admissionReference),
    operationReference: parseGuestOperationReference(raw.operationReference),
    storeReference: uuid<GuestStoreReference>(raw.storeReference),
    publicTableReference: uuid<GuestPublicTableReference>(raw.publicTableReference),
    diningSessionReference: uuid<GuestDiningSessionReference>(raw.diningSessionReference),
    diningParticipantReference: uuid<GuestDiningParticipantReference>(
      raw.diningParticipantReference,
    ),
    evaluatedAt,
    validUntil,
  });
}

export function createGuestSession(value: unknown): GuestSession {
  const raw = closed(value, [
    "sessionReference",
    "status",
    "version",
    "brandReference",
    "storeReference",
    "publicStoreReference",
    "publicTableReference",
    "channel",
    "locale",
    "qrReference",
    "qrRevocationVersion",
    "diningState",
    "diningSessionReference",
    "diningParticipantReference",
    "createdAt",
    "lastSeenAt",
    "idleExpiresAt",
    "absoluteExpiresAt",
    "orderClosedAt",
    "closureExpiresAt",
    "rotatedFromGuestSessionReference",
    "revocationReason",
    "revokedAt",
  ]);
  if (
    !["Active", "Revoked", "Expired"].includes(raw.status as string) ||
    !Number.isSafeInteger(raw.version) ||
    (raw.version as number) < 1 ||
    (raw.channel !== "DineIn" && raw.channel !== "Pickup") ||
    (raw.diningState !== "ContextOnly" && raw.diningState !== "DiningBound") ||
    typeof raw.locale !== "string" ||
    !localePattern.test(raw.locale) ||
    !Number.isSafeInteger(raw.qrRevocationVersion) ||
    (raw.qrRevocationVersion as number) < 1
  ) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const publicTableReference =
    raw.publicTableReference === null
      ? null
      : uuid<GuestPublicTableReference>(raw.publicTableReference);
  if ((raw.channel === "DineIn") !== (publicTableReference !== null)) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const diningSessionReference =
    raw.diningSessionReference === null
      ? null
      : uuid<GuestDiningSessionReference>(raw.diningSessionReference);
  const diningParticipantReference =
    raw.diningParticipantReference === null
      ? null
      : uuid<GuestDiningParticipantReference>(raw.diningParticipantReference);
  if (
    (raw.diningState === "ContextOnly" &&
      (diningSessionReference !== null || diningParticipantReference !== null)) ||
    (raw.diningState === "DiningBound" &&
      (raw.channel !== "DineIn" ||
        diningSessionReference === null ||
        diningParticipantReference === null))
  ) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  const createdAt = instant(raw.createdAt);
  const lastSeenAt = instant(raw.lastSeenAt);
  const idleExpiresAt = instant(raw.idleExpiresAt);
  const absoluteExpiresAt = instant(raw.absoluteExpiresAt);
  const orderClosedAt = raw.orderClosedAt === null ? null : instant(raw.orderClosedAt);
  const closureExpiresAt = raw.closureExpiresAt === null ? null : instant(raw.closureExpiresAt);
  const revokedAt = raw.revokedAt === null ? null : instant(raw.revokedAt);
  const status = raw.status as GuestSessionStatus;
  const revocationReason = raw.revocationReason as GuestSessionRevocationReason | null;
  const reasons: readonly GuestSessionRevocationReason[] = [
    "Rotated",
    "BindingChanged",
    "Logout",
    "StoreUnavailable",
    "QrRevoked",
    "OrderClosed",
    "DiningSessionClosed",
    "RiskChanged",
    "Administrative",
  ];
  if (
    Date.parse(lastSeenAt) < Date.parse(createdAt) ||
    Date.parse(idleExpiresAt) !== Date.parse(lastSeenAt) + 4 * 60 * 60 * 1000 ||
    Date.parse(absoluteExpiresAt) !== Date.parse(createdAt) + 24 * 60 * 60 * 1000 ||
    (orderClosedAt === null) !== (closureExpiresAt === null) ||
    (orderClosedAt !== null &&
      Date.parse(closureExpiresAt as CanonicalInstant) !==
        Date.parse(orderClosedAt) + 2 * 60 * 60 * 1000) ||
    (status === "Active" && (revocationReason !== null || revokedAt !== null)) ||
    (status === "Revoked" &&
      (!reasons.includes(revocationReason as GuestSessionRevocationReason) ||
        revokedAt === null ||
        Date.parse(revokedAt) < Date.parse(createdAt))) ||
    (status === "Expired" && (revocationReason !== null || revokedAt !== null))
  ) {
    throw new GuestSessionError("GUEST_SESSION_INPUT_INVALID");
  }
  return Object.freeze({
    sessionReference: uuid<GuestSessionReference>(raw.sessionReference),
    status,
    version: raw.version as number,
    brandReference: uuid<GuestBrandReference>(raw.brandReference),
    storeReference: uuid<GuestStoreReference>(raw.storeReference),
    publicStoreReference: uuid<GuestPublicStoreReference>(raw.publicStoreReference),
    publicTableReference,
    channel: raw.channel,
    locale: raw.locale as GuestLocale,
    qrReference: uuid<GuestQrReference>(raw.qrReference),
    qrRevocationVersion: raw.qrRevocationVersion as number,
    diningState: raw.diningState,
    diningSessionReference,
    diningParticipantReference,
    createdAt,
    lastSeenAt,
    idleExpiresAt,
    absoluteExpiresAt,
    orderClosedAt,
    closureExpiresAt,
    rotatedFromGuestSessionReference:
      raw.rotatedFromGuestSessionReference === null
        ? null
        : uuid<GuestSessionReference>(raw.rotatedFromGuestSessionReference),
    revocationReason,
    revokedAt,
  });
}

export function createGuestSessionRecord(value: unknown): GuestSessionRecord {
  const raw = closed(value, [
    "session",
    "sessionSelectorHash",
    "csrfSelectorHash",
    "operationReference",
    "operationIntentHash",
  ]);
  return Object.freeze({
    session: createGuestSession(raw.session),
    sessionSelectorHash: parseGuestSelectorHash(raw.sessionSelectorHash),
    csrfSelectorHash: parseGuestSelectorHash(raw.csrfSelectorHash),
    operationReference: parseGuestOperationReference(raw.operationReference),
    operationIntentHash: parseGuestSelectorHash(raw.operationIntentHash),
  });
}

export function assertGuestSessionUsable(
  session: GuestSession,
  observedAtInput: unknown,
): GuestSession {
  const observedAt = instant(observedAtInput);
  const effectiveExpiry = Math.min(
    Date.parse(session.idleExpiresAt),
    Date.parse(session.absoluteExpiresAt),
    session.closureExpiresAt === null
      ? Number.POSITIVE_INFINITY
      : Date.parse(session.closureExpiresAt),
  );
  if (session.status !== "Active" || Date.parse(observedAt) >= effectiveExpiry) {
    throw new GuestSessionError("GUEST_SESSION_UNAVAILABLE");
  }
  return session;
}
