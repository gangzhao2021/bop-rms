import {
  resolveActiveMembership,
  resolveActiveStoreAssignment,
  type Membership,
  type StoreAssignment,
} from "@bop/membership";
import type { CanonicalInstant, TenantContext } from "@bop/tenant";
import {
  parseBusinessAction,
  parseEvidenceReference,
  parsePolicyReference,
  parsePolicyVersion,
  parseRoleReference,
  revalidateTenantContext,
  type PermissionEvidence,
  type PermissionEvidenceSource,
  type PolicyReference,
  type PolicyVersion,
} from "../contracts/permission-evaluation.js";
import {
  PermissionPolicyContractError,
  type PermissionDefinition,
  type PermissionGrant,
  type PermissionOverride,
  type PermissionRole,
  type PolicyState,
  type RoleAssignment,
} from "../domain/permission-policy.js";

export interface PermissionPolicyMaterializationInput {
  readonly tenantContext: TenantContext;
  readonly policyState: PolicyState;
  readonly membership: Membership;
  readonly storeAssignment: StoreAssignment | null;
  readonly permissionDefinitions: readonly PermissionDefinition[];
  readonly roles: readonly PermissionRole[];
  readonly roleAssignments: readonly RoleAssignment[];
  readonly permissionGrants: readonly PermissionGrant[];
  readonly permissionOverrides: readonly PermissionOverride[];
}

export interface PermissionPolicyMaterialization {
  readonly policySnapshotReference: PolicyReference;
  readonly policyVersion: PolicyVersion;
  readonly evidence: readonly PermissionEvidence[];
  readonly audit: {
    readonly source: "PermissionPolicy";
    readonly evidenceCount: number;
  };
}

function fail(): never {
  throw new PermissionPolicyContractError("PERMISSION_POLICY_MATERIALIZATION_INVALID");
}

function active(from: CanonicalInstant, until: CanonicalInstant | null, at: number): boolean {
  return Date.parse(from) <= at && (until === null || at < Date.parse(until));
}

function latestFrom(values: readonly CanonicalInstant[]): CanonicalInstant {
  return [...values].sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? fail();
}

function earliestUntil(values: readonly (CanonicalInstant | null)[]): CanonicalInstant | null {
  const finite = values.filter((value): value is CanonicalInstant => value !== null);
  return finite.sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function scopeMatches(
  brandReference: string,
  storeReference: string | null,
  context: ReturnType<typeof revalidateTenantContext>,
): boolean {
  return (
    brandReference === context.brand.brandReference &&
    (storeReference === null || storeReference === context.store?.storeReference)
  );
}

function frozenFacts(values: readonly unknown[]): void {
  if (!Object.isFrozen(values) || values.some((value) => !Object.isFrozen(value))) fail();
}

function deduplicateAndSort(values: PermissionEvidence[]): readonly PermissionEvidence[] {
  const seen = new Map<string, PermissionEvidence>();
  for (const value of values) {
    const previous = seen.get(value.evidenceReference);
    if (previous && JSON.stringify(previous) !== JSON.stringify(value)) fail();
    seen.set(value.evidenceReference, value);
  }
  const sourceOrder: Readonly<Record<PermissionEvidenceSource, number>> = {
    ExplicitDeny: 0,
    ExplicitAllow: 1,
    RolePermission: 2,
  };
  return Object.freeze(
    [...seen.values()].sort(
      (left, right) =>
        sourceOrder[left.source] - sourceOrder[right.source] ||
        left.evidenceReference.localeCompare(right.evidenceReference, "en"),
    ),
  );
}

export function materializePermissionEvidence(
  input: PermissionPolicyMaterializationInput,
): PermissionPolicyMaterialization {
  try {
    if (!Object.isFrozen(input)) fail();
    const context = revalidateTenantContext(input.tenantContext);
    if (
      !Object.isFrozen(input.policyState) ||
      input.policyState.brandReference !== context.brand.brandReference
    )
      fail();
    frozenFacts(input.permissionDefinitions);
    frozenFacts(input.roles);
    frozenFacts(input.roleAssignments);
    frozenFacts(input.permissionGrants);
    frozenFacts(input.permissionOverrides);

    const actorReference = context.actor.actorReference ?? fail();
    const membership = resolveActiveMembership(
      Object.freeze([input.membership]),
      actorReference,
      context.brand.brandReference,
      context.resolvedAt,
    );
    const storeAssignment =
      context.store === null
        ? null
        : resolveActiveStoreAssignment(
            membership,
            Object.freeze(input.storeAssignment === null ? [] : [input.storeAssignment]),
            context.store.storeReference,
            context.resolvedAt,
          );
    if (context.store === null && input.storeAssignment !== null) fail();

    const at = Date.parse(context.resolvedAt);
    const definitions = new Map(
      input.permissionDefinitions.map((definition) => [definition.permissionReference, definition]),
    );
    const roles = new Map(input.roles.map((role) => [role.roleReference, role]));
    if (
      definitions.size !== input.permissionDefinitions.length ||
      roles.size !== input.roles.length
    )
      fail();

    const evidence: PermissionEvidence[] = [];
    for (const override of input.permissionOverrides) {
      const definition = definitions.get(override.permissionReference) ?? fail();
      if (
        definition.action !== override.action ||
        definition.lifecycle !== "Active" ||
        override.lifecycle !== "Active" ||
        override.actorReference !== actorReference ||
        !scopeMatches(override.brandReference, override.storeReference, context) ||
        !active(override.effectiveFrom, override.effectiveUntil, at)
      )
        continue;
      evidence.push(
        Object.freeze({
          source: override.effect === "Deny" ? "ExplicitDeny" : "ExplicitAllow",
          evidenceReference: parseEvidenceReference(override.overrideReference),
          action: parseBusinessAction(definition.action),
          actorReference,
          roleReference: null,
          brandReference: override.brandReference,
          storeReference: override.storeReference,
          effectiveFrom: override.effectiveFrom,
          effectiveUntil: override.effectiveUntil,
        }),
      );
    }

    for (const assignment of input.roleAssignments) {
      const role = roles.get(assignment.roleReference) ?? fail();
      if (
        assignment.lifecycle !== "Active" ||
        role.lifecycle !== "Active" ||
        assignment.membershipReference !== membership.membershipReference ||
        assignment.actorReference !== actorReference ||
        assignment.brandReference !== role.brandReference ||
        assignment.storeReference !== role.storeReference ||
        !scopeMatches(role.brandReference, role.storeReference, context) ||
        !active(assignment.effectiveFrom, assignment.effectiveUntil, at) ||
        !active(role.effectiveFrom, role.effectiveUntil, at)
      )
        continue;
      if (
        role.storeReference === null
          ? assignment.storeAssignmentReference !== null
          : storeAssignment === null ||
            assignment.storeAssignmentReference !== storeAssignment.storeAssignmentReference
      )
        fail();
      for (const grant of input.permissionGrants) {
        if (
          grant.roleReference !== role.roleReference ||
          grant.lifecycle !== "Active" ||
          grant.brandReference !== role.brandReference ||
          grant.storeReference !== role.storeReference ||
          !active(grant.effectiveFrom, grant.effectiveUntil, at)
        )
          continue;
        const definition = definitions.get(grant.permissionReference) ?? fail();
        if (definition.lifecycle !== "Active" || definition.action !== grant.action) continue;
        const effectiveFrom = latestFrom([
          role.effectiveFrom,
          assignment.effectiveFrom,
          grant.effectiveFrom,
        ]);
        const effectiveUntil = earliestUntil([
          role.effectiveUntil,
          assignment.effectiveUntil,
          grant.effectiveUntil,
        ]);
        if (effectiveUntil !== null && Date.parse(effectiveUntil) <= Date.parse(effectiveFrom))
          fail();
        evidence.push(
          Object.freeze({
            source: "RolePermission",
            evidenceReference: parseEvidenceReference(grant.grantReference),
            action: parseBusinessAction(definition.action),
            actorReference,
            roleReference: parseRoleReference(role.roleReference),
            brandReference: role.brandReference,
            storeReference: role.storeReference,
            effectiveFrom,
            effectiveUntil,
          }),
        );
      }
    }

    const normalized = deduplicateAndSort(evidence);
    return Object.freeze({
      policySnapshotReference: parsePolicyReference(input.policyState.snapshotReference),
      policyVersion: parsePolicyVersion(input.policyState.version),
      evidence: normalized,
      audit: Object.freeze({
        source: "PermissionPolicy",
        evidenceCount: normalized.length,
      }),
    });
  } catch (error) {
    if (error instanceof PermissionPolicyContractError) throw error;
    throw new PermissionPolicyContractError("PERMISSION_POLICY_MATERIALIZATION_INVALID");
  }
}
