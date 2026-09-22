import type { ConsumerTransaction } from "@bop/eventing";
import {
  createDiningCartReplacementSettlementGate,
  createPostgresCheckoutAllocationHistory,
} from "@rms/ordering";
import { createCheckoutAllocationOrderObservation } from "./checkout-allocation-order-observation.js";

/** Public owner ports only, borrowing the replacement writer transaction.
 * Current Host authority and completeness of all submission entry paths must be
 * established by the calling composition before this is used as its write gate.
 */
export function createDiningCartReplacementSettlement(
  options: Parameters<typeof createCheckoutAllocationOrderObservation>[0],
) {
  const scope = Object.freeze({ ...options.scope });
  const now = options.now,
    authorize = options.authorize;
  const observer = createCheckoutAllocationOrderObservation({ scope, now, authorize });
  return createDiningCartReplacementSettlementGate<ConsumerTransaction>({
    scope,
    now,
    authorize,
    history: async (transaction, input) =>
      createPostgresCheckoutAllocationHistory({
        scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
        authorize: () => authorize(transaction),
      }).loadForReplacement(transaction, input),
    observe: (transaction, allocation) => observer.resolve(transaction, allocation),
  });
}
