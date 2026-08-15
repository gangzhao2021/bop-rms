import {
  parseBrandReference,
  parseCanonicalInstant,
  parseStoreReference,
  type BrandReference,
  type CanonicalInstant,
  type StoreReference,
} from "@bop/tenant";
import { parseBusinessAction, type BusinessAction } from "./permission-evaluation.js";
import {
  parsePermissionReference,
  parseRoleCode,
  type PermissionReference,
  type RoleCode,
} from "../domain/permission-policy.js";
export type RoleAdministrationReference = string & {
  readonly __roleAdministrationReference: unique symbol;
};
export type RoleAdministrationVersion = number & {
  readonly __roleAdministrationVersion: unique symbol;
};
export const roleAdministrationLifecycles = [
  "Draft",
  "InReview",
  "Approved",
  "Active",
  "Rejected",
  "Deactivated",
] as const;
export type RoleAdministrationLifecycle = (typeof roleAdministrationLifecycles)[number];
export interface RolePermissionSelection {
  readonly permissionReference: PermissionReference;
  readonly action: BusinessAction;
  readonly groupCode: string;
  readonly highRisk: boolean;
  readonly dependencyActions: readonly BusinessAction[];
}
export interface RoleAdministrationVersionRecord {
  readonly administrationReference: RoleAdministrationReference;
  readonly roleReference: RoleAdministrationReference;
  readonly version: RoleAdministrationVersion;
  readonly brandReference: BrandReference;
  readonly storeReference: StoreReference | null;
  readonly code: RoleCode;
  readonly displayName: string;
  readonly description: string;
  readonly roleType: "System" | "Custom";
  readonly lifecycle: RoleAdministrationLifecycle;
  readonly sourcePolicyVersion: number;
  readonly selections: readonly RolePermissionSelection[];
  readonly authoredByReference: RoleAdministrationReference;
  readonly submittedByReference: RoleAdministrationReference | null;
  readonly approvedByReference: RoleAdministrationReference | null;
  readonly decisionEvidenceReference: RoleAdministrationReference | null;
  readonly reasonCode: string;
  readonly changedAt: CanonicalInstant;
}
export class RoleAdministrationContractError extends Error {
  constructor(readonly code: "ROLE_ADMIN_INPUT_INVALID" | "ROLE_ADMIN_DEPENDENCY_BLOCKED") {
    super(
      code === "ROLE_ADMIN_DEPENDENCY_BLOCKED"
        ? "role permission dependencies are blocked"
        : "role administration input is invalid",
    );
    this.name = "RoleAdministrationContractError";
  }
}
const invalid = (): never => {
  throw new RoleAdministrationContractError("ROLE_ADMIN_INPUT_INVALID");
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
  safe = /^[^\p{Cc}\p{Cf}]{1,180}$/u,
  code = /^[A-Z][A-Z0-9_]{2,63}$/u,
  group = /^[a-z][a-z0-9_]{1,63}$/u;
const exact = (value: unknown, fields: readonly string[]): Record<string, unknown> => {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((field) => typeof field !== "string" || !fields.includes(field))
  )
    return invalid();
  return value as Record<string, unknown>;
};
export function parseRoleAdministrationReference(value: unknown): RoleAdministrationReference {
  if (typeof value !== "string" || !uuid.test(value)) return invalid();
  return value as RoleAdministrationReference;
}
export function parseRoleAdministrationVersion(value: unknown): RoleAdministrationVersion {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid();
  return value as RoleAdministrationVersion;
}
function selection(value: unknown): RolePermissionSelection {
  const input = exact(value, [
    "permissionReference",
    "action",
    "groupCode",
    "highRisk",
    "dependencyActions",
  ]);
  if (
    typeof input.groupCode !== "string" ||
    !group.test(input.groupCode) ||
    typeof input.highRisk !== "boolean" ||
    !Array.isArray(input.dependencyActions)
  )
    return invalid();
  const action = parseBusinessAction(input.action),
    dependencies = Object.freeze(input.dependencyActions.map(parseBusinessAction).sort());
  if (new Set(dependencies).size !== dependencies.length || dependencies.includes(action))
    return invalid();
  return Object.freeze({
    permissionReference: parsePermissionReference(input.permissionReference),
    action,
    groupCode: input.groupCode,
    highRisk: input.highRisk,
    dependencyActions: dependencies,
  });
}
export function createRoleAdministrationVersion(value: unknown): RoleAdministrationVersionRecord {
  const input = exact(value, [
    "administrationReference",
    "roleReference",
    "version",
    "brandReference",
    "storeReference",
    "code",
    "displayName",
    "description",
    "roleType",
    "lifecycle",
    "sourcePolicyVersion",
    "selections",
    "authoredByReference",
    "submittedByReference",
    "approvedByReference",
    "decisionEvidenceReference",
    "reasonCode",
    "changedAt",
  ]);
  if (
    typeof input.displayName !== "string" ||
    !safe.test(input.displayName) ||
    typeof input.description !== "string" ||
    !safe.test(input.description) ||
    !["System", "Custom"].includes(String(input.roleType)) ||
    !roleAdministrationLifecycles.includes(input.lifecycle as RoleAdministrationLifecycle) ||
    !Number.isSafeInteger(input.sourcePolicyVersion) ||
    (input.sourcePolicyVersion as number) < 1 ||
    !Array.isArray(input.selections) ||
    typeof input.reasonCode !== "string" ||
    !code.test(input.reasonCode)
  )
    return invalid();
  const storeReference =
      input.storeReference === null ? null : parseStoreReference(input.storeReference),
    selections = Object.freeze(
      input.selections.map(selection).sort((a, b) => a.action.localeCompare(b.action)),
    );
  if (
    new Set(selections.map((item) => item.permissionReference)).size !== selections.length ||
    new Set(selections.map((item) => item.action)).size !== selections.length
  )
    return invalid();
  const authoredByReference = parseRoleAdministrationReference(input.authoredByReference),
    submittedByReference =
      input.submittedByReference === null
        ? null
        : parseRoleAdministrationReference(input.submittedByReference),
    approvedByReference =
      input.approvedByReference === null
        ? null
        : parseRoleAdministrationReference(input.approvedByReference),
    decisionEvidenceReference =
      input.decisionEvidenceReference === null
        ? null
        : parseRoleAdministrationReference(input.decisionEvidenceReference);
  if (
    ["InReview", "Approved", "Active", "Rejected", "Deactivated"].includes(
      String(input.lifecycle),
    ) !==
      (submittedByReference !== null) ||
    (approvedByReference !== null && approvedByReference === submittedByReference) ||
    (input.lifecycle === "Approved" ||
      input.lifecycle === "Active" ||
      input.lifecycle === "Deactivated") !==
      (approvedByReference !== null) ||
    (input.lifecycle === "Approved" ||
      input.lifecycle === "Active" ||
      input.lifecycle === "Rejected" ||
      input.lifecycle === "Deactivated") !==
      (decisionEvidenceReference !== null) ||
    (input.roleType === "System" && !["Active", "Deactivated"].includes(String(input.lifecycle)))
  )
    return invalid();
  return Object.freeze({
    administrationReference: parseRoleAdministrationReference(input.administrationReference),
    roleReference: parseRoleAdministrationReference(input.roleReference),
    version: parseRoleAdministrationVersion(input.version),
    brandReference: parseBrandReference(input.brandReference),
    storeReference,
    code: parseRoleCode(input.code),
    displayName: input.displayName,
    description: input.description,
    roleType: input.roleType,
    lifecycle: input.lifecycle,
    sourcePolicyVersion: input.sourcePolicyVersion,
    selections,
    authoredByReference,
    submittedByReference,
    approvedByReference,
    decisionEvidenceReference,
    reasonCode: input.reasonCode,
    changedAt: parseCanonicalInstant(input.changedAt),
  }) as RoleAdministrationVersionRecord;
}
export interface RoleAdministrationCompareResult {
  readonly added: readonly BusinessAction[];
  readonly removed: readonly BusinessAction[];
  readonly highRiskChanges: readonly BusinessAction[];
  readonly missingDependencies: readonly {
    readonly action: BusinessAction;
    readonly missing: readonly BusinessAction[];
  }[];
  readonly affectedAssignmentCount: number;
  readonly activationBlocked: boolean;
}
export function compareRoleAdministration(
  current: RoleAdministrationVersionRecord,
  candidate: RoleAdministrationVersionRecord,
  affectedAssignmentCount: number,
): RoleAdministrationCompareResult {
  if (
    !Number.isSafeInteger(affectedAssignmentCount) ||
    affectedAssignmentCount < 0 ||
    current.roleReference !== candidate.roleReference ||
    current.brandReference !== candidate.brandReference ||
    current.storeReference !== candidate.storeReference
  )
    return invalid();
  const before = new Map(current.selections.map((item) => [item.action, item])),
    after = new Map(candidate.selections.map((item) => [item.action, item]));
  const added = [...after.keys()].filter((action) => !before.has(action)).sort(),
    removed = [...before.keys()].filter((action) => !after.has(action)).sort(),
    highRiskChanges = [
      ...new Set([
        ...added.filter((action) => after.get(action)?.highRisk),
        ...removed.filter((action) => before.get(action)?.highRisk),
      ]),
    ].sort(),
    missingDependencies = candidate.selections
      .map((item) => ({
        action: item.action,
        missing: item.dependencyActions.filter((action) => !after.has(action)).sort(),
      }))
      .filter((item) => item.missing.length > 0);
  return Object.freeze({
    added: Object.freeze(added),
    removed: Object.freeze(removed),
    highRiskChanges: Object.freeze(highRiskChanges),
    missingDependencies: Object.freeze(
      missingDependencies.map((item) =>
        Object.freeze({ action: item.action, missing: Object.freeze(item.missing) }),
      ),
    ),
    affectedAssignmentCount,
    activationBlocked: missingDependencies.length > 0,
  });
}
export function assertRoleAdministrationActivatable(
  current: RoleAdministrationVersionRecord,
  candidate: RoleAdministrationVersionRecord,
  affectedAssignmentCount: number,
): void {
  if (compareRoleAdministration(current, candidate, affectedAssignmentCount).activationBlocked)
    throw new RoleAdministrationContractError("ROLE_ADMIN_DEPENDENCY_BLOCKED");
}
