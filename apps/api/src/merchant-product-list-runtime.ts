import { readClosedRecord } from "@bop/identity";
import {
  CatalogError,
  CatalogProductListError,
  copyCategoryPersistenceValue,
  parseCatalogInstant,
} from "@rms/catalog";
import { createMerchantBrandScope } from "./merchant-brand-scope.js";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createMerchantProductCurrentAuthorization } from "./merchant-product-current-authorization.js";
import {
  createMerchantProductListQuery,
  merchantProductListCategoryRequiredFields,
  merchantProductListRequiredFields,
} from "./merchant-product-list-query.js";
import { createMerchantProductStoreCapabilityGuard } from "./merchant-product-store-capability.js";
import { MerchantProductWriteFeatureDisabled } from "./merchant-product-write-authority.js";
import { createMerchantStoreScope } from "./merchant-store-scope.js";

type ListOptions = Parameters<typeof createMerchantProductListQuery>[0];
export type MerchantProductListRuntimeOptions = Omit<ListOptions, "authority">;
const fail = (code: CatalogProductListError["code"] = "Unavailable"): never => {
  throw new CatalogProductListError(code);
};
const bounded = (error: unknown): never => {
  if (error instanceof CatalogProductListError) throw error;
  if (error instanceof MerchantProductWriteFeatureDisabled) return fail("FeatureDisabled");
  if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
    return fail("Denied");
  return fail();
};

/** Fixed list composition. Session, current Brand IAM, FeatureControl, and the
 * Catalog query borrow one transaction, including the final authority checks. */
export function createMerchantProductListRuntime(options: MerchantProductListRuntimeOptions) {
  const source = options.merchant,
    merchant = Object.freeze({
      ...source,
      now: source.now.bind(source),
      currentActor: source.currentActor.bind(source),
      validateAssociation: source.validateAssociation.bind(source),
      transactions: Object.freeze({ run: source.transactions.run.bind(source.transactions) }),
    }),
    host = createMerchantCategoryTransactions(merchant.transactions),
    resolveStore = createMerchantStoreScope(merchant),
    resolveBrand = createMerchantBrandScope(merchant),
    cursorKey = options.cursorKey instanceof Uint8Array ? new Uint8Array(options.cursorKey) : null,
    categorySource = options.categorySource;
  if (!cursorKey || cursorKey.length < 32 || cursorKey.length > 64) return fail();

  return async (raw: { readonly sessionCookie: unknown; readonly filters: unknown }) => {
    try {
      const request = readClosedRecord(raw, ["sessionCookie", "filters"]),
        sessionCookie = request.sessionCookie,
        filters = copyCategoryPersistenceValue(request.filters),
        observedAt = parseCatalogInstant(merchant.now()),
        validUntil = new Date(Date.parse(observedAt) + 5000).toISOString();
      return await host.transactions.run(async (tx) => {
        const query = tx.query;
        let failed = false,
          ready = false,
          latest: string = observedAt;
        let current: (() => Promise<void>) | undefined;
        let assertAuthorization: (() => void) | undefined;
        const check = () => {
          try {
            const at = parseCatalogInstant(merchant.now());
            if (failed || tx.query !== query || at < latest || at >= validUntil) return fail();
            assertAuthorization?.();
            latest = at;
          } catch (error) {
            failed = true;
            throw error;
          }
        };
        await host.registerBeforeCommit(
          tx,
          async () => {
            check();
            if (!ready || !current) return fail();
            await current();
            check();
          },
          check,
        );
        try {
          check();
          const store = await resolveStore(tx, sessionCookie, "merchant.access"),
            scope = await resolveBrand(tx, sessionCookie, store.sessionReference);
          check();
          if (
            store.selected.tenantReference !== scope.tenantReference ||
            store.context.brand.brandReference !== scope.context.brand.brandReference ||
            String(store.store.storeReference) !== String(scope.selectedStoreReference) ||
            store.actorReference !== scope.actorReference ||
            !(await store.allowed())
          )
            return fail("Denied");
          const authorization = createMerchantProductCurrentAuthorization({
            merchant,
            transaction: tx,
            scope,
            sessionCookie,
            sessionReference: store.sessionReference,
            clock: { now: merchant.now },
            originalValidUntil: validUntil,
            capabilityKey: "catalog.cat_product_list",
          });
          assertAuthorization = authorization.assertCurrent;
          const capability = createMerchantProductStoreCapabilityGuard({
            transaction: tx,
            tenantReference: scope.tenantReference,
            brandReference: scope.context.brand.brandReference,
            storeReference: store.store.storeReference,
            actorReference: scope.actorReference,
            clock: { now: merchant.now },
            originalValidUntil: validUntil,
            registerBeforeCommit: host.registerBeforeCommit,
            currentAuthorization: authorization,
            capabilityKey: "catalog.cat_product_list",
          });
          let categoryFields = categorySource !== undefined;
          current = async () => {
            try {
              check();
              await authorization.authorizeActions([
                "catalog.manage",
                "catalog.product.manage",
                "catalog.product.read",
                "catalog.sku.read",
                ...(categoryFields ? ["catalog.category.read"] : []),
              ]);
              await capability.holdUntilCommit();
              check();
            } catch (error) {
              failed = true;
              return bounded(error);
            }
          };
          const borrowedTransactions: ListOptions["merchant"]["transactions"] = {
            run: (work) => work(tx),
          };
          const load = createMerchantProductListQuery({
            merchant: Object.freeze({ ...merchant, transactions: borrowedTransactions }),
            cursorKey,
            ...(categorySource === undefined ? {} : { categorySource }),
            authority: {
              async withCurrentProductList(input, work) {
                const packet = readClosedRecord(input, [
                  "sessionCookie",
                  "screenId",
                  "permission",
                  "action",
                  "capability",
                  "purposeCode",
                  "requiredFields",
                ]);
                const fields = copyCategoryPersistenceValue(packet.requiredFields);
                const sameFields = (expected: readonly string[]) =>
                  Array.isArray(fields) &&
                  fields.length === expected.length &&
                  fields.every((value, i) => value === expected[i]);
                if (
                  packet.sessionCookie !== sessionCookie ||
                  packet.screenId !== "CAT-PRODUCT-LIST" ||
                  packet.permission !== "catalog.manage" ||
                  packet.action !== "catalog.product.manage" ||
                  packet.capability !== "catalog.cat_product_list" ||
                  packet.purposeCode !== "CATALOG_PRODUCT_LIST" ||
                  (!sameFields(merchantProductListRequiredFields) &&
                    !sameFields(merchantProductListCategoryRequiredFields))
                )
                  return fail();
                categoryFields = sameFields(merchantProductListCategoryRequiredFields);
                if (!current) return fail();
                await current();
                const result = await work(
                  Object.freeze({
                    tenantReference: scope.tenantReference,
                    brandReference: String(scope.context.brand.brandReference),
                    storeReference: String(store.store.storeReference),
                    actorReference: String(scope.actorReference),
                    sessionReference: String(store.sessionReference),
                    locale: store.store.locale,
                  }),
                );
                await current();
                return result;
              },
            },
          });
          const result = await load({ sessionCookie, filters });
          check();
          ready = true;
          return result;
        } catch (error) {
          failed = true;
          throw error;
        }
      });
    } catch (error) {
      return bounded(error);
    }
  };
}
