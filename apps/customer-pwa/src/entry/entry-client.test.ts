import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeCustomerQrFragment, createCustomerEntryClient } from "./entry-client.js";
import {
  getCustomerCsrfCredential,
  getPaymentOperationReference,
  setPaymentOperationReference,
  setCustomerCsrfCredential,
} from "../session/customer-transaction-context.js";

const established = Object.freeze({
  schemaVersion: 2,
  status: "Established",
  brandDisplayName: "BOP Test Kitchen",
  storeDisplayName: "Harbour Test Store",
  publicStoreReference: "018f2a1b-7c3d-7a4e-8b5c-1234567890ab",
  publicTableReference: "018f2a1b-7c3d-7a4e-9b5c-1234567890ab",
  channel: "DineIn",
  operatingState: "Open",
  availableServiceModes: ["DineIn", "Pickup"],
  locale: "en-CA",
  contextExpiresAt: "2026-08-11T20:00:00.000Z",
  csrfToken: "A".repeat(43),
});

function response(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

describe("customer entry browser boundary", () => {
  it("removes the fragment before returning the compact credential", () => {
    const calls: unknown[][] = [];
    expect(
      consumeCustomerQrFragment({
        hash: "#qr=aaa.bbb.ccc",
        pathname: "/",
        search: "",
        replaceState: (...args) => calls.push(args),
      }),
    ).toBe("aaa.bbb.ccc");
    expect(calls).toEqual([[null, "", "/"]]);
  });

  it.each(["", "#other=aaa.bbb.ccc", "#qr=a%2Eb.c", "#qr=only.two"])(
    "fails closed and still clears an invalid fragment: %s",
    (hash) => {
      const replaceState = vi.fn();
      expect(
        consumeCustomerQrFragment({ hash, pathname: "/", search: "", replaceState }),
      ).toBeNull();
      expect(replaceState).toHaveBeenCalledWith(null, "", "/");
    },
  );

  it("posts once across repeated starts and keeps browser storage out of the boundary", async () => {
    setPaymentOperationReference("018f7900-0000-7000-8000-000000000001");
    const events: string[] = [];
    const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      events.push("fetch");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      });
      expect(JSON.parse(String(init?.body))).toEqual({ qrToken: "aaa.bbb.ccc" });
      return response(201, established);
    });
    const client = createCustomerEntryClient({
      fetch,
      hash: "#qr=aaa.bbb.ccc",
      pathname: "/",
      search: "",
      replaceState: () => events.push("clear"),
      online: () => true,
    });
    const [first, second] = await Promise.all([client.start(), client.start()]);
    expect(events).toEqual(["clear", "fetch"]);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
    expect(first.kind).toBe("Established");
    expect(getCustomerCsrfCredential()).toBe(established.csrfToken);
    expect(getPaymentOperationReference()).toBeNull();
  });

  it("maps closed error contracts without exposing an oracle", async () => {
    const fetch = vi.fn(async () =>
      response(422, {
        schemaVersion: 1,
        code: "entry_unavailable",
        messageKey: "customer.entry.unavailable",
        recovery: { action: "RescanOrAskStaff", storeSelection: "Hidden" },
      }),
    );
    const client = createCustomerEntryClient({
      fetch,
      hash: "#qr=aaa.bbb.ccc",
      pathname: "/",
      search: "",
      replaceState: vi.fn(),
      online: () => true,
    });
    await expect(client.start()).resolves.toEqual({ kind: "EntryUnavailable" });
  });

  it("reports offline without sending a request and retries only when explicitly asked", async () => {
    let online = false;
    const fetch = vi.fn(async () => response(201, established));
    const client = createCustomerEntryClient({
      fetch,
      hash: "#qr=aaa.bbb.ccc",
      pathname: "/",
      search: "",
      replaceState: vi.fn(),
      online: () => online,
    });
    await expect(client.start()).resolves.toEqual({ kind: "Offline" });
    expect(fetch).not.toHaveBeenCalled();
    online = true;
    await expect(client.retry()).resolves.toMatchObject({ kind: "Established" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { ...established, schemaVersion: 1 },
    { ...established, storeDisplayName: " <script>" },
    { ...established, availableServiceModes: ["DineIn", "DineIn"] },
    { ...established, operatingState: "Closed", availableServiceModes: ["DineIn"] },
    { ...established, unexpected: true },
  ])("fails a malformed success closed", async (body) => {
    const client = createCustomerEntryClient({
      fetch: async () => response(201, body),
      hash: "#qr=aaa.bbb.ccc",
      pathname: "/",
      search: "",
      replaceState: vi.fn(),
      online: () => true,
    });
    await expect(client.start()).resolves.toEqual({ kind: "CommandFailed" });
  });

  it("rejects a query-bearing entry URL and removes the query and fragment", () => {
    const replaceState = vi.fn();
    expect(
      consumeCustomerQrFragment({
        hash: "#qr=aaa.bbb.ccc",
        pathname: "/",
        search: "?qr=aaa.bbb.ccc",
        replaceState,
      }),
    ).toBeNull();
    expect(replaceState).toHaveBeenCalledWith(null, "", "/");
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function client(fetch: typeof globalThis.fetch, online = () => true) {
  return createCustomerEntryClient({
    fetch,
    online,
    hash: "#qr=aaa.bbb.ccc",
    pathname: "/",
    search: "",
    replaceState: vi.fn(),
  });
}
const headers = { "content-type": "application/json", "cache-control": "no-store" };
const flush = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};
afterEach(() => {
  vi.useRealTimers();
  setCustomerCsrfCredential(null);
  setPaymentOperationReference(null);
});

describe("entry response ownership and bounded delivery", () => {
  it("never lets an older client's response overwrite a newer established credential", async () => {
    const older = deferred<Response>();
    const first = client(() => older.promise).start();
    const newer = "B".repeat(43);
    await expect(
      client(async () => response(201, { ...established, csrfToken: newer })).start(),
    ).resolves.toMatchObject({ kind: "Established" });
    older.resolve(response(201, established));
    await expect(first).resolves.toEqual({ kind: "CommandFailed" });
    expect(getCustomerCsrfCredential()).toBe(newer);
  });
  it.each([null, "A".repeat(43)])(
    "rejects same-value generation replacement before headers: %s",
    async (value) => {
      const pending = deferred<Response>();
      const first = client(() => pending.promise).start();
      setCustomerCsrfCredential(value);
      setCustomerCsrfCredential(null);
      pending.resolve(response(201, established));
      await expect(first).resolves.toEqual({ kind: "CommandFailed" });
      expect(getCustomerCsrfCredential()).toBeNull();
    },
  );
  it("checks generation again after a pending body read", async () => {
    let stream!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        stream = controller;
      },
      cancel,
    });
    const pending = client(async () => new Response(body, { status: 201, headers })).start();
    await flush();
    setCustomerCsrfCredential("B".repeat(43));
    stream.enqueue(new TextEncoder().encode(JSON.stringify(established)));
    await expect(pending).resolves.toEqual({ kind: "CommandFailed" });
    expect(getCustomerCsrfCredential()).toBe("B".repeat(43));
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("failure leaves a newer credential and payment operation untouched", async () => {
    const responsePending = deferred<Response>();
    const pending = client(() => responsePending.promise).start();
    setCustomerCsrfCredential("B".repeat(43));
    setPaymentOperationReference("current-operation");
    responsePending.reject(new Error("private diagnostic"));
    await expect(pending).resolves.toEqual({ kind: "CommandFailed" });
    expect(getCustomerCsrfCredential()).toBe("B".repeat(43));
    expect(getPaymentOperationReference()).toBe("current-operation");
  });
  it("shares a pending request across start/retry and permits a later explicit retry", async () => {
    const delivery = deferred<Response>();
    const fetch = vi.fn(() => delivery.promise);
    const entry = client(fetch);
    const first = entry.start();
    expect(entry.retry()).toBe(first);
    expect(entry.start()).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
    delivery.resolve(response(201, established));
    await first;
    fetch.mockImplementation(async () => response(201, established));
    await entry.retry();
    expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("ignores an offline response without publishing a credential", async () => {
    let online = true;
    const delivery = deferred<Response>();
    const pending = client(
      () => delivery.promise,
      () => online,
    ).start();
    online = false;
    delivery.resolve(response(201, established));
    await expect(pending).resolves.toEqual({ kind: "Offline" });
    expect(getCustomerCsrfCredential()).toBeNull();
  });
  it("treats a throwing online boundary as offline with no request", async () => {
    const fetch = vi.fn();
    await expect(
      client(fetch, () => {
        throw new Error("private");
      }).start(),
    ).resolves.toEqual({ kind: "Offline" });
    expect(fetch).not.toHaveBeenCalled();
  });
  it("times out even when fetch ignores abort and cancels a late response", async () => {
    vi.useFakeTimers();
    const delivery = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    const pending = client((_url, init) => {
      signal = init?.signal;
      return delivery.promise;
    }).start();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ kind: "CommandFailed" });
    expect(signal?.aborted).toBe(true);
    const cancel = vi.fn();
    delivery.resolve(new Response(new ReadableStream({ cancel }), { status: 201, headers }));
    await flush();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getCustomerCsrfCredential()).toBeNull();
  });
  it("keeps the deadline through body reads and cancels stalled streams", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const pending = client(
      async () => new Response(new ReadableStream({ cancel }), { status: 201, headers }),
    ).start();
    await flush();
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(pending).resolves.toEqual({ kind: "CommandFailed" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getCustomerCsrfCredential()).toBeNull();
  });
  it("counts actual UTF-8 bytes and cancels oversize bodies", async () => {
    const cancel = vi.fn();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("界".repeat(6000)));
      },
      cancel,
    });
    await expect(
      client(
        async () =>
          new Response(body, { status: 201, headers: { ...headers, "content-length": "1" } }),
      ).start(),
    ).resolves.toEqual({ kind: "CommandFailed" });
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(getCustomerCsrfCredential()).toBeNull();
  });
  it("accepts permitted Unicode public labels within the bounded response", async () => {
    await expect(
      client(async () =>
        response(201, {
          ...established,
          brandDisplayName: "界".repeat(120),
          storeDisplayName: "店".repeat(120),
        }),
      ).start(),
    ).resolves.toMatchObject({ kind: "Established" });
  });
  it.each(["cache", "type", "redirect", "empty"] as const)(
    "rejects the %s envelope",
    async (kind) => {
      const cancel = vi.fn();
      const delivery = new Response(kind === "empty" ? null : new ReadableStream({ cancel }), {
        status: 201,
        headers: {
          "content-type": kind === "type" ? "text/html" : "application/json",
          "cache-control": kind === "cache" ? "public" : "no-store",
        },
      });
      if (kind === "redirect") Object.defineProperty(delivery, "redirected", { value: true });
      await expect(client(async () => delivery).start()).resolves.toEqual({
        kind: "CommandFailed",
      });
      expect(cancel).toHaveBeenCalledTimes(kind === "empty" ? 0 : 1);
    },
  );
  it.each([new Uint8Array([0xff]), new TextEncoder().encode("{")])(
    "rejects invalid UTF-8 or JSON without credential publication",
    async (bytes) => {
      await expect(
        client(async () => new Response(bytes, { status: 201, headers })).start(),
      ).resolves.toEqual({ kind: "CommandFailed" });
      expect(getCustomerCsrfCredential()).toBeNull();
    },
  );
  it.each([
    [400, "entry_request_invalid", "customer.entry.request_invalid", "Rescan", "RequestInvalid"],
    [
      422,
      "entry_unavailable",
      "customer.entry.unavailable",
      "RescanOrAskStaff",
      "EntryUnavailable",
    ],
    [
      503,
      "entry_service_unavailable",
      "customer.entry.service_unavailable",
      "RetryOrAskStaff",
      "ServiceUnavailable",
    ],
  ] as const)(
    "requires exact HTTP status for the %s failure contract",
    async (status, code, messageKey, action, kind) => {
      const error = {
        schemaVersion: 1,
        code,
        messageKey,
        recovery: { action, storeSelection: "Hidden" },
      };
      await expect(client(async () => response(status, error)).start()).resolves.toEqual({ kind });
      await expect(client(async () => response(200, error)).start()).resolves.toEqual({
        kind: "ServiceUnavailable",
      });
      expect(getCustomerCsrfCredential()).toBeNull();
    },
  );
});
