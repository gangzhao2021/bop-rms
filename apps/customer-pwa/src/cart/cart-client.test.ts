import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserCustomerCartClient, setCustomerCartCsrfCredential } from "./cart-client.js";
import { CartClientError, type CartView } from "./types.js";
import { getCustomerCsrfCredential } from "../session/customer-transaction-context.js";

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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe("complete Cart response bounds", () => {
  it.each(["headers", "body"] as const)(
    "enforces the deadline during stalled %s without cooperative abort",
    async (stage) => {
      vi.useFakeTimers();
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const response = new Response(body);
      const fetch = vi.fn(async () =>
        stage === "body" ? response : new Promise<Response>(() => undefined),
      );
      vi.stubGlobal("fetch", fetch);
      setCustomerCartCsrfCredential("c".repeat(43));
      const result = createBrowserCustomerCartClient().createCart({ operationReference: id(20) });
      const assertion = expect(result).rejects.toMatchObject({ code: "network_unknown" });
      await vi.advanceTimersByTimeAsync(15_000);
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
      if (stage === "body") {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
      }
      expect(getCustomerCsrfCredential()).toBe("c".repeat(43));
    },
  );

  it.each(["before", "headers", "body"] as const)(
    "honors caller cancellation at %s and removes its listener",
    async (stage) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const remove = vi.spyOn(caller.signal, "removeEventListener");
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({ cancel });
      const fetch = vi.fn(async () =>
        stage === "body" ? new Response(body) : new Promise<Response>(() => undefined),
      );
      vi.stubGlobal("fetch", fetch);
      if (stage === "before") caller.abort();
      const result = createBrowserCustomerCartClient().loadCurrent(caller.signal);
      const assertion = expect(result).rejects.toMatchObject({ code: "network_unknown" });
      await Promise.resolve();
      caller.abort();
      await assertion;
      expect(fetch).toHaveBeenCalledTimes(stage === "before" ? 0 : 1);
      expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
      expect(vi.getTimerCount()).toBe(0);
      if (stage === "body") {
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(body.locked).toBe(false);
      }
    },
  );

  it("discards a late session-expiry response without clearing current CSRF", async () => {
    vi.useFakeTimers();
    let release: (value: Response) => void = () => undefined;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(JSON.stringify({ error: { code: "cart_session_expired" } })),
        );
      },
      cancel,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    setCustomerCartCsrfCredential("c".repeat(43));
    const result = createBrowserCustomerCartClient().loadCurrent();
    const assertion = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    await vi.advanceTimersByTimeAsync(15_000);
    await assertion;
    release(new Response(body, { status: 401 }));
    await vi.advanceTimersByTimeAsync(0);
    expect(getCustomerCsrfCredential()).toBe("c".repeat(43));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["read", "write"] as const)(
    "bounds oversize and invalid UTF-8 %s responses",
    async (kind) => {
      for (const bytes of [new Uint8Array(16 * 1024 * 1024 + 1), new Uint8Array([0xc3, 0x28])]) {
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            if (bytes.length < 10) controller.close();
          },
          cancel,
        });
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => new Response(body)),
        );
        setCustomerCartCsrfCredential("c".repeat(43));
        const client = createBrowserCustomerCartClient();
        await expect(
          kind === "read"
            ? client.loadCurrent()
            : client.createCart({ operationReference: id(20) }),
        ).rejects.toMatchObject({
          code: kind === "read" ? "cart_service_unavailable" : "network_unknown",
        });
        expect(body.locked).toBe(false);
        if (bytes.length > 10) expect(cancel).toHaveBeenCalledTimes(1);
      }
    },
  );

  it("rejects redirects and sends the same-origin privacy boundary", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const response = new Response(body);
    Object.defineProperty(response, "redirected", { value: true });
    const fetch = vi.fn(async () => response);
    vi.stubGlobal("fetch", fetch);
    await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
      code: "cart_service_unavailable",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/bff/customer/cart",
      expect.objectContaining({
        mode: "cors",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
      }),
    );
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("accepts a maximal structural Cart and cleans up successful response resources", async () => {
    vi.useFakeTimers();
    const value: CartView = {
      ...cart(),
      cart: {
        ...cart().cart,
        items: Array.from({ length: 100 }, (_, i) => ({
          cartItemReference: id(100 + i),
          sellableReference: id(300 + i),
          displayName: "合".repeat(200),
          quantity: 100,
          configuration: Array.from({ length: 50 }, (_, j) => ({
            optionReference: id(1000 + j),
            displayName: "合".repeat(200),
            quantity: 100,
          })),
          customerNote: "a".repeat(500),
          lineEstimate: { status: "Unavailable", reasonCode: "FINAL_QUOTE_REQUIRED" },
          warnings: Array.from({ length: 100 }, () => "S".repeat(64)),
        })),
      },
    };
    const response = new Response(JSON.stringify(value));
    const caller = new AbortController();
    const remove = vi.spyOn(caller.signal, "removeEventListener");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(createBrowserCustomerCartClient().loadCurrent(caller.signal)).resolves.toEqual(
      value,
    );
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
  });

  it("cleans up on definitive server rejection", async () => {
    vi.useFakeTimers();
    const response = new Response(JSON.stringify({ error: { code: "cart_rate_limited" } }), {
      status: 429,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => response),
    );
    await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
      code: "cart_rate_limited",
    });
    expect(response.body?.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

it("does not parse a session-expiry body completed by timeout cancellation", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        new TextEncoder().encode(JSON.stringify({ error: { code: "cart_session_expired" } })),
      );
    },
    cancel,
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body, { status: 401 })),
  );
  setCustomerCartCsrfCredential("c".repeat(43));
  const result = createBrowserCustomerCartClient().loadCurrent();
  const assertion = expect(result).rejects.toMatchObject({ code: "network_unknown" });
  await vi.advanceTimersByTimeAsync(15_000);
  await assertion;
  await vi.advanceTimersByTimeAsync(0);
  expect(getCustomerCsrfCredential()).toBe("c".repeat(43));
  expect(cancel).toHaveBeenCalledTimes(1);
  expect(body.locked).toBe(false);
  expect(vi.getTimerCount()).toBe(0);
});

describe("Cart response Session isolation", () => {
  const original = "c".repeat(43);
  const replacement = "d".repeat(43);
  function deferredResponse() {
    let resolve: (value: Response) => void = () => undefined;
    let reject: (error: Error) => void = () => undefined;
    const promise = new Promise<Response>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    return { promise, resolve, reject };
  }
  function response(status: number) {
    return new Response(
      JSON.stringify(
        status === 200
          ? cart()
          : { error: { code: status === 401 ? "cart_session_expired" : "cart_not_found" } },
      ),
      { status },
    );
  }
  it.each([200, 401, 404])(
    "discards old %s headers without changing the newer credential",
    async (status) => {
      const old = deferredResponse();
      const fetch = vi
        .fn()
        .mockReturnValueOnce(old.promise)
        .mockImplementation(async () => response(200));
      vi.stubGlobal("fetch", fetch);
      setCustomerCartCsrfCredential(original);
      const client = createBrowserCustomerCartClient();
      const stale = client.loadCurrent();
      const rejected = expect(stale).rejects.toMatchObject({ code: "network_unknown" });
      setCustomerCartCsrfCredential(replacement);
      expect(await client.loadCurrent()).toEqual(cart());
      const late = response(status);
      const cancel = vi.spyOn(late.body as ReadableStream<Uint8Array>, "cancel");
      old.resolve(late);
      await rejected;
      expect(getCustomerCsrfCredential()).toBe(replacement);
      expect(cancel).toHaveBeenCalledOnce();
      expect(late.body?.locked).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
  it.each([200, 401])("discards old %s body after a context switch", async (status) => {
    vi.useFakeTimers();
    let finish: () => void = () => undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        finish = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify(status === 200 ? cart() : { error: { code: "cart_session_expired" } }),
            ),
          );
          controller.close();
        };
      },
    });
    const acquire = vi.spyOn(body, "getReader");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(body, { status })),
    );
    setCustomerCartCsrfCredential(original);
    const pending = createBrowserCustomerCartClient().loadCurrent();
    const rejected = expect(pending).rejects.toMatchObject({ code: "network_unknown" });
    await vi.advanceTimersByTimeAsync(0);
    expect(acquire).toHaveBeenCalledOnce();
    setCustomerCartCsrfCredential(replacement);
    finish();
    await rejected;
    expect(getCustomerCsrfCredential()).toBe(replacement);
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(["reinstall", "reset-and-reinstall", "null-reset"])(
    "detects %s without relying on raw credential equality",
    async (mode) => {
      const pending = deferredResponse();
      vi.stubGlobal(
        "fetch",
        vi.fn(() => pending.promise),
      );
      setCustomerCartCsrfCredential(mode === "null-reset" ? null : original);
      const result = createBrowserCustomerCartClient().loadCurrent();
      const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
      if (mode === "reset-and-reinstall") setCustomerCartCsrfCredential(null);
      setCustomerCartCsrfCredential(mode === "null-reset" ? null : original);
      pending.resolve(response(200));
      await rejected;
      expect(getCustomerCsrfCredential()).toBe(mode === "null-reset" ? null : original);
    },
  );
  it("keeps a stale committed write uncertain and never submits again", async () => {
    const old = deferredResponse();
    const fetch = vi.fn(() => old.promise);
    vi.stubGlobal("fetch", fetch);
    setCustomerCartCsrfCredential(original);
    const result = createBrowserCustomerCartClient().removeItem({
      cart: cart(),
      cartItemReference: id(2),
      operationReference: id(30),
    });
    const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    setCustomerCartCsrfCredential(replacement);
    old.resolve(response(200));
    await rejected;
    expect(fetch).toHaveBeenCalledOnce();
    expect(getCustomerCsrfCredential()).toBe(replacement);
  });
  it("bounds a transport failure from the old context", async () => {
    const old = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => old.promise),
    );
    setCustomerCartCsrfCredential(original);
    const result = createBrowserCustomerCartClient().loadCurrent();
    const rejected = expect(result).rejects.toMatchObject({ code: "network_unknown" });
    setCustomerCartCsrfCredential(replacement);
    old.reject(new Error("synthetic transport detail"));
    await rejected;
    expect(getCustomerCsrfCredential()).toBe(replacement);
  });
  it("lets a current401 clear CSRF while another old request becomes stale", async () => {
    const old = deferredResponse();
    const second = deferredResponse();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValueOnce(old.promise).mockReturnValueOnce(second.promise),
    );
    setCustomerCartCsrfCredential(original);
    const client = createBrowserCustomerCartClient();
    const first = client.loadCurrent();
    const firstRejected = expect(first).rejects.toMatchObject({ code: "cart_session_expired" });
    const other = client.loadCurrent();
    const otherRejected = expect(other).rejects.toMatchObject({ code: "network_unknown" });
    old.resolve(response(401));
    await firstRejected;
    second.resolve(response(200));
    await otherRejected;
    expect(getCustomerCsrfCredential()).toBeNull();
  });
});

it("rechecks Session context when a stream completes", async () => {
  let delivered = false;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (!delivered) {
          delivered = true;
          controller.enqueue(new TextEncoder().encode(JSON.stringify(cart())));
        } else {
          controller.close();
          queueMicrotask(() => setCustomerCartCsrfCredential("d".repeat(43)));
        }
      },
    },
    { highWaterMark: 0 },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(body)),
  );
  setCustomerCartCsrfCredential("c".repeat(43));
  await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
    code: "network_unknown",
  });
  expect(getCustomerCsrfCredential()).toBe("d".repeat(43));
});

it("rejects a context replaced after parsing but before the Promise delivers the Cart", async () => {
  const parse = JSON.parse;
  vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
    const value = parse(text, reviver);
    queueMicrotask(() => setCustomerCartCsrfCredential("d".repeat(43)));
    return value;
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(cart()))),
  );
  setCustomerCartCsrfCredential("c".repeat(43));
  await expect(createBrowserCustomerCartClient().loadCurrent()).rejects.toMatchObject({
    code: "network_unknown",
  });
  expect(getCustomerCsrfCredential()).toBe("d".repeat(43));
});

it.each(["createCart", "addItem", "updateItem", "removeItem"] as const)(
  "rejects replacement before %s result delivery",
  async (method) => {
    const parse = JSON.parse;
    vi.spyOn(JSON, "parse").mockImplementation((text, reviver) => {
      const value = parse(text, reviver);
      queueMicrotask(() =>
        queueMicrotask(() => queueMicrotask(() => setCustomerCartCsrfCredential("d".repeat(43)))),
      );
      return value;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(cart()))),
    );
    setCustomerCartCsrfCredential("c".repeat(43));
    const client = createBrowserCustomerCartClient();
    const input = {
      cart: cart(),
      cartItemReference: id(2),
      operationReference: id(30),
      sellableReference: id(3),
      draft: { quantity: 1, optionSelections: [], customerNote: null },
    };
    await expect(client[method](input)).rejects.toMatchObject({ code: "network_unknown" });
    expect(getCustomerCsrfCredential()).toBe("d".repeat(43));
  },
);
