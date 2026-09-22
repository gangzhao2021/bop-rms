import { createTenantContext } from "@bop/tenant";
import { createPostgresCurrentMembershipSource, resolveActiveMembership } from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Selected Store access establishes navigation only. Brand actions require
 * their own current Brand-scoped policy decision; a Store grant is insufficient.
 */
export function createMerchantBrandScope(source: PersistentMerchantBffOptions) {
  const resolveStore = createMerchantStoreScope(source);
  type Transaction = Parameters<Parameters<typeof source.transactions.run>[0]>[0];
  return async (transaction: Transaction, sessionCookie: unknown, expectedSession: string) => {
    if (typeof expectedSession !== "string") throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
    const selected = await resolveStore(
      transaction,
      sessionCookie,
      "merchant.access",
      expectedSession,
    );
    if (!(await selected.allowed())) throw new Error("BRAND_SERVICE_PERMISSION_DENIED");
    const context = createTenantContext(
      selected.context.actor,
      selected.context.brand,
      null,
      selected.context.resolvedAt,
    );
    const authorizeAction = async (action: string) => {
      const current = await resolveStore(
        transaction,
        sessionCookie,
        "merchant.access",
        expectedSession,
      );
      if (
        !(await current.allowed()) ||
        current.selected.tenantReference !== selected.selected.tenantReference ||
        current.context.brand.brandReference !== context.brand.brandReference ||
        current.store.storeReference !== selected.store.storeReference ||
        current.actorReference !== selected.actorReference
      )
        return null;
      const fresh = createTenantContext(
        current.context.actor,
        current.context.brand,
        null,
        current.context.resolvedAt,
      );
      const memberships = createPostgresCurrentMembershipSource(transaction, fresh);
      const membership = resolveActiveMembership(
        await memberships.findMemberships(current.actorReference, fresh.brand.brandReference),
        current.actorReference,
        fresh.brand.brandReference,
        fresh.resolvedAt,
      );
      const decision = await createPostgresCurrentPermissionPolicySource(transaction).authorize({
        tenantContext: fresh,
        membership,
        storeAssignment: null,
        action,
      });
      if (decision.scopeKind !== "Brand" || decision.action !== action) return null;
      return decision;
    };
    return Object.freeze({
      tenantReference: selected.selected.tenantReference,
      context,
      actorReference: selected.actorReference,
      authorizeAction,
    });
  };
}
