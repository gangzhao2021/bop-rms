import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CartPage } from "./CartPage.js";
import type { CartState, CartStateController } from "./cart-state.js";
import type { CartView } from "./types.js";

const id = (n: number) => `018f5300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

function cart(): CartView {
  return {
    schemaVersion: 1,
    cart: {
      cartReference: id(1),
      version: 3,
      orderType: "Pickup",
      serviceMode: "Pickup",
      context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
      lifecycle: {
        status: "Active",
        idleExpiresAt: "2026-08-02T21:00:00.000Z",
        absoluteExpiresAt: "2026-08-03T20:00:00.000Z",
      },
      items: [
        {
          cartItemReference: id(2),
          sellableReference: id(3),
          displayName: "Synthetic tea",
          quantity: 2,
          configuration: [{ optionReference: id(4), displayName: "Synthetic size", quantity: 1 }],
          customerNote: null,
          lineEstimate: {
            status: "Available",
            total: { amountMinor: "1000", currency: "CAD" },
          },
          warnings: ["SYNTHETIC_WARNING"],
        },
      ],
      quote: {
        quoteReference: id(5),
        quoteVersion: 1,
        cartVersion: 3,
        subtotal: { amountMinor: "1000", currency: "CAD" },
        discount: { amountMinor: "0", currency: "CAD" },
        tax: { amountMinor: "130", currency: "CAD" },
        fee: { amountMinor: "0", currency: "CAD" },
        total: { amountMinor: "1130", currency: "CAD" },
        expiresAt: "2026-08-02T20:05:00.000Z",
        warnings: [],
        blockingReasons: [],
      },
      warnings: [],
    },
  };
}

function controller(state: CartState): CartStateController {
  return {
    getState: () => state,
    load: async () => undefined,
    removeItem: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
    updateItem: async () => undefined,
  };
}

describe("CUST-CART page contract", () => {
  it("renders exact Cart fields, Quote, boundaries and accessible controls", () => {
    const html = renderToStaticMarkup(
      <CartPage controller={controller({ status: "ready", cart: cart() })} />,
    );
    expect(html).toContain("Your cart");
    expect(html).toContain("Synthetic Brand");
    expect(html).toContain("Synthetic Store");
    expect(html).toContain("Synthetic tea");
    expect(html).toContain("Synthetic size");
    expect(html).toContain("CAD 1130 minor units");
    expect(html).toContain("Cart version 3");
    expect(html).toContain("Continue shopping");
    expect(html).toContain("Clear cart");
    expect(html).toContain("Checkout");
    expect(html).toContain("Clear cart requires an atomic server command and is unavailable.");
    expect(html).toContain("Checkout is implemented by WP-1220 and later packages.");
    expect(html).toContain("disabled");
    expect(html).toContain('aria-label="Increase Synthetic tea quantity"');
    expect(html).toContain('href="#cart-content"');
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB|serviceWorker/u);
  });

  it("renders offline as explicit read-only with no enabled mutation", () => {
    const html = renderToStaticMarkup(
      <CartPage controller={controller({ status: "offline-readonly", cart: cart() })} />,
    );
    expect(html).toContain("Offline read-only");
    expect(html).toContain("nothing will replay on reconnect");
    expect(html).toContain('disabled="" aria-label="Decrease Synthetic tea quantity"');
    expect(html).toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
  });

  it("renders explicit Feature-disabled and Quote-expired states", () => {
    const disabled = cart();
    expect(
      renderToStaticMarkup(
        <CartPage
          controller={controller({
            status: "ready",
            cart: { ...disabled, cart: { ...disabled.cart, warnings: ["FEATURE_DISABLED"] } },
          })}
        />,
      ),
    ).toContain("Cart ordering is not enabled");
    const expired = cart();
    expect(
      renderToStaticMarkup(
        <CartPage
          controller={controller({
            status: "ready",
            cart: { ...expired, cart: { ...expired.cart, warnings: ["QUOTE_EXPIRED"] } },
          })}
        />,
      ),
    ).toContain("Quote expired");
  });

  it.each([
    ["loading", "Loading cart"],
    ["empty", "Your cart is empty"],
    ["session-expired", "Session expired"],
    ["not-found", "Cart unavailable"],
    ["conflict", "Cart changed"],
    ["validation", "Review this item"],
    ["rate-limited", "Please wait"],
    ["expired", "Cart expired"],
    ["abandoned", "Cart closed"],
    ["command-failed", "Outcome not confirmed"],
    ["unavailable", "Cart temporarily unavailable"],
  ] as const)("renders the %s state", (status, message) => {
    const state: CartState =
      status === "loading" || status === "empty"
        ? { status }
        : {
            status,
            cart: null,
            issueCodes: [],
            retryAfterSeconds: status === "rate-limited" ? 5 : null,
            canRetrySameOperation: status === "command-failed",
          };
    expect(renderToStaticMarkup(<CartPage controller={controller(state)} />)).toContain(message);
  });
});
