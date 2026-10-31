import { createTenantContext } from "@bop/tenant";
import { createPostgresCurrentMembershipSource, resolveActiveMembership } from "@bop/membership";
import { createPostgresCurrentPermissionPolicySource } from "@bop/permission";
import type { createPostgresBrowserSessionStore } from "@bop/identity";
import type { createMerchantSelectedContext } from "./merchant-selected-context.js";
import { merchantProductListRequiredFields } from "./merchant-product-list-query.js";
type Transaction = Parameters<
  NonNullable<Parameters<typeof createPostgresBrowserSessionStore>[0]["onSessionCreated"]>
>[0];
type Selected = Awaited<ReturnType<ReturnType<typeof createMerchantSelectedContext>>>;
export interface MerchantProductListNavigationAuthority {
  /** Current IAM/selection/complete field/Phase fences must remain held in this
   * transaction until outer COMMIT or rollback. Never authorize from candidate
   * navigation, configured HTTP handler, or a selected Store permission alone. */
  holdUntilTransactionCompletes(
    tx: Transaction,
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly storeReference: string;
      readonly actorReference: string;
      readonly sessionReference: string;
      readonly observedAt: string;
      readonly screenId: "CAT-PRODUCT-LIST";
      readonly permission: "catalog.manage";
      readonly action: "catalog.product.manage";
      readonly capability: "catalog.cat_product_list";
      readonly purposeCode: "CATALOG_PRODUCT_LIST";
      readonly requiredFields: typeof merchantProductListRequiredFields;
    },
  ): Promise<void>;
}
export async function allowsProductListNavigation(
  tx: Transaction,
  selected: Selected,
  sessionReference: string,
  authority: MerchantProductListNavigationAuthority | undefined,
): Promise<boolean> {
  if (!authority) return false;
  const context = selected.context,
    actor = context.actor.actorReference,
    store = context.store;
  if (!actor || !store) return false;
  await tx.query("SAVEPOINT merchant_catalog_navigation", []);
  try {
    await authority.holdUntilTransactionCompletes(
      tx,
      Object.freeze({
        tenantReference: selected.tenantReference,
        brandReference: context.brand.brandReference,
        storeReference: store.storeReference,
        actorReference: actor,
        sessionReference,
        observedAt: context.resolvedAt,
        screenId: "CAT-PRODUCT-LIST",
        permission: "catalog.manage",
        action: "catalog.product.manage",
        capability: "catalog.cat_product_list",
        purposeCode: "CATALOG_PRODUCT_LIST",
        requiredFields: merchantProductListRequiredFields,
      }),
    );
    const brandContext = createTenantContext(
      context.actor,
      context.brand,
      null,
      context.resolvedAt,
    );
    const memberships = createPostgresCurrentMembershipSource(tx, context);
    const membership = resolveActiveMembership(
      await memberships.findMemberships(actor, brandContext.brand.brandReference),
      actor,
      brandContext.brand.brandReference,
      brandContext.resolvedAt,
    );
    const policy = createPostgresCurrentPermissionPolicySource(tx);
    let allowed = true;
    for (const action of [
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.sku.read",
    ]) {
      const decision = await policy.authorize({
        tenantContext: brandContext,
        membership,
        storeAssignment: null,
        action,
      });
      if (
        decision.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      ) {
        allowed = false;
        break;
      }
    }
    await tx.query("RELEASE SAVEPOINT merchant_catalog_navigation", []);
    return allowed;
  } catch {
    await tx.query("ROLLBACK TO SAVEPOINT merchant_catalog_navigation", []);
    await tx.query("RELEASE SAVEPOINT merchant_catalog_navigation", []);
    return false;
  }
}
