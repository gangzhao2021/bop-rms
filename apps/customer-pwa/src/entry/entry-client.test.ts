import { describe, expect, it, vi } from "vitest";
import { consumeCustomerQrFragment, createCustomerEntryClient } from "./entry-client.js";
import {
  getCustomerCsrfCredential,
  getPaymentOperationReference,
  setPaymentOperationReference,
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
  return { status, json: async () => body } as Response;
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
