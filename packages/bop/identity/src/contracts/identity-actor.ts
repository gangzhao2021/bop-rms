export const actorTypes = ["User", "System", "Service"] as const;
export type ActorType = (typeof actorTypes)[number];

export const accountKinds = ["Customer", "Workforce", "Platform", "Service", "System"] as const;
export type AccountKind = (typeof accountKinds)[number];

export const identityStatuses = ["Active", "Suspended", "Disabled", "Merged"] as const;
export type IdentityStatus = (typeof identityStatuses)[number];

export const authenticationMethods = ["Oidc", "ServiceCredential", "System"] as const;
export type AuthenticationMethod = (typeof authenticationMethods)[number];

export const verificationLevels = ["SingleFactor", "Mfa", "RecentMfa"] as const;
export type VerificationLevel = (typeof verificationLevels)[number];

export const identityContractErrorCodes = [
  "IDENTITY_INPUT_INVALID",
  "ACTOR_REFERENCE_INVALID",
  "ACTOR_SHAPE_INVALID",
  "ACTOR_INACTIVE",
  "AUTHENTICATION_METHOD_INVALID",
  "VERIFICATION_LEVEL_INVALID",
  "TIMESTAMP_INVALID",
  "SESSION_REFERENCE_INVALID",
  "SESSION_SHAPE_INVALID",
  "SESSION_POLICY_INVALID",
  "SESSION_REVOKED",
  "SESSION_EXPIRED",
  "SESSION_UNKNOWN",
  "SESSION_VERSION_CONFLICT",
  "SESSION_ROTATED",
  "REVOCATION_INVALID",
  "EVENT_INVALID",
] as const;
export type IdentityContractErrorCode = (typeof identityContractErrorCodes)[number];

const safeMessages: Readonly<Record<IdentityContractErrorCode, string>> = {
  IDENTITY_INPUT_INVALID: "identity input is invalid",
  ACTOR_REFERENCE_INVALID: "actor reference is invalid",
  ACTOR_SHAPE_INVALID: "actor shape is invalid",
  ACTOR_INACTIVE: "actor is not active",
  AUTHENTICATION_METHOD_INVALID: "authentication method is invalid",
  VERIFICATION_LEVEL_INVALID: "verification level is invalid",
  TIMESTAMP_INVALID: "timestamp is invalid",
  SESSION_REFERENCE_INVALID: "session reference is invalid",
  SESSION_SHAPE_INVALID: "session shape is invalid",
  SESSION_POLICY_INVALID: "session policy is invalid",
  SESSION_REVOKED: "session is not active",
  SESSION_EXPIRED: "session is not active",
  SESSION_UNKNOWN: "session is not active",
  SESSION_VERSION_CONFLICT: "session version conflict",
  SESSION_ROTATED: "session is not active",
  REVOCATION_INVALID: "session revocation is invalid",
  EVENT_INVALID: "identity event is invalid",
};

export class IdentityContractError extends Error {
  readonly code: IdentityContractErrorCode;

  constructor(code: IdentityContractErrorCode) {
    super(safeMessages[code]);
    this.name = "IdentityContractError";
    this.code = code;
  }
}

export type ActorReference = string & { readonly __actorReference: unique symbol };
export type CanonicalInstant = string & { readonly __canonicalInstant: unique symbol };

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const canonicalInstantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function parseOpaqueUuidV7(value: unknown, code: IdentityContractErrorCode): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value)) {
    throw new IdentityContractError(code);
  }
  return value;
}

export function parseCanonicalInstant(value: unknown): CanonicalInstant {
  if (typeof value !== "string" || !canonicalInstantPattern.test(value)) {
    throw new IdentityContractError("TIMESTAMP_INVALID");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new IdentityContractError("TIMESTAMP_INVALID");
  }
  return value as CanonicalInstant;
}

export function readClosedRecord(
  value: unknown,
  keys: readonly string[],
  code: IdentityContractErrorCode = "IDENTITY_INPUT_INVALID",
): Readonly<Record<string, unknown>> {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new IdentityContractError(code);
    }
    if (Object.getPrototypeOf(value) !== Object.prototype) {
      throw new IdentityContractError(code);
    }
    const allowed = new Set(keys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key)) ||
      ownKeys.length !== keys.length
    ) {
      throw new IdentityContractError(code);
    }
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const record: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) {
        throw new IdentityContractError(code);
      }
      record[key] = descriptor.value;
    }
    return Object.freeze(record);
  } catch (error) {
    if (error instanceof IdentityContractError) throw error;
    throw new IdentityContractError(code);
  }
}

function oneOf<const T extends readonly string[]>(
  value: unknown,
  values: T,
  code: IdentityContractErrorCode,
): T[number] {
  if (typeof value !== "string" || !values.includes(value as T[number])) {
    throw new IdentityContractError(code);
  }
  return value as T[number];
}

export interface IdentityActor {
  readonly actorType: ActorType;
  readonly actorReference: ActorReference | null;
  readonly accountKind: AccountKind;
  readonly status: "Active";
  readonly authenticationMethod: AuthenticationMethod;
  readonly verificationLevel: VerificationLevel;
  readonly authenticatedAt: CanonicalInstant;
  readonly recentMfaAt: CanonicalInstant | null;
}

export function createIdentityActor(value: unknown): IdentityActor {
  const record = readClosedRecord(
    value,
    [
      "actorType",
      "actorReference",
      "accountKind",
      "status",
      "authenticationMethod",
      "verificationLevel",
      "authenticatedAt",
      "recentMfaAt",
    ],
    "ACTOR_SHAPE_INVALID",
  );
  const actorType = oneOf(record.actorType, actorTypes, "ACTOR_SHAPE_INVALID");
  const accountKind = oneOf(record.accountKind, accountKinds, "ACTOR_SHAPE_INVALID");
  const status = oneOf(record.status, identityStatuses, "ACTOR_SHAPE_INVALID");
  if (status !== "Active") throw new IdentityContractError("ACTOR_INACTIVE");

  const expectedShape =
    (actorType === "User" &&
      record.actorReference !== null &&
      ["Customer", "Workforce", "Platform"].includes(accountKind)) ||
    (actorType === "Service" && record.actorReference !== null && accountKind === "Service") ||
    (actorType === "System" && record.actorReference === null && accountKind === "System");
  if (!expectedShape) throw new IdentityContractError("ACTOR_SHAPE_INVALID");

  const actorReference =
    record.actorReference === null
      ? null
      : (parseOpaqueUuidV7(record.actorReference, "ACTOR_REFERENCE_INVALID") as ActorReference);
  const authenticationMethod = oneOf(
    record.authenticationMethod,
    authenticationMethods,
    "AUTHENTICATION_METHOD_INVALID",
  );
  if (
    (actorType === "User" && authenticationMethod !== "Oidc") ||
    (actorType === "Service" && authenticationMethod !== "ServiceCredential") ||
    (actorType === "System" && authenticationMethod !== "System")
  ) {
    throw new IdentityContractError("AUTHENTICATION_METHOD_INVALID");
  }

  const verificationLevel = oneOf(
    record.verificationLevel,
    verificationLevels,
    "VERIFICATION_LEVEL_INVALID",
  );
  if (actorType !== "User" && verificationLevel !== "SingleFactor") {
    throw new IdentityContractError("VERIFICATION_LEVEL_INVALID");
  }
  const authenticatedAt = parseCanonicalInstant(record.authenticatedAt);
  const recentMfaAt =
    record.recentMfaAt === null ? null : parseCanonicalInstant(record.recentMfaAt);
  if (
    (verificationLevel === "RecentMfa") !== (recentMfaAt !== null) ||
    (recentMfaAt !== null && Date.parse(recentMfaAt) > Date.parse(authenticatedAt))
  ) {
    throw new IdentityContractError("VERIFICATION_LEVEL_INVALID");
  }

  return Object.freeze({
    actorType,
    actorReference,
    accountKind,
    status: "Active",
    authenticationMethod,
    verificationLevel,
    authenticatedAt,
    recentMfaAt,
  });
}
