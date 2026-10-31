import {
  createPostgresCurrentWorkforceMfaSource,
  parseCanonicalInstant,
  parseOpaqueUuidV7,
  readClosedRecord,
} from "@bop/identity";
import { createTenantContext, type TenantContext } from "@bop/tenant";
import {
  createPostgresCurrentMembershipSource,
  resolveActiveMembership,
  resolveActiveStoreAssignment,
} from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import type { ConsumerTransaction } from "@bop/eventing";

interface Query {
  tenantReference: string;
  brandReference: string;
  storeReference: string;
  actorReference: string;
  observedAt: string;
  permissionCode: string;
}
const denied = (): never => {
  throw new Error("WORKFORCE_AUTHORITY_UNAVAILABLE");
};
/** Composition only. Identity/Tenant resolver must authorize this lookup purpose
 * and retain current actor/association fences in the borrowed transaction.
 * Role interpretation and refund-specific policy stay with Payment.
 */
export function createMerchantWorkforcePermissionSource(options: {
  resolveContext(
    tx: ConsumerTransaction,
    query: Query,
  ): Promise<{
    tenantReference: string;
    context: TenantContext;
  }>;
}) {
  return async (tx: ConsumerTransaction, value: unknown) => {
    const raw = readClosedRecord(value, [
      "tenantReference",
      "brandReference",
      "storeReference",
      "actorReference",
      "observedAt",
      "permissionCode",
    ]);
    const ref = (value: unknown) => String(parseOpaqueUuidV7(value, "ACTOR_REFERENCE_INVALID"));
    if (typeof raw.permissionCode !== "string") return denied();
    const query = {
      tenantReference: ref(raw.tenantReference),
      brandReference: ref(raw.brandReference),
      storeReference: ref(raw.storeReference),
      actorReference: ref(raw.actorReference),
      observedAt: parseCanonicalInstant(raw.observedAt),
      permissionCode: raw.permissionCode,
    };
    const resolved = await options.resolveContext(tx, query);
    const context = createTenantContext(
      resolved.context.actor,
      resolved.context.brand,
      resolved.context.store,
      resolved.context.resolvedAt,
    );
    if (
      resolved.tenantReference !== query.tenantReference ||
      context.brand.brandReference !== query.brandReference ||
      context.store?.storeReference !== query.storeReference ||
      context.actor.actorReference !== query.actorReference ||
      context.actor.actorType !== "User" ||
      context.actor.accountKind !== "Workforce" ||
      context.actor.status !== "Active" ||
      String(context.resolvedAt) !== String(query.observedAt)
    )
      return denied();
    const actor = context.actor.actorReference;
    const memberships = createPostgresCurrentMembershipSource(tx, context);
    const membership = resolveActiveMembership(
      await memberships.findMemberships(actor, context.brand.brandReference),
      actor,
      context.brand.brandReference,
      context.resolvedAt,
    );
    const assignment = resolveActiveStoreAssignment(
      membership,
      await memberships.findStoreAssignments(
        membership.membershipReference,
        context.store.storeReference,
      ),
      context.store.storeReference,
      context.resolvedAt,
    );
    const policy = createPostgresCurrentPermissionPolicySource(tx);
    const input = { tenantContext: context, membership, storeAssignment: assignment };
    if ((await policy.authorize({ ...input, action: "merchant.access" })).effect !== "Allow")
      return denied();
    const authorized = await policy.authorizeWithRoles({ ...input, action: query.permissionCode });
    return Object.freeze({
      ...query,
      decision: authorized.decision,
      activeRoleCodes: authorized.activeRoleCodes,
    });
  };
}

/** Adds Identity MFA facts for actions whose owning policy needs them. */
export function createMerchantWorkforceAuthoritySource(
  options: Parameters<typeof createMerchantWorkforcePermissionSource>[0],
) {
  const permission = createMerchantWorkforcePermissionSource(options);
  return async (tx: ConsumerTransaction, value: unknown) => {
    const result = await permission(tx, value);
    const query = {
      tenantReference: result.tenantReference,
      brandReference: result.brandReference,
      storeReference: result.storeReference,
      actorReference: result.actorReference,
      permissionCode: result.permissionCode,
      observedAt: result.observedAt,
    };
    const actor = result.actorReference;
    const mfa = await createPostgresCurrentWorkforceMfaSource({
      authorize: async () => {
        const current = await options.resolveContext(tx, query);
        return (
          current.tenantReference === query.tenantReference &&
          current.context.actor.actorReference === actor &&
          current.context.actor.status === "Active" &&
          current.context.brand.brandReference === query.brandReference &&
          current.context.store?.storeReference === query.storeReference &&
          String(current.context.resolvedAt) === String(query.observedAt)
        );
      },
    })(tx, { actorReference: actor, observedAt: query.observedAt });
    return Object.freeze({ ...result, mfa });
  };
}
