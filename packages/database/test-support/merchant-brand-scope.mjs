import { createBrand, createStore, createTenantContext } from "../../bop/tenant/src/index.ts";

/**
 * WP-2423: a Brand scope resolver for API compositions under test. The current Actor is switchable;
 * each Actor holds the listed Brand actions (and Store actions at the selected Store). As the real resolver, it leaves the Store selected.
 */
export function syntheticMerchantBrandScope({
  tenantReference,
  brandReference,
  storeReference,
  timeZone = "America/Toronto",
  grants,
  storeGrants = {},
  policyReference,
  at = "2026-09-20T00:00:00.000Z",
}) {
  const brand = createBrand({
    brandReference,
    code: "SYNTHETIC_BRAND",
    displayName: "Synthetic Brand",
    defaultLocale: "en-CA",
    currencyCode: "CAD",
    lifecycle: "Active",
    version: 1,
    createdAt: at,
    updatedAt: at,
  });
  const state = { actor: Object.keys(grants)[0] };
  const resolveScope = async (tx) => {
    const current = state.actor;
    const context = createTenantContext(
      {
        actorType: "User",
        actorReference: current,
        accountKind: "Workforce",
        status: "Active",
        authenticationMethod: "Oidc",
        verificationLevel: "SingleFactor",
        authenticatedAt: at,
        recentMfaAt: null,
      },
      brand,
      null,
      at,
    );
    await tx.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [tenantReference, brandReference, storeReference],
    );
    const storeContext = createTenantContext(
      context.actor,
      brand,
      createStore({
        storeReference,
        brandReference,
        code: "SYNTHETIC_STORE",
        displayName: "Synthetic Store",
        timeZone,
        locale: "en-CA",
        currencyCode: "CAD",
        lifecycle: "Active",
        version: 1,
        createdAt: at,
        updatedAt: at,
      }),
      at,
    );
    const decide = (action, allowed, scopeKind) => {
      const decision = {
        effect: allowed ? "Allow" : "Deny",
        reason: "ROLE_PERMISSION",
        source: "RolePermission",
      };
      return {
        action,
        scopeKind,
        ...decision,
        policySnapshotReference: policyReference,
        policyVersion: 1,
        audit: decision,
      };
    };
    return {
      context,
      storeContext,
      authorizeStoreAction: async (action) => {
        await tx.query("SELECT set_config('bop.store_id',$1,true)", [storeReference]);
        return decide(action, (storeGrants[current] ?? []).includes(action), "Store");
      },
      tenantReference,
      selectedStoreReference: storeReference,
      selectedStoreTimeZone: timeZone,
      actorReference: current,
      authorizeAction: async (action) => {
        // As the real resolver: each decision re-selects the Store in this transaction.
        await tx.query("SELECT set_config('bop.store_id',$1,true)", [storeReference]);
        const allowed = (grants[current] ?? []).includes(action);
        const decision = {
          effect: allowed ? "Allow" : "Deny",
          reason: "ROLE_PERMISSION",
          source: "RolePermission",
        };
        return {
          action,
          scopeKind: "Brand",
          ...decision,
          policySnapshotReference: policyReference,
          policyVersion: 1,
          audit: decision,
        };
      },
    };
  };
  return {
    resolveScope,
    as(actor) {
      state.actor = actor;
    },
  };
}
