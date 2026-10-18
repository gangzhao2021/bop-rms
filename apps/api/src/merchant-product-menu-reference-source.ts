import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductLifecycleReviewRequest,
  createPostgresProductPricingBindingSourceStore,
  createPostgresProductReferenceHistorySourceStore,
  createPostgresMenuReferenceSourceStore,
  matchProductMenuReferences,
  type ProductLifecycleTransaction,
  type ProductLifecycleReviewRequest,
  type MenuReferenceSourceOptions,
} from "@rms/catalog";
type CurrentOptions = Parameters<typeof createPostgresProductPricingBindingSourceStore>[0];
type RecordedOptions = Parameters<typeof createPostgresProductReferenceHistorySourceStore>[0];
/** Internal owning source composition, not an HTTP command or complete lifecycle review.
 * Bind to the caller transaction; acquire outer Catalog/Tenant/Tax/Pricing/Availability/Bundle before
 * Menu when composing them. Never write Menu or acquire per-Menu publication writer locks
 * in this consumer. Supplied DTOs never supply authority/lifetime. */
export function createMerchantProductMenuReferenceSource(options: {
  readonly transaction: ProductLifecycleTransaction;
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly clock: { now(): string };
  readonly currentAuthority: CurrentOptions["authority"];
  readonly recordedAuthority: RecordedOptions["authority"];
  readonly menuAuthority: MenuReferenceSourceOptions["authority"];
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
    menu = createPostgresMenuReferenceSourceStore({
      ...common,
      authority: options.menuAuthority,
    });
  const menuRequest = {
    purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ" as const,
    brandReference: request.brandReference,
    actorReference: request.actorReference,
    operationReference: request.operationReference,
    catalogIntentDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(request)),
  };
  return Object.freeze({
    async withCurrentMatches<T>(
      work: (matches: ReturnType<typeof matchProductMenuReferences>) => Promise<T>,
    ): Promise<T> {
      try {
        return await current.withCurrentSnapshot(request, (catalogCurrent) =>
          recorded.withCurrentSnapshot(request, (catalogHistory) =>
            menu.withCurrentSnapshot(menuRequest, (menuSource) =>
              work(
                matchProductMenuReferences({
                  request,
                  catalogCurrent,
                  catalogHistory,
                  menuSource,
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
