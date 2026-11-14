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
/**
 * Pages owner discovery while leaving out card-machine payments, and keeps the workload's page
 * contract: a non-null cursor only follows a full page and equals its last candidate. Filtering a
 * single owner page could return fewer candidates with a cursor, which the refund workload
 * rejects as invalid discovery (WP-2423 worker recovery, 2026-10-15). Every owner read advances,
 * so the loop ends; an excluded tail ends the round with a null cursor.
 */
export async function discoverWithoutCardMachinePayments(input, { read, isCardMachinePayment }) {
  const limit = input.limit;
  const kept = [];
  let after = input.afterDispositionReference;
  for (;;) {
    const page = await read({ afterDispositionReference: after, limit: limit - kept.length });
    for (const candidate of page.candidates)
      if (!(await isCardMachinePayment(candidate))) kept.push(candidate);
    if (page.nextAfterDispositionReference === null)
      return Object.freeze({
        candidates: Object.freeze(kept),
        nextAfterDispositionReference: null,
      });
    if (kept.length === limit)
      return Object.freeze({
        candidates: Object.freeze(kept),
        nextAfterDispositionReference: kept[kept.length - 1].dispositionReference,
      });
    if (after !== null && page.nextAfterDispositionReference <= after)
      throw new Error("INTERNAL_COMPENSATION_DISCOVERY_UNAVAILABLE");
    after = page.nextAfterDispositionReference;
  }
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
        if (!excludeCardMachinePayments) return reader(tx, input);
        // The refund workload only; stock of such an Order is still released by its own workload.
        const cards = createPostgresCardMachinePaymentStore({
          scope,
          authorize: async () => active(),
        });
        return discoverWithoutCardMachinePayments(input, {
          read: (page) => reader(tx, page),
          isCardMachinePayment: async (candidate) =>
            (await cards.loadByIntent(tx, candidate.paymentIntentReference)) !== null,
        });
      });
    },
  });
}
