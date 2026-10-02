import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  contentRegistryFields,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductContentRegistry,
  type CatalogContentRegistryAuthority,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

/** Current native IAM and independent registry fields/policy both remain mandatory.
 * The Catalog source owns its definitions and history; this adapter grants none. */
export function createMerchantProductContentRegistryAuthority(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly transaction: ProductLifecycleTransaction;
  readonly sessionCookie: unknown;
  readonly sessionReference: string;
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
    readonly actorReference: string;
  };
  readonly authority: CatalogContentRegistryAuthority;
}): CatalogContentRegistryAuthority {
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
  ]);
  const expected = Object.freeze({
    tenantReference: parseCatalogReference(rawScope.tenantReference),
    brandReference: parseCatalogReference(rawScope.brandReference),
    storeReference: parseCatalogReference(rawScope.storeReference),
    actorReference: parseCatalogReference(rawScope.actorReference),
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
    for (const action of ["catalog.manage", "catalog.content-registry.read"]) {
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
  return Object.freeze({
    async holdUntilTransactionCompletes(
      actual: ProductLifecycleTransaction,
      value: Parameters<CatalogContentRegistryAuthority["holdUntilTransactionCompletes"]>[1],
    ) {
      try {
        if (actual !== tx || active) return fail();
        active = true;
        check();
        const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
          "tenantReference",
          "brandReference",
          "actorReference",
          "actorKind",
          "purposeCode",
          "permission",
          "action",
          "registry",
          "requiredFields",
          "observedAt",
        ]);
        const at = parseCatalogInstant(raw.observedAt),
          registry =
            raw.registry === null ? null : parseCatalogProductContentRegistry(raw.registry);
        if (
          raw.tenantReference !== expected.tenantReference ||
          raw.brandReference !== expected.brandReference ||
          raw.actorReference !== expected.actorReference
        )
          return fail("CATALOG_PERMISSION_DENIED");
        if (
          raw.actorKind !== "User" ||
          raw.purposeCode !== "CATALOG_PRODUCT_CONTENT_REGISTRY" ||
          raw.permission !== "catalog.manage" ||
          raw.action !== "catalog.content-registry.read" ||
          JSON.stringify(raw.requiredFields) !== JSON.stringify(contentRegistryFields) ||
          at < observedAt ||
          at > check() ||
          (registry !== null &&
            (registry.tenantReference !== expected.tenantReference ||
              registry.brandReference !== expected.brandReference ||
              registry.registeredAt > at))
        )
          return fail();
        const input = Object.freeze({
          tenantReference: expected.tenantReference,
          brandReference: expected.brandReference,
          actorReference: expected.actorReference,
          actorKind: "User" as const,
          purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY" as const,
          permission: "catalog.manage" as const,
          action: "catalog.content-registry.read" as const,
          registry,
          requiredFields: contentRegistryFields,
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
}
