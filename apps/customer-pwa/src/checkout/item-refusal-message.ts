import type { CartItemView } from "../cart/types.js";
import type { CheckoutRefusedLine } from "./session-client.js";

/** The item as the guest chose it: "Flat White (Small, Oat milk)". */
function itemName(item: CartItemView): string {
  const options = item.configuration.map((option) =>
    option.quantity === 1 ? option.displayName : `${option.displayName} × ${option.quantity}`,
  );
  return options.length === 0 ? item.displayName : `${item.displayName} (${options.join(", ")})`;
}

/** The cart's lines of the same item with the same options (the line itself included). */
function linesOf(item: CartItemView, items: readonly CartItemView[]): CartItemView[] {
  const options = (entry: CartItemView) =>
    JSON.stringify(
      entry.configuration
        .map((option) => [option.optionReference, option.quantity] as const)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
    );
  return items.filter(
    (other) =>
      other.sellableReference === item.sellableReference && options(other) === options(item),
  );
}

/**
 * What to do with the cart controls to bring an item down to `left` (every line together): each
 * line has "−" (down to 1) and "Remove", so one line is changed to `left`, and several lines are
 * told how many to take out.
 */
function lowerTo(name: string, lines: readonly CartItemView[], left: number): string {
  const ordered = lines.reduce((sum, line) => sum + line.quantity, 0);
  if (left === 0) return lines.length === 1 ? `Remove ${name}` : `Remove every ${name}`;
  if (lines.length === 1) return `Change ${name} to ${left}`;
  const extra = ordered - left;
  return extra === 1 ? `Remove one ${name}` : `Remove ${extra} of your ${ordered} ${name}`;
}

/**
 * WP-2423: what the guest is told when the store can't make their cart as it stands. It names the
 * item and how many are left, says nothing was charged and what to change with the cart's own
 * controls; the cart is kept.
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
  const lines = linesOf(item, items);
  if (status === "item_unavailable" || line === null || line.available === null)
    return `${name} isn’t available right now. ${notCharged} ${lowerTo(name, lines, 0)} from your cart, then try again.`;
  const left = line.available;
  const ordered = lines.reduce((sum, entry) => sum + entry.quantity, 0);
  if (line.sharedStock)
    return left === 0
      ? `We don’t have enough left to make ${name} along with the rest of your order — some items use the same ingredients. ${notCharged} ${lowerTo(name, lines, 0)} or change other items, then try again.`
      : `We can make only ${left} ${name} along with the rest of your order — some items use the same ingredients. ${notCharged} ${lowerTo(name, lines, left)} or change other items, then try again.`;
  return left === 0
    ? `${name} just sold out. ${notCharged} ${lowerTo(name, lines, 0)} from your cart, then try again.`
    : `Only ${left} ${name} can be made right now — you have ${ordered} in your cart. ${notCharged} ${lowerTo(name, lines, left)}, then try again.`;
}

/**
 * WP-2423: what the guest is told on the cart when the store can't make the quantity they asked
 * for on a line (the stock is checked line by line here; checkout checks the cart together). The
 * cart is unchanged.
 */
export function cartItemShortMessage(
  cartItemReference: string,
  available: number,
  items: readonly CartItemView[],
): string | null {
  const item = items.find((entry) => entry.cartItemReference === cartItemReference);
  if (item === undefined) return null;
  const name = itemName(item);
  if (available === 0) return `${name} just sold out. ${lowerTo(name, [item], 0)} before checkout.`;
  return available >= item.quantity
    ? `Only ${available} ${name} can be made right now, so we couldn’t add more. Your cart is unchanged.`
    : `Only ${available} ${name} can be made right now — this line has ${item.quantity}. ${lowerTo(name, [item], available)} before checkout.`;
}
