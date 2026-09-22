import {
  CartError,
  parseCartAggregate,
  parseOrderingInstant,
  parseOrderingReference,
} from "../domain/cart.js";
import {
  parseCheckoutSessionAllocation,
  type CheckoutSessionAllocation,
} from "../domain/checkout-session-allocation.js";

/** Allocated checkout clearance only. The caller must retain Cart/current Dining
 * fences and establish that all possible submissions use this allocation history.
 * Does not close a Dining session, release resources or authorize replacement.
 */
export function createDiningCartReplacementSettlementGate<Transaction>(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  now(): string;
  authorize(transaction: Transaction): Promise<boolean>;
  history(
    transaction: Transaction,
    input: {
      readonly cartReference: string;
      readonly expectedCartVersion: number;
      readonly observedAt: string;
    },
  ): Promise<readonly CheckoutSessionAllocation[]>;
  observe(
    transaction: Transaction,
    allocation: CheckoutSessionAllocation,
  ): Promise<{ readonly status: "Confirmed" | "Unresolved" }>;
}) {
  const scope = Object.freeze({
    brandReference: parseOrderingReference(options.scope.brandReference),
    storeReference: parseOrderingReference(options.scope.storeReference),
  });
  const { now, authorize, history, observe } = options;
  return Object.freeze({
    async clear(transaction: Transaction, value: unknown, observedAt: string): Promise<boolean> {
      try {
        const cart = parseCartAggregate(value);
        let previous = parseOrderingInstant(observedAt);
        const tick = () => {
          const at = parseOrderingInstant(now());
          if (at < previous) throw new Error("clock");
          previous = at;
          return at;
        };
        const at = tick();
        if (
          cart.brandReference !== scope.brandReference ||
          cart.storeReference !== scope.storeReference ||
          cart.orderType !== "DineIn" ||
          !["Qr", "Web"].includes(cart.sourceChannel) ||
          cart.lifecycle === null ||
          cart.lifecycle.status === "Active" ||
          cart.lifecycle.terminalAt === null ||
          cart.lifecycle.terminalAt > at ||
          cart.updatedAt > at ||
          (await authorize(transaction)) !== true
        )
          return false;
        const allocations = await history(transaction, {
          cartReference: cart.cartReference,
          expectedCartVersion: cart.aggregateVersion,
          observedAt: tick(),
        });
        if (!Array.isArray(allocations) || allocations.length > 1000) return false;
        const operations = new Set<string>();
        for (const value of allocations) {
          const allocation = parseCheckoutSessionAllocation(value);
          if (
            allocation.brandReference !== scope.brandReference ||
            allocation.storeReference !== scope.storeReference ||
            allocation.cartReference !== cart.cartReference ||
            allocation.cartVersion > cart.aggregateVersion ||
            allocation.allocatedAt > tick() ||
            operations.has(allocation.createOperationReference)
          )
            return false;
          operations.add(allocation.createOperationReference);
          if ((await observe(transaction, allocation)).status !== "Confirmed") return false;
        }
        if ((await authorize(transaction)) !== true) return false;
        tick();
        return true;
      } catch {
        throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
