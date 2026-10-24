import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  categoryPersistenceFields,
  copyCategoryPersistenceValue,
  createPostgresCategorySourceStore,
  deriveCatalogProductCategoryLookup,
  parseCatalogProductCategoryLookup,
  parseProductCategoryLookupPolicy,
  productCategoryLookupFields,
  parseCatalogReference,
  parseCatalogLocale,
  parseCatalogInstant,
  type CatalogProductCategoryLookup,
  type ProductCategoryLookupScreen,
  type CategorySourceAuthority,
} from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
export class MerchantProductCategoryLookupError extends Error {
  constructor(readonly code: "Invalid" | "Denied" | "Unavailable" | "Stale" | "FeatureDisabled") {
    super("Product category lookup is unavailable");
  }
}
const fail = (code: MerchantProductCategoryLookupError["code"] = "Unavailable"): never => {
  throw new MerchantProductCategoryLookupError(code);
};
export function parseProductCategoryLookupRequest(value: unknown): ProductCategoryLookupScreen {
  try {
    const raw = readClosedRecord(copyCategoryPersistenceValue(value), ["parentScreenId"]);
    if (raw.parentScreenId !== "CAT-PRODUCT-CREATE" && raw.parentScreenId !== "CAT-PRODUCT-EDIT")
      return fail("Invalid");
    return raw.parentScreenId;
  } catch {
    return fail("Invalid");
  }
}
export interface ProductCategoryLookupSelection {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly locale: string;
}
export interface MerchantProductCategoryLookupResult {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly lookup: CatalogProductCategoryLookup;
}
export interface ProductCategoryLookupAuthority {
  withCurrentProductCategoryLookup<T>(
    input: {
      readonly sessionCookie: unknown;
      readonly screenId: ProductCategoryLookupScreen;
      readonly capability: "catalog.cat_product_create" | "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly purposeCode: "CATALOG_PRODUCT_CATEGORY_LOOKUP";
      readonly requiredFields: typeof productCategoryLookupFields;
    },
    work: (scope: ProductCategoryLookupSelection) => Promise<T>,
  ): Promise<T>;
}
export function parseMerchantProductCategoryLookupResult(
  value: unknown,
): MerchantProductCategoryLookupResult {
  try {
    const raw = readClosedRecord(copyCategoryPersistenceValue(value), ["scope", "lookup"]),
      scope = readClosedRecord(raw.scope, ["brandReference", "storeReference"]),
      lookup = parseCatalogProductCategoryLookup(raw.lookup),
      brandReference = parseCatalogReference(scope.brandReference),
      storeReference = parseCatalogReference(scope.storeReference);
    if (lookup.brandReference !== brandReference) return fail();
    return Object.freeze({ scope: Object.freeze({ brandReference, storeReference }), lookup });
  } catch {
    return fail();
  }
}
export function createMerchantProductCategoryLookupQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authority: ProductCategoryLookupAuthority;
  readonly holdFieldsPolicyAndPhaseUntilCommit: (
    tx: Parameters<CategorySourceAuthority["holdUntilTransactionCompletes"]>[0],
    input: ProductCategoryLookupSelection & {
      readonly screenId: ProductCategoryLookupScreen;
      readonly capability: "catalog.cat_product_create" | "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly purposeCode: "CATALOG_PRODUCT_CATEGORY_LOOKUP";
      readonly requiredFields: typeof productCategoryLookupFields;
      readonly referencedFields: typeof categoryPersistenceFields;
      readonly observedAt: string;
    },
  ) => Promise<unknown>;
  readonly maximumCategoryNodes: number;
  readonly maximumSourceCommits: number;
}) {
  if (
    typeof options.authority?.withCurrentProductCategoryLookup !== "function" ||
    typeof options.holdFieldsPolicyAndPhaseUntilCommit !== "function" ||
    typeof options.merchant?.now !== "function" ||
    !Number.isSafeInteger(options.maximumCategoryNodes) ||
    options.maximumCategoryNodes < 1 ||
    options.maximumCategoryNodes > 10000 ||
    !Number.isSafeInteger(options.maximumSourceCommits) ||
    options.maximumSourceCommits < 1 ||
    options.maximumSourceCommits > 1000000
  )
    return fail();
  const resolveStore = createMerchantStoreScope(options.merchant),
    resolveBrand = createMerchantBrandScope(options.merchant),
    host = createMerchantCategoryTransactions(options.merchant.transactions);
  return async (request: {
    readonly sessionCookie: unknown;
    readonly query: unknown;
  }): Promise<MerchantProductCategoryLookupResult> => {
    try {
      const screenId = parseProductCategoryLookupRequest(request.query),
        capability =
          screenId === "CAT-PRODUCT-CREATE"
            ? ("catalog.cat_product_create" as const)
            : ("catalog.cat_product_edit" as const);
      let calls = 0,
        completed: MerchantProductCategoryLookupResult | undefined;
      const result = await options.authority.withCurrentProductCategoryLookup(
        {
          sessionCookie: request.sessionCookie,
          screenId,
          capability,
          permission: "catalog.manage",
          purposeCode: "CATALOG_PRODUCT_CATEGORY_LOOKUP",
          requiredFields: productCategoryLookupFields,
        },
        async (value) => {
          if (++calls !== 1) return fail();
          const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
            "tenantReference",
            "brandReference",
            "storeReference",
            "actorReference",
            "sessionReference",
            "locale",
          ]);
          const scope = Object.freeze({
            tenantReference: parseCatalogReference(raw.tenantReference),
            brandReference: parseCatalogReference(raw.brandReference),
            storeReference: parseCatalogReference(raw.storeReference),
            actorReference: parseCatalogReference(raw.actorReference),
            sessionReference: parseCatalogReference(raw.sessionReference),
            locale: parseCatalogLocale(raw.locale),
          });
          completed = await host.transactions.run(async (tx) => {
            const store = await resolveStore(
                tx,
                request.sessionCookie,
                "merchant.access",
                scope.sessionReference,
              ),
              brand = await resolveBrand(tx, request.sessionCookie, scope.sessionReference);
            if (
              store.selected.tenantReference !== scope.tenantReference ||
              String(store.context.brand.brandReference) !== scope.brandReference ||
              String(store.store.storeReference) !== scope.storeReference ||
              String(store.actorReference) !== scope.actorReference ||
              brand.tenantReference !== scope.tenantReference ||
              String(brand.context.brand.brandReference) !== scope.brandReference ||
              String(brand.actorReference) !== scope.actorReference
            )
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            const allowed = async () => {
              if (!(await store.allowed())) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              for (const required of ["catalog.manage", "catalog.category.read"]) {
                const decision = await brand.authorizeAction(required);
                if (
                  decision?.effect !== "Allow" ||
                  decision.scopeKind !== "Brand" ||
                  decision.action !== required
                )
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
              }
            };
            let policy: ReturnType<typeof parseProductCategoryLookupPolicy> | undefined;
            const hold = async () => {
              await allowed();
              const current = parseProductCategoryLookupPolicy(
                await options.holdFieldsPolicyAndPhaseUntilCommit(
                  tx,
                  Object.freeze({
                    ...scope,
                    screenId,
                    capability,
                    permission: "catalog.manage",
                    purposeCode: "CATALOG_PRODUCT_CATEGORY_LOOKUP",
                    requiredFields: productCategoryLookupFields,
                    referencedFields: categoryPersistenceFields,
                    observedAt: parseCatalogInstant(options.merchant.now()),
                  }),
                ),
              );
              if (policy !== undefined && JSON.stringify(policy) !== JSON.stringify(current))
                throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
              policy = current;
            };
            await hold();
            await host.registerBeforeCommit(tx, hold);
            const source = createPostgresCategorySourceStore({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: scope.actorReference,
              transactions: { run: async (work) => work(tx) },
              clock: { now: options.merchant.now },
              readCapability: capability,
              maximumCategoryNodes: options.maximumCategoryNodes,
              maximumSourceCommits: options.maximumSourceCommits,
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  if (
                    actual !== tx ||
                    input.tenantReference !== scope.tenantReference ||
                    input.brandReference !== scope.brandReference ||
                    input.actorReference !== scope.actorReference ||
                    input.purposeCode !== "CATALOG_CATEGORY_SOURCE_READ" ||
                    input.permission !== "catalog.manage" ||
                    input.capability !== capability ||
                    JSON.stringify(input.requiredFields) !==
                      JSON.stringify(categoryPersistenceFields)
                  )
                    throw new CatalogError("CATALOG_PERMISSION_DENIED");
                  await hold();
                },
              },
            });
            const snapshot = await source.loadSnapshot();
            if (!policy) return fail();
            const lookup = deriveCatalogProductCategoryLookup(
              snapshot,
              screenId,
              scope.locale,
              policy,
              options.merchant.now(),
            );
            return parseMerchantProductCategoryLookupResult({
              scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
              lookup,
            });
          });
          return completed;
        },
      );
      if (calls !== 1 || result !== completed) return fail();
      const safe = parseMerchantProductCategoryLookupResult(result),
        now = parseCatalogInstant(options.merchant.now());
      if (safe.lookup.parentScreenId !== screenId) return fail();
      if (
        now < safe.lookup.projection.asOfUtc ||
        Date.parse(now) - Date.parse(safe.lookup.projection.asOfUtc) > 5000
      )
        return fail("Stale");
      return safe;
    } catch (error) {
      if (error instanceof MerchantProductCategoryLookupError) throw error;
      if (error instanceof CatalogError)
        return fail(error.code === "CATALOG_PERMISSION_DENIED" ? "Denied" : "Unavailable");
      return fail();
    }
  };
}
