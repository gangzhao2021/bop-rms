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
  createPostgresConfigurationReferenceSourceStore,
  type ConfigurationReferenceSourceOptions,
} from "@rms/pricing";
import { composeMerchantProductPricingReferenceSourceMatches } from "./merchant-product-pricing-reference-matches.js";
type CurrentOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecordedOptions = Parameters<typeof createPostgresProductReferenceHistorySourceStore>[0];
export type MerchantProductPricingReferenceMatches = ReturnType<
  typeof composeMerchantProductPricingReferenceSourceMatches
>;
/** Internal read composition on a supplied caller UoW. Acquire outer Catalog/Tenant/Tax
 * holders before this read. Callback work is reference review, not lifecycle approval;
 * missing current owner authority fails closed and no normal command is enabled. */
export function createMerchantProductPricingReferenceSource(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly clock: { now(): string };
  readonly currentAuthority: CurrentOptions["authority"];
  readonly recordedAuthority: RecordedOptions["authority"];
  readonly pricing: Omit<
    ConfigurationReferenceSourceOptions,
    "tenantReference" | "brandReference" | "actorReference" | "transactions" | "clock"
  >;
}) {
  const request = parseProductLifecycleReviewRequest(options.request),
    transactions = {
      run: <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => work(options.transaction),
    },
    common = {
      tenantReference: options.tenantReference,
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      clock: options.clock,
      transactions,
    },
    current = createPostgresProductPricingBindingSourceStore({
      ...common,
      authority: options.currentAuthority,
    }),
    recorded = createPostgresProductReferenceHistorySourceStore({
      ...common,
      authority: options.recordedAuthority,
    }),
    pricing = createPostgresConfigurationReferenceSourceStore({ ...options.pricing, ...common }),
    pricingRequest = {
      purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
      brandReference: request.brandReference,
      actorReference: request.actorReference,
      operationReference: request.operationReference,
      catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
    };
  return Object.freeze({
    async withCurrentMatches<T>(
      work: (matches: MerchantProductPricingReferenceMatches) => Promise<T>,
    ): Promise<T> {
      try {
        return await current.withCurrentSnapshot(request, (catalogCurrent) =>
          recorded.withCurrentSnapshot(request, (catalogHistory) =>
            pricing.withCurrentSnapshot(pricingRequest, (source) =>
              work(
                composeMerchantProductPricingReferenceSourceMatches({
                  request,
                  catalogCurrent,
                  catalogHistory,
                  pricingSource: source,
                  now: options.clock.now(),
                }),
              ),
            ),
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
