import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserCustomerCartClient, setCustomerCartCsrfCredential } from "./cart-client.js";
import { CartClientError, type CartView } from "./types.js";

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
      items: [],
      quote: null,
      warnings: [],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setCustomerCartCsrfCredential(null);
});

describe("Customer Cart browser client", () => {
  it("loads only the same-origin network Cart and runtime-validates it", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(cart()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    expect(await createBrowserCustomerCartClient().loadCurrent()).toEqual(cart());
    expect(fetch).toHaveBeenCalledWith("/bff/customer/cart", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
  });

  it("keeps CSRF and operation context in memory and sends no client money", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(cart()), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    setCustomerCartCsrfCredential("c".repeat(43));
    await createBrowserCustomerCartClient().updateItem({
      cart: cart(),
      cartItemReference: id(2),
      operationReference: id(20),
      draft: { quantity: 2, optionSelections: [], customerNote: null },
    });
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(init).toMatchObject({
      method: "PATCH",
      cache: "no-store",
      credentials: "same-origin",
      headers: {
        "idempotency-key": id(20),
        "if-match": '"3"',
        "x-csrf-token": "c".repeat(43),
      },
    });
    expect(init.body).toBe('{"quantity":2,"optionSelections":[],"customerNote":null}');
    expect(String(init.body)).not.toMatch(/price|tax|amount|brand|store/iu);
  });

  it("fails closed without an in-memory CSRF credential", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      createBrowserCustomerCartClient().removeItem({
        cart: cart(),
        cartItemReference: id(2),
        operationReference: id(20),
      }),
    ).rejects.toMatchObject({ code: "cart_session_expired" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("clears the in-memory CSRF credential when the server expires the session", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ error: { code: "cart_session_expired", messageKey: "safe" } }),
          { status: 401 },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    setCustomerCartCsrfCredential("c".repeat(43));
    await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
      code: "cart_session_expired",
    });
    await expect(
      createBrowserCustomerCartClient().removeItem({
        cart: cart(),
        cartItemReference: id(2),
        operationReference: id(20),
      }),
    ).rejects.toMatchObject({ code: "cart_session_expired" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("maps rate-limit, malformed success and network ambiguity without inferring success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ error: { code: "cart_rate_limited", messageKey: "safe" } }),
            { status: 429, headers: { "Retry-After": "7" } },
          ),
      ),
    );
    await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
      code: "cart_rate_limited",
      retryAfterSeconds: 7,
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ schemaVersion: 1 }))),
    );
    await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
      code: "cart_service_unavailable",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Promise.reject(new TypeError("network"))),
    );
    await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
      code: "network_unknown",
    } satisfies Partial<CartClientError>);
  });
});
