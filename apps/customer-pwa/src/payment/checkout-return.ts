import { useEffect, useState } from "react";
import { createBrowserCustomerCartClient } from "../cart/cart-client.js";
import type { CartView } from "../cart/types.js";

/**
 * WP-2423 item 2: where a guest goes back to when a payment didn't start. The server places a table's
 * round and empties its cart before it asks the Provider, so after a Provider fault "your cart" is
 * empty and the dishes wait on the table page as an unpaid round, with its own pay button. Sending
 * the guest to an empty cart would have them order everything again.
 *
 * - "cart": the dishes are still in the cart.
 * - "table-saved": a table's cart is empty: the dishes are on the table page.
 * - "table": a table's cart couldn't be read; the table page is right either way.
 */
export type CheckoutReturn = "cart" | "table-saved" | "table";

export function checkoutReturnFor(
  dineIn: boolean,
  cart: CartView | null | "unread",
): CheckoutReturn {
  if (!dineIn) return "cart";
  if (cart === "unread") return "table";
  return cart !== null && cart.cart.items.length > 0 ? "cart" : "table-saved";
}

/** Reads the cart once when a failure asks where to go back to (never while nothing failed). */
export function useCheckoutReturn(
  active: boolean,
  dineIn: boolean,
  loadCart: () => Promise<CartView | null> = () => createBrowserCustomerCartClient().loadCurrent(),
): CheckoutReturn {
  const [answer, setAnswer] = useState<CheckoutReturn>(dineIn ? "table" : "cart");
  useEffect(() => {
    if (!active || !dineIn) return;
    let stopped = false;
    void loadCart().then(
      (cart) => {
        if (!stopped) setAnswer(checkoutReturnFor(true, cart));
      },
      () => {
        if (!stopped) setAnswer(checkoutReturnFor(true, "unread"));
      },
    );
    return () => {
      stopped = true;
    };
    // Once for each failure; the loader is a stable default.
  }, [active, dineIn]);
  return dineIn ? answer : "cart";
}
