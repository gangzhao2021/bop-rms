import { createPostgresCatalogOrderSnapshotSource } from "@rms/catalog";
import {
  createPostgresPriceQuoteHistoryReader,
  createPostgresConfiguredPriceQuoteHistoryReader,
} from "@rms/pricing";
import {
  createOrderPricingSource,
  createConfiguredOrderPricingSource,
  createConfiguredOrderSubmissionSource,
  createOrderSubmissionSource,
  createPostgresCartQueryStore,
} from "@rms/ordering";

/** Request-authorized composition; the outer Order service owns Guest and final commit fences. */
export interface CustomerOrderSourceOptions {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly cartTransactions: Parameters<typeof createPostgresCartQueryStore>[0];
  readonly catalogTransactions: Parameters<typeof createPostgresCatalogOrderSnapshotSource>[0];
  readonly pricingTransactions: Parameters<typeof createPostgresPriceQuoteHistoryReader>[0];
  readonly catalogScope: Omit<
    Parameters<typeof createPostgresCatalogOrderSnapshotSource>[1],
    "brandReference" | "storeReference"
  >;
  readonly catalogSafety: Omit<
    Parameters<typeof createPostgresCatalogOrderSnapshotSource>[2],
    "clock"
  >;
  readonly catalogReferences: Parameters<typeof createPostgresCatalogOrderSnapshotSource>[3];
  readonly clock: Readonly<{ now(): string }>;
}
function createVersionedCustomerOrderSourceComposition(
  options: CustomerOrderSourceOptions,
  quoteVersion: 1 | 2,
) {
  const scope = Object.freeze({ ...options.scope });
  return (quoteVersion === 2 ? createConfiguredOrderSubmissionSource : createOrderSubmissionSource)(
    {
      scope,
      clock: options.clock,
      carts: createPostgresCartQueryStore(options.cartTransactions, scope),
      pricing:
        quoteVersion === 2
          ? createConfiguredOrderPricingSource({
              scope,
              clock: options.clock,
              history: createPostgresConfiguredPriceQuoteHistoryReader(
                options.pricingTransactions,
                scope,
              ),
            })
          : createOrderPricingSource({
              scope,
              clock: options.clock,
              history: createPostgresPriceQuoteHistoryReader(options.pricingTransactions, scope),
            }),
      catalog: createPostgresCatalogOrderSnapshotSource(
        options.catalogTransactions,
        { ...options.catalogScope, ...scope },
        { ...options.catalogSafety, clock: options.clock },
        options.catalogReferences,
      ),
    },
  );
}

export function createCustomerOrderSourceComposition(
  options: CustomerOrderSourceOptions,
): ReturnType<typeof createOrderSubmissionSource> {
  return createVersionedCustomerOrderSourceComposition(options, 1) as ReturnType<
    typeof createOrderSubmissionSource
  >;
}
export function createCustomerConfiguredOrderSourceComposition(
  options: CustomerOrderSourceOptions,
): ReturnType<typeof createConfiguredOrderSubmissionSource> {
  return createVersionedCustomerOrderSourceComposition(options, 2) as ReturnType<
    typeof createConfiguredOrderSubmissionSource
  >;
}
