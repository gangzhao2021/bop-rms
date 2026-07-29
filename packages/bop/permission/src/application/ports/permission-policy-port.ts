import type { BrandReference } from "@bop/tenant";
import type {
  PermissionDefinition,
  PermissionGrant,
  PermissionOverride,
  PermissionPolicyAuditDescriptor,
  PermissionReference,
  PermissionRole,
  PolicyState,
  RoleAssignment,
} from "../../domain/permission-policy.js";
import type {
  PolicyReference,
  PolicyVersion,
  RoleReference,
} from "../../contracts/permission-evaluation.js";

export interface PermissionPolicySnapshot {
  readonly state: PolicyState;
  readonly permissionDefinitions: readonly PermissionDefinition[];
  readonly roles: readonly PermissionRole[];
  readonly roleAssignments: readonly RoleAssignment[];
  readonly permissionGrants: readonly PermissionGrant[];
  readonly permissionOverrides: readonly PermissionOverride[];
}

export interface PermissionPolicyMutation {
  readonly brandReference: BrandReference;
  readonly expectedPolicyVersion: PolicyVersion;
  readonly nextSnapshotReference: PolicyReference;
  readonly audit: PermissionPolicyAuditDescriptor;
  readonly permissionDefinition?: PermissionDefinition;
  readonly role?: PermissionRole;
  readonly roleAssignment?: RoleAssignment;
  readonly permissionGrant?: PermissionGrant;
  readonly permissionOverride?: PermissionOverride;
}

export interface PermissionPolicyPort {
  loadPolicySnapshot(brandReference: BrandReference): Promise<PermissionPolicySnapshot | null>;
  getPermissionDefinition(
    permissionReference: PermissionReference,
  ): Promise<PermissionDefinition | null>;
  getRole(roleReference: RoleReference): Promise<PermissionRole | null>;
  mutatePolicyAtomically(mutation: PermissionPolicyMutation): Promise<PermissionPolicySnapshot>;
}
