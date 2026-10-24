import { describe, expect, it } from "vitest";
import type { CartItemView } from "../cart/types.js";
import { cartItemShortMessage, checkoutItemRefusalMessage } from "./item-refusal-message.js";

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
  it("names the item, how many can be made of all its lines together, and that nothing was charged", () => {
    // v15 run: two lines of one each; "−" stops at 1, so the guest is told to remove one.
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "a", available: 1, sharedStock: false },
        items,
      ),
    ).toBe(
      "Only 1 Flat White (Small) can be made right now — you have 2 in your cart. You haven’t been charged. Remove one Flat White (Small), then try again.",
    );
  });

  it("gives the change the cart controls can make: one line is lowered, several are counted", () => {
    const one = [item("a", "Latte", 3)];
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "a", available: 1, sharedStock: false },
        one,
      ),
    ).toBe(
      "Only 1 Latte can be made right now — you have 3 in your cart. You haven’t been charged. Change Latte to 1, then try again.",
    );
    const three = [item("a", "Latte", 2), item("b", "Latte", 1), item("c", "Latte", 1)];
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "a", available: 2, sharedStock: false },
        three,
      ),
    ).toContain("Remove 2 of your 4 Latte, then try again.");
    expect(
      checkoutItemRefusalMessage(
        "item_short",
        { cartItemReference: "a", available: 0, sharedStock: false },
        three,
      ),
    ).toBe(
      "Latte just sold out. You haven’t been charged. Remove every Latte from your cart, then try again.",
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
      "Mocha just sold out. You haven’t been charged. Remove Mocha from your cart, then try again.",
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
      "Mocha isn’t available right now. You haven’t been charged. Remove Mocha from your cart, then try again.",
    );
    const unknown = checkoutItemRefusalMessage("item_short", null, items);
    expect(unknown).toBe(
      "Some items in your cart can’t be made right now. You haven’t been charged. Edit your cart, then try again.",
    );
    expect(unknown).not.toMatch(/[A-Z]{2,}_|[0-9a-f]{8}-/u);
  });

  it("tells the guest on the cart how many of a line the store can make when more was asked", () => {
    expect(cartItemShortMessage("b", 2, items)).toBe(
      "Only 2 Mocha can be made right now, so we couldn’t add more. Your cart is unchanged.",
    );
    expect(cartItemShortMessage("b", 1, items)).toBe(
      "Only 1 Mocha can be made right now — this line has 2. Change Mocha to 1 before checkout.",
    );
    expect(cartItemShortMessage("b", 0, items)).toBe(
      "Mocha just sold out. Remove Mocha before checkout.",
    );
    expect(cartItemShortMessage("missing", 1, items)).toBe(null);
  });
});
