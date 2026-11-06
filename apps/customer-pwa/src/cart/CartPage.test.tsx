import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { afterEach, describe, expect, it } from "vitest";
import { CartPage, cartPollIntervalMs, cartPollShouldRead } from "./CartPage.js";
import type { CartState, CartStateController } from "./cart-state.js";
import { checkoutInProgressMessage, type CartView } from "./types.js";
import type { SendRoundController, SendRoundState } from "../checkout/send-round.js";
import { LanguageRoot } from "../i18n/i18n.js";
import { cartText } from "../journey/messages.js";
import {
  setCustomerCsrfCredential,
  setTablePaymentTiming,
} from "../session/customer-transaction-context.js";

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
    refresh: async () => undefined,
    removeItem: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: () => () => undefined,
    updateItem: async () => undefined,
  };
}

function renderPage(state: CartState): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={controller(state)} />
    </MemoryRouter>,
  );
}

describe("CUST-CART page contract", () => {
  it("explains foreign ownership, disables all row controls and suppresses a supplied foreign note", () => {
    const base = cart();
    const item = base.cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const shared: CartView = {
      ...base,
      cart: {
        ...base.cart,
        orderType: "DineIn",
        serviceMode: "DineIn",
        items: [
          {
            ...item,
            warnings: ["OTHER_PARTICIPANT_ITEM"],
            customerNote: "Synthetic restricted foreign note",
          },
        ],
      },
    };
    const html = renderPage({ status: "ready", cart: shared });
    expect(html).toContain("Added by another guest. Only they can change this item.");
    expect(html).not.toContain("Synthetic restricted foreign note");
    expect(html).not.toContain("OTHER_PARTICIPANT_ITEM");
    expect(
      html.match(new RegExp(`aria-describedby="cart-item-ownership-${id(2)}" disabled=""`, "gu")),
    ).toHaveLength(3);
  });
  it("keeps current-participant notes and controls available", () => {
    const base = cart();
    const item = base.cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const html = renderPage({
      status: "ready",
      cart: {
        ...base,
        cart: {
          ...base.cart,
          orderType: "DineIn",
          serviceMode: "DineIn",
          items: [{ ...item, warnings: [], customerNote: "Synthetic own note" }],
        },
      },
    });
    expect(html).toContain("Synthetic own note");
    expect(html).not.toContain("Added by another guest");
    expect(html).toContain('type="button" aria-label="Increase Synthetic tea quantity"');
    expect(html).not.toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
  });

  it("renders exact Cart fields, Quote, boundaries and accessible controls", () => {
    const html = renderPage({ status: "ready", cart: cart() });
    expect(html).toContain("Your cart");
    expect(html).toContain("Synthetic Brand");
    expect(html).toContain("Synthetic Store");
    expect(html).toContain("Synthetic tea");
    expect(html).toContain("Synthetic size");
    expect(html).toContain("$11.30");
    expect(html).not.toContain("Cart version");
    expect(html).not.toContain("Quote v");
    expect(html).not.toContain("SYNTHETIC_WARNING");
    expect(html).toContain("Continue shopping");
    expect(html).not.toContain("Clear cart");
    expect(html).toContain(">Checkout</a>");
    expect(html).toContain('aria-label="Customer journey"');
    expect(html).toContain('<span aria-current="page">Cart</span>');
    expect(html).toContain("<h1>Synthetic Store</h1>");
    expect(html).toContain('aria-label="Increase Synthetic tea quantity"');
    expect(html).toContain('href="#main-content"');
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB|serviceWorker/u);
  });

  it("renders offline as explicit read-only with no enabled mutation", () => {
    const html = renderPage({ status: "offline-readonly", cart: cart() });
    expect(html).toContain("You’re offline");
    expect(html).toContain("nothing will replay on reconnect");
    expect(html).toContain("Refresh after reconnecting");
    expect(html).toContain('disabled="" aria-label="Decrease Synthetic tea quantity"');
    expect(html).toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
  });

  it("renders explicit Feature-disabled and Quote-expired states", () => {
    const disabled = cart();
    expect(
      renderPage({
        status: "ready",
        cart: { ...disabled, cart: { ...disabled.cart, warnings: ["FEATURE_DISABLED"] } },
      }),
    ).toContain("Cart ordering isn’t enabled");
    const expired = cart();
    expect(
      renderPage({
        status: "ready",
        cart: { ...expired, cart: { ...expired.cart, warnings: ["QUOTE_EXPIRED"] } },
      }),
    ).toContain("Prices have expired");
  });

  it("WP-2423: names the item and how many the store can make when more was asked", () => {
    const html = renderPage({
      status: "validation",
      cart: cart(),
      issueCodes: ["ITEM_SHORT"],
      retryAfterSeconds: null,
      canRetrySameOperation: false,
      shortItem: { cartItemReference: id(2), available: 2 },
    });
    expect(html).toContain("Not enough left");
    expect(html).toContain(
      "Only 2 Synthetic tea (Synthetic size) can be made right now, so we couldn’t add more. Your cart is unchanged.",
    );
    expect(html).not.toContain("can’t be ordered as selected");
  });

  it.each([
    ["loading", "Loading cart"],
    ["empty", "Your cart is empty"],
    ["replacement-forbidden", "Cart replacement not permitted"],
    ["session-expired", "Session expired"],
    ["not-found", "Cart not found"],
    ["conflict", "Cart changed"],
    ["validation", "Review this item"],
    ["rate-limited", "Please wait"],
    ["expired", "Cart expired"],
    ["abandoned", "Cart closed"],
    ["command-failed", "Outcome not confirmed"],
    ["unavailable", "We couldn’t load your cart"],
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
    const html = renderPage(state);
    expect(html).toContain(message);
    // The screen-reader status says what happened in plain words, never the state's name.
    expect(html).toContain(`aria-live="polite">${cartText.stateAnnouncement[status]}</div>`);
    expect(html).not.toContain("Cart state");
  });
});

it("disables superseding Cart changes while retaining explicit retry", () => {
  const html = renderPage({
    status: "command-failed",
    cart: cart(),
    issueCodes: [],
    retryAfterSeconds: null,
    canRetrySameOperation: true,
  });
  expect(html).toContain("Outcome not confirmed");
  expect(html).toContain("Retry the same operation");
  expect(html).toContain('disabled="" aria-label="Decrease Synthetic tea quantity"');
  expect(html).toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Remove<\/button>/u);
});

it.each(["Pickup", "DineIn"] as const)(
  "shows the empty %s server Cart without checkout",
  (orderType) => {
    const empty = cart();
    const state: CartState = {
      status: "ready",
      cart: {
        ...empty,
        cart: { ...empty.cart, orderType, serviceMode: orderType, items: [], quote: null },
      },
    };
    const html = renderPage(state);
    expect(html).toContain("Your cart is empty");
    expect(html).toContain("Browse menu");
    expect(html).not.toContain("cart-checkout-link");
    expect(state.cart.cart.cartReference).toBe(id(1));
  },
);
it("WP-2423 M03: an emptied pickup cart names the order its dishes went to", () => {
  const empty = cart();
  const html = renderPage({
    status: "ready",
    cart: {
      ...empty,
      cart: {
        ...empty.cart,
        items: [],
        quote: null,
        placedOrder: { orderReference: id(13), orderNumber: "13" },
      },
    },
  });
  expect(html).toContain("Already ordered");
  expect(html).toContain("These dishes are in order 13.");
  expect(html).toContain(`href="/orders/${id(13)}"`);
  expect(html).not.toContain("Your cart is empty");
  expect(html).not.toContain("cart-checkout-link");
});
it("WP-2423 M03 review: an emptied cart whose order closed unpaid offers its dishes back", () => {
  const empty = cart();
  const html = renderPage({
    status: "ready",
    cart: {
      ...empty,
      cart: {
        ...empty.cart,
        items: [],
        quote: null,
        placedOrder: { orderReference: id(13), orderNumber: "13", notMade: true },
      },
    },
  });
  expect(html).toContain("Order closed");
  expect(html).toContain("Order 13 was closed and won’t be made.");
  expect(html).toContain("Put these dishes back in my cart");
  expect(html).toContain(`href="/orders/${id(13)}"`);
  expect(html).not.toContain("Already ordered");
  expect(html).not.toContain("Open it to see whether it’s paid");
});
it("WP-2423 M03 review: a cart filled before this fix says its dishes are already in an order", () => {
  const full = cart();
  const html = renderPage({
    status: "ready",
    cart: {
      ...full,
      cart: {
        ...full.cart,
        placedOrder: { orderReference: id(13), orderNumber: "13", notMade: false },
      },
    },
  });
  expect(html).toContain("Already ordered");
  expect(html).toContain("The dishes in your cart are already in order 13");
  expect(html).toContain(`href="/orders/${id(13)}"`);
  // Its checkout is refused, so it is not offered (the loop back to this cart).
  expect(html).not.toContain("cart-checkout-link");
  expect(html).not.toContain('href="/checkout"');
  // The dishes stay listed so the guest can remove them.
  expect(html).toContain(full.cart.items[0]?.displayName ?? "missing dish");
});
it.each(["FEATURE_DISABLED", "PROJECTION_STALE"])(
  "preserves %s for an empty server Cart",
  (warning) => {
    const empty = cart();
    const html = renderPage({
      status: "ready",
      cart: { ...empty, cart: { ...empty.cart, items: [], warnings: [warning] } },
    });
    expect(html).not.toContain("Your cart is empty");
    expect(html).toContain(
      warning === "FEATURE_DISABLED" ? "Ordering is paused" : "may be out of date",
    );
  },
);
it.each(["command-pending", "offline-readonly", "command-failed"] as const)(
  "does not hide %s behind the empty Cart state",
  (status) => {
    const empty = cart();
    const html = renderPage({
      status,
      cart: { ...empty, cart: { ...empty.cart, items: [] } },
      issueCodes: [],
      retryAfterSeconds: null,
      canRetrySameOperation: true,
    });
    expect(html).not.toContain("Your cart is empty");
    if (status === "command-failed") expect(html).toContain("Outcome not confirmed");
    if (status === "offline-readonly") expect(html).toContain("You’re offline");
  },
);

it.each(["Expired", "Abandoned"] as const)(
  "shows terminal %s from a successful load without checkout",
  (status) => {
    for (const empty of [false, true]) {
      const base = cart();
      const html = renderPage({
        status: "ready",
        cart: {
          ...base,
          cart: {
            ...base.cart,
            lifecycle: { ...base.cart.lifecycle, status },
            items: empty ? [] : base.cart.items,
          },
        },
      });
      expect(html).toContain(status === "Expired" ? "Cart expired" : "Cart closed");
      expect(html).toContain("Ask staff for help continuing your order.");
      expect(html).not.toContain("Your cart is empty");
      expect(html).not.toContain("cart-checkout-link");
      expect(html).not.toContain("Requote");
      expect(html).not.toContain("Continue shopping");
    }
  },
);

it("shows terminal Dining continuation with offline and unknown-outcome guards", () => {
  const terminal: CartView = {
    ...cart(),
    cart: {
      ...cart().cart,
      orderType: "DineIn",
      lifecycle: { ...cart().cart.lifecycle, status: "Expired" },
    },
  };
  for (const status of ["ready", "offline-readonly", "command-pending"] as const) {
    const state = { status, cart: terminal };
    const supplied = { ...controller(state), replaceExpiredCart: async () => undefined };
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CartPage controller={supplied} />
      </MemoryRouter>,
    );
    expect(html).toContain("Start an empty cart");
    // WP-2423: anyone at the table may continue past a timed-out cart.
    expect(html).toContain("Anyone at your table can start an empty cart to keep ordering.");
    expect(html).toContain("Items that weren’t ordered aren’t copied.");
    expect(html).not.toContain("table host");
    if (status !== "ready")
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start an empty cart/);
  }
});

it("shows rescan/staff guidance without retry for a known replacement refusal", () => {
  const current = cart();
  const state: CartState = {
    status: "replacement-forbidden",
    cart: {
      ...current,
      cart: {
        ...current.cart,
        orderType: "DineIn",
        lifecycle: { ...current.cart.lifecycle, status: "Expired" },
      },
    },
    issueCodes: [],
    retryAfterSeconds: null,
    canRetrySameOperation: false,
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={{ ...controller(state), replaceExpiredCart: async () => undefined }} />
    </MemoryRouter>,
  );
  expect(html).toContain("Scan the table QR code again or ask staff for help.");
  expect(html).not.toContain("Retry the same operation");
  expect(html).not.toContain("Outcome not confirmed");
  expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Start an empty cart/);
});

it("WP-2423: an Abandoned dine-in cart stays with the person who started the table", () => {
  const terminal: CartView = {
    ...cart(),
    cart: {
      ...cart().cart,
      orderType: "DineIn",
      lifecycle: { ...cart().cart.lifecycle, status: "Abandoned" },
    },
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CartPage
        controller={{
          ...controller({ status: "ready", cart: terminal }),
          replaceExpiredCart: async () => undefined,
        }}
      />
    </MemoryRouter>,
  );
  expect(html).toContain("Cart closed");
  expect(html).toContain("The person who started the table can start an empty cart");
});

it("WP-2423: a dine-in cart that timed out during a change points back to the menu", () => {
  const current = cart();
  const state: CartState = {
    status: "expired",
    cart: { ...current, cart: { ...current.cart, orderType: "DineIn" } },
    issueCodes: [],
    retryAfterSeconds: null,
    canRetrySameOperation: false,
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={controller(state)} />
    </MemoryRouter>,
  );
  expect(html).toContain("your table continues with a new cart");
  expect(html).not.toContain("Ask staff for help continuing your order.");
  expect(html).toContain("Return to menu");
});

it("WP-2423: a replacement held back by the table's last order says so, not a dropped connection", () => {
  const current = cart();
  const state: CartState = {
    status: "order-processing",
    cart: {
      ...current,
      cart: {
        ...current.cart,
        orderType: "DineIn",
        lifecycle: { ...current.cart.lifecycle, status: "Expired" },
      },
    },
    issueCodes: [],
    retryAfterSeconds: 10,
    canRetrySameOperation: false,
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={{ ...controller(state), replaceExpiredCart: async () => undefined }} />
    </MemoryRouter>,
  );
  expect(html).toContain(
    "Your table’s last order is still being processed. Try again in a moment.",
  );
  expect(html).not.toContain("The connection dropped");
});

it("WP-2423: says another guest at the table is checking out, with the wait", () => {
  const state: CartState = {
    status: "checkout-in-progress",
    cart: cart(),
    issueCodes: [],
    retryAfterSeconds: 90,
    canRetrySameOperation: false,
  };
  const html = renderToStaticMarkup(
    <MemoryRouter>
      <CartPage controller={controller(state)} />
    </MemoryRouter>,
  );
  expect(html).toContain("Another guest is checking out");
  expect(html).toContain(
    "Another guest at your table is paying for this order. Try again in about 2 minutes.",
  );
  expect(html).toContain("Refresh cart");
  expect(html).not.toContain("checkout_in_progress");
});

it("WP-2423: words the checkout-in-progress wait like the order-processing one", () => {
  const base = "Another guest at your table is paying for this order.";
  expect(checkoutInProgressMessage(null)).toBe(`${base} Try again shortly.`);
  expect(checkoutInProgressMessage(1)).toBe(`${base} Try again in a moment.`);
  expect(checkoutInProgressMessage(60)).toBe(`${base} Try again in a moment.`);
  expect(checkoutInProgressMessage(61)).toBe(`${base} Try again in about 2 minutes.`);
  expect(checkoutInProgressMessage(3600)).toBe(`${base} Try again in about 60 minutes.`);
  expect(checkoutInProgressMessage(120)).toBe(`${base} Try again in about 2 minutes.`);
});

describe("WP-2423 item 6: a table that pays at the end", () => {
  afterEach(() => {
    setCustomerCsrfCredential(null);
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "en", children: () => null }));
  });
  const tableCart = (overrides: Partial<CartView["cart"]> = {}): CartView => {
    const base = cart();
    const item = base.cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    return {
      ...base,
      cart: {
        ...base.cart,
        orderType: "DineIn",
        serviceMode: "DineIn",
        quote: null,
        items: [{ ...item, warnings: [] }],
        ...overrides,
      },
    };
  };
  const round = (state: SendRoundState): SendRoundController => ({
    getState: () => state,
    subscribe: () => () => undefined,
    send: async () => undefined,
    reset: () => undefined,
  });
  const page = (state: CartState, send: SendRoundState = { status: "idle" }) => {
    setCustomerCsrfCredential("c".repeat(43));
    setTablePaymentTiming("PayLater");
    return renderToStaticMarkup(
      <MemoryRouter>
        <CartPage controller={controller(state)} sendRound={round(send)} />
      </MemoryRouter>,
    );
  };

  it("at a table that pays at the end the main action is Place order, never Checkout", () => {
    const html = page({ status: "ready", cart: tableCart() });
    expect(html).toContain('<button class="cart-checkout-link" type="button"');
    expect(html).toContain(">Place order</button>");
    expect(html).not.toContain(">Checkout<");
    expect(html).not.toContain('href="/checkout"');
    expect(html).toContain("Nothing is charged now.");
    expect(html).toContain("Allergies? Ask a staff member before you order.");
  });

  it("in Chinese it says 下单, with nothing about paying or checking out on the button", () => {
    setCustomerCsrfCredential("c".repeat(43));
    setTablePaymentTiming("PayLater");
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <CartPage
          controller={controller({ status: "ready", cart: tableCart() })}
          sendRound={round({ status: "idle" })}
        />
      </MemoryRouter>,
    );
    expect(html).toContain(">下单</button>");
    expect(html).not.toContain(">结账<");
    expect(html).toContain("有过敏？点单前请先问店员。");
  });

  it("says nothing about a price lock or checkout in the summary", () => {
    const priced = page({ status: "ready", cart: tableCart() });
    expect(priced).toContain("Subtotal before tax");
    expect(priced).toContain("Tax is added to your table’s bill.");
    expect(priced).not.toContain("at checkout");
    const item = tableCart().cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const noPrices = page({
      status: "ready",
      cart: tableCart({
        items: [{ ...item, lineEstimate: { status: "Unavailable", reasonCode: "QUOTE_REQUIRED" } }],
      }),
    });
    expect(noPrices).toContain("Prices and tax are on your table’s bill.");
    expect(noPrices).not.toContain("at checkout");
    const quoted = page({
      status: "ready",
      cart: tableCart({
        quote: cart().cart.quote,
        warnings: ["QUOTE_EXPIRED"],
      }),
    });
    expect(quoted).not.toContain("Prices confirmed for");
    expect(quoted).not.toContain("Prices have expired");
    expect(quoted).toContain("$11.30");
  });

  it("a table not yet known waits on a disabled Continue; pay-first keeps Checkout", () => {
    setCustomerCsrfCredential("c".repeat(43));
    const unknown = renderToStaticMarkup(
      <MemoryRouter>
        <CartPage
          controller={controller({ status: "ready", cart: tableCart() })}
          sendRound={round({ status: "idle" })}
        />
      </MemoryRouter>,
    );
    expect(unknown).toContain('type="button" disabled="">Continue</button>');
    expect(unknown).not.toContain(">Checkout<");
    setTablePaymentTiming("PayFirst");
    const payFirst = renderToStaticMarkup(
      <MemoryRouter>
        <CartPage
          controller={controller({ status: "ready", cart: tableCart() })}
          sendRound={round({ status: "idle" })}
        />
      </MemoryRouter>,
    );
    expect(payFirst).toContain('href="/checkout"');
    expect(payFirst).toContain(">Checkout<");
    expect(payFirst).not.toContain("Place order");
  });

  it("holds the cart still while a round is on its way", () => {
    const html = page({ status: "ready", cart: tableCart() }, { status: "sending" });
    expect(html).toContain(">Placing your order…</button>");
    expect(html).toContain('disabled="">Placing your order…');
    // − (already at the end of its range is not the point: all three controls are held).
    expect(html).toContain('disabled="" aria-label="Decrease Synthetic tea quantity"');
    expect(html).toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
    expect(html).toMatch(/disabled="">Remove/u);
    expect(html).toContain('aria-disabled="true"');
    // Its answer is only said here, so the journey bar holds still with Continue shopping.
    expect(html).toMatch(/<a aria-disabled="true"[^>]*href="\/menu"[^>]*>Menu<\/a>/u);
    expect(html).toMatch(/<a aria-disabled="true"[^>]*href="\/dine-in\/session"[^>]*>Your table</u);
    const idle = page({ status: "ready", cart: tableCart() });
    expect(idle).not.toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
    expect(idle).not.toContain('aria-disabled="true"');
  });

  it("says when the tap also places what other guests added", () => {
    const base = tableCart();
    const item = base.cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const shared = tableCart({
      items: [{ ...item, warnings: ["OTHER_PARTICIPANT_ITEM"] }],
    });
    expect(page({ status: "ready", cart: shared })).toContain(
      "This also places 2 items other guests added.",
    );
    expect(page({ status: "ready", cart: base })).not.toContain("other guests added");
    const one = tableCart({
      items: [{ ...item, quantity: 1, warnings: ["OTHER_PARTICIPANT_ITEM"] }],
    });
    expect(page({ status: "ready", cart: one })).toContain(
      "This also places 1 item another guest added.",
    );
  });

  it("asks once about a total that went up, with the total on the button", () => {
    const html = page(
      { status: "ready", cart: tableCart() },
      {
        status: "confirm-total",
        total: { amountMinor: "2260", currency: "CAD" },
        reason: "changed",
      },
    );
    expect(html).toContain(
      '<p role="alert">The price changed since you added this. It now comes to $22.60 with tax.</p>',
    );
    expect(html).toContain(">Place order · $22.60</button>");
    expect(
      page(
        { status: "ready", cart: tableCart() },
        {
          status: "confirm-total",
          total: { amountMinor: "2260", currency: "CAD" },
          reason: "shown",
        },
      ),
    ).toContain("This order comes to $22.60 with tax.");
    expect(
      page(
        { status: "ready", cart: tableCart() },
        {
          status: "confirm-total",
          total: { amountMinor: "2260", currency: "CAD" },
          reason: "fees",
        },
      ),
    ).toContain("This order comes to $22.60 with tax and fees.");
  });

  it("an answer that got lost is said above an emptied cart, with the way to finish it", () => {
    const maybePlaced = { status: "unconfirmed", mayBePlaced: true } as const;
    const html = page({ status: "empty" }, maybePlaced);
    expect(html).toContain("We couldn’t confirm your order was placed. Try again");
    expect(html).toContain(">Try again</button>");
    expect(html).toContain('href="/dine-in/session"');
    expect(html).toContain("Check your table");
    expect(html.indexOf("We couldn’t confirm your order")).toBeLessThan(
      html.indexOf("Your cart is empty"),
    );
    // Also while the cart is offline or still loading.
    for (const state of [
      { status: "offline-readonly", cart: null },
      { status: "loading" },
    ] as const)
      expect(page(state, maybePlaced)).toContain(">Try again</button>");
    // The cart it may have emptied can't be changed meanwhile.
    expect(page({ status: "ready", cart: tableCart() }, maybePlaced)).toContain(
      'disabled="" aria-label="Increase Synthetic tea quantity"',
    );
  });

  it("an answer lost before any send says nothing was placed, and leaves the cart free", () => {
    const html = page(
      { status: "ready", cart: tableCart() },
      { status: "unconfirmed", mayBePlaced: false },
    );
    expect(html).toContain("We couldn’t place your order, so nothing was sent.");
    expect(html).not.toContain("We couldn’t confirm");
    expect(html).toContain(">Try again</button>");
    expect(html).not.toContain("Check your table");
    expect(html).not.toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
    expect(html).not.toMatch(/disabled="">Remove/u);
    expect(html).toMatch(/type="button">Place order</u);
  });

  it("when someone else just placed it, an empty cart says so and points at the table", () => {
    const html = page({ status: "empty" }, { status: "cart-changed" });
    expect(html).toContain("Someone at your table just placed this order.");
    expect(html).toContain('class="cart-primary-link" href="/dine-in/session"');
    expect(html).toContain("See your table");
    expect(html).toContain("Browse menu");
    expect(html).not.toContain("Your cart is empty");
    // Without a send that ended that way, an empty cart is just empty.
    expect(page({ status: "empty" })).toContain("Your cart is empty");
  });

  it("names a dish that ran out, and each other stop in plain words", () => {
    const item = tableCart().cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const ready = { status: "ready", cart: tableCart() } as const;
    expect(
      page(ready, {
        status: "refused",
        refusal: "item_short",
        line: { cartItemReference: item.cartItemReference, available: 0, sharedStock: false },
      }),
    ).toContain("Synthetic tea (Synthetic size) just sold out.");
    const closed = page(ready, { status: "store-closed" });
    expect(closed).toContain("The store isn’t taking new orders right now");
    expect(closed).toContain("Back to your table");
    expect(page(ready, { status: "table-checking-out" })).toContain(
      "New dishes can’t be sent while the bill is being settled.",
    );
    expect(page(ready, { status: "session-ended" })).toContain("Your session ended.");
    const changed = page(ready, { status: "cart-changed" });
    expect(changed).toContain("so nothing was placed yet");
    expect(changed).toContain("tap Place order");
    expect(changed).not.toContain("submitting");
    expect(
      page(ready, { status: "blocked", messages: ["This order can’t be paid yet."] }),
    ).toContain("This order can’t be paid yet.");
  });

  it("WP-2423 guest-cart-503: names the dish the Store can't sell now; the round wasn't sent", () => {
    const item = tableCart().cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const ready = { status: "ready", cart: tableCart() } as const;
    const line = { cartItemReference: item.cartItemReference, available: null, sharedStock: false };
    const unavailable = page(ready, { status: "refused", refusal: "item_unavailable", line });
    expect(unavailable).toContain(
      "Synthetic tea (Synthetic size) isn’t available right now, so this round hasn’t been sent. Remove Synthetic tea (Synthetic size), then tap Place order.",
    );
    // Nothing is charged at a table that pays at the end: never "hasn't been charged".
    expect(unavailable).not.toContain("hasn’t been charged");
    expect(page(ready, { status: "refused", refusal: "item_options_changed", line })).toContain(
      "The choices for Synthetic tea (Synthetic size) have changed, so this round hasn’t been sent.",
    );
  });

  it("WP-2423 guest-cart-503: marks a dish not sold now, lets anyone remove it, and holds Order", () => {
    const item = tableCart().cart.items[0];
    if (item === undefined) throw new Error("synthetic item missing");
    const marked = tableCart({
      items: [{ ...item, warnings: ["OTHER_PARTICIPANT_ITEM", "ITEM_UNAVAILABLE"] }],
    });
    const html = page({ status: "ready", cart: marked });
    expect(html).toContain("Not available right now. Remove it to order the rest.");
    expect(html).toContain("Added by another guest. Anyone at the table can remove it now.");
    expect(html).not.toContain("Only they can change this item.");
    expect(html).not.toContain("ITEM_UNAVAILABLE");
    // Remove is enabled for that line; the other controls stay the adder's.
    expect(html).toMatch(/aria-describedby="cart-item-ownership-[^"]+">Remove/u);
    expect(html).toContain('disabled="" aria-label="Increase Synthetic tea quantity"');
    // Order waits until no such line is left, and says why.
    expect(html).toMatch(/disabled="" aria-describedby="cart-remove-unavailable">Place order/u);
    expect(html).toContain("Remove the dishes that aren’t available right now, then order.");
    const options = page({
      status: "ready",
      cart: tableCart({ items: [{ ...item, warnings: ["ITEM_OPTIONS_CHANGED"] }] }),
    });
    expect(options).toContain(
      "The choices for this item have changed. Remove it, then add it again.",
    );
    expect(page({ status: "ready", cart: tableCart() })).not.toContain("cart-remove-unavailable");
  });

  it("WP-2423 guest-cart-503: the open table cart re-reads only on screen and never mid-send", () => {
    expect(cartPollIntervalMs).toBe(15_000);
    const ready = { status: "ready", cart: tableCart() } as const;
    expect(cartPollShouldRead("visible", { status: "idle" }, ready)).toBe(true);
    expect(cartPollShouldRead("hidden", { status: "idle" }, ready)).toBe(false);
    expect(cartPollShouldRead("visible", { status: "sending" }, ready)).toBe(false);
    expect(cartPollShouldRead("visible", { status: "unconfirmed", mayBePlaced: true }, ready)).toBe(
      false,
    );
    expect(
      cartPollShouldRead("visible", { status: "idle" }, {
        status: "command-pending",
        cart: tableCart(),
      } as never),
    ).toBe(false);
  });

  it("another guest placing an order never reads as paying, in either language", () => {
    const busy: SendRoundState = {
      status: "busy",
      wait: "checkout-in-progress",
      retryAfterSeconds: 30,
    };
    const english = page({ status: "ready", cart: tableCart() }, busy);
    expect(english).toContain("Someone at your table is placing an order. Try again in a moment.");
    expect(english).not.toContain("paying");
    setCustomerCsrfCredential("c".repeat(43));
    setTablePaymentTiming("PayLater");
    renderToStaticMarkup(createElement(LanguageRoot, { initial: "zh-Hans", children: () => null }));
    const blocked = renderToStaticMarkup(
      <MemoryRouter>
        <CartPage
          controller={controller({
            status: "checkout-in-progress",
            cart: tableCart(),
            issueCodes: [],
            retryAfterSeconds: 30,
            canRetrySameOperation: false,
          })}
          sendRound={round({ status: "idle" })}
        />
      </MemoryRouter>,
    );
    expect(blocked).toContain("同桌有人正在下单");
    // A send stopped by another guest's change says nothing went out, and names the button.
    expect(page({ status: "ready", cart: tableCart() }, { status: "cart-changed" })).toContain(
      "同桌的购物车有变化，还没有下单。请看一下再点“下单”。",
    );
    const error = blocked.slice(blocked.indexOf("cart-state"), blocked.indexOf("cart-layout"));
    expect(error).not.toMatch(/付款|结账/u);
  });
});
