import {
  IdentityContractError,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
  type ActorReference,
  type CanonicalInstant,
} from "./identity-actor.js";

/** Current account identity only. No login, Session or MFA fact is asserted. */
export interface CurrentWorkforceAccount {
  readonly profile: "CurrentWorkforceAccountV1";
  readonly actorType: "User";
  readonly actorReference: ActorReference;
  readonly accountKind: "Workforce";
  readonly status: "Active";
  readonly observedAt: CanonicalInstant;
  readonly validUntil: CanonicalInstant;
}
export function parseCurrentWorkforceAccount(value: unknown): CurrentWorkforceAccount {
  const r = readClosedRecord(
    value,
    ["profile", "actorType", "actorReference", "accountKind", "status", "observedAt", "validUntil"],
    "ACTOR_SHAPE_INVALID",
  );
  if (
    r.profile !== "CurrentWorkforceAccountV1" ||
    r.actorType !== "User" ||
    r.accountKind !== "Workforce" ||
    r.status !== "Active"
  )
    throw new IdentityContractError("ACTOR_SHAPE_INVALID");
  const observedAt = parseCanonicalInstant(r.observedAt),
    validUntil = parseCanonicalInstant(r.validUntil);
  if (
    observedAt.startsWith("0000-") ||
    validUntil.startsWith("0000-") ||
    observedAt >= validUntil ||
    Date.parse(validUntil) > Date.parse(observedAt) + 5000
  )
    throw new IdentityContractError("TIMESTAMP_INVALID");
  return Object.freeze({
    profile: "CurrentWorkforceAccountV1",
    actorType: "User",
    actorReference: parseOpaqueUuidV7(
      r.actorReference,
      "ACTOR_REFERENCE_INVALID",
    ) as ActorReference,
    accountKind: "Workforce",
    status: "Active",
    observedAt,
    validUntil,
  });
}
