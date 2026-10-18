import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  createPostgresProductPricingBindingSourceStore,
  createPostgresProductReferenceHistorySourceStore,
  createPostgresAvailabilityReferenceSourceStore,
  matchProductAvailabilityReferences,
  type ProductLifecycleTransaction,
  type ProductLifecycleReviewRequest,
  type AvailabilityReferenceSourceOptions,
} from "@rms/catalog";
type CurrentOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecordedOptions = Parameters<typeof createPostgresProductReferenceHistorySourceStore>[0];
/** Internal owning source composition, not an HTTP command or complete lifecycle review.
 * Bind to the caller transaction; acquire outer Catalog/Tenant/Tax/Pricing before
 * Availability when composing them. Supplied DTOs never supply authority/lifetime. */
export function createMerchantProductAvailabilityReferenceSource(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly clock: { now(): string };
  readonly currentAuthority: CurrentOptions["authority"];
  readonly recordedAuthority: RecordedOptions["authority"];
  readonly availabilityAuthority: AvailabilityReferenceSourceOptions["authority"];
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
    availability = createPostgresAvailabilityReferenceSourceStore({
      ...common,
      authority: options.availabilityAuthority,
    });
  const availabilityRequest = {
    purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ" as const,
    brandReference: request.brandReference,
    actorReference: request.actorReference,
    operationReference: request.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  };
  return Object.freeze({
    async withCurrentMatches<T>(
      work: (matches: ReturnType<typeof matchProductAvailabilityReferences>) => Promise<T>,
    ): Promise<T> {
      try {
        return await current.withCurrentSnapshot(request, (catalogCurrent) =>
          recorded.withCurrentSnapshot(request, (catalogHistory) =>
            availability.withCurrentSnapshot(availabilityRequest, (availabilitySource) =>
              work(
                matchProductAvailabilityReferences({
                  request,
                  catalogCurrent,
                  catalogHistory,
                  availabilitySource,
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
