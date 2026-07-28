import {
  createIdentityActor,
  IdentityContractError,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type ActorReference,
  type CanonicalInstant,
  type IdentityActor,
} from "./identity-actor.js";

export const authenticationSessionStatuses = ["Active", "Revoked", "Expired"] as const;
export type AuthenticationSessionStatus = (typeof authenticationSessionStatuses)[number];

export const revocationReasons = [
  "Logout",
  "GlobalLogout",
  "MembershipDisabled",
  "RoleRemoved",
  "StoreAssignmentRemoved",
  "CredentialReset",
  "CredentialCompromised",
  "Recovery",
  "ConcurrentLimit",
  "RiskChange",
  "Administrative",
] as const;
export type RevocationReason = (typeof revocationReasons)[number];

export const sessionPolicies = {
  WorkforceStandard: {
    code: "WorkforceStandard",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 30,
    absoluteTimeoutMinutes: 12 * 60,
  },
  Privileged: {
    code: "Privileged",
    maxActiveSessions: 2,
    idleTimeoutMinutes: 15,
    absoluteTimeoutMinutes: 8 * 60,
  },
  NamedKdsOperator: {
    code: "NamedKdsOperator",
    maxActiveSessions: 5,
    idleTimeoutMinutes: 60,
    absoluteTimeoutMinutes: 12 * 60,
  },
} as const;
export type SessionPolicyCode = keyof typeof sessionPolicies;
export type SessionPolicy = (typeof sessionPolicies)[SessionPolicyCode];
export type SessionReference = string & { readonly __sessionReference: unique symbol };
export type CorrelationReference = string & { readonly __correlationReference: unique symbol };
export type IdempotencyReference = string & { readonly __idempotencyReference: unique symbol };
export type PurposeCode = string & { readonly __purposeCode: unique symbol };
export type SessionVersion = number & { readonly __sessionVersion: unique symbol };

function requiredEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  code: "SESSION_SHAPE_INVALID" | "REVOCATION_INVALID",
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new IdentityContractError(code);
  }
  return value as T[number];
}

export function parseSessionVersion(value: unknown): SessionVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new IdentityContractError("SESSION_SHAPE_INVALID");
  }
  return value as SessionVersion;
}

export function parseSessionReference(value: unknown): SessionReference {
  return parseOpaqueUuidV7(value, "SESSION_REFERENCE_INVALID") as SessionReference;
}

export function parseCorrelationReference(value: unknown): CorrelationReference {
  return parseOpaqueUuidV7(value, "EVENT_INVALID") as CorrelationReference;
}

export function parseIdempotencyReference(value: unknown): IdempotencyReference {
  return parseOpaqueUuidV7(value, "REVOCATION_INVALID") as IdempotencyReference;
}

export function parsePurposeCode(value: unknown): PurposeCode {
  if (typeof value !== "string" || !/^[A-Z][A-Z0-9_]{0,127}$/u.test(value)) {
    throw new IdentityContractError("REVOCATION_INVALID");
  }
  return value as PurposeCode;
}

function policyFromRecord(record: Readonly<Record<string, unknown>>): SessionPolicy {
  if (typeof record.policyCode !== "string" || !Object.hasOwn(sessionPolicies, record.policyCode)) {
    throw new IdentityContractError("SESSION_POLICY_INVALID");
  }
  const policy = sessionPolicies[record.policyCode as SessionPolicyCode];
  if (
    record.maxActiveSessions !== policy.maxActiveSessions ||
    record.idleTimeoutMinutes !== policy.idleTimeoutMinutes ||
    record.absoluteTimeoutMinutes !== policy.absoluteTimeoutMinutes
  ) {
    throw new IdentityContractError("SESSION_POLICY_INVALID");
  }
  return policy;
}

function addMinutes(instant: CanonicalInstant, minutes: number): string {
  return new Date(Date.parse(instant) + minutes * 60_000).toISOString();
}

export interface AuthenticationSession {
  readonly sessionReference: SessionReference;
  readonly actor: IdentityActor;
  readonly status: AuthenticationSessionStatus;
  readonly policy: SessionPolicy;
  readonly version: SessionVersion;
  readonly authenticatedAt: CanonicalInstant;
  readonly createdAt: CanonicalInstant;
  readonly lastSeenAt: CanonicalInstant;
  readonly idleExpiresAt: CanonicalInstant;
  readonly absoluteExpiresAt: CanonicalInstant;
  readonly rotatedFromSessionReference: SessionReference | null;
  readonly revocationReason: RevocationReason | null;
  readonly revokedAt: CanonicalInstant | null;
}

export function createAuthenticationSession(value: unknown): AuthenticationSession {
  const record = readClosedRecord(
    value,
    [
      "sessionReference",
      "actor",
      "status",
      "policyCode",
      "maxActiveSessions",
      "idleTimeoutMinutes",
      "absoluteTimeoutMinutes",
      "version",
      "authenticatedAt",
      "createdAt",
      "lastSeenAt",
      "idleExpiresAt",
      "absoluteExpiresAt",
      "rotatedFromSessionReference",
      "revocationReason",
      "revokedAt",
    ],
    "SESSION_SHAPE_INVALID",
  );
  const sessionReference = parseSessionReference(record.sessionReference);
  const actor = createIdentityActor(record.actor);
  const status = requiredEnum(
    record.status,
    authenticationSessionStatuses,
    "SESSION_SHAPE_INVALID",
  );
  const policy = policyFromRecord(record);
  const version = parseSessionVersion(record.version);
  const authenticatedAt = parseCanonicalInstant(record.authenticatedAt);
  const createdAt = parseCanonicalInstant(record.createdAt);
  const lastSeenAt = parseCanonicalInstant(record.lastSeenAt);
  const idleExpiresAt = parseCanonicalInstant(record.idleExpiresAt);
  const absoluteExpiresAt = parseCanonicalInstant(record.absoluteExpiresAt);
  if (
    authenticatedAt !== actor.authenticatedAt ||
    Date.parse(authenticatedAt) > Date.parse(createdAt) ||
    Date.parse(createdAt) > Date.parse(lastSeenAt) ||
    Date.parse(lastSeenAt) > Date.parse(idleExpiresAt) ||
    Date.parse(idleExpiresAt) > Date.parse(absoluteExpiresAt) ||
    idleExpiresAt !== addMinutes(lastSeenAt, policy.idleTimeoutMinutes) ||
    absoluteExpiresAt !== addMinutes(createdAt, policy.absoluteTimeoutMinutes)
  ) {
    throw new IdentityContractError("SESSION_SHAPE_INVALID");
  }

  const rotatedFromSessionReference =
    record.rotatedFromSessionReference === null
      ? null
      : parseSessionReference(record.rotatedFromSessionReference);
  if (rotatedFromSessionReference === sessionReference) {
    throw new IdentityContractError("SESSION_ROTATED");
  }
  const revocationReason =
    record.revocationReason === null
      ? null
      : requiredEnum(record.revocationReason, revocationReasons, "REVOCATION_INVALID");
  const revokedAt = record.revokedAt === null ? null : parseCanonicalInstant(record.revokedAt);
  if (
    (status === "Revoked") !== (revocationReason !== null && revokedAt !== null) ||
    (status !== "Revoked" && (revocationReason !== null || revokedAt !== null)) ||
    (revokedAt !== null && Date.parse(revokedAt) < Date.parse(createdAt))
  ) {
    throw new IdentityContractError("REVOCATION_INVALID");
  }

  return Object.freeze({
    sessionReference,
    actor,
    status,
    policy,
    version,
    authenticatedAt,
    createdAt,
    lastSeenAt,
    idleExpiresAt,
    absoluteExpiresAt,
    rotatedFromSessionReference,
    revocationReason,
    revokedAt,
  });
}

export function assertSessionUsable(
  session: AuthenticationSession,
  observedAtInput: unknown,
): AuthenticationSession {
  const observedAt = parseCanonicalInstant(observedAtInput);
  if (session.status === "Revoked") throw new IdentityContractError("SESSION_REVOKED");
  if (session.status === "Expired") throw new IdentityContractError("SESSION_EXPIRED");
  if (
    Date.parse(observedAt) < Date.parse(session.createdAt) ||
    Date.parse(observedAt) >= Date.parse(session.idleExpiresAt) ||
    Date.parse(observedAt) >= Date.parse(session.absoluteExpiresAt)
  ) {
    throw new IdentityContractError("SESSION_EXPIRED");
  }
  return session;
}

export interface SessionRevokedEvent {
  readonly eventType: "identity.session-revoked.v1";
  readonly sessionReference: SessionReference;
  readonly actorReference: ActorReference;
  readonly reason: RevocationReason;
  readonly occurredAt: CanonicalInstant;
  readonly correlationId: CorrelationReference;
}

export function createSessionRevokedEvent(value: unknown): SessionRevokedEvent {
  const record = readClosedRecord(
    value,
    ["eventType", "sessionReference", "actorReference", "reason", "occurredAt", "correlationId"],
    "EVENT_INVALID",
  );
  if (record.eventType !== "identity.session-revoked.v1") {
    throw new IdentityContractError("EVENT_INVALID");
  }
  return Object.freeze({
    eventType: "identity.session-revoked.v1",
    sessionReference: parseSessionReference(record.sessionReference),
    actorReference: parseOpaqueUuidV7(
      record.actorReference,
      "ACTOR_REFERENCE_INVALID",
    ) as ActorReference,
    reason: requiredEnum(record.reason, revocationReasons, "REVOCATION_INVALID"),
    occurredAt: parseCanonicalInstant(record.occurredAt),
    correlationId: parseCorrelationReference(record.correlationId),
  });
}

export interface CredentialCompromisedEvent {
  readonly eventType: "identity.credential-compromised.v1";
  readonly actorReference: ActorReference;
  readonly credentialReferenceHmacSha256: string;
  readonly occurredAt: CanonicalInstant;
  readonly correlationId: CorrelationReference;
}

export function createCredentialCompromisedEvent(value: unknown): CredentialCompromisedEvent {
  const record = readClosedRecord(
    value,
    ["eventType", "actorReference", "credentialReferenceHmacSha256", "occurredAt", "correlationId"],
    "EVENT_INVALID",
  );
  if (
    record.eventType !== "identity.credential-compromised.v1" ||
    typeof record.credentialReferenceHmacSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(record.credentialReferenceHmacSha256)
  ) {
    throw new IdentityContractError("EVENT_INVALID");
  }
  return Object.freeze({
    eventType: "identity.credential-compromised.v1",
    actorReference: parseOpaqueUuidV7(
      record.actorReference,
      "ACTOR_REFERENCE_INVALID",
    ) as ActorReference,
    credentialReferenceHmacSha256: record.credentialReferenceHmacSha256,
    occurredAt: parseCanonicalInstant(record.occurredAt),
    correlationId: parseCorrelationReference(record.correlationId),
  });
}
