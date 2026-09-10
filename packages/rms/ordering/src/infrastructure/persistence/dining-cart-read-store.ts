import { readClosedRecord } from "@bop/identity";
import type { DiningCartReadPorts } from "../../application/dining-cart-read-service.js";
import { CartError, parseOrderingInstant, parseOrderingReference } from "../../domain/cart.js";
import {
  createPostgresCartQueryStore,
  type CartQueryTransactionRunner,
} from "./cart-query-store.js";

const selectCurrent = `SELECT cart_id AS "cartReference", aggregate_version AS "aggregateVersion"
FROM rms_ordering.cart
WHERE brand_id = $1 AND store_id = $2 AND dining_session_id = $3
  AND order_type = 'DineIn' AND source_channel IN ('Qr', 'Web')
  AND lifecycle_status = 'Active'
  AND idle_expires_at > $4::timestamptz AND absolute_expires_at > $4::timestamptz
ORDER BY cart_id LIMIT 2`;
function unavailable(): never {
  throw new CartError("CART_DEPENDENCY_UNAVAILABLE");
}
function header(result: unknown) {
  if (result === null || typeof result !== "object") return unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    descriptor.value.length > 1
  )
    return unavailable();
  if (descriptor.value.length === 0) return null;
  const raw = readClosedRecord(descriptor.value[0], ["cartReference", "aggregateVersion"]);
  const cartReference = parseOrderingReference(raw.cartReference);
  if (
    typeof raw.aggregateVersion !== "number" ||
    !Number.isSafeInteger(raw.aggregateVersion) ||
    raw.aggregateVersion < 1
  )
    return unavailable();
  return Object.freeze({ cartReference, aggregateVersion: raw.aggregateVersion });
}
/** Infrastructure-only current observation; callers must use current Identity/Dining authorization. */
export function createPostgresDiningCartReadStore(
  runner: CartQueryTransactionRunner,
  scope: { readonly brandReference: string; readonly storeReference: string },
): DiningCartReadPorts["carts"] {
  let brand: string;
  let store: string;
  try {
    const captured = readClosedRecord(scope, ["brandReference", "storeReference"]);
    brand = parseOrderingReference(captured.brandReference);
    store = parseOrderingReference(captured.storeReference);
  } catch {
    throw new CartError("CART_INPUT_INVALID");
  }
  return Object.freeze({
    async current(value: Parameters<DiningCartReadPorts["carts"]["current"]>[0]) {
      let diningSessionReference: string;
      let observedAt: string;
      try {
        const input = readClosedRecord(value, [
          "brandReference",
          "storeReference",
          "diningSessionReference",
          "observedAt",
        ]);
        if (
          parseOrderingReference(input.brandReference) !== brand ||
          parseOrderingReference(input.storeReference) !== store
        )
          throw new Error("scope");
        diningSessionReference = parseOrderingReference(input.diningSessionReference);
        observedAt = parseOrderingInstant(input.observedAt);
      } catch {
        throw new CartError("CART_INPUT_INVALID");
      }
      try {
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, store],
          );
          const parameters = Object.freeze([brand, store, diningSessionReference, observedAt]);
          const first = header(await transaction.query(selectCurrent, parameters));
          if (first === null) return null;
          const reader = createPostgresCartQueryStore(
            { run: async (action) => action(transaction) },
            { brandReference: brand, storeReference: store },
          );
          const cart = await reader.load(first.cartReference);
          if (
            cart === null ||
            cart.aggregateVersion !== first.aggregateVersion ||
            cart.orderType !== "DineIn" ||
            cart.diningSessionReference !== diningSessionReference ||
            !["Qr", "Web"].includes(cart.sourceChannel) ||
            cart.updatedAt > observedAt ||
            cart.lifecycle?.status !== "Active" ||
            cart.lifecycle.idleExpiresAt <= observedAt ||
            cart.lifecycle.absoluteExpiresAt <= observedAt
          )
            return unavailable();
          const last = header(await transaction.query(selectCurrent, parameters));
          if (
            last === null ||
            last.cartReference !== first.cartReference ||
            last.aggregateVersion !== first.aggregateVersion
          )
            return unavailable();
          return cart;
        });
      } catch {
        return unavailable();
      }
    },
  });
}
