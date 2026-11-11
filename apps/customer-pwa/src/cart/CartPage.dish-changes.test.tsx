// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CartPage } from "./CartPage.js";
import type { CartState, CartStateController } from "./cart-state.js";
import type { CartView } from "./types.js";
import { clearSeenPrices } from "./seen-prices.js";
import type { SendRoundController, SendRoundState } from "../checkout/send-round.js";
import type { CheckoutQuote } from "../checkout/types.js";
import type { CustomerMenuClient } from "../menu/types.js";
import {
  setCustomerCsrfCredential,
  setTablePaymentTiming,
} from "../session/customer-transaction-context.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const id = (n: number) => `018f5310-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cad = (amountMinor: string) => ({ amountMinor, currency: "CAD" });
const cart: CartView = {
  schemaVersion: 1,
  cart: {
    cartReference: id(1),
    version: 3,
    orderType: "DineIn",
    serviceMode: "DineIn",
    context: { brandName: "Synthetic Brand", storeName: "Synthetic Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2099-01-01T00:00:00.000Z",
      absoluteExpiresAt: "2099-01-02T00:00:00.000Z",
    },
    items: [
      {
        cartItemReference: id(2),
        sellableReference: id(3),
        displayName: "Synthetic noodles",
        quantity: 1,
        configuration: [],
        customerNote: null,
        lineEstimate: { status: "Available", total: cad("1300") },
        warnings: [],
      },
    ],
    quote: null,
    warnings: [],
  },
} as unknown as CartView;
const quote = (reference: string, renamed: boolean): CheckoutQuote => ({
  quoteReference: reference,
  quoteVersion: 2,
  cartVersion: 3,
  subtotal: cad("1300"),
  discount: cad("0"),
  tax: cad("169"),
  fee: cad("0"),
  total: cad("1469"),
  expiresAt: "2099-01-01T00:00:00.000Z",
  warnings: [],
  blockingReasons: [],
  priceChange: null,
  lines: [{ cartItemReference: id(2), quantity: 1, subtotal: cad("1300") }],
  sinceAdded: renamed
    ? [
        {
          cartItemReference: id(2),
          quantity: 1,
          subtotal: cad("1300"),
          changes: ["Name", "Allergens"],
        },
      ]
    : [],
});
const controller = (state: CartState): CartStateController => ({
  getState: () => state,
  load: async () => undefined,
  refresh: async () => true,
  removeItem: async () => undefined,
  retry: async () => undefined,
  setOnline: () => undefined,
  subscribe: () => () => undefined,
  updateItem: async () => undefined,
});
const menuClient: CustomerMenuClient = {
  load: async () => ({ status: "unavailable" }) as never,
};

beforeEach(() => {
  clearSeenPrices();
  setCustomerCsrfCredential("c".repeat(43));
  setTablePaymentTiming("PayLater");
});
afterEach(() => {
  setCustomerCsrfCredential(null);
  document.body.replaceChildren();
  clearSeenPrices();
});

it("price-hold-dish-changes: a round stopped for a dish changed after the cart was shown lists it, and Place order waits for the tick on that quote", async () => {
  // The cart was shown with nothing changed (Q1); at the tap the Store priced the renamed dish (Q2).
  let roundState: SendRoundState = { status: "idle" };
  const listeners = new Set<() => void>();
  const send = vi.fn<SendRoundController["send"]>(async () => undefined);
  const round: SendRoundController = {
    getState: () => roundState,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    send,
    reset: () => undefined,
  };
  const shown = quote(id(10), false);
  const changed = quote(id(11), true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <CartPage
          controller={controller({ status: "ready", cart } as CartState)}
          sendRound={round}
          menuClient={menuClient}
          storeProfile={null}
          quoteClient={{ quote: async () => shown }}
        />
      </MemoryRouter>,
    );
  });
  await act(async () => new Promise((resolve) => setTimeout(resolve, 2_100)));
  const place = () =>
    [...container.querySelectorAll("button")].find((button) =>
      button.textContent?.startsWith("Place order"),
    );
  expect(place()?.disabled).toBe(false);
  expect(container.textContent).not.toContain("Changed since you added it");
  await act(async () => place()?.click());
  expect(send.mock.calls[0]?.[2]).toEqual(shown);
  // The round answers: the dish changed since it was added.
  roundState = { status: "confirm-changes", quote: changed };
  await act(async () => listeners.forEach((listener) => listener()));
  expect(container.textContent).toContain("Changed since you added it:");
  expect(container.textContent).toContain("Synthetic noodles was renamed since you added it.");
  expect(container.textContent).toContain(
    "A dish changed since you added it. Nothing was ordered.",
  );
  expect(place()?.disabled).toBe(true);
  const tick = container.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(tick?.checked).toBe(false);
  await act(async () => tick?.click());
  expect(place()?.disabled).toBe(false);
  await act(async () => place()?.click());
  // The quote the guest ticked is the one handed to the round.
  expect(send.mock.calls[1]?.[2]).toEqual(changed);
  act(() => root.unmount());
});

it("price-hold-dish-changes: a round that cannot say whether a dish changed says so and offers try again", async () => {
  const unknown: SendRoundState = { status: "changes-unknown" };
  const round: SendRoundController = {
    getState: () => unknown,
    subscribe: () => () => undefined,
    send: async () => undefined,
    reset: () => undefined,
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter>
        <CartPage
          controller={controller({ status: "ready", cart } as CartState)}
          sendRound={round}
          menuClient={menuClient}
          storeProfile={null}
          quoteClient={{ quote: async () => quote(id(10), false) }}
        />
      </MemoryRouter>,
    );
  });
  expect(container.textContent).toContain(
    "We couldn’t check whether a dish changed since you added it, so nothing was ordered or charged.",
  );
  expect(
    [...container.querySelectorAll("button")].some((button) => button.textContent === "Try again"),
  ).toBe(true);
  act(() => root.unmount());
});
