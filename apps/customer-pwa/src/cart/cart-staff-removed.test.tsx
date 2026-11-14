import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { CartPage, staffRemovedDishes } from "./CartPage.js";
import { createBrowserCustomerCartClient, setCustomerCartCsrfCredential } from "./cart-client.js";
import type { CartState, CartStateController } from "./cart-state.js";
import type { CartView } from "./types.js";

// WP-2423 shared-table-checkout (c): when staff take a dish out of the table's cart, every phone
// at the table is told on its next read, by the dish's name (no codes, no staff name).

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const removed = [
  {
    removedAt: "2026-08-02T20:10:00.000Z",
    quantity: 1,
    names: { "en-CA": "Mapo tofu", "zh-Hans-CA": "麻婆豆腐" },
  },
];
function tableCart(staffRemoved?: unknown, recentRounds?: unknown): CartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version: 5,
      orderType: "DineIn",
      serviceMode: "DineIn",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-02T21:00:00.000Z",
        absoluteExpiresAt: "2026-08-03T20:00:00.000Z",
      },
      items: [],
      quote: null,
      warnings: [],
      ...(staffRemoved === undefined ? {} : { staffRemoved }),
      ...(recentRounds === undefined ? {} : { recentRounds }),
    },
  } as unknown as CartView;
}
const page = (cart: CartView) => {
  const state: CartState = { status: "ready", cart } as CartState;
  const controller: CartStateController = {
    getState: () => state,
    load: async () => undefined,
    refresh: async () => true,
    removeItem: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
    updateItem: async () => undefined,
  };
  return renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={controller} />
    </MemoryRouter>,
  );
};

describe("Staff removed a dish from the table's cart", () => {
  it("names the dish in the guest's language", () => {
    expect(staffRemovedDishes(tableCart(removed))).toEqual(["Mapo tofu"]);
    expect(staffRemovedDishes(tableCart())).toEqual([]);
  });

  it("a dish on no current menu is still told, as a dish", () => {
    const unnamed = tableCart([removed[0], { ...removed[0], names: {} }]);
    expect(staffRemovedDishes(unnamed)).toEqual(["Mapo tofu", null]);
    const html = page(unnamed);
    expect(html).toContain("Staff removed Mapo tofu from the cart.");
    expect(html).toContain("Staff removed a dish from the cart.");
  });

  it("the cart page tells every phone, without codes", () => {
    const html = page(tableCart(removed));
    expect(html).toContain("Staff removed Mapo tofu from the cart.");
    expect(html).not.toMatch(/018f5300/u);
  });

  it("an empty cart after another phone's round still says what staff took out", () => {
    // v15 batch-5: phone 2's only dish was taken out on the staff round; its cart is empty.
    const html = page(
      tableCart(removed, [
        {
          roundNumber: 1,
          sentAt: "2026-08-02T20:10:00.000Z",
          sentByThisPhone: false,
          cartItemReferences: [id(7)],
          paymentState: "AwaitingPayment",
        },
      ]),
    );
    expect(html).toContain("Staff removed Mapo tofu from the cart.");
    expect(html).toContain("Your cart is empty");
  });

  it("the cart client reads the removals the store sends", async () => {
    const fetch = vi.fn(
      async () => new Response(JSON.stringify(tableCart(removed)), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);
    try {
      const view = await createBrowserCustomerCartClient().loadCurrent();
      expect(view?.cart.staffRemoved).toEqual(removed);
    } finally {
      vi.unstubAllGlobals();
      setCustomerCartCsrfCredential(null);
    }
  });
});
