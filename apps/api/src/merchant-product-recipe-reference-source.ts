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
  createPostgresRecipeReferenceSourceStore,
  RecipeWorkflowError,
  type RecipeReferenceSourceOptions,
} from "@rms/recipe";
import { composeMerchantProductRecipeReferenceMatches } from "./merchant-product-recipe-reference-matches.js";
type CurrentOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecordedOptions = Parameters<typeof createPostgresProductReferenceHistorySourceStore>[0];
/** Internal owning source composition, not an HTTP command or complete lifecycle review.
 * Bind to the caller transaction; acquire outer Catalog/Tenant/Tax/Pricing/Availability before
 * Menu/Recipe when composing them. Supplied DTOs never supply authority/lifetime. */
export function createMerchantProductRecipeReferenceSource(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly clock: { now(): string };
  readonly currentAuthority: CurrentOptions["authority"];
  readonly recordedAuthority: RecordedOptions["authority"];
  readonly recipeAuthority: RecipeReferenceSourceOptions["authority"];
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
    recipe = createPostgresRecipeReferenceSourceStore({
      ...common,
      authority: options.recipeAuthority,
    });
  const recipeRequest = {
    purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
    brandReference: request.brandReference,
    actorReference: request.actorReference,
    operationReference: request.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  };
  return Object.freeze({
    async withCurrentMatches<T>(
      work: (
        matches: ReturnType<typeof composeMerchantProductRecipeReferenceMatches>,
      ) => Promise<T>,
    ): Promise<T> {
      try {
        return await current.withCurrentSnapshot(request, (catalogCurrent) =>
          recorded.withCurrentSnapshot(request, (catalogHistory) =>
            recipe
              .withCurrentSnapshot(recipeRequest, (recipeSource) =>
                work(
                  composeMerchantProductRecipeReferenceMatches({
                    request,
                    catalogCurrent,
                    catalogHistory,
                    recipeSource,
                    now: options.clock.now(),
                  }),
                ),
              )
              .catch((error) => {
                // Translate at the owner boundary before outer Catalog holders sanitize dependencies.
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
        if (error instanceof RecipeWorkflowError && error.code === "RECIPE_PERMISSION_DENIED")
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
          throw error;
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
