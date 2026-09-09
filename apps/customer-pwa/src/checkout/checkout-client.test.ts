import { afterEach, describe, expect, it, vi } from "vitest";
import type { CustomerCartClient } from "../cart/cart-client.js";
import { CartClientError, type CartView } from "../cart/types.js";
import {
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/carts/${id(1)}/quote`,
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "idempotency-key": id(9),
          "x-csrf-token": "c".repeat(43),
        },
        body: JSON.stringify({ cartVersion: 3 }),
        signal: expect.any(AbortSignal),
      }),
    );
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
      code: "network_unknown",
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

  it("coalesces concurrent Quote writes into one key and one request", async () => {
    let release!: (value: CheckoutQuote) => void;
    let quoteCalls = 0;
    let keyCalls = 0;
    const gate = new Promise<CheckoutQuote>((resolve) => {
      release = resolve;
    });
    const client: CheckoutClient = {
      loadCart: async () => cart,
      quote: async () => {
        quoteCalls += 1;
        return gate;
      },
    };
    const controller = createCheckoutController(client, () => {
      keyCalls += 1;
      return id(9);
    });
    await controller.load();
    const first = controller.quote();
    const second = controller.quote();
    expect(second).toBe(first);
    expect({ quoteCalls, keyCalls }).toEqual({ quoteCalls: 1, keyCalls: 1 });
    release(quote);
    await Promise.all([first, second]);
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

describe("bounded foreground Quote responses", () => {
  const original = "c".repeat(43);
  const replacement = "d".repeat(43);
  const client = () => createCheckoutClient({} as CustomerCartClient);
  const success = () => new Response(JSON.stringify(publicQuote), { status: 201 });
  const error = (code: string, status: number) =>
    new Response(
      JSON.stringify({ schemaVersion: 1, error: { code, messageKey: "customer.quote.synthetic" } }),
      { status },
    );
  function pendingResponse() {
    let resolve: (response: Response) => void = () => undefined;
    const promise = new Promise<Response>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  }
  it.each(["headers", "body"])("bounds stalled %s even when abort is ignored", async (stage) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const fetch = vi.fn(async () =>
      stage === "headers" ? new Promise<Response>(() => undefined) : new Response(body),
    );
    vi.stubGlobal("fetch", fetch);
    setCustomerCsrfCredential(original);
    const result = client().quote(cart, id(9));
    const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        mode: "cors",
        cache: "no-store",
        credentials: "same-origin",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    if (stage === "body") {
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    }
  });
  it("shares one deadline across delayed headers and body", async () => {
    vi.useFakeTimers();
    const pending = pendingResponse();
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => pending.promise),
    );
    setCustomerCsrfCredential(original);
    const result = client().quote(cart, id(9));
    const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    await vi.advanceTimersByTimeAsync(14000);
    pending.resolve(new Response(body));
    await vi.advanceTimersByTimeAsync(1000);
    await rejected;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancels a late successful body without parsing or replaying it", async () => {
    vi.useFakeTimers();
    const pending = pendingResponse();
    const fetch = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetch);
    setCustomerCsrfCredential(original);
    const result = client().quote(cart, id(9));
    const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    await vi.advanceTimersByTimeAsync(15000);
    await rejected;
    const response = success();
    const cancel = vi.spyOn(response.body as ReadableStream<Uint8Array>, "cancel");
    pending.resolve(response);
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(response.body?.locked).toBe(false);
    expect(fetch).toHaveBeenCalledOnce();
    expect(getCustomerCsrfCredential()).toBe(original);
  });
  it.each(["json", "utf8", "oversize", "interrupted", "redirect"])(
    "keeps %s output uncertain",
    async (mode) => {
      const bytes =
        mode === "oversize"
          ? new Uint8Array(16 * 1024 * 1024 + 1)
          : mode === "utf8"
            ? new Uint8Array([0xc3, 0x28])
            : new TextEncoder().encode("{");
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (mode === "interrupted") controller.error(new Error("synthetic stream failure"));
          else {
            controller.enqueue(bytes);
            controller.close();
          }
        },
      });
      const response = new Response(body);
      if (mode === "redirect") Object.defineProperty(response, "redirected", { value: true });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => response),
      );
      setCustomerCsrfCredential(original);
      await expect(client().quote(cart, id(9))).rejects.toMatchObject({ code: "network_unknown" });
      expect(body.locked).toBe(false);
      expect(getCustomerCsrfCredential()).toBe(original);
    },
  );
  it.each([
    ["quote_version_conflict", 409, "cart_version_conflict"],
    ["quote_idempotency_conflict", 409, "cart_idempotency_conflict"],
    ["quote_configuration_invalid", 422, "cart_selection_invalid"],
    ["quote_request_invalid", 400, "cart_request_invalid"],
  ] as const)("retains matching %s rejection", async (code, status, mapped) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => error(code, status)),
    );
    setCustomerCsrfCredential(original);
    await expect(client().quote(cart, id(9))).rejects.toMatchObject({ code: mapped });
  });
  it.each([
    ["quote_version_conflict", 503],
    ["quote_configuration_invalid", 400],
    ["quote_service_unavailable", 503],
    ["quote_not_found", 404],
    ["unrecognized", 422],
  ] as const)("keeps unmatched or unavailable %s uncertain", async (code, status) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => error(code, status)),
    );
    setCustomerCsrfCredential(original);
    await expect(client().quote(cart, id(9))).rejects.toMatchObject({ code: "network_unknown" });
  });
  it.each(["success", "rejection", "same-value", "reset-and-reinstall"])(
    "isolates superseded %s replies",
    async (mode) => {
      const pending = pendingResponse();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise),
      );
      setCustomerCsrfCredential(original);
      const result = client().quote(cart, id(9));
      const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
      if (mode === "reset-and-reinstall") setCustomerCsrfCredential(null);
      const next = mode === "same-value" || mode === "reset-and-reinstall" ? original : replacement;
      setCustomerCsrfCredential(next);
      pending.resolve(mode === "rejection" ? error("quote_version_conflict", 409) : success());
      await rejected;
      expect(getCustomerCsrfCredential()).toBe(next);
    },
  );
  it("rejects replacement during body consumption and releases the reader", async () => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(new TextEncoder().encode(JSON.stringify(publicQuote)));
          controller.close();
        };
      },
    });
    const acquire = vi.spyOn(body, "getReader");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body)),
    );
    setCustomerCsrfCredential(original);
    const result = client().quote(cart, id(9));
    const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledOnce();
    setCustomerCsrfCredential(replacement);
    finish();
    await rejected;
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("checks the final Quote delivery boundary after body parsing", async () => {
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const value = parse(text, reviver);
      queueMicrotask(() =>
        queueMicrotask(() => queueMicrotask(() => setCustomerCsrfCredential(replacement))),
      );
      return value;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => success()),
    );
    setCustomerCsrfCredential(original);
    await expect(client().quote(cart, id(9))).rejects.toMatchObject({ code: "network_unknown" });
    expect(getCustomerCsrfCredential()).toBe(replacement);
  });
  it("validates against the requested Cart version despite caller mutation", async () => {
    const pending = pendingResponse();
    const fetch = vi.fn(() => pending.promise);
    vi.stubGlobal("fetch", fetch);
    setCustomerCsrfCredential(original);
    const mutable = { ...cart, cart: { ...cart.cart } };
    const result = client().quote(mutable, id(9));
    mutable.cart.version = 99;
    mutable.cart.cartReference = id(90);
    pending.resolve(success());
    expect(await result).toEqual(quote);
    expect(fetch).toHaveBeenCalledWith(
      "/api/v1/carts/" + id(1) + "/quote",
      expect.objectContaining({ body: JSON.stringify({ cartVersion: 3 }) }),
    );
  });
  it("keeps unknown server results retryable under the original controller key", async () => {
    let recover = false;
    const fetch = vi.fn(async () =>
      recover ? success() : error("quote_service_unavailable", 503),
    );
    vi.stubGlobal("fetch", fetch);
    setCustomerCsrfCredential(original);
    const keys = vi.fn(() => id(9));
    const controller = createCheckoutController(
      createCheckoutClient({ loadCurrent: async () => cart } as CustomerCartClient),
      keys,
    );
    await controller.load();
    await controller.quote();
    expect(controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
    recover = true;
    await controller.retry();
    expect(controller.getState()).toMatchObject({ status: "ready", quote });
    expect(keys).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const attempt of [1, 2])
      expect(fetch).toHaveBeenNthCalledWith(
        attempt,
        expect.any(String),
        expect.objectContaining({ headers: expect.objectContaining({ "idempotency-key": id(9) }) }),
      );
  });
});

it.each([202, 206])("does not treat HTTP%s as a completed Quote", async (status) => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(publicQuote), { status })),
  );
  setCustomerCsrfCredential("c".repeat(43));
  await expect(
    createCheckoutClient({} as CustomerCartClient).quote(cart, id(9)),
  ).rejects.toMatchObject({ code: "network_unknown" });
});
it.each([{ cartReference: "invalid" }, { version: 0 }])(
  "rejects malformed Cart identity/version before transport",
  async (change) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    setCustomerCsrfCredential("c".repeat(43));
    await expect(
      createCheckoutClient({} as CustomerCartClient).quote(
        { ...cart, cart: { ...cart.cart, ...change } },
        id(9),
      ),
    ).rejects.toMatchObject({ code: "cart_request_invalid" });
    expect(fetch).not.toHaveBeenCalled();
  },
);
