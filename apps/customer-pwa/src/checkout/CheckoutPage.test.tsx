import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { CheckoutPage } from "./CheckoutPage.js";
import {
  setCustomerCsrfCredential,
  setTablePaymentTiming,
} from "../session/customer-transaction-context.js";
import type { CheckoutController } from "./checkout-client.js";
import type { CheckoutSessionController } from "./session-controller.js";
import type { CheckoutQuote, CheckoutState } from "./types.js";
import type { CartView } from "../cart/types.js";
import { clearSeenPrices, recordFirstSeenPrices } from "../cart/seen-prices.js";

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

  it("WP-2423 M03: Back after paying lands on the order, never on a payable checkout", () => {
    const html = render({
      status: "empty",
      placedOrder: { orderReference: "01902423-0000-7000-8000-000000000013", orderNumber: "13" },
    });
    expect(html).toContain("Already ordered");
    expect(html).toContain("These dishes are in order 13.");
    expect(html).toContain('href="/orders/01902423-0000-7000-8000-000000000013"');
    expect(html).toContain("View order status");
    expect(html).toContain('href="/menu"');
    expect(html).not.toContain("Your cart is empty");
    expect(html).not.toContain("Continue to payment");
    expect(render({ status: "empty" })).toContain("Your cart is empty");
  });

  it("WP-2423 M03 review: a cart whose dishes are already in an order offers no payment", () => {
    const html = render({
      status: "ready",
      cart: {
        ...cart,
        cart: {
          ...cart.cart,
          placedOrder: { orderReference: id(13), orderNumber: "13", notMade: false },
        },
      },
      quote: null,
    });
    expect(html).toContain("The dishes in your cart are already in order 13");
    expect(html).toContain(`href="/orders/${id(13)}"`);
    expect(html).toContain('href="/cart"');
    expect(html).not.toContain("Continue to payment");
  });

  it("WP-2423 live minor 22: a dish that can't be ordered now leads to the cart, with no tip asked", () => {
    const html = render({
      status: "item-unavailable",
      cart,
      refusal: "item_unavailable",
      line: null,
      canRetry: false,
    });
    expect(html).not.toContain('aria-label="Tip amount"');
    expect(html).not.toContain("Choose a tip to continue");
    expect(html).toMatch(
      /<a[^>]*class="checkout-continue__button"[^>]*href="\/cart"[^>]*>Change your cart<\/a>/u,
    );
    // price-hold-dish-changes (v15 batch 6): one way to the cart, not two identical links.
    expect(html.match(/>Change your cart</gu)).toHaveLength(1);
    expect(html).not.toMatch(/<button[^>]*class="checkout-continue__button"/u);
  });

  it.each(["item_unavailable", "item_short"] as const)(
    "WP-2423 live minor 22 review: a checkout start refused with %s leads to the cart, with no tip asked",
    (status) => {
      const session: CheckoutSessionController = {
        getState: () => ({ status, canRetry: false, line: null }),
        subscribe: () => () => undefined,
        start: async () => undefined,
        retry: async () => undefined,
        reset: () => undefined,
        setOnline: () => undefined,
      };
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <CheckoutPage
            controller={controller({
              status: "ready",
              cart,
              quote: { ...quote, blockingReasons: [], priceChange: null },
            })}
            sessionController={session}
            now={() => Date.parse("2026-08-12T00:01:00.000Z")}
          />
        </MemoryRouter>,
      );
      expect(html).toContain('role="alert"');
      expect(html).not.toContain('aria-label="Tip amount"');
      expect(html).not.toContain("Choose a tip to continue");
      expect(html).not.toContain("Continue to payment");
      expect(html).toMatch(
        /<a[^>]*class="checkout-continue__button"[^>]*href="\/cart"[^>]*>Change your cart<\/a>/u,
      );
      expect(html.match(/>Change your cart</gu)).toHaveLength(1);
      expect(html).not.toMatch(/<button[^>]*class="checkout-continue__button"/u);
    },
  );

  it("v15 live check: an empty cart asks for no tip", () => {
    expect(render({ status: "empty" })).not.toContain('aria-label="Tip amount"');
    expect(
      render({ status: "ready", cart: { ...cart, cart: { ...cart.cart, items: [] } }, quote }),
    ).not.toContain('aria-label="Tip amount"');
  });

  it("marks an expired Quote and offers a fresh idempotent request", () => {
    const html = render({ status: "ready", cart, quote }, Date.parse("2026-08-12T00:06:00.000Z"));
    expect(html).toContain(
      "We’ve stopped keeping your price. Tap Refresh prices: any price that changed is shown before you pay. Your details are kept.",
    );
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

describe("WP-2423 item 6: a table that pays at the end reaches this page only for documents", () => {
  afterEach(() => setCustomerCsrfCredential(null));
  const tableCart: CartView = {
    ...cart,
    cart: { ...cart.cart, orderType: "DineIn", serviceMode: "DineIn" },
  };
  const paging = (state: CheckoutState, timing: "PayLater" | "PayFirst") => {
    setCustomerCsrfCredential("c".repeat(43));
    setTablePaymentTiming(timing);
    return renderToStaticMarkup(
      <MemoryRouter>
        <CheckoutPage
          controller={controller(state)}
          now={() => Date.parse("2026-08-12T00:01:00.000Z")}
        />
      </MemoryRouter>,
    );
  };
  it("is called Place order, with no steps, price lock or tip", () => {
    const html = paging(
      { status: "ready", cart: tableCart, quote: { ...quote, warnings: [], priceChange: null } },
      "PayLater",
    );
    expect(html).toContain('<h2 id="page-heading">Place order</h2>');
    expect(html).toContain("Place order · $1.13");
    expect(html).not.toContain("checkout-progress");
    expect(html).not.toContain("Your price is kept");
    expect(html).not.toContain("checkout-tip");
    expect(html).not.toContain(">Checkout<");
    expect(html).toContain("Nothing is charged now.");
  });
  it("a pay-first table keeps the review page with its steps", () => {
    const html = paging(
      { status: "ready", cart: tableCart, quote: { ...quote, warnings: [], priceChange: null } },
      "PayFirst",
    );
    expect(html).toContain("checkout-progress");
    expect(html).toContain("Your price is kept for 4:00");
    expect(html).not.toContain("Place order");
  });
});

describe("WP-2423 guest-payment-state: what the guest pays, and until when", () => {
  const priced = (amountMinor: string): CheckoutQuote => ({
    ...quote,
    subtotal: { amountMinor, currency: "CAD" },
    total: { amountMinor, currency: "CAD" },
    warnings: [],
    blockingReasons: [],
    priceChange: null,
    lines: [{ cartItemReference: id(2), quantity: 1, subtotal: { amountMinor, currency: "CAD" } }],
  });
  afterEach(() => clearSeenPrices());

  it("M114: while the order is being priced, no tip choice flashes and the button says so", () => {
    const html = render({ status: "pending", cart });
    expect(html).not.toContain('aria-label="Tip amount"');
    expect(html).not.toContain("Choose a tip to continue");
    expect(html).toContain("Getting your total…");
  });

  it("M74: a dish whose price rose since it was added is listed by name and must be accepted", () => {
    recordFirstSeenPrices(id(1), [
      { cartItemReference: id(2), quantity: 1, amountMinor: 549n, currency: "CAD" },
    ]);
    // The cart showed the new price first; that is not the guest accepting it.
    recordFirstSeenPrices(id(1), [
      { cartItemReference: id(2), quantity: 1, amountMinor: 599n, currency: "CAD" },
    ]);
    const html = render({ status: "ready", cart, quote: priced("599") });
    expect(html).toContain("Prices changed since you added these:");
    expect(html).toContain("Synthetic tea: $5.49 → $5.99");
    expect(html).toContain("New total $5.99");
    expect(html).toContain("I accept the new prices");
    expect(html).toMatch(/<button[^>]*class="checkout-continue__button"[^>]*disabled=""/u);
    // The line itself shows the Store's price for it, never a blank.
    expect(html).toContain('<span class="checkout-items__amount">$5.99</span>');
  });

  it("price-hold-dish-changes (DEC-PRICE-HOLD §3): a dish the Store says was renamed or given other allergens is named and ticked before paying", () => {
    const quote = {
      ...priced("549"),
      sinceAdded: [
        {
          cartItemReference: id(2),
          quantity: 1,
          subtotal: { amountMinor: "549", currency: "CAD" },
          changes: ["Name", "Allergens"] as const,
        },
      ],
    };
    const html = render({ status: "ready", cart, quote });
    expect(html).toContain("Changed since you added it:");
    expect(html).toContain("Synthetic tea was renamed since you added it.");
    // The menu is not read in this render: the guest is told to ask, never told nothing changed.
    expect(html).toContain(
      "Synthetic tea allergens changed since you added it. Ask staff before you order.",
    );
    expect(html).toContain("I have read these changes");
    expect(html).toMatch(/<button[^>]*class="checkout-continue__button"[^>]*disabled=""/u);
    // v15 2026-11-11 b10: the greyed button says why, next to it (the box is far above on a phone).
    expect(html).toMatch(
      /aria-describedby="checkout-tick-changes"[^>]*>[^<]*<\/button><p class="checkout-continue__note" id="checkout-tick-changes">Tick the box above to continue to payment\.<\/p>/u,
    );
    // A first price that differs is listed as a price change (after a reload too).
    const rose = render({
      status: "ready",
      cart,
      quote: {
        ...priced("599"),
        sinceAdded: [
          {
            cartItemReference: id(2),
            quantity: 1,
            subtotal: { amountMinor: "549", currency: "CAD" },
            changes: [],
          },
        ],
      },
    });
    expect(rose).toContain("Synthetic tea: $5.49 → $5.99");
    expect(rose).toContain("I accept the new prices");
    expect(rose).toContain("Tick the box above to continue to payment.");
    expect(rose).not.toContain("I have read these changes");
    // Nothing changed: nothing is asked.
    clearSeenPrices();
    const same = render({ status: "ready", cart, quote: priced("549") });
    expect(same).not.toContain("Changed since you added it:");
    expect(same).not.toContain("I have read these changes");
    expect(same).not.toContain("Tick the box above");
  });

  it("price-hold-dish-changes: a quote that cannot say whether a dish changed is try again, never paid as nothing changed", () => {
    clearSeenPrices();
    const html = render({
      status: "ready",
      cart,
      quote: { ...priced("549"), sinceAddedUnknown: true as const },
    });
    expect(html).toContain(
      "We couldn’t check whether a dish changed since you added it, so nothing was ordered or charged.",
    );
    expect(html).toMatch(/>Try again<\/button>/u);
    expect(html).toMatch(/<button[^>]*class="checkout-continue__button"[^>]*disabled=""/u);
    clearSeenPrices();
  });

  it("M74: a decrease is listed without asking anything", () => {
    recordFirstSeenPrices(id(1), [
      { cartItemReference: id(2), quantity: 1, amountMinor: 549n, currency: "CAD" },
    ]);
    const html = render({ status: "ready", cart, quote: priced("499") });
    expect(html).toContain("Synthetic tea: now $4.99, was $5.49");
    expect(html).not.toContain("I accept the new prices");
  });

  it("M165: back from the payment page after a menu update, the page says why it priced again", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={[{ pathname: "/checkout", state: { menuUpdated: true } }]}>
        <CheckoutPage
          controller={controller({ status: "ready", cart, quote: priced("599") })}
          now={() => Date.parse("2026-08-12T00:01:00.000Z")}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("The restaurant just updated its menu, so we priced your order again.");
  });

  it("Owner #26 (DEC-PRICE-HOLD) / M125: the countdown says how long the price is kept, and its last minute is announced", () => {
    expect(render({ status: "ready", cart, quote: priced("599") })).toContain(
      "Your price is kept for 4:00",
    );
    const late = render(
      { status: "ready", cart, quote: priced("599") },
      Date.parse("2026-08-12T00:04:10.000Z"),
    );
    expect(late).toContain("Your price is kept for 0:50");
    expect(late).toContain(
      '<p role="alert">Your price is kept for 1 more minute. Continue now, or we’ll check prices again.</p>',
    );
  });
});
