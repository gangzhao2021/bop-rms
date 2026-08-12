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
  it("renders only server Cart and Quote facts with the Payment boundary disabled", () => {
    const html = render({ status: "ready", cart, quote });
    expect(html).toContain("Synthetic tea");
    expect(html).toContain("CAD 113 minor units");
    expect(html).toContain("SYNTHETIC_WARNING");
    expect(html).toContain("SYNTHETIC_BLOCK");
    expect(html).toContain("Price changed");
    expect(html).toContain("I confirm the changed price");
    expect(html).toContain(
      "Contact, capacity hold, tip and receipt-choice adapters are unavailable",
    );
    expect(html).toContain("disabled");
  });

  it("marks an expired Quote and offers a fresh idempotent request", () => {
    const html = render({ status: "ready", cart, quote }, Date.parse("2026-08-12T00:06:00.000Z"));
    expect(html).toContain("Quote expired");
    expect(html).toContain("Get a new quote");
  });

  it.each([
    ["offline", "Offline read-only. Nothing will replay."],
    ["outcome-unknown", "The Quote outcome is unknown; no success was assumed."],
    ["session-expired", "Checkout state: session-expired"],
    ["conflict", "Checkout state: conflict"],
    ["validation", "Checkout state: validation"],
    ["unavailable", "Checkout state: unavailable"],
  ] as const)("renders the %s recovery state", (status, message) => {
    expect(render({ status, cart, canRetry: status === "outcome-unknown" })).toContain(message);
  });
});
