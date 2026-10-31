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
    // WP-2423 item 8 ⑦ (Owner decision 11): nothing is chosen for the guest, "No tip" included.
    expect(html).not.toContain('aria-pressed="true"');
    expect(html).toContain("Choose a tip to continue");
    expect(html).toMatch(/<button[^>]*class="checkout-continue__button"[^>]*disabled=""/u);
  });

  it("WP-2423 item 8 ⑦: offers the Store's own tip percentages, and asks nothing when tips are off", () => {
    const tiers = render({
      status: "ready",
      cart,
      quote: { ...quote, tips: { enabled: true, tierPercents: [12, 20, 25] } },
    });
    expect(tiers).toContain("12%<span>$0.12</span>");
    expect(tiers).toContain("25%<span>$0.25</span>");
    expect(tiers).not.toContain("15%");
    expect(tiers).toContain("No tip");
    expect(tiers).toContain("Other");
    const off = render({
      status: "ready",
      cart,
      quote: { ...quote, tips: { enabled: false, tierPercents: [10, 15, 18] } },
    });
    expect(off).not.toContain('aria-label="Tip amount"');
    expect(off).not.toContain("Choose a tip");
    // The total shown before payment is the order's own, with no tip.
    expect(off).toContain("Continue to payment · $1.13");
  });

  it("v15 live check: an empty cart asks for no tip", () => {
    expect(render({ status: "empty" })).not.toContain('aria-label="Tip amount"');
    expect(
      render({ status: "ready", cart: { ...cart, cart: { ...cart.cart, items: [] } }, quote }),
    ).not.toContain('aria-label="Tip amount"');
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

it.each([
  [
    "checkout-in-progress",
    "Another guest is checking out",
    "Another guest at your table is paying for this order. Try again in about 3 minutes.",
  ],
  [
    "order-processing",
    "Order still processing",
    "Your table’s last order is still being processed. Try again in about 3 minutes.",
  ],
] as const)("WP-2423: explains %s pricing refusals and offers a retry", (status, title, text) => {
  const html = render({ status, cart, retryAfterSeconds: 150, canRetry: true });
  expect(html).toContain(title);
  expect(html).toContain(text);
  expect(html).toContain("Try again</button>");
  expect(html).not.toContain("We couldn’t price your order just now");
  expect(html).not.toContain("cart_");
});
