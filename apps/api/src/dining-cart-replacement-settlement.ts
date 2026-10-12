import type { ConsumerTransaction } from "@bop/eventing";
import {
  createDiningCartReplacementSettlementGate,
  createPostgresCheckoutAllocationHistory,
  loadCheckoutAllocationSubmittedBatch,
  loadCheckoutSessionDeadline,
  parseCheckoutSessionAllocation,
  parseOrderingInstant,
} from "@rms/ordering";
import { createCheckoutAllocationPaymentObservation } from "./checkout-allocation-payment-observation.js";

const unavailable = (): never => {
  throw new Error("CHECKOUT_REPLACEMENT_OBSERVATION_UNAVAILABLE");
};

/** Why an allocation on a timed-out table Cart does or does not hold back its replacement. */
export type CheckoutReplacementObservation =
  | {
      readonly status: "Settled";
      readonly reason: "OrderSubmitted" | "PaymentFailed" | "CheckoutExpired";
    }
  | {
      readonly status: "Pending";
      readonly reason: "PaymentInFlight" | "AwaitingOrderProcessing" | "CheckoutOpen";
    };

/**
 * WP-2423 (2026-10-11): a checkout on the previous Cart is settled for replacement once it can no
 * longer create an order or a charge from that Cart, read through owner facts only:
 * - its order batch was submitted (Ordering): acceptance/payment from then on belong to the Order;
 * - its payment reached a terminal Failed outcome (Payment);
 * - no payment intent exists and its checkout session's deadline has passed (Ordering).
 * Anything else (open checkout session, payment without terminal outcome, a successful payment
 * whose order is not processed yet) is Pending: replacement waits and the guest retries later.
 */
export function createCheckoutAllocationReplacementObservation(
  options: Parameters<typeof createCheckoutAllocationPaymentObservation>[0],
) {
  const payment = createCheckoutAllocationPaymentObservation(options);
  const settled = (reason: "OrderSubmitted" | "PaymentFailed" | "CheckoutExpired") =>
    Object.freeze({ status: "Settled" as const, reason });
  const pending = (reason: "PaymentInFlight" | "AwaitingOrderProcessing" | "CheckoutOpen") =>
    Object.freeze({ status: "Pending" as const, reason });
  return Object.freeze({
    async resolve(
      transaction: ConsumerTransaction,
      value: unknown,
    ): Promise<CheckoutReplacementObservation> {
      try {
        const allocation = parseCheckoutSessionAllocation(value),
          started = parseOrderingInstant(options.now());
        if (
          allocation.brandReference !== options.scope.brandReference ||
          allocation.storeReference !== options.scope.storeReference ||
          (await options.authorize(transaction)) !== true
        )
          return unavailable();
        const finish = async <T>(result: T) => {
          const at = parseOrderingInstant(options.now());
          if (at < started || (await options.authorize(transaction)) !== true) return unavailable();
          return result;
        };
        if (await loadCheckoutAllocationSubmittedBatch(transaction, allocation))
          return finish(settled("OrderSubmitted"));
        const observed = await payment.resolve(transaction, allocation);
        if (observed.status === "Terminal")
          return finish(
            observed.outcome === "Failed"
              ? settled("PaymentFailed")
              : // Charged before its order exists: the order is still being processed.
                pending("AwaitingOrderProcessing"),
          );
        if (observed.reason !== "IntentUnavailable") return finish(pending("PaymentInFlight"));
        const deadline = await loadCheckoutSessionDeadline(transaction, allocation);
        const at = parseOrderingInstant(options.now());
        return finish(
          deadline !== null && at >= deadline
            ? settled("CheckoutExpired")
            : pending("CheckoutOpen"),
        );
      } catch {
        return unavailable();
      }
    },
  });
}

/** Public owner ports only, borrowing the replacement writer transaction.
 * Current Host authority and completeness of all submission entry paths must be
 * established by the calling composition before this is used as its write gate.
 */
export function createDiningCartReplacementSettlement(
  options: Parameters<typeof createCheckoutAllocationReplacementObservation>[0],
) {
  const scope = Object.freeze({ ...options.scope });
  const now = options.now,
    authorize = options.authorize;
  const observer = createCheckoutAllocationReplacementObservation({ scope, now, authorize });
  return createDiningCartReplacementSettlementGate<ConsumerTransaction>({
    scope,
    now,
    authorize,
    history: async (transaction, input) =>
      createPostgresCheckoutAllocationHistory({
        scope: { brandReference: scope.brandReference, storeReference: scope.storeReference },
        authorize: () => authorize(transaction),
      }).loadForReplacement(transaction, input),
    observe: async (transaction, allocation) => {
      const observed = await observer.resolve(transaction, allocation);
      return { status: observed.status };
    },
  });
}
