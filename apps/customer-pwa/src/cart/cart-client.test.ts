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
    expect(fetch).toHaveBeenCalledWith(
      "/bff/customer/cart",
      expect.objectContaining({
        method: "GET",
        cache: "no-store",
        credentials: "same-origin",
        signal: expect.any(AbortSignal),
      }),
    );
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

  it("creates and adds with separate exact operation keys and server Cart version", async () => {
    const created = cart();
    const added = {
      ...cart(),
      cart: {
        ...cart().cart,
        version: 4,
        items: [
          {
            cartItemReference: id(30),
            sellableReference: id(3),
            displayName: "Synthetic tea",
            quantity: 1,
            configuration: [],
            customerNote: null,
            lineEstimate: { status: "Unavailable", reasonCode: "FINAL_QUOTE_REQUIRED" },
            warnings: [],
          },
        ],
      },
    } satisfies CartView;
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(created), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(added), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    setCustomerCartCsrfCredential("c".repeat(43));
    const client = createBrowserCustomerCartClient();
    await client.createCart({ operationReference: id(20) });
    await client.addItem({
      cart: created,
      sellableReference: id(3),
      operationReference: id(21),
      draft: { quantity: 1, optionSelections: [], customerNote: null },
    });
    expect(fetch.mock.calls[0]?.[0]).toBe("/api/v1/carts");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      method: "POST",
      headers: { "idempotency-key": id(20), "x-csrf-token": "c".repeat(43) },
      body: "{}",
    });
    expect(fetch.mock.calls[1]?.[0]).toBe(`/api/v1/carts/${id(1)}/items`);
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      headers: { "idempotency-key": id(21), "if-match": '"3"' },
    });
    expect(String(fetch.mock.calls[1]?.[1]?.body)).toBe(
      `{"sellableReference":"${id(3)}","quantity":1,"optionSelections":[],"customerNote":null}`,
    );
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

const writeCases = ["createCart", "addItem", "updateItem", "removeItem"] as const;
describe("uncertain Cart response transport", () => {
  it.each(writeCases)("keeps %s malformed/unavailable responses unknown", async (method) => {
    const client = createBrowserCustomerCartClient();
    const input = {
      cart: cart(),
      cartItemReference: id(2),
      sellableReference: id(3),
      operationReference: id(20),
      draft: { quantity: 2, optionSelections: [], customerNote: null },
    };
    setCustomerCartCsrfCredential("c".repeat(43));
    for (const response of [
      new Response("broken", { status: 200 }),
      new Response("{}", { status: 200 }),
      new Response(JSON.stringify({ error: { code: "cart_service_unavailable" } }), {
        status: 503,
      }),
      new Response(JSON.stringify({ error: { code: "cart_session_expired" } }), { status: 503 }),
      new Response(JSON.stringify({ error: { code: "cart_selection_invalid" } }), { status: 500 }),
    ]) {
      const fetch = vi.fn(async () => response);
      vi.stubGlobal("fetch", fetch);
      await expect(client[method](input)).rejects.toMatchObject({ code: "network_unknown" });
      expect(fetch).toHaveBeenCalledTimes(1);
    }
    const fetch = vi.fn(async () => new Response(JSON.stringify(cart())));
    vi.stubGlobal("fetch", fetch);
    await expect(client[method](input)).resolves.toEqual(cart());
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    [400, "cart_request_invalid"],
    [401, "cart_session_expired"],
    [404, "cart_not_found"],
    [409, "cart_version_conflict"],
    [409, "cart_idempotency_conflict"],
    [422, "cart_selection_invalid"],
    [409, "cart_expired"],
    [409, "cart_abandoned"],
    [429, "cart_rate_limited"],
  ])("retains matching %s/%s rejection semantics", async (status, code) => {
    setCustomerCartCsrfCredential("c".repeat(43));
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () => new Response(JSON.stringify({ error: { code } }), { status: Number(status) }),
      ),
    );
    await expect(
      createBrowserCustomerCartClient().createCart({ operationReference: id(20) }),
    ).rejects.toMatchObject({ code });
  });
});
