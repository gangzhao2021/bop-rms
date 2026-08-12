import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerCartClient } from "../cart/cart-client.js";
import { CartClientError, type CartView } from "../cart/types.js";
import { setCustomerCsrfCredential } from "../session/customer-transaction-context.js";
import {
  createCheckoutClient,
  createCheckoutController,
  type CheckoutClient,
} from "./checkout-client.js";
import type { CheckoutQuote } from "./types.js";

const id = (n: number) => `018f7700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const cart: CartView = {
  schemaVersion: 1,
  cart: {
    cartReference: id(1),
    version: 3,
    orderType: "Pickup",
    serviceMode: "Pickup",
    context: { brandName: "Synthetic", storeName: "Store" },
    lifecycle: {
      status: "Active",
      idleExpiresAt: "2026-08-12T01:00:00.000Z",
      absoluteExpiresAt: "2026-08-13T01:00:00.000Z",
    },
    items: [
      {
        cartItemReference: id(2),
        sellableReference: id(3),
        displayName: "Tea",
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
  warnings: [],
  blockingReasons: [],
  priceChange: null,
};

const publicQuote = {
  schemaVersion: 1,
  quote: {
    quoteReference: id(4),
    quoteVersion: 1,
    cartVersion: 3,
    currency: "CAD",
    subtotal: { amountMinor: "100", currency: "CAD" },
    discount: { amountMinor: "0", currency: "CAD" },
    tax: { amountMinor: "13", currency: "CAD" },
    fee: { amountMinor: "0", currency: "CAD" },
    total: { amountMinor: "113", currency: "CAD" },
    expiresAt: "2026-08-12T00:05:00.000Z",
    warnings: [],
    blockingReasons: [],
    priceChange: null,
  },
};

afterEach(() => {
  setCustomerCsrfCredential(null);
  vi.unstubAllGlobals();
});

describe("WP-1703 Checkout transport", () => {
  it("sends the page-memory CSRF credential and accepts the closed public Quote", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify(publicQuote), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    setCustomerCsrfCredential("c".repeat(43));
    const client = createCheckoutClient({} as CustomerCartClient);

    await expect(client.quote(cart, id(9))).resolves.toEqual(quote);
    expect(fetchMock).toHaveBeenCalledWith(`/api/v1/carts/${id(1)}/quote`, {
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        "content-type": "application/json",
        "idempotency-key": id(9),
        "x-csrf-token": "c".repeat(43),
      },
      body: JSON.stringify({ cartVersion: 3 }),
    });
  });

  it("fails a response carrying an unapproved internal field closed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              ...publicQuote,
              quote: { ...publicQuote.quote, taxEvidence: { source: "private" } },
            }),
            { status: 200 },
          ),
      ),
    );
    setCustomerCsrfCredential("c".repeat(43));
    const client = createCheckoutClient({} as CustomerCartClient);

    await expect(client.quote(cart, id(9))).rejects.toMatchObject({
      code: "cart_service_unavailable",
    });
  });

  it("makes no Quote request without the page-memory CSRF credential", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createCheckoutClient({} as CustomerCartClient);

    await expect(client.quote(cart, id(9))).rejects.toMatchObject({
      code: "cart_session_expired",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("makes no request with a malformed in-memory credential or operation key", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = createCheckoutClient({} as CustomerCartClient);
    setCustomerCsrfCredential("malformed");
    await expect(client.quote(cart, id(9))).rejects.toMatchObject({
      code: "cart_request_invalid",
    });
    setCustomerCsrfCredential("c".repeat(43));
    await expect(client.quote(cart, "malformed")).rejects.toMatchObject({
      code: "cart_request_invalid",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("WP-1703 Checkout state", () => {
  it("loads and accepts only the server Quote", async () => {
    const client: CheckoutClient = { loadCart: async () => cart, quote: async () => quote };
    const controller = createCheckoutController(client, () => id(9));
    await controller.load();
    await controller.quote();
    expect(controller.getState()).toEqual({ status: "ready", cart, quote });
  });

  it("retries an unknown outcome with the same operation key", async () => {
    const keys: string[] = [];
    let fail = true;
    const client: CheckoutClient = {
      loadCart: async () => cart,
      async quote(_cart, key) {
        keys.push(key);
        if (fail) throw new CartClientError("network_unknown");
        return quote;
      },
    };
    const controller = createCheckoutController(client, () => id(9));
    await controller.load();
    await controller.quote();
    expect(controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
    fail = false;
    await controller.retry();
    expect(keys).toEqual([id(9), id(9)]);
  });

  it("refreshes Cart after a definitive Quote version conflict", async () => {
    const refreshed = {
      ...cart,
      cart: { ...cart.cart, version: 4 },
    } satisfies CartView;
    let loads = 0;
    const client: CheckoutClient = {
      loadCart: async () => {
        loads += 1;
        return loads === 1 ? cart : refreshed;
      },
      quote: async () => {
        throw new CartClientError("cart_version_conflict");
      },
    };
    const controller = createCheckoutController(client, () => id(9));
    await controller.load();
    await controller.quote();

    expect(controller.getState()).toEqual({
      status: "conflict",
      cart: refreshed,
      canRetry: false,
    });
  });

  it("never calls or auto-replays Quote while offline", async () => {
    let calls = 0;
    const client: CheckoutClient = {
      loadCart: async () => cart,
      quote: async () => {
        calls += 1;
        return quote;
      },
    };
    const controller = createCheckoutController(client);
    await controller.load();
    controller.setOnline(false);
    await controller.quote();
    controller.setOnline(true);
    expect(calls).toBe(0);
    expect(controller.getState()).toMatchObject({ status: "offline" });
  });
});
