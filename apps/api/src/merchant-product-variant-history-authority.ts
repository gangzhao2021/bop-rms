import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  productVariantHistoryFields,
  createPostgresProductVariantIdentityHistorySource,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductVariantIdentityHistoryRequest,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

type HistoryAuthority = Parameters<
  typeof createPostgresProductVariantIdentityHistorySource
>[0]["authority"];

/** Native admission is separate from the owning history and independent field policy.
 * Receipt reads check current permission without replacing original history. */
export function createMerchantProductVariantHistoryAuthority(options: {
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
  readonly authority: HistoryAuthority;
}) {
  const fail = (
    code:
      | "CATALOG_DEPENDENCY_UNAVAILABLE"
      | "CATALOG_PERMISSION_DENIED" = "CATALOG_DEPENDENCY_UNAVAILABLE",
  ): never => {
    throw new CatalogError(code);
  };
  if (
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.merchant?.now !== "function" ||
    typeof options.transaction?.query !== "function"
  )
    return fail();
  const rawScope = readClosedRecord(copyCategoryPersistenceValue(options.scope), [
    "tenantReference",
    "brandReference",
    "storeReference",
    "actorReference",
    "productReference",
  ]);
  const expected = Object.freeze({
    tenantReference: parseCatalogReference(rawScope.tenantReference),
    brandReference: parseCatalogReference(rawScope.brandReference),
    storeReference: parseCatalogReference(rawScope.storeReference),
    actorReference: parseCatalogReference(rawScope.actorReference),
    productReference: parseCatalogReference(rawScope.productReference),
  });
  const tx = options.transaction,
    query = tx.query,
    session = parseCatalogReference(options.sessionReference),
    cookie = options.sessionCookie,
    now = options.merchant.now.bind(options.merchant),
    resolve = createMerchantBrandScope(options.merchant),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    observedAt = parseCatalogInstant(now()),
    validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
  let latest = observedAt,
    failed = false,
    active = false;
  const check = () => {
    const at = parseCatalogInstant(now());
    if (failed || tx.query !== query || at < latest || at >= validUntil) return fail();
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
      return fail("CATALOG_PERMISSION_DENIED");
    for (const action of ["catalog.manage", "catalog.product.history.read"]) {
      const decision = await current.authorizeAction(action);
      check();
      if (
        decision?.effect !== "Allow" ||
        decision.scopeKind !== "Brand" ||
        decision.action !== action
      )
        return fail("CATALOG_PERMISSION_DENIED");
    }
  };
  const assertCurrent = async (actual: ProductLifecycleTransaction): Promise<void> => {
    try {
      if (actual !== tx || active) return fail();
      active = true;
      await permission();
      check();
    } catch (error) {
      failed = true;
      if (error instanceof CatalogError) throw error;
      return fail();
    } finally {
      active = false;
    }
  };
  const authority: HistoryAuthority = Object.freeze({
    async holdUntilTransactionCompletes(
      actual: ProductLifecycleTransaction,
      value: Parameters<HistoryAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        if (actual !== tx || active) return fail();
        active = true;
        check();
        const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "actorReference",
          "purposeCode",
          "permission",
          "request",
          "requiredFields",
          "observedAt",
        ]);
        const at = parseCatalogInstant(raw.observedAt),
          request = parseProductVariantIdentityHistoryRequest(raw.request);
        if (
          raw.tenantReference !== expected.tenantReference ||
          raw.brandReference !== expected.brandReference ||
          raw.actorReference !== expected.actorReference
        )
          return fail("CATALOG_PERMISSION_DENIED");
        if (
          raw.purposeCode !== "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY" ||
          raw.permission !== "catalog.product.history.read" ||
          JSON.stringify(raw.requiredFields) !== JSON.stringify(productVariantHistoryFields) ||
          at < observedAt ||
          at > check() ||
          request.productReference !== expected.productReference
        )
          return fail();
        const input = Object.freeze({
          tenantReference: expected.tenantReference,
          brandReference: expected.brandReference,
          actorReference: expected.actorReference,
          purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY" as const,
          permission: "catalog.product.history.read" as const,
          request,
          requiredFields: productVariantHistoryFields,
          observedAt: at,
        });
        await permission();
        if ((await hold(tx, input)) !== undefined) return fail();
        check();
        await permission();
        check();
      } catch (error) {
        failed = true;
        if (error instanceof CatalogError) throw error;
        return fail();
      } finally {
        active = false;
      }
    },
  });
  return Object.freeze({ authority, assertCurrent });
}
