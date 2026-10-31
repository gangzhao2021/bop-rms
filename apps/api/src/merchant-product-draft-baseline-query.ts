import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  copyCategoryPersistenceValue,
  parseCatalogReference,
  parseCatalogInstant,
  parseCatalogProductDraftBaseline,
  createPostgresProductDraftBaselineStore,
  productDraftBaselineFields,
  productDraftBaselineReferencedFields,
  type CatalogProductDraftBaseline,
  type ProductDraftBaselineSourceAuthority,
} from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import {
  createMerchantProductCategoryAssignments,
  type MerchantProductCategoryPolicy,
} from "./merchant-product-category-assignments.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";
export class MerchantProductDraftBaselineError extends Error {
  constructor(readonly code: "Invalid" | "Denied" | "Unavailable" | "Stale" | "FeatureDisabled") {
    super("Product draft baseline is unavailable");
  }
}
const fail = (code: MerchantProductDraftBaselineError["code"] = "Unavailable"): never => {
  throw new MerchantProductDraftBaselineError(code);
};
export function parseProductDraftBaselineRequest(value: unknown): {
  readonly productReference: string;
} {
  try {
    const raw = readClosedRecord(copyCategoryPersistenceValue(value), ["productReference"]);
    return Object.freeze({ productReference: parseCatalogReference(raw.productReference) });
  } catch {
    return fail("Invalid");
  }
}
export interface ProductDraftBaselineSelection {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
}
export interface MerchantProductDraftBaselineResult {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly baseline: CatalogProductDraftBaseline | null;
}
export interface ProductDraftBaselineAuthority {
  withCurrentProductDraftBaseline<T>(
    input: {
      readonly sessionCookie: unknown;
      readonly productReference: string;
      readonly screenId: "CAT-PRODUCT-EDIT";
      readonly capability: "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly action: "catalog.product.manage";
      readonly purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ";
      readonly requiredFields: typeof productDraftBaselineFields;
    },
    work: (scope: ProductDraftBaselineSelection) => Promise<T>,
  ): Promise<T>;
}
export function parseMerchantProductDraftBaselineResult(
  value: unknown,
): MerchantProductDraftBaselineResult {
  try {
    const raw = readClosedRecord(copyCategoryPersistenceValue(value), ["scope", "baseline"]),
      scope = readClosedRecord(raw.scope, ["brandReference", "storeReference"]),
      brandReference = parseCatalogReference(scope.brandReference),
      storeReference = parseCatalogReference(scope.storeReference),
      baseline = raw.baseline === null ? null : parseCatalogProductDraftBaseline(raw.baseline);
    if (baseline !== null && baseline.brandReference !== brandReference) return fail();
    return Object.freeze({ scope: Object.freeze({ brandReference, storeReference }), baseline });
  } catch {
    return fail();
  }
}
export function createMerchantProductDraftBaselineQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authority: ProductDraftBaselineAuthority;
  readonly holdFieldsAndPhaseUntilCommit: (
    tx: Parameters<ProductDraftBaselineSourceAuthority["holdUntilTransactionCompletes"]>[0],
    input: ProductDraftBaselineSelection & {
      readonly productReference: string;
      readonly screenId: "CAT-PRODUCT-EDIT";
      readonly capability: "catalog.cat_product_edit";
      readonly permission: "catalog.manage";
      readonly action: "catalog.product.manage";
      readonly purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ";
      readonly requiredFields: typeof productDraftBaselineFields;
      readonly referencedFields: typeof productDraftBaselineReferencedFields;
      readonly observedAt: string;
    },
  ) => Promise<void>;
  readonly categoryPolicy?: MerchantProductCategoryPolicy;
  readonly maximumSkus: number;
  readonly maximumOptionBindings: number;
}) {
  if (
    typeof options.authority?.withCurrentProductDraftBaseline !== "function" ||
    typeof options.holdFieldsAndPhaseUntilCommit !== "function" ||
    typeof options.merchant?.now !== "function" ||
    [options.maximumSkus, options.maximumOptionBindings].some(
      (n) => !Number.isSafeInteger(n) || n < 1 || n > 10000,
    )
  )
    return fail();
  const resolveStore = createMerchantStoreScope(options.merchant),
    resolveBrand = createMerchantBrandScope(options.merchant),
    host = createMerchantCategoryTransactions(options.merchant.transactions);
  return async (request: {
    readonly sessionCookie: unknown;
    readonly query: unknown;
  }): Promise<MerchantProductDraftBaselineResult> => {
    try {
      const query = parseProductDraftBaselineRequest(request.query),
        capability = "catalog.cat_product_edit" as const,
        screenId = "CAT-PRODUCT-EDIT" as const,
        permission = "catalog.manage" as const,
        action = "catalog.product.manage" as const,
        purposeCode = "CATALOG_PRODUCT_DRAFT_BASELINE_READ" as const;
      let calls = 0,
        completed: MerchantProductDraftBaselineResult | undefined;
      const result = await options.authority.withCurrentProductDraftBaseline(
        {
          sessionCookie: request.sessionCookie,
          ...query,
          screenId,
          capability,
          permission,
          action,
          purposeCode,
          requiredFields: productDraftBaselineFields,
        },
        async (value) => {
          if (++calls !== 1) return fail();
          const raw = readClosedRecord(copyCategoryPersistenceValue(value), [
              "tenantReference",
              "brandReference",
              "storeReference",
              "actorReference",
              "sessionReference",
            ]),
            scope = Object.freeze({
              tenantReference: parseCatalogReference(raw.tenantReference),
              brandReference: parseCatalogReference(raw.brandReference),
              storeReference: parseCatalogReference(raw.storeReference),
              actorReference: parseCatalogReference(raw.actorReference),
              sessionReference: parseCatalogReference(raw.sessionReference),
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
              String(brand.actorReference) !== scope.actorReference ||
              String(brand.selectedStoreReference) !== scope.storeReference
            )
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            const hold = async () => {
              if (!(await store.allowed())) throw new CatalogError("CATALOG_PERMISSION_DENIED");
              for (const required of [
                permission,
                action,
                "catalog.product.read",
                "catalog.sku.read",
              ]) {
                const decision = await brand.authorizeAction(required);
                if (
                  decision?.effect !== "Allow" ||
                  decision.scopeKind !== "Brand" ||
                  decision.action !== required
                )
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
              }
              await options.holdFieldsAndPhaseUntilCommit(
                tx,
                Object.freeze({
                  ...scope,
                  ...query,
                  screenId,
                  capability,
                  permission,
                  action,
                  purposeCode,
                  requiredFields: productDraftBaselineFields,
                  referencedFields: productDraftBaselineReferencedFields,
                  observedAt: parseCatalogInstant(options.merchant.now()),
                }),
              );
            };
            await hold();
            await host.registerBeforeCommit(tx, hold);
            const categoryAssignments = createMerchantProductCategoryAssignments({
              transaction: tx,
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: scope.actorReference,
              now: options.merchant.now,
              policy: options.categoryPolicy,
              registerBeforeCommit: host.registerBeforeCommit,
            });
            const source = createPostgresProductDraftBaselineStore({
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              actorReference: scope.actorReference,
              transactions: { run: async (work) => work(tx) },
              clock: { now: options.merchant.now },
              maximumSkus: options.maximumSkus,
              maximumOptionBindings: options.maximumOptionBindings,
              ...(categoryAssignments === undefined ? {} : { categoryAssignments }),
              authority: {
                async holdUntilTransactionCompletes(actual, input) {
                  if (
                    actual !== tx ||
                    input.tenantReference !== scope.tenantReference ||
                    input.brandReference !== scope.brandReference ||
                    input.actorReference !== scope.actorReference ||
                    input.productReference !== query.productReference ||
                    input.purposeCode !== purposeCode ||
                    input.permission !== permission ||
                    input.action !== action ||
                    input.capability !== capability ||
                    JSON.stringify(input.requiredFields) !==
                      JSON.stringify(productDraftBaselineFields) ||
                    JSON.stringify(input.referencedFields) !==
                      JSON.stringify(productDraftBaselineReferencedFields)
                  )
                    throw new CatalogError("CATALOG_PERMISSION_DENIED");
                  await hold();
                },
              },
            });
            const baseline = await source.loadBaseline(query.productReference);
            return parseMerchantProductDraftBaselineResult({
              scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
              baseline,
            });
          });
          return completed;
        },
      );
      if (calls !== 1 || result !== completed) return fail();
      const safe = parseMerchantProductDraftBaselineResult(result),
        now = parseCatalogInstant(options.merchant.now());
      if (safe.baseline !== null) {
        if (safe.baseline.productReference !== query.productReference) return fail();
        if (
          now < safe.baseline.projection.asOfUtc ||
          Date.parse(now) - Date.parse(safe.baseline.projection.asOfUtc) > 5000
        )
          return fail("Stale");
      }
      return safe;
    } catch (error) {
      if (error instanceof MerchantProductDraftBaselineError) throw error;
      if (error instanceof CatalogError)
        return fail(error.code === "CATALOG_PERMISSION_DENIED" ? "Denied" : "Unavailable");
      return fail();
    }
  };
}
