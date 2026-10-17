import type { CartItemView } from "../cart/types.js";
import type { CheckoutRefusedLine } from "./session-client.js";

/** The item as the guest chose it: "Flat White (Small, Oat milk)". */
function itemName(item: CartItemView): string {
  const options = item.configuration.map((option) =>
    option.quantity === 1 ? option.displayName : `${option.displayName} × ${option.quantity}`,
  );
  return options.length === 0 ? item.displayName : `${item.displayName} (${options.join(", ")})`;
}

/** How many of the same item with the same options the cart holds (all its lines together). */
function orderedOf(item: CartItemView, items: readonly CartItemView[]): number {
  const options = (entry: CartItemView) =>
    JSON.stringify(
      entry.configuration
        .map((option) => [option.optionReference, option.quantity] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return items
    .filter(
      (other) =>
        other.sellableReference === item.sellableReference && options(other) === options(item),
    )
    .reduce((sum, other) => sum + other.quantity, 0);
}

/**
 * WP-2423: what the guest is told when the store can't make their cart as it stands. It names the
 * item and how many are left, says nothing was charged and what to change; the cart is kept.
 */
export function checkoutItemRefusalMessage(
  status: "item_short" | "item_unavailable",
  line: CheckoutRefusedLine | null,
  items: readonly CartItemView[],
): string {
  const notCharged = "You haven’t been charged.";
  const item =
    line === null
      ? undefined
      : items.find((entry) => entry.cartItemReference === line.cartItemReference);
  if (item === undefined)
    return `Some items in your cart can’t be made right now. ${notCharged} Edit your cart, then try again.`;
  const name = itemName(item);
  if (status === "item_unavailable" || line === null || line.available === null)
    return `${name} isn’t available right now. ${notCharged} Remove it from your cart, then try again.`;
  const left = line.available;
  const ordered = orderedOf(item, items);
  if (line.sharedStock)
    return left === 0
      ? `We don’t have enough left to make ${name} along with the rest of your order — some items use the same ingredients. ${notCharged} Remove ${name} or change other items, then try again.`
      : `We can make only ${left} ${name} along with the rest of your order — some items use the same ingredients. ${notCharged} Change ${name} to ${left} or change other items, then try again.`;
  return left === 0
    ? `${name} just sold out. ${notCharged} Remove it from your cart, then try again.`
    : `Only ${left} ${name} left — you have ${ordered} in your cart. ${notCharged} Change it to ${left}, then try again.`;
}
