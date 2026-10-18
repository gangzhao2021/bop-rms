import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductCategoryLookupPolicy,
  productCategoryAssignmentFields,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
import type { MerchantProductCategoryPolicy } from "./merchant-product-category-assignments.js";

/** Native IAM is independent of the mandatory current fields/phase/policy holder.
 * Category facts remain owned by Catalog; neither source can grant the other. */
export function createMerchantProductCategoryPolicyAuthority(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly transaction: ProductLifecycleTransaction;
  readonly sessionCookie: unknown;
  readonly sessionReference: string;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
    readonly productReference: string;
  };
  readonly holdPolicyUntilTransactionCompletes: MerchantProductCategoryPolicy;
}): MerchantProductCategoryPolicy {
  const unavailable = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  if (
    typeof options.holdPolicyUntilTransactionCompletes !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.transaction?.query !== "function"
  )
    return unavailable();
  const scope = readClosedRecord(copyCategoryPersistenceValue(options.scope), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "productReference",
  ]);
  const expected = Object.freeze({
    tenantReference: parseCatalogReference(scope.tenantReference),
    brandReference: parseCatalogReference(scope.brandReference),
    storeReference: parseCatalogReference(scope.storeReference),
    actorReference: parseCatalogReference(scope.actorReference),
    productReference: parseCatalogReference(scope.productReference),
  });
  const session = parseCatalogReference(options.sessionReference),
    cookie = options.sessionCookie;
  const tx = options.transaction,
    query = tx.query,
    now = options.merchant.now.bind(options.merchant);
  const resolve = createMerchantBrandScope(options.merchant),
    hold = options.holdPolicyUntilTransactionCompletes;
  const observedAt = parseCatalogInstant(now());
  const validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
  let latest = observedAt,
    failed = false,
    active = false;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (failed || tx.query !== query || at < latest || at >= validUntil) return unavailable();
    latest = at;
    return at;
  };
  const permission = async () => {
    check();
    const current = await resolve(tx, cookie, session);
    check();
    if (
      current.tenantReference !== expected.tenantReference ||
      String(current.context.brand.brandReference) !== expected.brandReference ||
      String(current.selectedStoreReference) !== expected.storeReference ||
      String(current.actorReference) !== expected.actorReference
    )
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    for (const action of ["catalog.product.manage", "catalog.manage"]) {
      const result = await current.authorizeAction(action);
      check();
      if (result?.effect !== "Allow" || result.scopeKind !== "Brand" || result.action !== action)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }
  };
  return async (actual, value) => {
    try {
      if (actual !== tx || active) return unavailable();
      active = true;
      check();
      const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
        "tenantReference",
        "brandReference",
        "actorReference",
        "productReference",
        "productVersionReference",
        "purposeCode",
        "permission",
        "referencedPermission",
        "requiredFields",
        "referencedFields",
        "observedAt",
      ]);
      for (const key of [
        "tenantReference",
        "brandReference",
        "actorReference",
        "productReference",
      ] as const)
        if (parseCatalogReference(raw[key]) !== expected[key])
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
      parseCatalogReference(raw.productVersionReference);
      const at = parseCatalogInstant(raw.observedAt);
      if (
        at < observedAt ||
        at > check() ||
        !["CATALOG_PRODUCT_CATEGORY_ACCESS", "CATALOG_PRODUCT_CATEGORY_MUTATION"].includes(
          String(raw.purposeCode),
        ) ||
        raw.permission !== "catalog.product.manage" ||
        raw.referencedPermission !== "catalog.manage" ||
        JSON.stringify(raw.requiredFields) !== JSON.stringify(productCategoryAssignmentFields) ||
        JSON.stringify(raw.referencedFields) !==
          JSON.stringify(["categoryReference", "brandReference", "lifecycle"])
      )
        throw new CatalogError("CATALOG_INPUT_INVALID");
      await permission();
      const policy = parseProductCategoryLookupPolicy(
        await hold(
          tx,
          Object.freeze({
            tenantReference: expected.tenantReference,
            brandReference: expected.brandReference,
            actorReference: expected.actorReference,
            productReference: expected.productReference,
            productVersionReference: parseCatalogReference(raw.productVersionReference),
            purposeCode:
              raw.purposeCode === "CATALOG_PRODUCT_CATEGORY_ACCESS"
                ? "CATALOG_PRODUCT_CATEGORY_ACCESS"
                : "CATALOG_PRODUCT_CATEGORY_MUTATION",
            permission: "catalog.product.manage",
            referencedPermission: "catalog.manage",
            requiredFields: productCategoryAssignmentFields,
            referencedFields: Object.freeze([
              "categoryReference",
              "brandReference",
              "lifecycle",
            ] as const),
            observedAt: at,
          }),
        ),
      );
      check();
      await permission();
      return policy;
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return unavailable();
    } finally {
      active = false;
    }
  };
}
