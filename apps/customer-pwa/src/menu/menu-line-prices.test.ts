import { describe, expect, it } from "vitest";
import type { CartItemView } from "../cart/types.js";
import { summarizeCart } from "./MenuPage.js";
import {
  cartLinePrices,
  cartLinesSubtotal,
  quoteConsistentLinePrices,
} from "./menu-line-prices.js";
import type { MenuSellable, MenuView } from "./types.js";

const id = (n: number) => `018f7800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const oat = id(10);
const shot = id(11);
const flatWhite: MenuSellable = {
  sellableReference: id(1),
  name: "Flat White — Regular (12 oz)",
  description: null,
  photo: null,
  presentationRole: "Standard",
  pinned: false,
  availability: "Available",
  price: { amount: "4.95", currency: "CAD" },
  allergens: [],
  optionRules: [
    {
      name: "Milk",
      minimumSelections: 1,
      maximumSelections: 1,
      options: [
        {
          optionReference: oat,
          name: "Oat milk",
          maximumQuantity: 1,
          conflictOptionReferences: [],
          selectedByDefault: false,
          price: { amount: "0.75", currency: "CAD" },
        },
        {
          optionReference: shot,
          name: "Espresso shot",
          maximumQuantity: 3,
          conflictOptionReferences: [],
          selectedByDefault: false,
          price: { amount: "1.0000", currency: "CAD" },
        },
      ],
    },
  ],
};
const menu: MenuView = {
  name: "DEMO",
  locale: "en-CA",
  effectiveFrom: "2026-10-18T12:00:00.000Z",
  effectiveUntil: null,
  sections: [{ sectionReference: id(50), name: "Coffee", sellables: [flatWhite] }],
};
const line = (n: number, extra: Partial<CartItemView> = {}): CartItemView => ({
  cartItemReference: id(100 + n),
  sellableReference: flatWhite.sellableReference,
  displayName: flatWhite.name,
  quantity: 1,
  configuration: [],
  customerNote: null,
  lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
  warnings: [],
  ...extra,
});

describe("WP-2423 cart lines at the price the guest saw", () => {
  it("prices a line the Store hasn't priced from the published size and option prices", () => {
    const prices = cartLinePrices(
      [
        line(1, {
          quantity: 2,
          configuration: [
            { optionReference: oat, displayName: "Oat milk", quantity: 1 },
            { optionReference: shot, displayName: "Espresso shot", quantity: 2 },
          ],
        }),
        line(2),
      ],
      menu,
    );
    expect(prices.get(id(101))).toEqual({ amountMinor: 1540n, currency: "CAD" });
    expect(prices.get(id(102))).toEqual({ amountMinor: 495n, currency: "CAD" });
    expect(cartLinesSubtotal(prices)).toEqual({ amountMinor: 2035n, currency: "CAD" });
  });

  it("keeps the Store's own line price and leaves unknown items unpriced", () => {
    const prices = cartLinePrices(
      [
        line(1, {
          lineEstimate: { status: "Available", total: { amountMinor: "500", currency: "CAD" } },
        }),
        line(2, { sellableReference: id(99) }),
        line(3, { configuration: [{ optionReference: id(98), displayName: "Gone", quantity: 1 }] }),
      ],
      menu,
    );
    expect(prices.get(id(101))).toEqual({ amountMinor: 500n, currency: "CAD" });
    expect(prices.get(id(102))).toBeNull();
    expect(prices.get(id(103))).toBeNull();
    expect(cartLinesSubtotal(prices)).toBeNull();
    expect(cartLinePrices([line(1)], null).get(id(101))).toBeNull();
  });

  it("never shows lines that disagree with the quote beside them", () => {
    const items = [line(1)];
    expect(
      quoteConsistentLinePrices(items, menu, { amountMinor: "495", currency: "CAD" }).get(id(101)),
    ).toEqual({ amountMinor: 495n, currency: "CAD" });
    expect(
      quoteConsistentLinePrices(items, menu, { amountMinor: "450", currency: "CAD" }).get(id(101)),
    ).toBeNull();
  });

  it("gives the menu's cart summary a subtotal before tax, or none when a line can't be priced", () => {
    const view = {
      schemaVersion: 1 as const,
      cart: {
        cartReference: id(200),
        version: 1,
        orderType: "Pickup" as const,
        serviceMode: "Pickup",
        context: { brandName: "B", storeName: "S" },
        lifecycle: {
          status: "Active" as const,
          idleExpiresAt: "2026-10-21T12:00:00.000Z",
          absoluteExpiresAt: "2026-10-21T12:00:00.000Z",
        },
        items: [line(1)],
        quote: null,
        warnings: [],
      },
    };
    expect(summarizeCart(view, menu)).toEqual({ count: 1, subtotal: "$4.95" });
    expect(summarizeCart(view, null)).toEqual({ count: 1, subtotal: null });
  });
});
