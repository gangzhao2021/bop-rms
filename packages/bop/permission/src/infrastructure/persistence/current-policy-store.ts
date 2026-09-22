import type { Membership, StoreAssignment } from "@bop/membership";
import type { TenantContext } from "@bop/tenant";
import { materializePermissionEvidence } from "../../application/materialize-policy-evidence.js";
import { evaluatePermission } from "../../application/evaluate-permission.js";
import {
  parseBusinessAction,
  revalidateTenantContext,
} from "../../contracts/permission-evaluation.js";
import {
  PermissionPolicyContractError,
  createPolicyState,
  createPermissionDefinition,
  createPermissionRole,
  createRoleAssignment,
  createPermissionGrant,
  createPermissionOverride,
} from "../../domain/permission-policy.js";
export interface PermissionPolicyTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}
const unavailable = (): never => {
  throw new PermissionPolicyContractError("PERMISSION_POLICY_MATERIALIZATION_INVALID");
};
function rows(value: unknown): readonly Record<string, unknown>[] {
  if (!value || typeof value !== "object") return unavailable();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > 1024)
    return unavailable();
  return d.value;
}
function at(value: unknown): string {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) return unavailable();
  return value.toISOString();
}
function timestamps(row: Record<string, unknown>, observedAt: string) {
  const updatedAt = at(row.updated_at),
    createdAt = at(row.created_at);
  if (updatedAt > observedAt) return unavailable();
  const version =
    typeof row.version === "string" && /^[1-9][0-9]*$/u.test(row.version)
      ? Number(row.version)
      : unavailable();
  if (!Number.isSafeInteger(version)) return unavailable();
  return { version, createdAt, updatedAt };
}
function period(row: Record<string, unknown>) {
  return {
    effectiveFrom: at(row.effective_from),
    effectiveUntil: row.effective_until === null ? null : at(row.effective_until),
  };
}
/** Internal workforce capability: Identity/Tenant/Membership facts must be current and fenced
 * by their owners in this same outer transaction. This is not guest-session authorization.
 * Requires the internal Permission owner role: PostgreSQL SHARE table locking needs
 * mutation privileges. Do not grant these privileges to a public read-only caller.
 */
export function createPostgresCurrentPermissionPolicySource(
  transaction: PermissionPolicyTransaction,
) {
  const source = {
    async authorizeWithRoles(
      input: Readonly<{
        tenantContext: TenantContext;
        membership: Membership;
        storeAssignment: StoreAssignment | null;
        action: string;
      }>,
    ) {
      try {
        const context = revalidateTenantContext(input.tenantContext),
          action = parseBusinessAction(input.action);
        const brand = context.brand.brandReference,
          store = context.store?.storeReference ?? null;
        const actor = context.actor.actorReference;
        if (actor === null) return unavailable();
        await transaction.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [brand, store ?? ""],
        );
        await transaction.query(
          "LOCK TABLE bop_permission.policy_state,bop_permission.permission_definition,bop_permission.role,bop_permission.role_assignment,bop_permission.permission_grant,bop_permission.permission_override IN SHARE MODE",
          [],
        );
        const stateRows = rows(
          await transaction.query("SELECT * FROM bop_permission.policy_state WHERE brand_id=$1", [
            brand,
          ]),
        );
        if (stateRows.length !== 1) return unavailable();
        const rawState = stateRows[0];
        if (!rawState || at(rawState.updated_at) > context.resolvedAt) return unavailable();
        const state = createPolicyState(
          {
            brandReference: rawState.brand_id,
            snapshotReference: rawState.snapshot_id,
            version: Number(rawState.version),
            updatedAt: at(rawState.updated_at),
          },
          context.brand,
        );
        const definitionRows = rows(
          await transaction.query(
            "SELECT * FROM bop_permission.permission_definition ORDER BY permission_id LIMIT 1025",
            [],
          ),
        );
        const definitions = definitionRows.map((r) =>
          createPermissionDefinition({
            permissionReference: r.permission_id,
            action: r.action_code,
            lifecycle: r.lifecycle,
            ...timestamps(r, context.resolvedAt),
          }),
        );
        const scoped = [brand, store];
        const roleRows = rows(
          await transaction.query(
            "SELECT * FROM bop_permission.role WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) ORDER BY role_id LIMIT 1025",
            scoped,
          ),
        );
        const roles = roleRows.map((r) =>
          createPermissionRole(
            {
              roleReference: r.role_id,
              brandReference: r.brand_id,
              storeReference: r.store_id,
              code: r.role_code,
              lifecycle: r.lifecycle,
              ...period(r),
              ...timestamps(r, context.resolvedAt),
            },
            context.brand,
            r.store_id === null ? null : context.store,
          ),
        );
        const definitionById = new Map(definitions.map((d) => [String(d.permissionReference), d]));
        const roleById = new Map(roles.map((r) => [String(r.roleReference), r]));
        const assignmentRows = rows(
          await transaction.query(
            "SELECT * FROM bop_permission.role_assignment WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) AND actor_id=$3 AND membership_id=$4 ORDER BY assignment_id LIMIT 1025",
            [brand, store, actor, input.membership.membershipReference],
          ),
        );
        const assignments = assignmentRows.map((r) => {
          const role = roleById.get(String(r.role_id)) ?? unavailable();
          return createRoleAssignment(
            {
              assignmentReference: r.assignment_id,
              roleReference: r.role_id,
              membershipReference: r.membership_id,
              storeAssignmentReference: r.store_assignment_id,
              actorReference: r.actor_id,
              brandReference: r.brand_id,
              storeReference: r.store_id,
              lifecycle: r.lifecycle,
              ...period(r),
              ...timestamps(r, context.resolvedAt),
            },
            role,
            input.membership,
            r.store_id === null ? null : input.storeAssignment,
          );
        });
        const grantRows = rows(
          await transaction.query(
            "SELECT * FROM bop_permission.permission_grant WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) ORDER BY grant_id LIMIT 1025",
            scoped,
          ),
        );
        const grants = grantRows.map((r) => {
          const role = roleById.get(String(r.role_id)) ?? unavailable();
          const definition = definitionById.get(String(r.permission_id)) ?? unavailable();
          return createPermissionGrant(
            {
              grantReference: r.grant_id,
              roleReference: r.role_id,
              permissionReference: r.permission_id,
              action: definition.action,
              brandReference: r.brand_id,
              storeReference: r.store_id,
              lifecycle: r.lifecycle,
              ...period(r),
              ...timestamps(r, context.resolvedAt),
            },
            role,
            definition,
          );
        });
        const overrideRows = rows(
          await transaction.query(
            "SELECT * FROM bop_permission.permission_override WHERE brand_id=$1 AND (store_id IS NULL OR store_id=$2) AND actor_id=$3 ORDER BY override_id LIMIT 1025",
            [brand, store, actor],
          ),
        );
        const overrides = overrideRows.map((r) => {
          const definition = definitionById.get(String(r.permission_id)) ?? unavailable();
          return createPermissionOverride(
            {
              overrideReference: r.override_id,
              permissionReference: r.permission_id,
              action: definition.action,
              actorReference: r.actor_id,
              brandReference: r.brand_id,
              storeReference: r.store_id,
              effect: r.effect,
              lifecycle: r.lifecycle,
              reasonReference: r.reason_reference,
              correlationReference: r.correlation_reference,
              ...period(r),
              ...timestamps(r, context.resolvedAt),
            },
            definition,
          );
        });
        const policy = materializePermissionEvidence(
          Object.freeze({
            tenantContext: context,
            policyState: state,
            membership: input.membership,
            storeAssignment: input.storeAssignment,
            permissionDefinitions: Object.freeze(definitions),
            roles: Object.freeze(roles),
            roleAssignments: Object.freeze(assignments),
            permissionGrants: Object.freeze(grants),
            permissionOverrides: Object.freeze(overrides),
          }),
        );
        const decision = evaluatePermission({
          tenantContext: context,
          action,
          resourceScope: { kind: context.scopeKind, brandReference: brand, storeReference: store },
          policySnapshotReference: policy.policySnapshotReference,
          policyVersion: policy.policyVersion,
          evidence: policy.evidence,
        });
        return Object.freeze({ decision, activeRoleCodes: policy.activeRoleCodes });
      } catch {
        return unavailable();
      }
    },
  };
  return Object.freeze({
    authorizeWithRoles: source.authorizeWithRoles,
    async authorize(input: Parameters<typeof source.authorizeWithRoles>[0]) {
      return (await source.authorizeWithRoles(input)).decision;
    },
  });
}
