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
  RecipeWorkflowError,
  createPostgresRecipeReferenceSourceStore,
  createPostgresRecipeInventoryReferenceSourceStore,
  type RecipeReferenceSourceOptions,
  type RecipeInventoryReferenceOptions,
} from "@rms/recipe";
import {
  InventoryItemError,
  createPostgresInventorySkuMappingReferenceSourceStore,
  type InventorySkuMappingReferenceSourceOptions,
} from "@rms/inventory";
import { composeMerchantProductRecipeInventoryReferenceMatches } from "./merchant-product-recipe-inventory-reference-matches.js";
type CurrentOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecordedOptions = Parameters<typeof createPostgresProductReferenceHistorySourceStore>[0];
/** Internal composition in the caller physical RC UoW: Catalog, Recipe, Inventory.
 * Earlier lifecycle source fences must already be held by the full assembly.
 * Callback cannot mutate these sources or acquire earlier owning writer locks. */
export function createMerchantProductRecipeInventoryReferenceSource(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly clock: { now(): string };
  readonly currentAuthority: CurrentOptions["authority"];
  readonly recordedAuthority: RecordedOptions["authority"];
  readonly recipeAuthority: RecipeReferenceSourceOptions["authority"];
  readonly recipeInventoryAuthority: RecipeInventoryReferenceOptions["authority"];
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
    },
    requestCommon = {
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      operationReference: request.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
    };
  const current = createPostgresProductPricingBindingSourceStore({
      ...common,
      authority: options.currentAuthority,
    }),
    recorded = createPostgresProductReferenceHistorySourceStore({
      ...common,
      authority: options.recordedAuthority,
    }),
    recipe = createPostgresRecipeReferenceSourceStore({
      ...common,
      authority: options.recipeAuthority,
    }),
    recipeInventory = createPostgresRecipeInventoryReferenceSourceStore({
      ...common,
      authority: options.recipeInventoryAuthority,
    }),
    inventory = createPostgresInventorySkuMappingReferenceSourceStore({
      ...common,
      authority: options.inventoryAuthority,
    });
  return Object.freeze({
    async withCurrentMatches<T>(
      work: (
        matches: ReturnType<typeof composeMerchantProductRecipeInventoryReferenceMatches>,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        return await current.withCurrentSnapshot(request, (catalogCurrent) =>
          recorded.withCurrentSnapshot(request, (catalogHistory) =>
            recipe
              .withCurrentSnapshot(
                { purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ", ...requestCommon },
                (recipeSource) =>
                  recipeInventory.withCurrentSnapshot(
                    {
                      purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ",
                      ...requestCommon,
                    },
                    (recipeInventorySource) =>
                      inventory
                        .withCurrentSnapshot(
                          {
                            purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
                            tenantReference: options.tenantReference,
                            ...requestCommon,
                          },
                          (inventorySource) =>
                            work(
                              composeMerchantProductRecipeInventoryReferenceMatches({
                                tenantReference: options.tenantReference,
                                request,
                                catalogCurrent,
                                catalogHistory,
                                recipeSource,
                                recipeInventorySource,
                                inventorySource,
                                now: options.clock.now(),
                              }),
                            ),
                        )
                        .catch((error) => {
                          // Translate before Recipe sanitizes errors from its foreign callback.
                          if (
                            error instanceof InventoryItemError &&
                            error.code === "INVENTORY_ITEM_PERMISSION_DENIED"
                          )
                            throw new RecipeWorkflowError("RECIPE_PERMISSION_DENIED");
                          throw error;
                        }),
                  ),
              )
              .catch((error) => {
                // Translate before Catalog sanitizes the owning Recipe boundary.
                if (
                  error instanceof RecipeWorkflowError &&
                  error.code === "RECIPE_PERMISSION_DENIED"
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
