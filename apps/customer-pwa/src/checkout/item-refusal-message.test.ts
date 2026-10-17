import { describe, expect, it } from "vitest";
import type { CartItemView } from "../cart/types.js";
import { checkoutItemRefusalMessage } from "./item-refusal-message.js";

const item = (
  cartItemReference: string,
  displayName: string,
  quantity: number,
  configuration: CartItemView["configuration"] = [],
  sellableReference = displayName,
): CartItemView => ({
  cartItemReference,
  sellableReference,
  displayName,
  quantity,
  configuration,
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
  warnings: [],
});
const small = [{ optionReference: "size-s", displayName: "Small", quantity: 1 }];
const items = [
  item("a", "Flat White", 1, small),
  item("b", "Mocha", 2),
  item("c", "Flat White", 1, small),
];

describe("WP-2423 checkout item refusal text", () => {
  it("names the item, how many are left of all its lines together, and that nothing was charged", () => {
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "a", available: 1, sharedStock: false },
        items,
      ),
    ).toBe(
      "Only 1 Flat White (Small) left — you have 2 in your cart. You haven’t been charged. Change it to 1, then try again.",
    );
  });

  it("explains items sharing an ingredient, and a sold-out item", () => {
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "b", available: 1, sharedStock: true },
        items,
      ),
    ).toBe(
      "We can make only 1 Mocha along with the rest of your order — some items use the same ingredients. You haven’t been charged. Change Mocha to 1 or change other items, then try again.",
    );
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "b", available: 0, sharedStock: true },
        items,
      ),
    ).toContain("We don’t have enough left to make Mocha along with the rest of your order");
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "b", available: 0, sharedStock: false },
        items,
      ),
    ).toBe(
      "Mocha just sold out. You haven’t been charged. Remove it from your cart, then try again.",
    );
  });

  it("uses plain words for an item that can't be sold or a line it can't find (no codes)", () => {
    expect(
      checkoutItemRefusalMessage(
        "item_unavailable",
        { cartItemReference: "b", available: null, sharedStock: false },
        items,
      ),
    ).toBe(
      "Mocha isn’t available right now. You haven’t been charged. Remove it from your cart, then try again.",
    );
    const unknown = checkoutItemRefusalMessage("item_short", null, items);
    expect(unknown).toBe(
      "Some items in your cart can’t be made right now. You haven’t been charged. Edit your cart, then try again.",
    );
    expect(unknown).not.toMatch(/[A-Z]{2,}_|[0-9a-f]{8}-/u);
  });
});
