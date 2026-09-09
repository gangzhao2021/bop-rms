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
    expect(controller.getState()).toMatchObject({ status: "ready", quote: null });
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

describe("foreground Checkout intent continuity", () => {
  function deferred<T>() {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((yes) => {
      resolve = yes;
    });
    return { promise, resolve };
  }
  function setup() {
    let recover = false;
    const loadCart = vi.fn(async () => cart);
    const send = vi.fn<CheckoutClient["quote"]>(async () => {
      if (!recover) throw new CartClientError("network_unknown");
      return quote;
    });
    const keys = vi.fn(() => id(9));
    const controller = createCheckoutController({ loadCart, quote: send }, keys);
    return {
      controller,
      loadCart,
      send,
      keys,
      recover: () => {
        recover = true;
      },
    };
  }
  it("keeps the original Cart/version and key after unknown outcome and refresh", async () => {
    const f = setup();
    const initial = {
      ...cart,
      cart: { ...cart.cart, items: cart.cart.items.map((item) => ({ ...item })) },
    };
    f.loadCart.mockResolvedValueOnce(initial);
    await f.controller.load();
    await f.controller.quote();
    initial.cart.version = 99;
    const initialItem = initial.cart.items[0];
    if (initialItem === undefined) throw new Error("synthetic item missing");
    initialItem.quantity = 99;
    f.loadCart.mockResolvedValue({
      ...cart,
      cart: { ...cart.cart, cartReference: id(90), version: 4 },
    });
    await f.controller.load();
    expect(f.controller.getState()).toMatchObject({
      status: "outcome-unknown",
      cart: { cart: { cartReference: id(1), version: 3 } },
    });
    f.recover();
    await f.controller.retry();
    expect(f.keys).toHaveBeenCalledOnce();
    expect(f.send).toHaveBeenCalledTimes(2);
    for (const call of f.send.mock.calls) {
      expect(call[0].cart.version).toBe(3);
      expect(call[0].cart.items[0]?.quantity).toBe(1);
      expect(Object.isFrozen(call[0].cart.items[0])).toBe(true);
      expect(call[1]).toBe(id(9));
    }
  });
  it.each([
    "cart_version_conflict",
    "cart_idempotency_conflict",
    "cart_request_invalid",
    "cart_session_expired",
    "cart_service_unavailable",
  ] as const)("retains unknown history after later %s", async (code) => {
    const f = setup();
    await f.controller.load();
    await f.controller.quote();
    f.send.mockRejectedValueOnce(new CartClientError(code));
    await f.controller.retry();
    expect(f.controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
    expect(f.loadCart).toHaveBeenCalledOnce();
    f.recover();
    await f.controller.retry();
    expect(f.keys).toHaveBeenCalledOnce();
    expect(f.controller.getState()).toMatchObject({ status: "ready", quote });
  });
  it("does not replace a pending Quote through a concurrent load", async () => {
    const f = setup();
    const gate = deferred<CheckoutQuote>();
    f.send.mockImplementationOnce(() => gate.promise);
    await f.controller.load();
    const active = f.controller.quote();
    await f.controller.load();
    expect(f.loadCart).toHaveBeenCalledOnce();
    expect(f.controller.getState()).toMatchObject({ status: "pending" });
    gate.resolve(quote);
    await active;
    expect(f.controller.getState()).toMatchObject({ status: "ready", quote });
  });
  it("discards a load started before a newer Quote finishes", async () => {
    const f = setup();
    f.recover();
    await f.controller.load();
    const gate = deferred<CartView>();
    f.loadCart.mockImplementationOnce(() => gate.promise);
    const stale = f.controller.load();
    await f.controller.quote();
    gate.resolve({ ...cart, cart: { ...cart.cart, version: 8 } });
    await stale;
    expect(f.controller.getState()).toMatchObject({
      status: "ready",
      quote,
      cart: { cart: { version: 3 } },
    });
  });
  it("lets only the latest overlapping load publish", async () => {
    const f = setup();
    const first = deferred<CartView>();
    const second = deferred<CartView>();
    f.loadCart
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const older = f.controller.load();
    const newer = f.controller.load();
    second.resolve({ ...cart, cart: { ...cart.cart, version: 4 } });
    await newer;
    first.resolve(cart);
    await older;
    expect(f.controller.getState()).toMatchObject({
      status: "ready",
      cart: { cart: { version: 4 } },
    });
  });
  it("keeps failed refresh from discarding unknown intent", async () => {
    const f = setup();
    await f.controller.load();
    await f.controller.quote();
    f.loadCart.mockRejectedValueOnce(new CartClientError("cart_session_expired"));
    await f.controller.load();
    expect(f.controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
    f.recover();
    await f.controller.retry();
    expect(f.keys).toHaveBeenCalledOnce();
  });
  it("blocks retry in a replacement Session context without clearing its credential", async () => {
    const f = setup();
    setCustomerCsrfCredential("c".repeat(43));
    await f.controller.load();
    await f.controller.quote();
    setCustomerCsrfCredential("d".repeat(43));
    await f.controller.retry();
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.keys).toHaveBeenCalledOnce();
    expect(f.controller.getState()).toMatchObject({
      status: "outcome-unknown",
      cart: null,
      canRetry: false,
    });
    expect(getCustomerCsrfCredential()).toBe("d".repeat(43));
  });
  it("does not publish a loaded Cart after its Session context changes", async () => {
    const f = setup();
    const gate = deferred<CartView>();
    f.loadCart.mockImplementationOnce(() => gate.promise);
    const load = f.controller.load();
    setCustomerCsrfCredential("d".repeat(43));
    gate.resolve(cart);
    await load;
    expect(f.controller.getState()).toMatchObject({ status: "unavailable", cart: null });
  });
  it("retains a pending plan across offline/reconnect without automatic replay", async () => {
    const f = setup();
    await f.controller.load();
    await f.controller.quote();
    f.controller.setOnline(false);
    await f.controller.retry();
    expect(f.controller.getState()).toMatchObject({ status: "offline", canRetry: true });
    expect(f.send).toHaveBeenCalledOnce();
    f.controller.setOnline(true);
    expect(f.send).toHaveBeenCalledOnce();
    expect(f.controller.getState()).toMatchObject({ status: "outcome-unknown", canRetry: true });
    f.recover();
    await f.controller.retry();
    expect(f.keys).toHaveBeenCalledOnce();
  });
  it("allocates no key offline and a retry with no pending plan sends nothing", async () => {
    const f = setup();
    await f.controller.load();
    f.controller.setOnline(false);
    await f.controller.quote();
    expect(f.keys).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    f.controller.setOnline(true);
    await f.controller.retry();
    expect(f.send).not.toHaveBeenCalled();
    expect(f.controller.getState()).toMatchObject({ status: "ready", quote: null });
  });
  it("does not infer an empty Cart after an interrupted initial load", async () => {
    const f = setup();
    const gate = deferred<CartView>();
    f.loadCart.mockImplementationOnce(() => gate.promise);
    const active = f.controller.load();
    f.controller.setOnline(false);
    f.controller.setOnline(true);
    gate.resolve(cart);
    await active;
    expect(f.controller.getState()).toMatchObject({ status: "unavailable", cart: null });
  });
  it("installs the command flight before notifying reentrant subscribers", async () => {
    const f = setup();
    const gate = deferred<CheckoutQuote>();
    f.send.mockImplementationOnce(() => gate.promise);
    await f.controller.load();
    let nested: Promise<void> | undefined;
    const unsubscribe = f.controller.subscribe(() => {
      if (f.controller.getState().status === "pending") nested = f.controller.quote();
    });
    const active = f.controller.quote();
    expect(nested).toBe(active);
    expect(f.send).toHaveBeenCalledOnce();
    gate.resolve(quote);
    await active;
    unsubscribe();
  });
  it("keeps an in-flight confirmed result read-only after going offline", async () => {
    const f = setup();
    const gate = deferred<CheckoutQuote>();
    f.send.mockImplementationOnce(() => gate.promise);
    await f.controller.load();
    const active = f.controller.quote();
    f.controller.setOnline(false);
    gate.resolve(quote);
    await active;
    expect(f.controller.getState()).toMatchObject({ status: "offline", canRetry: false });
    f.controller.setOnline(true);
    expect(f.controller.getState()).toMatchObject({ status: "ready", quote: null });
    expect(f.send).toHaveBeenCalledOnce();
  });
  it("encodes the actual creation instant in a default UUIDv7 operation", async () => {
    vi.useFakeTimers();
    const instant = Date.parse("2026-09-09T12:00:00.000Z");
    vi.setSystemTime(instant);
    const send = vi.fn<CheckoutClient["quote"]>(async () => quote);
    const controller = createCheckoutController({ loadCart: async () => cart, quote: send });
    await controller.load();
    await controller.quote();
    expect(send).toHaveBeenCalledWith(
      expect.any(Object),
      expect.stringMatching(
        /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
      ),
    );
    const recorded = send.mock.calls[0]?.[1] ?? "";
    expect(parseInt(recorded.replaceAll("-", "").slice(0, 12), 16)).toBe(instant);
  });
});
