import { afterEach, describe, expect, it, vi } from "vitest";
import { createBrowserDiningBindingClient } from "./dining-binding-client.js";
import {
  getCustomerCsrfCredential,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";
const id = "018f5500-0000-7000-8000-000000000001";
const admissionReference = "018f5500-0000-7000-8000-000000000003";
const old = "a".repeat(43);
const candidate = "b".repeat(43);
const proof = "c".repeat(43);
const prepared = {
  status: "Prepared",
  operationReference: id,
  candidateCsrfToken: candidate,
  recoveryProof: proof,
  expiresAt: "2026-09-08T12:01:00.000Z",
};
const activated = { status: "Activated", operationReference: id, csrfToken: candidate };
const input = { operationReference: id, csrfToken: old };
const preparationInput = { ...input, admissionReference };
const activation = { ...input, candidateCsrfToken: candidate, recoveryProof: proof };
function response(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}
function setup(result: () => Response = () => response(prepared)) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => result());
  return { fetch, client: createBrowserDiningBindingClient({ fetch, online: () => true }) };
}
afterEach(() => {
  vi.useRealTimers();
  setCustomerCsrfCredential(null);
});
describe("browser Dining binding transport", () => {
  it("uses exact credential transport and leaves active CSRF in caller control", async () => {
    setCustomerCsrfCredential(old);
    const f = setup();
    expect(Object.isFrozen(f.client)).toBe(true);
    const result = await f.client.prepare(preparationInput);
    expect(result).toEqual(prepared);
    expect(Object.isFrozen(result)).toBe(true);
    expect(f.fetch).toHaveBeenCalledOnce();
    expect(f.fetch).toHaveBeenCalledWith(
      "/bff/customer/dining-binding/prepare",
      expect.objectContaining({
        method: "POST",
        mode: "cors",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        body: JSON.stringify({ admissionReference }),
        headers: { "content-type": "application/json", "idempotency-key": id, "x-csrf-token": old },
      }),
    );
    expect(getCustomerCsrfCredential()).toBe(old);
    expect(f.fetch.mock.calls[0]?.[1]?.headers).not.toHaveProperty("cookie");
  });
  it("acknowledges the candidate and repeats completion only when explicitly invoked", async () => {
    const f = setup(() => response(activated));
    expect(await f.client.activate(activation)).toEqual(activated);
    expect(f.fetch.mock.calls[0]?.[0]).toBe("/bff/customer/dining-binding/activate");
    expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(
      JSON.stringify({ candidateCsrfToken: candidate, recoveryProof: proof }),
    );
    expect(await f.client.complete({ operationReference: id, csrfToken: candidate })).toEqual(
      activated,
    );
    expect(f.fetch.mock.calls[1]?.[1]?.headers).toEqual({
      "content-type": "application/json",
      "idempotency-key": id,
      "x-csrf-token": candidate,
    });
    expect(f.fetch.mock.calls[1]?.[1]?.body).toBe("{}");
    expect(f.fetch).toHaveBeenCalledTimes(2);
  });
  it.each([
    null,
    {},
    input,
    { ...preparationInput, admissionReference: "invalid" },
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
    await expect(f.client.prepare(value)).rejects.toMatchObject({
      code: "request-invalid",
      message: "dining binding is unavailable",
    });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("captures the admission before external callbacks and never invokes its getter", async () => {
    const f = setup();
    const getter = vi.fn(() => admissionReference);
    const bad = Object.defineProperty({ ...preparationInput }, "admissionReference", {
      get: getter,
    });
    await expect(f.client.prepare(bad)).rejects.toMatchObject({ code: "request-invalid" });
    expect(getter).not.toHaveBeenCalled();
    expect(f.fetch).not.toHaveBeenCalled();
    const mutable = { ...preparationInput };
    const client = createBrowserDiningBindingClient({
      fetch: f.fetch,
      online() {
        mutable.admissionReference = "018f5500-0000-7000-8000-000000000004";
        return true;
      },
    });
    await client.prepare(mutable);
    expect(f.fetch.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ admissionReference }));
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
    await expect(f.client.activate(activation)).rejects.toMatchObject({ code: "outcome-unknown" });
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { ...activation, candidateCsrfToken: old },
    { ...activation, recoveryProof: candidate },
    { ...activation, recoveryProof: "bad" },
  ])("rejects invalid candidate proof before fetch", async (value) => {
    const f = setup();
    await expect(f.client.activate(value)).rejects.toMatchObject({ code: "request-invalid" });
    expect(f.fetch).not.toHaveBeenCalled();
  });
  it("does not send while offline or retry automatically after connectivity returns", async () => {
    let online = false;
    const f = setup();
    const client = createBrowserDiningBindingClient({ fetch: f.fetch, online: () => online });
    await expect(client.prepare(preparationInput)).rejects.toMatchObject({ code: "offline" });
    online = true;
    await Promise.resolve();
    expect(f.fetch).not.toHaveBeenCalled();
    await client.prepare(preparationInput);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { ...prepared, operationReference: "018f5500-0000-7000-8000-000000000002" },
    { ...prepared, candidateCsrfToken: old },
    { ...prepared, recoveryProof: candidate },
    { ...prepared, expiresAt: "2026-02-30T12:01:00.000Z" },
    { ...prepared, sessionCredential: "secret" },
    { ...prepared, status: "Activated" },
    null,
  ])("treats malformed or substituted preparation as unknown", async (value) => {
    const f = setup(() => response(value));
    const error = await f.client.prepare(preparationInput).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "outcome-unknown",
      message: "dining binding is unavailable",
    });
    expect(error).not.toHaveProperty("cause");
    expect(JSON.stringify(error)).not.toContain(proof);
    expect(f.fetch).toHaveBeenCalledOnce();
  });
  it.each([
    { ...activated, csrfToken: old },
    { ...activated, operationReference: "other" },
    { ...activated, recoveryProof: proof },
  ])("rejects substituted activation acknowledgement", async (value) => {
    const f = setup(() => response(value));
    await expect(f.client.activate(activation)).rejects.toMatchObject({ code: "outcome-unknown" });
    await expect(
      f.client.complete({ operationReference: id, csrfToken: candidate }),
    ).rejects.toMatchObject({ code: "outcome-unknown" });
  });
  it.each([
    [
      400,
      "dining_binding_request_invalid",
      "customer.dining.binding_request_invalid",
      "request-invalid",
    ],
    [503, "dining_binding_unavailable", "customer.dining.binding_unavailable", "unavailable"],
    [401, "dining_binding_unavailable", "customer.dining.binding_unavailable", "outcome-unknown"],
    [503, "dining_binding_unavailable", "wrong", "outcome-unknown"],
  ] as const)(
    "bounds server status %s without retrying",
    async (status, code, messageKey, expected) => {
      const f = setup(() => response({ error: { code, messageKey } }, status));
      await expect(f.client.activate(activation)).rejects.toMatchObject({ code: expected });
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
    await expect(f.client.prepare(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
  });
  it("bounds failures before headers without exposing the driver error", async () => {
    const fetch = vi.fn(async () => {
      throw new Error(proof);
    });
    const client = createBrowserDiningBindingClient({ fetch, online: () => true });
    const error = await client.prepare(preparationInput).catch((error: unknown) => error);
    expect(error).toMatchObject({
      code: "outcome-unknown",
      message: "dining binding is unavailable",
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
    const client = createBrowserDiningBindingClient({ fetch, online: () => true, timeoutMs: 10 });
    const result = expect(client.prepare(preparationInput)).rejects.toMatchObject({
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
    const client = createBrowserDiningBindingClient({ fetch, online: () => true, timeoutMs: 10 });
    const result = expect(client.prepare(preparationInput)).rejects.toMatchObject({
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
    await expect(f.client.prepare(preparationInput)).rejects.toMatchObject({
      code: "outcome-unknown",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });
  it.each([0, 15001, 1.5, NaN])("rejects invalid deadline %s", (timeoutMs) => {
    expect(() => createBrowserDiningBindingClient({ timeoutMs })).toThrow(
      "dining binding is unavailable",
    );
  });
});
