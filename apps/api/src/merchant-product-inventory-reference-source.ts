import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  createPostgresProductPricingBindingSourceStore,
  createPostgresProductReferenceHistorySourceStore,
  type ProductLifecycleTransaction,
  type ProductLifecycleReviewRequest,
} from "@rms/catalog";
import {
  InventoryItemError,
  createPostgresInventorySkuMappingReferenceSourceStore,
  type InventorySkuMappingReferenceSourceOptions,
} from "@rms/inventory";
import { composeMerchantProductInventoryReferenceMatches } from "./merchant-product-inventory-reference-matches.js";
type CurrentOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecordedOptions = Parameters<typeof createPostgresProductReferenceHistorySourceStore>[0];
/** Internal reference composition bound to the caller's physical RC transaction.
 * Acquires Catalog before Inventory; supplied DTOs never supply current authority.
 * Complete lifecycle assembly must acquire earlier source fences before calling it. */
export function createMerchantProductInventoryReferenceSource(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly clock: { now(): string };
  readonly currentAuthority: CurrentOptions["authority"];
  readonly recordedAuthority: RecordedOptions["authority"];
  readonly inventoryAuthority: InventorySkuMappingReferenceSourceOptions["authority"];
}) {
  const request = parseProductLifecycleReviewRequest(options.request),
    common = {
      tenantReference: options.tenantReference,
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      clock: options.clock,
      transactions: {
        run: <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) =>
          work(options.transaction),
      },
    };
  const current = createPostgresProductPricingBindingSourceStore({
      ...common,
      authority: options.currentAuthority,
    }),
    recorded = createPostgresProductReferenceHistorySourceStore({
      ...common,
      authority: options.recordedAuthority,
    }),
    inventory = createPostgresInventorySkuMappingReferenceSourceStore({
      ...common,
      authority: options.inventoryAuthority,
    });
  const inventoryRequest = {
    purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
    tenantReference: options.tenantReference,
    brandReference: request.brandReference,
    actorReference: request.actorReference,
    operationReference: request.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  };
  return Object.freeze({
    async withCurrentMatches<T>(
      work: (
        matches: ReturnType<typeof composeMerchantProductInventoryReferenceMatches>,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        return await current.withCurrentSnapshot(request, (catalogCurrent) =>
          recorded.withCurrentSnapshot(request, (catalogHistory) =>
            inventory
              .withCurrentSnapshot(inventoryRequest, (inventorySource) =>
                work(
                  composeMerchantProductInventoryReferenceMatches({
                    tenantReference: options.tenantReference,
                    request,
                    catalogCurrent,
                    catalogHistory,
                    inventorySource,
                    now: options.clock.now(),
                  }),
                ),
              )
              .catch((error) => {
                if (
                  error instanceof InventoryItemError &&
                  error.code === "INVENTORY_ITEM_PERMISSION_DENIED"
                )
                  throw new CatalogError("CATALOG_PERMISSION_DENIED");
                throw error;
              }),
          ),
        );
      } catch (error) {
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
