import {
  createBrand,
  createStore,
  parseCanonicalInstant,
  type Brand,
  type BrandReference,
  type CanonicalInstant,
  type Store,
  type StoreReference,
} from "@bop/tenant";

export const permissionPolicyErrorCodes = [
  "PERMISSION_POLICY_INPUT_INVALID",
  "PERMISSION_POLICY_SHAPE_INVALID",
  "PERMISSION_POLICY_SCOPE_INVALID",
  "PERMISSION_POLICY_DEPENDENCY_INVALID",
  "PERMISSION_POLICY_VERSION_CONFLICT",
  "PERMISSION_POLICY_TRANSITION_INVALID",
  "PERMISSION_POLICY_MATERIALIZATION_INVALID",
] as const;
export type PermissionPolicyErrorCode = (typeof permissionPolicyErrorCodes)[number];

const safeMessages: Readonly<Record<PermissionPolicyErrorCode, string>> = {
  PERMISSION_POLICY_INPUT_INVALID: "permission policy input is invalid",
  PERMISSION_POLICY_SHAPE_INVALID: "permission policy shape is invalid",
  PERMISSION_POLICY_SCOPE_INVALID: "permission policy scope is invalid",
  PERMISSION_POLICY_DEPENDENCY_INVALID: "permission policy dependency is invalid",
  PERMISSION_POLICY_VERSION_CONFLICT: "permission policy version conflict",
  PERMISSION_POLICY_TRANSITION_INVALID: "permission policy transition is invalid",
  PERMISSION_POLICY_MATERIALIZATION_INVALID: "permission policy materialization is invalid",
};

export class PermissionPolicyContractError extends Error {
  readonly code: PermissionPolicyErrorCode;

  constructor(code: PermissionPolicyErrorCode) {
    super(safeMessages[code]);
    this.name = "PermissionPolicyContractError";
    this.code = code;
  }
}

export type PermissionReference = string & { readonly __permissionReference: unique symbol };
export type RoleAssignmentReference = string & {
  readonly __roleAssignmentReference: unique symbol;
};
export type PermissionGrantReference = string & {
  readonly __permissionGrantReference: unique symbol;
};
export type PermissionOverrideReference = string & {
  readonly __permissionOverrideReference: unique symbol;
};
export type PolicyReasonReference = string & {
  readonly __policyReasonReference: unique symbol;
};
export type PolicyCorrelationReference = string & {
  readonly __policyCorrelationReference: unique symbol;
};
export type RoleCode = string & { readonly __roleCode: unique symbol };
export type PermissionPolicyInstant = CanonicalInstant;
export type PermissionPolicyVersion = number;
export type PermissionPolicySnapshotReference = string;
export type PermissionRoleReference = string;
export type PolicyBusinessAction = string;
export type PolicyActorReference = string;
export type PolicyMembershipReference = string;
export type PolicyStoreAssignmentReference = string;

export interface PolicyMembershipFact {
  readonly membershipReference: PolicyMembershipReference;
  readonly actorReference: PolicyActorReference;
  readonly brandReference: BrandReference;
}

export interface PolicyStoreAssignmentFact {
  readonly storeAssignmentReference: PolicyStoreAssignmentReference;
  readonly membershipReference: PolicyMembershipReference;
  readonly actorReference: PolicyActorReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference;
}

export const permissionDefinitionLifecycles = ["Active", "Retired"] as const;
export type PermissionDefinitionLifecycle = (typeof permissionDefinitionLifecycles)[number];
export const roleLifecycles = ["Active", "Suspended", "Retired"] as const;
export type RoleLifecycle = (typeof roleLifecycles)[number];
export const roleAssignmentLifecycles = ["Active", "Suspended", "Ended"] as const;
export type RoleAssignmentLifecycle = (typeof roleAssignmentLifecycles)[number];
export const permissionGrantLifecycles = ["Active", "Revoked"] as const;
export type PermissionGrantLifecycle = (typeof permissionGrantLifecycles)[number];
export const permissionOverrideLifecycles = ["Active", "Revoked"] as const;
export type PermissionOverrideLifecycle = (typeof permissionOverrideLifecycles)[number];
export const permissionOverrideEffects = ["Deny", "Allow"] as const;
export type PermissionOverrideEffect = (typeof permissionOverrideEffects)[number];

const uuidV7Pattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const roleCodePattern = /^[a-z][a-z0-9_]{1,62}[a-z0-9]$/u;

function uuid(value: unknown): string {
  if (typeof value !== "string" || !uuidV7Pattern.test(value))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_INPUT_INVALID");
  return value;
}

function instant(value: unknown): PermissionPolicyInstant {
  try {
    return parseCanonicalInstant(value);
  } catch {
    throw new PermissionPolicyContractError("PERMISSION_POLICY_INPUT_INVALID");
  }
}

function version(value: unknown): PermissionPolicyVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new PermissionPolicyContractError("PERMISSION_POLICY_INPUT_INVALID");
  return value as number;
}

function closed(value: unknown, keys: readonly string[]): Readonly<Record<string, unknown>> {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype
    )
      throw new PermissionPolicyContractError("PERMISSION_POLICY_SHAPE_INVALID");
    const ownKeys = Reflect.ownKeys(value);
    const allowed = new Set(keys);
    if (
      ownKeys.length !== keys.length ||
      ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))
    )
      throw new PermissionPolicyContractError("PERMISSION_POLICY_SHAPE_INVALID");
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
        throw new PermissionPolicyContractError("PERMISSION_POLICY_SHAPE_INVALID");
      result[key] = descriptor.value;
    }
    return Object.freeze(result);
  } catch (error) {
    if (error instanceof PermissionPolicyContractError) throw error;
    throw new PermissionPolicyContractError("PERMISSION_POLICY_SHAPE_INVALID");
  }
}

function enumValue<T extends string>(
  value: unknown,
  values: readonly T[],
  code: PermissionPolicyErrorCode = "PERMISSION_POLICY_SHAPE_INVALID",
): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new PermissionPolicyContractError(code);
  return value as T;
}

function period(
  fromInput: unknown,
  untilInput: unknown,
): readonly [PermissionPolicyInstant, PermissionPolicyInstant | null] {
  const from = instant(fromInput);
  const until = untilInput === null ? null : instant(untilInput);
  if (until !== null && Date.parse(until) <= Date.parse(from))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_SHAPE_INVALID");
  return [from, until];
}

function timestamps(
  createdInput: unknown,
  updatedInput: unknown,
): readonly [PermissionPolicyInstant, PermissionPolicyInstant] {
  const createdAt = instant(createdInput);
  const updatedAt = instant(updatedInput);
  if (Date.parse(updatedAt) < Date.parse(createdAt))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_SHAPE_INVALID");
  return [createdAt, updatedAt];
}

function parseRole(value: unknown): PermissionRoleReference {
  return uuid(value);
}

function parseAction(value: unknown): PolicyBusinessAction {
  if (
    typeof value !== "string" ||
    value.length > 128 ||
    !/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*){1,7}$/u.test(value)
  )
    throw new PermissionPolicyContractError("PERMISSION_POLICY_INPUT_INVALID");
  return value;
}

function parseSnapshot(value: unknown): PermissionPolicySnapshotReference {
  return uuid(value);
}

export function parsePermissionReference(value: unknown): PermissionReference {
  return uuid(value) as PermissionReference;
}
export function parseRoleAssignmentReference(value: unknown): RoleAssignmentReference {
  return uuid(value) as RoleAssignmentReference;
}
export function parsePermissionGrantReference(value: unknown): PermissionGrantReference {
  return uuid(value) as PermissionGrantReference;
}
export function parsePermissionOverrideReference(value: unknown): PermissionOverrideReference {
  return uuid(value) as PermissionOverrideReference;
}
export function parsePolicyReasonReference(value: unknown): PolicyReasonReference {
  return uuid(value) as PolicyReasonReference;
}
export function parsePolicyCorrelationReference(value: unknown): PolicyCorrelationReference {
  return uuid(value) as PolicyCorrelationReference;
}
export function parseRoleCode(value: unknown): RoleCode {
  if (typeof value !== "string" || !roleCodePattern.test(value))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_INPUT_INVALID");
  return value as RoleCode;
}

export interface PermissionDefinition {
  readonly permissionReference: PermissionReference;
  readonly action: PolicyBusinessAction;
  readonly lifecycle: PermissionDefinitionLifecycle;
  readonly version: PermissionPolicyVersion;
  readonly createdAt: PermissionPolicyInstant;
  readonly updatedAt: PermissionPolicyInstant;
}

export interface PolicyState {
  readonly brandReference: BrandReference;
  readonly snapshotReference: PermissionPolicySnapshotReference;
  readonly version: PermissionPolicyVersion;
  readonly updatedAt: PermissionPolicyInstant;
}

export interface PermissionRole {
  readonly roleReference: PermissionRoleReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly code: RoleCode;
  readonly lifecycle: RoleLifecycle;
  readonly effectiveFrom: PermissionPolicyInstant;
  readonly effectiveUntil: PermissionPolicyInstant | null;
  readonly version: PermissionPolicyVersion;
  readonly createdAt: PermissionPolicyInstant;
  readonly updatedAt: PermissionPolicyInstant;
}

export interface RoleAssignment {
  readonly assignmentReference: RoleAssignmentReference;
  readonly roleReference: PermissionRoleReference;
  readonly membershipReference: PolicyMembershipReference;
  readonly storeAssignmentReference: PolicyStoreAssignmentReference | null;
  readonly actorReference: PolicyActorReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly lifecycle: RoleAssignmentLifecycle;
  readonly effectiveFrom: PermissionPolicyInstant;
  readonly effectiveUntil: PermissionPolicyInstant | null;
  readonly version: PermissionPolicyVersion;
  readonly createdAt: PermissionPolicyInstant;
  readonly updatedAt: PermissionPolicyInstant;
}

export interface PermissionGrant {
  readonly grantReference: PermissionGrantReference;
  readonly roleReference: PermissionRoleReference;
  readonly permissionReference: PermissionReference;
  readonly action: PolicyBusinessAction;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly lifecycle: PermissionGrantLifecycle;
  readonly effectiveFrom: PermissionPolicyInstant;
  readonly effectiveUntil: PermissionPolicyInstant | null;
  readonly version: PermissionPolicyVersion;
  readonly createdAt: PermissionPolicyInstant;
  readonly updatedAt: PermissionPolicyInstant;
}

export interface PermissionOverride {
  readonly overrideReference: PermissionOverrideReference;
  readonly permissionReference: PermissionReference;
  readonly action: PolicyBusinessAction;
  readonly actorReference: PolicyActorReference;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly effect: PermissionOverrideEffect;
  readonly lifecycle: PermissionOverrideLifecycle;
  readonly reasonReference: PolicyReasonReference;
  readonly correlationReference: PolicyCorrelationReference;
  readonly effectiveFrom: PermissionPolicyInstant;
  readonly effectiveUntil: PermissionPolicyInstant | null;
  readonly version: PermissionPolicyVersion;
  readonly createdAt: PermissionPolicyInstant;
  readonly updatedAt: PermissionPolicyInstant;
}

export interface PermissionPolicyAuditDescriptor {
  readonly operation:
    | "PermissionDefinitionTransition"
    | "RoleTransition"
    | "RoleAssignmentTransition"
    | "PermissionGrantTransition"
    | "PermissionOverrideTransition"
    | "PolicyStateAdvance";
  readonly effect: PermissionOverrideEffect | null;
  readonly reasonReference: PolicyReasonReference | null;
  readonly correlationReference: PolicyCorrelationReference;
}

export function createPermissionDefinition(value: unknown): PermissionDefinition {
  const record = closed(value, [
    "permissionReference",
    "action",
    "lifecycle",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  const [createdAt, updatedAt] = timestamps(record.createdAt, record.updatedAt);
  return Object.freeze({
    permissionReference: parsePermissionReference(record.permissionReference),
    action: parseAction(record.action),
    lifecycle: enumValue(record.lifecycle, permissionDefinitionLifecycles),
    version: version(record.version),
    createdAt,
    updatedAt,
  });
}

export function createPolicyState(value: unknown, brandInput: Brand): PolicyState {
  const record = closed(value, ["brandReference", "snapshotReference", "version", "updatedAt"]);
  let brand: Brand;
  try {
    brand = createBrand(brandInput);
  } catch {
    throw new PermissionPolicyContractError("PERMISSION_POLICY_DEPENDENCY_INVALID");
  }
  if (brand.lifecycle !== "Active" || record.brandReference !== brand.brandReference)
    throw new PermissionPolicyContractError("PERMISSION_POLICY_SCOPE_INVALID");
  return Object.freeze({
    brandReference: brand.brandReference,
    snapshotReference: parseSnapshot(record.snapshotReference),
    version: version(record.version),
    updatedAt: instant(record.updatedAt),
  });
}

export function createPermissionRole(
  value: unknown,
  brandInput: Brand,
  storeInput: Store | null,
): PermissionRole {
  const record = closed(value, [
    "roleReference",
    "brandReference",
    "storeReference",
    "code",
    "lifecycle",
    "effectiveFrom",
    "effectiveUntil",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  let brand: Brand;
  let store: Store | null;
  try {
    brand = createBrand(brandInput);
    store = storeInput === null ? null : createStore(storeInput);
  } catch {
    throw new PermissionPolicyContractError("PERMISSION_POLICY_DEPENDENCY_INVALID");
  }
  if (
    brand.lifecycle !== "Active" ||
    record.brandReference !== brand.brandReference ||
    record.storeReference !== (store?.storeReference ?? null) ||
    (store !== null &&
      (store.lifecycle !== "Active" || store.brandReference !== brand.brandReference))
  )
    throw new PermissionPolicyContractError("PERMISSION_POLICY_SCOPE_INVALID");
  const [effectiveFrom, effectiveUntil] = period(record.effectiveFrom, record.effectiveUntil);
  const [createdAt, updatedAt] = timestamps(record.createdAt, record.updatedAt);
  return Object.freeze({
    roleReference: parseRole(record.roleReference),
    brandReference: brand.brandReference,
    storeReference: store?.storeReference ?? null,
    code: parseRoleCode(record.code),
    lifecycle: enumValue(record.lifecycle, roleLifecycles),
    effectiveFrom,
    effectiveUntil,
    version: version(record.version),
    createdAt,
    updatedAt,
  });
}

export function createRoleAssignment(
  value: unknown,
  role: PermissionRole,
  membership: PolicyMembershipFact,
  storeAssignment: PolicyStoreAssignmentFact | null,
): RoleAssignment {
  const record = closed(value, [
    "assignmentReference",
    "roleReference",
    "membershipReference",
    "storeAssignmentReference",
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
  const expectedStoreAssignment =
    role.storeReference === null ? null : storeAssignment?.storeAssignmentReference;
  if (
    !Object.isFrozen(role) ||
    !Object.isFrozen(membership) ||
    (storeAssignment !== null && !Object.isFrozen(storeAssignment)) ||
    record.roleReference !== role.roleReference ||
    record.membershipReference !== membership.membershipReference ||
    record.storeAssignmentReference !== expectedStoreAssignment ||
    record.actorReference !== membership.actorReference ||
    record.brandReference !== role.brandReference ||
    membership.brandReference !== role.brandReference ||
    record.storeReference !== role.storeReference ||
    (role.storeReference !== null &&
      (storeAssignment === null ||
        storeAssignment.membershipReference !== membership.membershipReference ||
        storeAssignment.actorReference !== membership.actorReference ||
        storeAssignment.brandReference !== role.brandReference ||
        storeAssignment.storeReference !== role.storeReference))
  )
    throw new PermissionPolicyContractError("PERMISSION_POLICY_DEPENDENCY_INVALID");
  const [effectiveFrom, effectiveUntil] = period(record.effectiveFrom, record.effectiveUntil);
  const [createdAt, updatedAt] = timestamps(record.createdAt, record.updatedAt);
  return Object.freeze({
    assignmentReference: parseRoleAssignmentReference(record.assignmentReference),
    roleReference: role.roleReference,
    membershipReference: membership.membershipReference,
    storeAssignmentReference: expectedStoreAssignment ?? null,
    actorReference: membership.actorReference,
    brandReference: role.brandReference,
    storeReference: role.storeReference,
    lifecycle: enumValue(record.lifecycle, roleAssignmentLifecycles),
    effectiveFrom,
    effectiveUntil,
    version: version(record.version),
    createdAt,
    updatedAt,
  });
}

export function createPermissionGrant(
  value: unknown,
  role: PermissionRole,
  permission: PermissionDefinition,
): PermissionGrant {
  const record = closed(value, [
    "grantReference",
    "roleReference",
    "permissionReference",
    "action",
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
    !Object.isFrozen(role) ||
    !Object.isFrozen(permission) ||
    record.roleReference !== role.roleReference ||
    record.permissionReference !== permission.permissionReference ||
    record.action !== permission.action ||
    record.brandReference !== role.brandReference ||
    record.storeReference !== role.storeReference
  )
    throw new PermissionPolicyContractError("PERMISSION_POLICY_DEPENDENCY_INVALID");
  const [effectiveFrom, effectiveUntil] = period(record.effectiveFrom, record.effectiveUntil);
  const [createdAt, updatedAt] = timestamps(record.createdAt, record.updatedAt);
  return Object.freeze({
    grantReference: parsePermissionGrantReference(record.grantReference),
    roleReference: role.roleReference,
    permissionReference: permission.permissionReference,
    action: permission.action,
    brandReference: role.brandReference,
    storeReference: role.storeReference,
    lifecycle: enumValue(record.lifecycle, permissionGrantLifecycles),
    effectiveFrom,
    effectiveUntil,
    version: version(record.version),
    createdAt,
    updatedAt,
  });
}

export function createPermissionOverride(
  value: unknown,
  permission: PermissionDefinition,
): PermissionOverride {
  const record = closed(value, [
    "overrideReference",
    "permissionReference",
    "action",
    "actorReference",
    "brandReference",
    "storeReference",
    "effect",
    "lifecycle",
    "reasonReference",
    "correlationReference",
    "effectiveFrom",
    "effectiveUntil",
    "version",
    "createdAt",
    "updatedAt",
  ]);
  if (
    !Object.isFrozen(permission) ||
    record.permissionReference !== permission.permissionReference ||
    record.action !== permission.action
  )
    throw new PermissionPolicyContractError("PERMISSION_POLICY_DEPENDENCY_INVALID");
  const [effectiveFrom, effectiveUntil] = period(record.effectiveFrom, record.effectiveUntil);
  const [createdAt, updatedAt] = timestamps(record.createdAt, record.updatedAt);
  return Object.freeze({
    overrideReference: parsePermissionOverrideReference(record.overrideReference),
    permissionReference: permission.permissionReference,
    action: permission.action,
    actorReference: uuid(record.actorReference),
    brandReference: uuid(record.brandReference) as BrandReference,
    storeReference:
      record.storeReference === null ? null : (uuid(record.storeReference) as StoreReference),
    effect: enumValue(record.effect, permissionOverrideEffects),
    lifecycle: enumValue(record.lifecycle, permissionOverrideLifecycles),
    reasonReference: parsePolicyReasonReference(record.reasonReference),
    correlationReference: parsePolicyCorrelationReference(record.correlationReference),
    effectiveFrom,
    effectiveUntil,
    version: version(record.version),
    createdAt,
    updatedAt,
  });
}

function transition<
  T extends { readonly version: PermissionPolicyVersion; readonly updatedAt: CanonicalInstant },
>(
  current: T,
  expectedVersion: PermissionPolicyVersion,
  next: Omit<T, "version" | "updatedAt">,
  updatedAtInput: unknown,
): T {
  if (current.version !== expectedVersion)
    throw new PermissionPolicyContractError("PERMISSION_POLICY_VERSION_CONFLICT");
  const updatedAt = instant(updatedAtInput);
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return Object.freeze({
    ...next,
    version: current.version + 1,
    updatedAt,
  }) as T;
}

export function transitionPermissionDefinition(
  current: PermissionDefinition,
  expectedVersion: PermissionPolicyVersion,
  next: PermissionDefinitionLifecycle,
  updatedAt: unknown,
): PermissionDefinition {
  if (current.lifecycle !== "Active" || next !== "Retired")
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return transition(current, expectedVersion, { ...current, lifecycle: next }, updatedAt);
}

export function transitionPermissionRole(
  current: PermissionRole,
  expectedVersion: PermissionPolicyVersion,
  next: RoleLifecycle,
  updatedAt: unknown,
): PermissionRole {
  const allowed: Readonly<Record<RoleLifecycle, readonly RoleLifecycle[]>> = {
    Active: ["Suspended", "Retired"],
    Suspended: ["Active", "Retired"],
    Retired: [],
  };
  if (!allowed[current.lifecycle].includes(next))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return transition(current, expectedVersion, { ...current, lifecycle: next }, updatedAt);
}

export function transitionRoleAssignment(
  current: RoleAssignment,
  expectedVersion: PermissionPolicyVersion,
  next: RoleAssignmentLifecycle,
  updatedAt: unknown,
): RoleAssignment {
  const allowed: Readonly<Record<RoleAssignmentLifecycle, readonly RoleAssignmentLifecycle[]>> = {
    Active: ["Suspended", "Ended"],
    Suspended: ["Active", "Ended"],
    Ended: [],
  };
  if (!allowed[current.lifecycle].includes(next))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return transition(current, expectedVersion, { ...current, lifecycle: next }, updatedAt);
}

export function revokePermissionGrant(
  current: PermissionGrant,
  expectedVersion: PermissionPolicyVersion,
  updatedAt: unknown,
): PermissionGrant {
  if (current.lifecycle !== "Active")
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return transition(current, expectedVersion, { ...current, lifecycle: "Revoked" }, updatedAt);
}

export function revokePermissionOverride(
  current: PermissionOverride,
  expectedVersion: PermissionPolicyVersion,
  updatedAt: unknown,
): PermissionOverride {
  if (current.lifecycle !== "Active")
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return transition(current, expectedVersion, { ...current, lifecycle: "Revoked" }, updatedAt);
}

export function advancePolicyState(
  current: PolicyState,
  expectedVersion: PermissionPolicyVersion,
  nextSnapshotInput: unknown,
  updatedAtInput: unknown,
): PolicyState {
  if (current.version !== expectedVersion)
    throw new PermissionPolicyContractError("PERMISSION_POLICY_VERSION_CONFLICT");
  const snapshotReference = parseSnapshot(nextSnapshotInput);
  if (snapshotReference === current.snapshotReference)
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  const updatedAt = instant(updatedAtInput);
  if (Date.parse(updatedAt) < Date.parse(current.updatedAt))
    throw new PermissionPolicyContractError("PERMISSION_POLICY_TRANSITION_INVALID");
  return Object.freeze({
    brandReference: current.brandReference,
    snapshotReference,
    version: current.version + 1,
    updatedAt,
  });
}
