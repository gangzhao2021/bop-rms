import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { CheckoutPage } from "./CheckoutPage.js";
import type { CheckoutController } from "./checkout-client.js";
import type { CheckoutQuote, CheckoutState } from "./types.js";
import type { CartView } from "../cart/types.js";

const id = (n: number) => `018f7800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cart: CartView = {
  schemaVersion: 1,
  cart: {
    cartReference: id(1),
    version: 3,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-08-12T01:00:00.000Z",
      absoluteExpiresAt: "2026-08-13T01:00:00.000Z",
    },
    items: [
      {
        cartItemReference: id(2),
        sellableReference: id(3),
        displayName: "Synthetic tea",
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" },
        warnings: [],
      },
    ],
    quote: null,
    warnings: [],
  },
};
const quote: CheckoutQuote = {
  quoteReference: id(4),
  quoteVersion: 1,
  cartVersion: 3,
  subtotal: { amountMinor: "100", currency: "CAD" },
  discount: { amountMinor: "0", currency: "CAD" },
  tax: { amountMinor: "13", currency: "CAD" },
  fee: { amountMinor: "0", currency: "CAD" },
  total: { amountMinor: "113", currency: "CAD" },
  expiresAt: "2026-08-12T00:05:00.000Z",
  warnings: ["SYNTHETIC_WARNING"],
  blockingReasons: ["SYNTHETIC_BLOCK"],
  priceChange: {
    outcome: "Changed",
    totalChange: { amountMinor: "13", currency: "CAD" },
    requiresReconfirmation: true,
    evaluatedAt: "2026-08-12T00:00:00.000Z",
  },
};

function controller(state: CheckoutState): CheckoutController {
  return {
    getState: () => state,
    load: async () => undefined,
    quote: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
  };
}

function render(state: CheckoutState, now = Date.parse("2026-08-12T00:01:00.000Z")): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CheckoutPage controller={controller(state)} now={() => now} />
    </MemoryRouter>,
  );
}

describe("CUST-CHECKOUT page contract", () => {
  it("renders only server Cart and Quote facts with payment gated by saved details", () => {
    const html = render({ status: "ready", cart, quote });
    expect(html).toContain("Synthetic tea");
    expect(html).toContain("$1.13");
    expect(html).not.toContain("SYNTHETIC_WARNING");
    expect(html).not.toContain("SYNTHETIC_BLOCK");
    expect(html).toContain("can’t be paid yet");
    expect(html).toContain("Price changed");
    expect(html).toContain("I confirm the changed price");
    expect(html).not.toContain("Capacity Hold");
    expect(html).toContain('aria-label="Checkout progress"');
    expect(html).toContain('aria-current="step"');
    expect(html).toContain('aria-label="Customer journey"');
    expect(html).toContain('aria-label="Tip amount"');
    expect(html).toContain("15%");
    expect(html).toContain("$0.15");
    expect(html).toContain("Continue to payment");
    expect(html).toMatch(/<button[^>]*class="checkout-continue__button"[^>]*disabled=""/u);
  });

  it("marks an expired Quote and offers a fresh idempotent request", () => {
    const html = render({ status: "ready", cart, quote }, Date.parse("2026-08-12T00:06:00.000Z"));
    expect(html).toContain("These prices expired");
    expect(html).toContain("Refresh prices");
  });

  it.each([
    ["offline", "You’re offline. Reconnect to continue"],
    ["outcome-unknown", "We couldn’t confirm your prices"],
    ["session-expired", "Your session ended"],
    ["conflict", "Your cart changed. Refresh to price the current cart."],
    ["validation", "can’t be ordered as selected"],
    ["unavailable", "We couldn’t price your order just now"],
  ] as const)("renders the %s recovery state", (status, message) => {
    expect(render({ status, cart, canRetry: status === "outcome-unknown" })).toContain(message);
  });
});

it.each(["pending", "offline", "outcome-unknown", "session-expired"] as const)(
  "does not offer a new Quote while %s",
  (status) => {
    const state: CheckoutState =
      status === "pending"
        ? { status, cart }
        : { status, cart, canRetry: status === "outcome-unknown" };
    const html = render(state);
    expect(html).not.toContain("Refresh prices");
    if (status === "outcome-unknown") expect(html).toContain("Retry pricing");
  },
);
it("disables the retained Quote retry while offline", () => {
  expect(render({ status: "offline", cart, canRetry: true })).toMatch(
    new RegExp("<button[^>]*disabled[^>]*>Retry pricing</button>", "u"),
  );
});

it("offers explicit new pricing only after a confirmed expired operation", () => {
  const html = render({ status: "quote-expired", cart, canRetry: false });
  expect(html).toContain("Your previous prices expired");
  expect(html).toContain("Refresh prices");
  expect(html).toContain('role="alert"');
  expect(html).not.toContain("Retry pricing");
  expect(html).not.toContain("checkout-totals");
});
