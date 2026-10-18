import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  categoryTreeViewFields,
  categoryTreeMenuViewFields,
  createPostgresProductSearchGenerationStore,
  parseCatalogCategoryTreeFilters,
  parseCatalogCategoryTreeQueryView,
  parseCatalogLocale,
  parseCatalogInstant,
  parseCatalogReference,
  type CatalogCategoryTreeQueryView,
  type ProductSearchBuildAuthority,
} from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryAuthority } from "./merchant-category-authority.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export type MerchantCategoryTreeErrorCode =
  "Invalid" | "Denied" | "Unavailable" | "FeatureDisabled" | "Stale";
export class MerchantCategoryTreeError extends Error {
  constructor(readonly code: MerchantCategoryTreeErrorCode) {
    super("Category tree is unavailable");
  }
}
export interface MerchantCategoryTreeSelection {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly locale: string;
}
export interface MerchantCategoryTreeAuthority {
  /** Current normal Screen/purpose/fields/selection/Phase holder through transaction COMMIT. */
  withCurrentCategoryTree<T>(
    input: {
      readonly sessionCookie: unknown;
      readonly screenId: "CAT-CATEGORY-TREE";
      readonly permission: "catalog.manage";
      readonly action: "catalog.manage";
      readonly capability: "catalog.cat_category_tree";
      readonly referencedCapability: "catalog.cat_product_list";
      readonly purposeCode: "CATALOG_CATEGORY_TREE";
      readonly requiredFields: typeof categoryTreeViewFields | typeof categoryTreeMenuViewFields;
    },
    work: (scope: MerchantCategoryTreeSelection) => Promise<T>,
  ): Promise<T>;
}
export interface MerchantCategoryTreeResult {
  /** Selected Store is request context. Tree/count ownership remains Brand, not Store applicability. */
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly query: CatalogCategoryTreeQueryView;
}
const fail = (code: MerchantCategoryTreeErrorCode = "Unavailable"): never => {
  throw new MerchantCategoryTreeError(code);
};
export function parseMerchantCategoryTreeResult(value: unknown): MerchantCategoryTreeResult {
  try {
    const raw = readClosedRecord(value, ["scope", "query"]);
    const scope = readClosedRecord(raw.scope, ["brandReference", "storeReference"]);
    const brandReference = parseCatalogReference(scope.brandReference),
      storeReference = parseCatalogReference(scope.storeReference);
    const query = parseCatalogCategoryTreeQueryView(raw.query);
    if (query.tree.brandReference !== brandReference) return fail();
    return Object.freeze({ scope: Object.freeze({ brandReference, storeReference }), query });
  } catch {
    return fail();
  }
}
export function createMerchantCategoryTreeQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authority: MerchantCategoryTreeAuthority;
  /** Trusted server composition; grants still require current independent leases. */
  readonly includeMenuUse?: boolean;
  createProductSourceAuthority(
    scope: MerchantCategoryTreeSelection & { readonly sessionCookie: unknown },
  ): ProductSearchBuildAuthority;
  holdCategoryFieldsAndPhaseUntilCommit: Parameters<
    typeof createMerchantCategoryAuthority
  >[0]["holdFieldsAndPhaseUntilCommit"];
  readonly maximumProducts: number;
  readonly maximumCategoryNodes: number;
  readonly maximumSourceCommits: number;
}) {
  const includeMenuUse = options.includeMenuUse === true;
  if (
    (options.includeMenuUse !== undefined && typeof options.includeMenuUse !== "boolean") ||
    typeof options.authority?.withCurrentCategoryTree !== "function" ||
    typeof options.createProductSourceAuthority !== "function" ||
    typeof options.holdCategoryFieldsAndPhaseUntilCommit !== "function" ||
    !Number.isSafeInteger(options.maximumProducts) ||
    options.maximumProducts < 1 ||
    options.maximumProducts > 10000 ||
    !Number.isSafeInteger(options.maximumCategoryNodes) ||
    options.maximumCategoryNodes < 1 ||
    options.maximumCategoryNodes > 10000 ||
    !Number.isSafeInteger(options.maximumSourceCommits) ||
    options.maximumSourceCommits < 1 ||
    options.maximumSourceCommits > 1000000
  )
    return fail();
  const resolveStore = createMerchantStoreScope(options.merchant),
    resolveBrand = createMerchantBrandScope(options.merchant);
  const host = createMerchantCategoryTransactions(options.merchant.transactions);
  return async (request: {
    readonly sessionCookie: unknown;
    readonly filters: unknown;
  }): Promise<MerchantCategoryTreeResult> => {
    try {
      const filters = parseCatalogCategoryTreeFilters(request.filters);
      let calls = 0,
        completed: MerchantCategoryTreeResult | undefined;
      const result = await options.authority.withCurrentCategoryTree(
        {
          sessionCookie: request.sessionCookie,
          screenId: "CAT-CATEGORY-TREE",
          permission: "catalog.manage",
          action: "catalog.manage",
          capability: "catalog.cat_category_tree",
          referencedCapability: "catalog.cat_product_list",
          purposeCode: "CATALOG_CATEGORY_TREE",
          requiredFields: includeMenuUse ? categoryTreeMenuViewFields : categoryTreeViewFields,
        },
        async (value) => {
          if (++calls !== 1) return fail();
          const raw = readClosedRecord(value, [
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
          const categoryAuthority = createMerchantCategoryAuthority({
            source: options.merchant,
            sessionCookie: request.sessionCookie,
            sessionReference: scope.sessionReference,
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            actorReference: scope.actorReference,
            holdFieldsAndPhaseUntilCommit: options.holdCategoryFieldsAndPhaseUntilCommit,
            registerBeforeCommit: host.registerBeforeCommit,
          });
          const productAuthority = options.createProductSourceAuthority(
            Object.freeze({ ...scope, sessionCookie: request.sessionCookie }),
          );
          if (typeof productAuthority?.holdUntilTransactionCompletes !== "function") return fail();
          completed = await host.transactions.run(async (tx) => {
            const store = await resolveStore(
              tx,
              request.sessionCookie,
              "merchant.access",
              scope.sessionReference,
            );
            const brand = await resolveBrand(tx, request.sessionCookie, scope.sessionReference);
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
              if (!(await store.allowed())) return false;
              for (const required of [
                "catalog.manage",
                "catalog.category.read",
                "catalog.product.read",
              ]) {
                const decision = await brand.authorizeAction(required);
                if (
                  decision?.effect !== "Allow" ||
                  decision.scopeKind !== "Brand" ||
                  decision.action !== required
                )
                  return false;
              }
              return true;
            };
            if (!(await allowed())) throw new CatalogError("CATALOG_PERMISSION_DENIED");
            await host.registerBeforeCommit(tx, async () => {
              if (!(await allowed())) throw new CatalogError("CATALOG_PERMISSION_DENIED");
            });
            let pendingProduct:
              | Parameters<ProductSearchBuildAuthority["holdUntilTransactionCompletes"]>[1]
              | undefined;
            let productRegistered = false;
            const productLease: ProductSearchBuildAuthority = {
              async holdUntilTransactionCompletes(sourceTx, input) {
                if (sourceTx !== tx || input.purposeCode !== "CATALOG_PRODUCT_CATEGORY_SOURCE_READ")
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                await productAuthority.holdUntilTransactionCompletes(sourceTx, input);
                pendingProduct = input;
                if (!productRegistered) {
                  await host.registerBeforeCommit(tx, async () => {
                    if (!pendingProduct) return fail();
                    await productAuthority.holdUntilTransactionCompletes(
                      tx,
                      Object.freeze({
                        ...pendingProduct,
                        observedAt: parseCatalogInstant(options.merchant.now()),
                      }),
                    );
                  });
                  productRegistered = true;
                }
              },
            };
            const reader = createPostgresProductSearchGenerationStore({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: scope.actorReference,
              clock: { now: options.merchant.now },
              transactions: { run: (work) => work(tx) },
              authorization: productLease,
              maximumProducts: options.maximumProducts,
              categorySource: {
                authority: categoryAuthority,
                ...(includeMenuUse ? { menuAuthority: categoryAuthority } : {}),
                treeAuthority: categoryAuthority,
                maximumCategoryNodes: options.maximumCategoryNodes,
                maximumSourceCommits: options.maximumSourceCommits,
              },
            });
            const query = await reader.loadCategoryTreeQuery(scope.locale, filters);
            if (!(await allowed()) || query.tree.brandReference !== scope.brandReference)
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            if (JSON.stringify(query.filters) !== JSON.stringify(filters)) return fail();
            return parseMerchantCategoryTreeResult({
              scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
              query,
            });
          });
          return completed;
        },
      );
      if (calls !== 1 || result !== completed) return fail();
      const safe = parseMerchantCategoryTreeResult(result);
      if (includeMenuUse && safe.query.tree.source.menu === undefined) return fail();
      const now = parseCatalogInstant(options.merchant.now());
      if (
        now < safe.query.tree.projection.asOfUtc ||
        Date.parse(now) - Date.parse(safe.query.tree.projection.asOfUtc) > 5000 ||
        (safe.query.tree.source.menu !== undefined &&
          Date.parse(now) - Date.parse(safe.query.tree.source.menu.asOfUtc) > 5000)
      )
        return fail("Stale");
      return safe;
    } catch (error) {
      if (error instanceof MerchantCategoryTreeError) throw error;
      if (error instanceof CatalogError)
        return fail(
          error.code === "CATALOG_INPUT_INVALID"
            ? "Invalid"
            : error.code === "CATALOG_PERMISSION_DENIED"
              ? "Denied"
              : "Unavailable",
        );
      return fail();
    }
  };
}
