// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CheckoutPage } from "./CheckoutPage.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import type { CheckoutController } from "./checkout-client.js";
import type { CheckoutQuote, CheckoutState } from "./types.js";
import type { CartView } from "../cart/types.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => "01909992-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-11T00:00:00.000Z",
  until = "2026-09-11T00:05:00.000Z";
const cart: CartView = {
  schemaVersion: 1,
  cart: {
    cartReference: id(1),
    version: 2,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-09-11T01:00:00.000Z",
      absoluteExpiresAt: "2026-09-12T01:00:00.000Z",
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
  cartVersion: 2,
  subtotal: { amountMinor: "100", currency: "CAD" },
  discount: { amountMinor: "0", currency: "CAD" },
  tax: { amountMinor: "13", currency: "CAD" },
  fee: { amountMinor: "0", currency: "CAD" },
  total: { amountMinor: "113", currency: "CAD" },
  expiresAt: until,
  warnings: [],
  blockingReasons: [],
  priceChange: null,
  tips: { enabled: false, tierPercents: [] },
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
beforeEach(() => setCustomerCsrfCredential("c".repeat(43)));
afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCsrfCredential(null);
  document.body.replaceChildren();
});

it("WP-2423 live minor 24: a details save answering the cart moved reads the cart again, and an ordered cart shows its order", async () => {
  // Another tab ordered this cart: its version moved, so this tab's details save answers "changed".
  let saved = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/bff/customer/checkout-details/current")
        return json({
          schemaVersion: 1,
          checkout: {
            cartReference: cart.cart.cartReference,
            cartVersion: cart.cart.version,
            orderType: "Pickup",
            details: {
              detailsReference: id(5),
              detailsVersion: 1,
              cartReference: cart.cart.cartReference,
              cartVersion: cart.cart.version,
              quoteReference: quote.quoteReference,
              quoteVersion: 1,
              pickupContact: { name: "Synthetic Guest", channel: "Phone", value: "+14165550100" },
              receipt: { choice: "InSession", email: null },
              policies: [],
              recordedAt: at,
            },
          },
        });
      if (path === "/bff/customer/checkout-details/policy")
        return json({
          schemaVersion: 1,
          policy: {
            cartReference: cart.cart.cartReference,
            cartVersion: cart.cart.version,
            orderType: "Pickup",
            checkedAt: at,
            validUntil: until,
            documents: [],
          },
        });
      if (path === "/bff/customer/checkout-details" && init?.method === "POST") {
        saved = true;
        return json(
          {
            schemaVersion: 1,
            error: {
              code: "details_version_conflict",
              messageKey: "customer.checkout.version_conflict",
            },
          },
          409,
        );
      }
      return json({ schemaVersion: 1, error: { code: "unknown" } }, 503);
    }),
  );
  // The cart as read again after the save conflict: the other tab's order holds its dishes.
  let state: CheckoutState = { status: "ready", cart, quote };
  const listeners = new Set<() => void>();
  const load = vi.fn(async () => {
    if (!saved) return;
    state = {
      status: "ready",
      cart: {
        ...cart,
        cart: {
          ...cart.cart,
          placedOrder: { orderReference: id(13), orderNumber: "13", notMade: false },
        },
      },
      quote: null,
    };
    listeners.forEach((listener) => listener());
  });
  const controller: CheckoutController = {
    getState: () => state,
    load,
    quote: async () => undefined,
    retry: async () => undefined,
    setOnline: () => undefined,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const container = document.createElement("div");
  document.body.append(container);
  const settle = async () => {
    for (let index = 0; index < 20; index += 1)
      await act(async () => {
        await Promise.resolve();
      });
  };
  await act(async () => {
    createRoot(container).render(
      <MemoryRouter>
        <CheckoutPage controller={controller} now={() => Date.parse(at)} />
      </MemoryRouter>,
    );
  });
  await settle();
  const pay = container.querySelector<HTMLButtonElement>("button.checkout-continue__button");
  expect(pay?.textContent).toContain("Continue to payment");
  expect(pay?.disabled).toBe(false);
  await act(async () => {
    pay?.click();
  });
  await settle();
  expect(saved).toBe(true);
  expect(load).toHaveBeenCalledTimes(2);
  expect(container.textContent).toContain("The dishes in your cart are already in order 13");
  expect(container.querySelector(`a[href="/orders/${id(13)}"]`)).not.toBeNull();
  expect(container.textContent).not.toContain("Continue to payment");
});
