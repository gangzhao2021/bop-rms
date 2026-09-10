import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserDiningJoinClient } from "./dining-join-client.js";
import {
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
const id = "018f5500-0000-7000-8000-000000000001";
const admissionReference = "018f5500-0000-7000-8000-000000000003";
const old = "a".repeat(43);
const joinCredential = "123456";
const prepared = { status: "Joined", operationReference: id, admissionReference };
const input = { operationReference: id, csrfToken: old };
const preparationInput = { ...input, joinCredential };
function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
function setup(result: () => Response = () => response(prepared)) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => result());
  return { fetch, client: createBrowserDiningJoinClient({ fetch, online: () => true }) };
}
afterEach(() => {
  vi.useRealTimers();
  setCustomerCsrfCredential(null);
});
describe("browser Dining Join transport", () => {
  it("uses exact credential transport and leaves active CSRF in caller control", async () => {
    setCustomerCsrfCredential(old);
    const f = setup();
    expect(Object.isFrozen(f.client)).toBe(true);
    const result = await f.client.join(preparationInput);
    expect(result).toEqual(prepared);
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledWith(
      "/bff/customer/dining/join",
      expect.objectContaining({
        method: "POST",
        mode: "cors",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ joinCredential }),
        headers: { "content-type": "application/json", "idempotency-key": id, "x-csrf-token": old },
      }),
    );
    expect(getCustomerCsrfCredential()).toBe(old);
    expect(f.fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("cookie");
  });
  it.each([
    "000000",
    "999999",
    "A".repeat(22),
    "A".repeat(21) + "Q",
    "A".repeat(21) + "g",
    "A".repeat(21) + "w",
  ])("accepts canonical credential framing %s", async (value) => {
    const f = setup();
    await expect(f.client.join({ ...preparationInput, joinCredential: value })).resolves.toEqual(
      prepared,
    );
  });
  it.each([
    "12345",
    "1234567",
    "１２３４５６",
    " 123456",
    "A".repeat(21) + "B",
    "A".repeat(21) + "=",
    "A".repeat(43),
    123456,
  ])("denies invalid Join framing %s", async (value) => {
    const f = setup();
    await expect(
      f.client.join({ ...preparationInput, joinCredential: value }),
    ).rejects.toMatchObject({ code: "request-invalid" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("sends exactly once per explicit original retry", async () => {
    const f = setup();
    expect(await f.client.join(preparationInput)).toEqual(prepared);
    expect(await f.client.join(preparationInput)).toEqual(prepared);
    expect(f.fetch).toHaveBeenCalledTimes(2);
    expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(f.fetch.mock.calls[1]?.[1]?.body);
  });
  it.each([
    null,
    {},
    input,
    { ...preparationInput, joinCredential: "invalid" },
    { ...preparationInput, sessionCredential: "synthetic" },
    { ...preparationInput, extra: true },
    { ...preparationInput, csrfToken: "short" },
    { ...preparationInput, operationReference: "other" },
    Object.defineProperty({ ...preparationInput }, "csrfToken", {
      get() {
        throw new Error("must not read");
      },
    }),
  ])("rejects invalid input before fetch", async (value) => {
    const f = setup();
    await expect(f.client.join(value)).rejects.toMatchObject({
      code: "request-invalid",
      message: "dining join is unavailable",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("captures the credential before external callbacks and never invokes its getter", async () => {
    const f = setup();
    const getter = vi.fn(() => joinCredential);
    const bad = Object.defineProperty({ ...preparationInput }, "joinCredential", {
      get: getter,
    });
    await expect(f.client.join(bad)).rejects.toMatchObject({ code: "request-invalid" });
    expect(getter).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    const mutable = { ...preparationInput };
    const client = createBrowserDiningJoinClient({
      fetch: f.fetch,
      online() {
        mutable.joinCredential = "654321";
        return true;
      },
    });
    await client.join(mutable);
    expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ joinCredential }));
  });
  it("does not accept a Pickup error as a known Dining outcome", async () => {
    const f = setup(() =>
      response(
        {
          error: {
            code: "cart_binding_unavailable",
            messageKey: "customer.cart.binding_unavailable",
          },
        },
        503,
      ),
    );
    await expect(f.client.join(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it("does not send while offline or retry automatically after connectivity returns", async () => {
    let online = false;
    const f = setup();
    const client = createBrowserDiningJoinClient({ fetch: f.fetch, online: () => online });
    await expect(client.join(preparationInput)).rejects.toMatchObject({ code: "offline" });
    online = true;
    await Promise.resolve();
    expect(f.fetch).not.toHaveBeenCalled();
    await client.join(preparationInput);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { ...prepared, operationReference: "018f5500-0000-7000-8000-000000000002" },
    { ...prepared, admissionReference: "invalid" },
    { ...prepared, admissionReference: admissionReference.toUpperCase() },
    { ...prepared, sessionCredential: "secret" },
    { ...prepared, status: "Activated" },
    null,
  ])("treats malformed or substituted admission as unknown", async (value) => {
    const f = setup(() => response(value));
    const error = await f.client.join(preparationInput).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "outcome-unknown",
      message: "dining join is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(old);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    [400, "dining_join_request_invalid", "customer.dining.join_request_invalid", "request-invalid"],
    [503, "dining_join_unavailable", "customer.dining.join_unavailable", "unavailable"],
    [401, "dining_join_unavailable", "customer.dining.join_unavailable", "outcome-unknown"],
    [503, "dining_join_unavailable", "wrong", "outcome-unknown"],
  ] as const)(
    "bounds server status %s without retrying",
    async (status, code, messageKey, expected) => {
      const f = setup(() => response({ error: { code, messageKey } }, status));
      await expect(f.client.join(preparationInput)).rejects.toMatchObject({ code: expected });
      expect(f.fetch).toHaveBeenCalledOnce();
    },
  );
  it.each([
    () => Response.json(prepared),
    () => new Response("<html>restricted</html>", { headers: { "cache-control": "no-store" } }),
    () => response(prepared, 201),
    () =>
      new Response("x".repeat(4097), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    () =>
      new Response(new Uint8Array([255]), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    () => {
      const r = response(prepared);
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ])("treats unsafe response envelopes as unknown", async (make) => {
    const f = setup(make);
    await expect(f.client.join(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
  });
  it("bounds failures before headers without exposing the driver error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(old);
    });
    const client = createBrowserDiningJoinClient({ fetch, online: () => true });
    const error = await client.join(preparationInput).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "outcome-unknown",
      message: "dining join is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
  });
  it.each(["headers", "body"])("bounds a stalled %s and cleans timers/streams", async (stage) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetch = vi.fn(async (): Promise<Response> =>
      stage === "headers"
        ? new Promise(() => undefined)
        : new Response(new ReadableStream<Uint8Array>({ cancel }), {
            headers: { "content-type": "application/json", "cache-control": "no-store" },
          }),
    );
    const client = createBrowserDiningJoinClient({ fetch, online: () => true, timeoutMs: 10 });
    const result = expect(client.join(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    if (stage === "body") expect(cancel).toHaveBeenCalledOnce();
  });
  it("cancels a late response body after a header timeout", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    let deliver!: (response: Response) => void;
    const fetch = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          deliver = resolve;
        }),
    );
    const client = createBrowserDiningJoinClient({ fetch, online: () => true, timeoutMs: 10 });
    const result = expect(client.join(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    await vi.advanceTimersByTimeAsync(10);
    await result;
    deliver(
      new Response(new ReadableStream<Uint8Array>({ cancel }), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      }),
    );
    await vi.advanceTimersByTimeAsync(0);
    expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(fetch).toHaveBeenCalledOnce();
  });
  it("cancels an unusable response body before acquiring a reader", async () => {
    const cancel = vi.fn();
    const f = setup(() => new Response(new ReadableStream<Uint8Array>({ cancel })));
    await expect(f.client.join(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([0, 15001, 1.5, NaN])("rejects invalid deadline %s", (timeoutMs) => {
    expect(() => createBrowserDiningJoinClient({ timeoutMs })).toThrow(
      "dining join is unavailable",
    );
  });
});
