import { listSeparator, t } from "../i18n/i18n.js";
import type { CartItemView } from "../cart/types.js";
import type { CheckoutRefusedLine } from "./session-client.js";

/** The item as the guest chose it: "Flat White (Small, Oat milk)". */
function itemName(item: CartItemView): string {
  const options = item.configuration.map((option) =>
    option.quantity === 1 ? option.displayName : `${option.displayName} × ${option.quantity}`,
  );
  return options.length === 0
    ? item.displayName
    : `${item.displayName} (${options.join(listSeparator())})`;
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
  if (left === 0)
    return lines.length === 1 ? t("Remove {name}", { name }) : t("Remove every {name}", { name });
  if (lines.length === 1) return t("Change {name} to {left}", { name, left });
  const extra = ordered - left;
  return extra === 1
    ? t("Remove one {name}", { name })
    : t("Remove {extra} of your {ordered} {name}", { extra, ordered, name });
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
  const notCharged = t("You haven’t been charged.");
  const item =
    line === null
      ? undefined
      : items.find((entry) => entry.cartItemReference === line.cartItemReference);
  if (item === undefined)
    return t(
      "Some items in your cart can’t be made right now. {notCharged} Edit your cart, then try again.",
      { notCharged },
    );
  const name = itemName(item);
  const lines = linesOf(item, items);
  if (status === "item_unavailable" || line === null || line.available === null)
    return t(
      "{name} isn’t available right now. {notCharged} {value1} from your cart, then try again.",
      { name, notCharged, value1: lowerTo(name, lines, 0) },
    );
  const left = line.available;
  const ordered = lines.reduce((sum, entry) => sum + entry.quantity, 0);
  if (line.sharedStock)
    return left === 0
      ? t(
          "We don’t have enough left to make {name} along with the rest of your order — some items use the same ingredients. {notCharged} {value1} or change other items, then try again.",
          { name, notCharged, value1: lowerTo(name, lines, 0) },
        )
      : t(
          "We can make only {left} {name} along with the rest of your order — some items use the same ingredients. {notCharged} {value1} or change other items, then try again.",
          { left, name, notCharged, value1: lowerTo(name, lines, left) },
        );
  return left === 0
    ? t("{name} just sold out. {notCharged} {value1} from your cart, then try again.", {
        name,
        notCharged,
        value1: lowerTo(name, lines, 0),
      })
    : t(
        "Only {left} {name} can be made right now — you have {ordered} in your cart. {notCharged} {value1}, then try again.",
        { left, name, ordered, notCharged, value1: lowerTo(name, lines, left) },
      );
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
  if (available === 0)
    return t("{name} just sold out. {value1} before checkout.", {
      name,
      value1: lowerTo(name, [item], 0),
    });
  return available >= item.quantity
    ? t(
        "Only {available} {name} can be made right now, so we couldn’t add more. Your cart is unchanged.",
        { available, name },
      )
    : t(
        "Only {available} {name} can be made right now — this line has {quantity}. {value1} before checkout.",
        { available, name, quantity: item.quantity, value1: lowerTo(name, [item], available) },
      );
}
