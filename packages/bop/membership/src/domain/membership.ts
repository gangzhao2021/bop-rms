import { createIdentityActor, type ActorReference, type IdentityActor } from "@bop/identity";
import { createStore, type BrandReference, type Store, type StoreReference } from "@bop/tenant";

export const membershipErrorCodes = [
  "MEMBERSHIP_INPUT_INVALID",
  "MEMBERSHIP_REFERENCE_INVALID",
  "WORKFORCE_RELATIONSHIP_REFERENCE_INVALID",
  "STORE_ASSIGNMENT_REFERENCE_INVALID",
  "MEMBERSHIP_ACTOR_INVALID",
  "MEMBERSHIP_SHAPE_INVALID",
  "STORE_ASSIGNMENT_SHAPE_INVALID",
  "MEMBERSHIP_EVIDENCE_REQUIRED",
  "MEMBERSHIP_VERSION_CONFLICT",
  "STORE_ASSIGNMENT_VERSION_CONFLICT",
  "MEMBERSHIP_TRANSITION_INVALID",
  "STORE_ASSIGNMENT_TRANSITION_INVALID",
  "STORE_BRAND_MISMATCH",
  "ACTIVE_MEMBERSHIP_NOT_FOUND",
  "ACTIVE_MEMBERSHIP_AMBIGUOUS",
  "ACTIVE_STORE_ASSIGNMENT_NOT_FOUND",
  "ACTIVE_STORE_ASSIGNMENT_AMBIGUOUS",
] as const;
export type MembershipErrorCode = (typeof membershipErrorCodes)[number];

const safeMessages: Readonly<Record<MembershipErrorCode, string>> = {
  MEMBERSHIP_INPUT_INVALID: "membership input is invalid",
  MEMBERSHIP_REFERENCE_INVALID: "membership reference is invalid",
  WORKFORCE_RELATIONSHIP_REFERENCE_INVALID: "workforce relationship reference is invalid",
  STORE_ASSIGNMENT_REFERENCE_INVALID: "store assignment reference is invalid",
  MEMBERSHIP_ACTOR_INVALID: "membership actor is invalid",
  MEMBERSHIP_SHAPE_INVALID: "membership shape is invalid",
  STORE_ASSIGNMENT_SHAPE_INVALID: "store assignment shape is invalid",
  MEMBERSHIP_EVIDENCE_REQUIRED: "membership evidence is required",
  MEMBERSHIP_VERSION_CONFLICT: "membership version conflict",
  STORE_ASSIGNMENT_VERSION_CONFLICT: "store assignment version conflict",
  MEMBERSHIP_TRANSITION_INVALID: "membership transition is invalid",
  STORE_ASSIGNMENT_TRANSITION_INVALID: "store assignment transition is invalid",
  STORE_BRAND_MISMATCH: "store does not belong to membership brand",
  ACTIVE_MEMBERSHIP_NOT_FOUND: "active membership was not found",
  ACTIVE_MEMBERSHIP_AMBIGUOUS: "active membership is ambiguous",
  ACTIVE_STORE_ASSIGNMENT_NOT_FOUND: "active store assignment was not found",
  ACTIVE_STORE_ASSIGNMENT_AMBIGUOUS: "active store assignment is ambiguous",
};

export class MembershipContractError extends Error {
  readonly code: MembershipErrorCode;

  constructor(code: MembershipErrorCode) {
    super(safeMessages[code]);
    this.name = "MembershipContractError";
    this.code = code;
  }
}

export type MembershipReference = string & { readonly __membershipReference: unique symbol };
export type StoreAssignmentReference = string & {
  readonly __storeAssignmentReference: unique symbol;
};
export type WorkforceRelationshipReference = string & {
  readonly __workforceRelationshipReference: unique symbol;
};
export type MembershipVersion = number & { readonly __membershipVersion: unique symbol };
export type MembershipInstant = string & { readonly __membershipInstant: unique symbol };

export const membershipLifecycles = ["PendingActivation", "Active", "Suspended", "Ended"] as const;
export type MembershipLifecycle = (typeof membershipLifecycles)[number];
export const storeAssignmentLifecycles = ["Active", "Suspended", "Ended"] as const;
export type StoreAssignmentLifecycle = (typeof storeAssignmentLifecycles)[number];

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

function uuid(value: unknown, code: MembershipErrorCode): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new MembershipContractError(code);
  return value;
}
export function parseMembershipReference(value: unknown): MembershipReference {
  return uuid(value, "MEMBERSHIP_REFERENCE_INVALID") as MembershipReference;
}
export function parseStoreAssignmentReference(value: unknown): StoreAssignmentReference {
  return uuid(value, "STORE_ASSIGNMENT_REFERENCE_INVALID") as StoreAssignmentReference;
}
export function parseWorkforceRelationshipReference(
  value: unknown,
): WorkforceRelationshipReference {
  return uuid(value, "WORKFORCE_RELATIONSHIP_REFERENCE_INVALID") as WorkforceRelationshipReference;
}
export function parseMembershipVersion(value: unknown): MembershipVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
  return value as MembershipVersion;
}
export function parseMembershipInstant(value: unknown): MembershipInstant {
  if (typeof value !== "string" || !instantPattern.test(value))
    throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value)
    throw new MembershipContractError("MEMBERSHIP_INPUT_INVALID");
  return value as MembershipInstant;
}

function closed(
  value: unknown,
  keys: readonly string[],
  code: MembershipErrorCode,
): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new MembershipContractError(code);
    const allowed = new Set(keys);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      throw new MembershipContractError(code);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new MembershipContractError(code);
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof MembershipContractError) throw error;
    throw new MembershipContractError(code);
  }
}

function membershipLifecycle(value: unknown): MembershipLifecycle {
  if (typeof value !== "string" || !membershipLifecycles.includes(value as MembershipLifecycle))
    throw new MembershipContractError("MEMBERSHIP_SHAPE_INVALID");
  return value as MembershipLifecycle;
}
function assignmentLifecycle(value: unknown): StoreAssignmentLifecycle {
  if (
    typeof value !== "string" ||
    !storeAssignmentLifecycles.includes(value as StoreAssignmentLifecycle)
  )
    throw new MembershipContractError("STORE_ASSIGNMENT_SHAPE_INVALID");
  return value as StoreAssignmentLifecycle;
}
function period(
  fromInput: unknown,
  untilInput: unknown,
  shapeCode: MembershipErrorCode,
): readonly [MembershipInstant, MembershipInstant | null] {
  const from = parseMembershipInstant(fromInput);
  const until = untilInput === null ? null : parseMembershipInstant(untilInput);
  if (until !== null && Date.parse(until) <= Date.parse(from))
    throw new MembershipContractError(shapeCode);
  return [from, until];
}
function isEffective(
  from: MembershipInstant,
  until: MembershipInstant | null,
  at: MembershipInstant,
): boolean {
  const instant = Date.parse(at);
  return Date.parse(from) <= instant && (until === null || instant < Date.parse(until));
}
function assertActor(actorInput: IdentityActor, expected: unknown): ActorReference {
  try {
    const actor = createIdentityActor(actorInput);
    if (
      actor.actorType !== "User" ||
      actor.accountKind !== "Workforce" ||
      actor.actorReference === null ||
      actor.actorReference !== expected
    )
      throw new MembershipContractError("MEMBERSHIP_ACTOR_INVALID");
    return actor.actorReference;
  } catch {
    throw new MembershipContractError("MEMBERSHIP_ACTOR_INVALID");
  }
}

export interface Membership {
  readonly membershipReference: MembershipReference;
  readonly actorReference: ActorReference;
  readonly brandReference: BrandReference;
  readonly workforceRelationshipReference: WorkforceRelationshipReference | null;
  readonly lifecycle: MembershipLifecycle;
  readonly effectiveFrom: MembershipInstant;
  readonly effectiveUntil: MembershipInstant | null;
  readonly version: MembershipVersion;
  readonly createdAt: MembershipInstant;
  readonly updatedAt: MembershipInstant;
}
export interface StoreAssignment {
  readonly storeAssignmentReference: StoreAssignmentReference;
  readonly membershipReference: MembershipReference;
  readonly actorReference: ActorReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
  readonly lifecycle: StoreAssignmentLifecycle;
  readonly effectiveFrom: MembershipInstant;
  readonly effectiveUntil: MembershipInstant | null;
  readonly version: MembershipVersion;
  readonly createdAt: MembershipInstant;
  readonly updatedAt: MembershipInstant;
}

export function createMembership(value: unknown, actor: IdentityActor): Membership {
  const r = closed(
    value,
    [
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
    ],
    "MEMBERSHIP_SHAPE_INVALID",
  );
  const lifecycle = membershipLifecycle(r.lifecycle);
  const relationship =
    r.workforceRelationshipReference === null
      ? null
      : parseWorkforceRelationshipReference(r.workforceRelationshipReference);
  if (lifecycle === "Active" && relationship === null)
    throw new MembershipContractError("MEMBERSHIP_EVIDENCE_REQUIRED");
  const [effectiveFrom, effectiveUntil] = period(
    r.effectiveFrom,
    r.effectiveUntil,
    "MEMBERSHIP_SHAPE_INVALID",
  );
  const createdAt = parseMembershipInstant(r.createdAt);
  const updatedAt = parseMembershipInstant(r.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new MembershipContractError("MEMBERSHIP_SHAPE_INVALID");
  return Object.freeze({
    membershipReference: parseMembershipReference(r.membershipReference),
    actorReference: assertActor(actor, r.actorReference),
    brandReference: uuid(r.brandReference, "MEMBERSHIP_SHAPE_INVALID") as BrandReference,
    workforceRelationshipReference: relationship,
    lifecycle,
    effectiveFrom,
    effectiveUntil,
    version: parseMembershipVersion(r.version),
    createdAt,
    updatedAt,
  });
}

export function createStoreAssignment(
  value: unknown,
  membership: Membership,
  storeInput: Store,
): StoreAssignment {
  let store: Store;
  try {
    store = createStore(storeInput);
  } catch {
    throw new MembershipContractError("STORE_ASSIGNMENT_SHAPE_INVALID");
  }
  const r = closed(
    value,
    [
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
    ],
    "STORE_ASSIGNMENT_SHAPE_INVALID",
  );
  if (
    r.membershipReference !== membership.membershipReference ||
    r.actorReference !== membership.actorReference ||
    r.brandReference !== membership.brandReference ||
    r.storeReference !== store.storeReference ||
    store.brandReference !== membership.brandReference
  )
    throw new MembershipContractError("STORE_BRAND_MISMATCH");
  const [effectiveFrom, effectiveUntil] = period(
    r.effectiveFrom,
    r.effectiveUntil,
    "STORE_ASSIGNMENT_SHAPE_INVALID",
  );
  const createdAt = parseMembershipInstant(r.createdAt);
  const updatedAt = parseMembershipInstant(r.updatedAt);
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new MembershipContractError("STORE_ASSIGNMENT_SHAPE_INVALID");
  return Object.freeze({
    storeAssignmentReference: parseStoreAssignmentReference(r.storeAssignmentReference),
    membershipReference: membership.membershipReference,
    actorReference: membership.actorReference,
    brandReference: membership.brandReference,
    storeReference: store.storeReference,
    lifecycle: assignmentLifecycle(r.lifecycle),
    effectiveFrom,
    effectiveUntil,
    version: parseMembershipVersion(r.version),
    createdAt,
    updatedAt,
  });
}

const membershipTransitions: Readonly<Record<MembershipLifecycle, readonly MembershipLifecycle[]>> =
  {
    PendingActivation: ["Active", "Ended"],
    Active: ["Suspended", "Ended"],
    Suspended: ["Active", "Ended"],
    Ended: [],
  };
const assignmentTransitions: Readonly<
  Record<StoreAssignmentLifecycle, readonly StoreAssignmentLifecycle[]>
> = {
  Active: ["Suspended", "Ended"],
  Suspended: ["Active", "Ended"],
  Ended: [],
};

export function transitionMembership(
  membership: Membership,
  expectedVersion: MembershipVersion,
  next: MembershipLifecycle,
  updatedAtInput: unknown,
): Membership {
  if (membership.version !== expectedVersion)
    throw new MembershipContractError("MEMBERSHIP_VERSION_CONFLICT");
  if (!membershipTransitions[membership.lifecycle].includes(next))
    throw new MembershipContractError("MEMBERSHIP_TRANSITION_INVALID");
  if (next === "Active" && membership.workforceRelationshipReference === null)
    throw new MembershipContractError("MEMBERSHIP_EVIDENCE_REQUIRED");
  const updatedAt = parseMembershipInstant(updatedAtInput);
  if (Date.parse(updatedAt) < Date.parse(membership.updatedAt))
    throw new MembershipContractError("MEMBERSHIP_TRANSITION_INVALID");
  return Object.freeze({
    ...membership,
    lifecycle: next,
    version: (membership.version + 1) as MembershipVersion,
    updatedAt,
  });
}

export function transitionStoreAssignment(
  assignment: StoreAssignment,
  expectedVersion: MembershipVersion,
  next: StoreAssignmentLifecycle,
  updatedAtInput: unknown,
): StoreAssignment {
  if (assignment.version !== expectedVersion)
    throw new MembershipContractError("STORE_ASSIGNMENT_VERSION_CONFLICT");
  if (!assignmentTransitions[assignment.lifecycle].includes(next))
    throw new MembershipContractError("STORE_ASSIGNMENT_TRANSITION_INVALID");
  const updatedAt = parseMembershipInstant(updatedAtInput);
  if (Date.parse(updatedAt) < Date.parse(assignment.updatedAt))
    throw new MembershipContractError("STORE_ASSIGNMENT_TRANSITION_INVALID");
  return Object.freeze({
    ...assignment,
    lifecycle: next,
    version: (assignment.version + 1) as MembershipVersion,
    updatedAt,
  });
}

export function resolveActiveMembership(
  memberships: readonly Membership[],
  actorReference: ActorReference,
  brandReference: BrandReference,
  atInput: unknown,
): Membership {
  const at = parseMembershipInstant(atInput);
  const matches = memberships.filter(
    (membership) =>
      membership.actorReference === actorReference &&
      membership.brandReference === brandReference &&
      membership.lifecycle === "Active" &&
      isEffective(membership.effectiveFrom, membership.effectiveUntil, at),
  );
  const match = matches[0];
  if (!match) throw new MembershipContractError("ACTIVE_MEMBERSHIP_NOT_FOUND");
  if (matches.length > 1) throw new MembershipContractError("ACTIVE_MEMBERSHIP_AMBIGUOUS");
  return match;
}

export function resolveActiveStoreAssignment(
  membership: Membership,
  assignments: readonly StoreAssignment[],
  storeReference: StoreReference,
  atInput: unknown,
): StoreAssignment {
  const at = parseMembershipInstant(atInput);
  if (
    membership.lifecycle !== "Active" ||
    !isEffective(membership.effectiveFrom, membership.effectiveUntil, at)
  )
    throw new MembershipContractError("ACTIVE_STORE_ASSIGNMENT_NOT_FOUND");
  const matches = assignments.filter(
    (assignment) =>
      assignment.membershipReference === membership.membershipReference &&
      assignment.actorReference === membership.actorReference &&
      assignment.brandReference === membership.brandReference &&
      assignment.storeReference === storeReference &&
      assignment.lifecycle === "Active" &&
      isEffective(assignment.effectiveFrom, assignment.effectiveUntil, at),
  );
  const match = matches[0];
  if (!match) throw new MembershipContractError("ACTIVE_STORE_ASSIGNMENT_NOT_FOUND");
  if (matches.length > 1) throw new MembershipContractError("ACTIVE_STORE_ASSIGNMENT_AMBIGUOUS");
  return match;
}

export interface MembershipAccessInvalidation {
  readonly membershipReference: MembershipReference;
  readonly actorReference: ActorReference;
  readonly storeAssignmentReferences: readonly StoreAssignmentReference[];
  readonly occurredAt: MembershipInstant;
}
export interface MembershipSuspension {
  readonly membership: Membership;
  readonly assignments: readonly StoreAssignment[];
  readonly invalidation: MembershipAccessInvalidation;
}

export function suspendMembershipAccess(
  membership: Membership,
  expectedMembershipVersion: MembershipVersion,
  assignments: readonly StoreAssignment[],
  expectedAssignmentVersions: ReadonlyMap<StoreAssignmentReference, MembershipVersion>,
  occurredAtInput: unknown,
): MembershipSuspension {
  const occurredAt = parseMembershipInstant(occurredAtInput);
  const active = assignments.filter(
    (assignment) =>
      assignment.membershipReference === membership.membershipReference &&
      assignment.lifecycle === "Active",
  );
  for (const assignment of active)
    if (expectedAssignmentVersions.get(assignment.storeAssignmentReference) !== assignment.version)
      throw new MembershipContractError("STORE_ASSIGNMENT_VERSION_CONFLICT");
  const suspendedMembership = transitionMembership(
    membership,
    expectedMembershipVersion,
    "Suspended",
    occurredAt,
  );
  const activeReferences = new Set(active.map((item) => item.storeAssignmentReference));
  const suspendedAssignments = assignments.map((assignment) =>
    activeReferences.has(assignment.storeAssignmentReference)
      ? transitionStoreAssignment(assignment, assignment.version, "Suspended", occurredAt)
      : assignment,
  );
  return Object.freeze({
    membership: suspendedMembership,
    assignments: Object.freeze(suspendedAssignments),
    invalidation: Object.freeze({
      membershipReference: membership.membershipReference,
      actorReference: membership.actorReference,
      storeAssignmentReferences: Object.freeze(
        active.map((assignment) => assignment.storeAssignmentReference),
      ),
      occurredAt,
    }),
  });
}
