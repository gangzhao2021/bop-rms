import {
  createPostgresOrderCompensationCandidateReader,
  parseOrderingReference,
  parseOrderingInstant,
} from "../../packages/rms/ordering/src/index.ts";
import { createPostgresCardMachinePaymentStore } from "../../packages/rms/payment/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";

/**
 * WP-2423 Q7 (DEC-COUNTER-PAYMENT-RECORD decision 4): a payment taken on the Store's own card
 * machine is refunded on that machine and recorded by staff; it never becomes a Provider refund.
 * The page cursor is kept, so discovery moves past such candidates.
 */
export async function withoutCardMachinePayments(transaction, scope, page, authorize) {
  const cards = createPostgresCardMachinePaymentStore({
    scope,
    authorize: async () => authorize(),
  });
  const kept = [];
  for (const candidate of page.candidates)
    if ((await cards.loadByIntent(transaction, candidate.paymentIntentReference)) === null)
      kept.push(candidate);
  return Object.freeze({ ...page, candidates: Object.freeze(kept) });
}
/** Read-only owner discovery; candidate presence never authorizes or executes a refund. */
/**
 * WP-2423 Q6: the refund workload also discovers staff cancellations of paid batches
 * (`includeStaffCancellations`); the stock release workload does not — their stock was already
 * returned in the cancellation transaction.
 */
export function createInternalCompensationCandidates(
  resources,
  { includeStaffCancellations = false, excludeCardMachinePayments = false } = {},
) {
  const unavailable = () => {
    throw new Error("INTERNAL_COMPENSATION_DISCOVERY_UNAVAILABLE");
  };
  if (!isPilotRuntime()) return unavailable();
  const binding = resources.publicProfile.binding;
  const scope = {
    brandReference: String(parseOrderingReference(resources.scope.brandReference)),
    storeReference: String(parseOrderingReference(resources.scope.storeReference)),
  };
  if (
    binding.brandReference !== scope.brandReference ||
    binding.storeReference !== scope.storeReference
  )
    return unavailable();
  const validUntil = parseOrderingInstant(binding.validUntil);
  const active = () => isPilotRuntime() && parseOrderingInstant(resources.now()) < validUntil;
  const reader = createPostgresOrderCompensationCandidateReader({
    scope,
    includeStaffCancellations: includeStaffCancellations === true,
    authorize: async (_tx, input) =>
      active() &&
      input.brandReference === scope.brandReference &&
      input.storeReference === scope.storeReference &&
      input.purpose === "DiscoverPaidWithoutFulfillableOrder",
  });
  return Object.freeze({
    async discover(input) {
      if (!active()) return unavailable();
      return resources.transactions.run(async (tx) => {
        const page = await reader(tx, input);
        // The refund workload only; stock of such an Order is still released by its own workload.
        return excludeCardMachinePayments
          ? withoutCardMachinePayments(tx, scope, page, active)
          : page;
      });
    },
  });
}
