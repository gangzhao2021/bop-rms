import { parseOpaqueUuidV7, readClosedRecord, type ActorReference } from "@bop/identity";
import {
  parseBrandReference,
  parseStoreReference,
  type BrandReference,
  type StoreReference,
} from "@bop/tenant";
import {
  MembershipContractError,
  membershipLifecycles,
  storeAssignmentLifecycles,
  parseMembershipInstant,
  parseMembershipReference,
  parseMembershipVersion,
  parseStoreAssignmentReference,
  parseWorkforceRelationshipReference,
  type Membership,
  type StoreAssignment,
} from "../domain/membership.js";

const invalid = (): never => {
  throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
};
function dense<T>(values: readonly T[], maximum: number): readonly T[] {
  if (
    !Array.isArray(values) ||
    Object.getPrototypeOf(values) !== Array.prototype ||
    values.length > maximum ||
    Reflect.ownKeys(values).length !== values.length + 1
  )
    return invalid();
  return Array.from({ length: values.length }, (_, index) => {
    const item = Object.getOwnPropertyDescriptor(values, String(index));
    if (!item?.enumerable || !("value" in item)) return invalid();
    return item.value as T;
  });
}
function times(value: Readonly<Record<string, unknown>>, at: string) {
  const from = parseMembershipInstant(value.effectiveFrom),
    until = value.effectiveUntil === null ? null : parseMembershipInstant(value.effectiveUntil),
    created = parseMembershipInstant(value.createdAt),
    updated = parseMembershipInstant(value.updatedAt);
  if (
    [from, until, created, updated].some((value) => value?.startsWith("0000-")) ||
    (until !== null && until <= from) ||
    updated < created ||
    updated > at
  )
    return invalid();
  parseMembershipVersion(value.version);
}
function membership(value: Membership, at: string): Membership {
  const row = readClosedRecord(value, [
    "membershipReference",
    "actorReference",
    "brandReference",
    "workforceRelationshipReference",
    "lifecycle",
    "effectiveFrom",
    "effectiveUntil",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  if (!Object.isFrozen(value) || !membershipLifecycles.some((state) => state === row.lifecycle))
    return invalid();
  parseMembershipReference(row.membershipReference);
  parseOpaqueUuidV7(row.actorReference, "ACTOR_REFERENCE_INVALID");
  parseBrandReference(row.brandReference);
  if (row.workforceRelationshipReference !== null)
    parseWorkforceRelationshipReference(row.workforceRelationshipReference);
  else if (row.lifecycle === "Active") return invalid();
  times(row, at);
  return value;
}
function assignment(value: StoreAssignment, at: string): StoreAssignment {
  const row = readClosedRecord(value, [
    "storeAssignmentReference",
    "membershipReference",
    "actorReference",
    "brandReference",
    "storeReference",
    "lifecycle",
    "effectiveFrom",
    "effectiveUntil",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  if (
    !Object.isFrozen(value) ||
    !storeAssignmentLifecycles.some((state) => state === row.lifecycle)
  )
    return invalid();
  parseStoreAssignmentReference(row.storeAssignmentReference);
  parseMembershipReference(row.membershipReference);
  parseOpaqueUuidV7(row.actorReference, "ACTOR_REFERENCE_INVALID");
  parseBrandReference(row.brandReference);
  parseStoreReference(row.storeReference);
  times(row, at);
  return value;
}
const effective = (value: Membership | StoreAssignment, at: string) =>
  value.effectiveFrom <= at && (value.effectiveUntil === null || at < value.effectiveUntil);
const eligible = (value: Membership, at: string) =>
  (value.lifecycle === "PendingActivation" || value.lifecycle === "Active") && effective(value, at);
const observation = (value: unknown): string => {
  const at = parseMembershipInstant(value);
  if (at.startsWith("0000-")) return invalid();
  return at;
};

/** Invitation precondition only: approved Pending Membership is not business
 * authority, an authenticated target Actor, or an activation command. Callers
 * must obtain these frozen owning snapshots under current approval/authority. */
export function resolveWorkforceInvitationMembership(
  memberships: readonly Membership[],
  actorReference: ActorReference,
  brandReference: BrandReference,
  observedAt: unknown,
): Membership {
  try {
    const at = observation(observedAt),
      actor = parseOpaqueUuidV7(actorReference, "ACTOR_REFERENCE_INVALID"),
      brand = parseBrandReference(brandReference),
      rows = dense(memberships, 1024).map((value) => membership(value, at));
    if (new Set(rows.map((value) => value.membershipReference)).size !== rows.length)
      return invalid();
    const matches = rows.filter(
      (value) =>
        value.actorReference === actor && value.brandReference === brand && eligible(value, at),
    );
    const selected = matches[0];
    if (matches.length !== 1 || !selected) return invalid();
    return selected;
  } catch {
    return invalid();
  }
}

/** Required Store scope is explicit. Empty means no Store assignment is required;
 * unrelated assignments never enlarge the returned invitation scope. */
export function resolveWorkforceInvitationStoreAssignments(
  membershipInput: Membership,
  assignments: readonly StoreAssignment[],
  requiredStoreReferences: readonly StoreReference[],
  observedAt: unknown,
): readonly StoreAssignment[] {
  try {
    const at = observation(observedAt),
      member = membership(membershipInput, at);
    if (!eligible(member, at)) return invalid();
    const required = dense(requiredStoreReferences, 100).map(parseStoreReference),
      rows = dense(assignments, 1024).map((value) => assignment(value, at));
    if (
      new Set(required).size !== required.length ||
      new Set(rows.map((value) => value.storeAssignmentReference)).size !== rows.length
    )
      return invalid();
    return Object.freeze(
      required.map((store) => {
        const matches = rows.filter(
          (value) =>
            value.membershipReference === member.membershipReference &&
            value.actorReference === member.actorReference &&
            value.brandReference === member.brandReference &&
            value.storeReference === store &&
            value.lifecycle === "Active" &&
            effective(value, at),
        );
        const selected = matches[0];
        if (matches.length !== 1 || !selected) return invalid();
        return selected;
      }),
    );
  } catch {
    return invalid();
  }
}
