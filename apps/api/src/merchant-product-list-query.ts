import { readClosedRecord } from "@bop/identity";
import {
  CatalogProductListError,
  catalogProductListCategoryFields,
  createPostgresCatalogProductListQueryStore,
  parseCatalogProductListRequest,
  parseCatalogProductListView,
  parseCatalogReference,
  parseCatalogLocale,
  type CatalogProductListView,
  type CatalogProductListCategorySource,
} from "@rms/catalog";
import { createMerchantStoreScope } from "./merchant-store-scope.js";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import type { PersistentMerchantBffOptions } from "./persistent-merchant-bff.js";

export const merchantProductListRequiredFields = Object.freeze([
  "activeSkuCount",
  "updatedAt",
  "createdAt",
  "internalCode",
  "lifecycle",
  "productReference",
  "name",
  "nameLocale",
  "localeFallback",
  "productType",
  "aggregateVersion",
  "source",
  "skuCount",
  "productLocalizedNames",
  "skuLocalizedNames",
  "skuCode",
] as const);
export const merchantProductListCategoryRequiredFields = Object.freeze([
  ...merchantProductListRequiredFields,
  ...catalogProductListCategoryFields,
]);
export interface MerchantProductListCapability {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly actorReference: string;
  readonly sessionReference: string;
  readonly locale: string;
}
export interface MerchantProductListAuthority {
  /** Public current IAM/selection/purpose/field/Phase lease. Hold ALL authority
   * and selected-scope fences until work (including transaction COMMIT) settles.
   * Caller input is a credential, never an asserted scope or a grant. */
  withCurrentProductList<T>(
    input: {
      readonly sessionCookie: unknown;
      readonly screenId: "CAT-PRODUCT-LIST";
      readonly permission: "catalog.manage";
      readonly action: "catalog.product.manage";
      readonly capability: "catalog.cat_product_list";
      readonly purposeCode: "CATALOG_PRODUCT_LIST";
      /** Every requested/displayed/searched field must be allowed; filters never confer grants.
       * LocalizedNames means the full searched map and any display fallback locale.
       * A partial locale permission cannot authorize this current all-locale query. */
      readonly requiredFields:
        typeof merchantProductListRequiredFields | typeof merchantProductListCategoryRequiredFields;
    },
    work: (scope: MerchantProductListCapability) => Promise<T>,
  ): Promise<T>;
}
const fail = (code: CatalogProductListError["code"] = "Unavailable"): never => {
  throw new CatalogProductListError(code);
};
export function createMerchantProductListQuery(options: {
  readonly merchant: PersistentMerchantBffOptions;
  readonly authority: MerchantProductListAuthority;
  readonly cursorKey: Uint8Array;
  readonly categorySource?: Omit<CatalogProductListCategorySource, "tenantReference">;
}) {
  const resolveStore = createMerchantStoreScope(options.merchant);
  const resolveBrand = createMerchantBrandScope(options.merchant);
  // Validate and copy explicit startup signing configuration before accepting a request.
  if (
    !(options.cursorKey instanceof Uint8Array) ||
    options.cursorKey.length < 32 ||
    options.cursorKey.length > 64
  )
    return fail();
  const cursorKey = new Uint8Array(options.cursorKey);
  const categorySource = options.categorySource;
  return async (request: { readonly sessionCookie: unknown; readonly filters: unknown }) => {
    try {
      let filters: Record<string, unknown>;
      try {
        const hasCategory =
          request.filters !== null &&
          typeof request.filters === "object" &&
          Object.hasOwn(request.filters, "categoryReference");
        filters = readClosedRecord(request.filters, [
          "search",
          "lifecycle",
          "productType",
          "limit",
          "cursor",
          "includeArchived",
          "hasActiveSku",
          "missingTranslationLocale",
          "updatedFrom",
          "updatedUntil",
          "createdFrom",
          "createdUntil",
          "sort",
          "direction",
          ...(hasCategory ? ["categoryReference"] : []),
        ]);
      } catch {
        return fail("Invalid");
      }
      let calls = 0;
      let completedView: CatalogProductListView | undefined;
      const result = await options.authority.withCurrentProductList(
        {
          sessionCookie: request.sessionCookie,
          screenId: "CAT-PRODUCT-LIST",
          permission: "catalog.manage",
          action: "catalog.product.manage",
          capability: "catalog.cat_product_list",
          purposeCode: "CATALOG_PRODUCT_LIST",
          requiredFields:
            categorySource !== undefined || filters.categoryReference != null
              ? merchantProductListCategoryRequiredFields
              : merchantProductListRequiredFields,
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
          const input = parseCatalogProductListRequest({
            ...filters,
            actorReference: scope.actorReference,
            purposeCode: "CATALOG_PRODUCT_LIST",
            locale: scope.locale,
            observedAt: options.merchant.now(),
          });
          completedView = await options.merchant.transactions.run(async (tx) => {
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
              return fail("Denied");
            const allowed = async () => {
              if (!(await store.allowed())) return false;
              for (const required of [
                "catalog.manage",
                "catalog.product.manage",
                "catalog.product.read",
                "catalog.sku.read",
                ...(categorySource === undefined ? [] : ["catalog.category.read"]),
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
            if (!(await allowed())) return fail("Denied");
            const reader = createPostgresCatalogProductListQueryStore({
              runner: { run: (work) => work(tx) },
              scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
              clock: { now: options.merchant.now },
              cursorKey,
              ...(categorySource === undefined
                ? {}
                : {
                    categorySource: {
                      ...categorySource,
                      tenantReference: scope.tenantReference,
                    },
                  }),
              authorization: {
                async withAuthorizedProductList(input, work) {
                  if (
                    input.actorReference !== scope.actorReference ||
                    input.brandReference !== scope.brandReference ||
                    input.storeReference !== scope.storeReference ||
                    input.purposeCode !== "CATALOG_PRODUCT_LIST" ||
                    input.locale !== scope.locale ||
                    !(await allowed())
                  )
                    return fail("Denied");
                  const result = await work();
                  if (!(await allowed())) return fail("Denied");
                  return result;
                },
              },
            });
            return reader.load(input);
          });
          return completedView;
        },
      );
      if (calls !== 1 || result !== completedView) return fail();
      return parseCatalogProductListView(result);
    } catch (error) {
      if (error instanceof CatalogProductListError) throw error;
      return fail();
    }
  };
}
