import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { CartError, CheckoutDetailsError, parseCheckoutDetailsSnapshot } from "@rms/ordering";
import { createApp } from "./app.js";
import {
  CustomerCheckoutDetailsHandler,
  type CustomerCheckoutDetailsPort,
} from "./customer-checkout-details.js";
const id = (n: number) => "01909996-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const origin = "https://customer.example";
const snapshot = parseCheckoutDetailsSnapshot({
  schemaVersion: 1,
  detailsReference: id(1),
  detailsVersion: 1,
  guestSessionReference: id(2),
  brandReference: id(3),
  storeReference: id(4),
  cartReference: id(5),
  cartVersion: 3,
  quoteReference: id(6),
  quoteVersion: 2,
  orderType: "Pickup",
  pickupContact: { name: "Synthetic guest", channel: "Phone", value: "+12025550123" },
  receipt: { choice: "TransactionalEmail", email: "receipt@example.invalid" },
  policies: [],
  recordedAt: "2026-09-11T00:00:00.000Z",
});
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(enabled = true) {
  const save = vi
    .fn<CustomerCheckoutDetailsPort["save"]>()
    .mockResolvedValue({ status: "Saved", snapshot });
  const read = vi.fn<NonNullable<CustomerCheckoutDetailsPort["read"]>>().mockResolvedValue({
    cartReference: snapshot.cartReference,
    cartVersion: snapshot.cartVersion,
    orderType: snapshot.orderType,
    details: snapshot,
  });
  const policy = vi.fn<NonNullable<CustomerCheckoutDetailsPort["policy"]>>().mockResolvedValue({
    cartReference: snapshot.cartReference,
    cartVersion: snapshot.cartVersion,
    orderType: snapshot.orderType,
    checkedAt: snapshot.recordedAt,
    validUntil: "2026-09-11T00:05:00.000Z",
    documents: [],
  });
  const server = createServer(
    createApp(
      enabled
        ? {
            customerCheckoutDetails: new CustomerCheckoutDetailsHandler({
              port: { quoteVersion: 2, save, read, policy },
              allowedOrigin: origin,
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/bff/customer/checkout-details";
  const body = {
    detailsReference: id(1),
    expectedVersion: 0,
    cartReference: id(5),
    cartVersion: 3,
    quoteReference: id(6),
    quoteVersion: 2,
    pickupContact: snapshot.pickupContact,
    receipt: snapshot.receipt,
    policies: [],
  };
  const headers = {
    origin,
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "idempotency-key": id(7),
    "x-csrf-token": "c".repeat(43),
    cookie: "__Host-bop-guest=" + "s".repeat(43),
  };
  const send = async (payload: unknown = body, overrides: Record<string, string> = {}) => {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: JSON.stringify(payload),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    return {
      status: response.status,
      payload: await response.json(),
      retryAfter: response.headers.get("retry-after"),
    };
  };
  const sendCurrent = async (
    payload: unknown = { cartReference: body.cartReference, cartVersion: body.cartVersion },
    overrides: Record<string, string> = {},
  ) => {
    const { "idempotency-key": _key, ...readHeaders } = headers;
    void _key;
    const response = await fetch(url + "/current", {
      method: "POST",
      headers: { ...readHeaders, ...overrides },
      body: JSON.stringify(payload),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    return { status: response.status, payload: await response.json() };
  };
  const sendPolicy = async () => {
    const response = await fetch(url + "/policy", {
      method: "POST",
      headers,
      body: JSON.stringify({ cartReference: body.cartReference, cartVersion: body.cartVersion }),
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    return { status: response.status, payload: await response.json() };
  };
  return { save, read, policy, body, send, sendCurrent, sendPolicy };
}
it("acknowledges the original saved revision without contact, policy or private identity disclosure", async () => {
  const f = await setup();
  const first = await f.send();
  expect(first.status).toBe(201);
  expect(first.payload).toEqual({
    schemaVersion: 1,
    details: {
      operationReference: id(7),
      detailsReference: id(1),
      detailsVersion: 1,
      cartReference: id(5),
      cartVersion: 3,
      quoteReference: id(6),
      quoteVersion: 2,
      orderType: "Pickup",
      receiptChoice: "TransactionalEmail",
      recordedAt: snapshot.recordedAt,
    },
  });
  const serialized = JSON.stringify(first.payload);
  for (const privateValue of [
    id(2),
    id(3),
    id(4),
    "+12025550123",
    "receipt@example.invalid",
    "Synthetic guest",
  ])
    expect(serialized).not.toContain(privateValue);
  f.save.mockResolvedValue({ status: "AlreadySaved", snapshot });
  expect(await f.send()).toEqual({ ...first, status: 200 });
});
it.each([
  { guestSessionReference: id(99) },
  { expectedVersion: -1 },
  { expectedVersion: 2147483647 },
  { cartVersion: 0 },
  { quoteVersion: 1 },
  { cartReference: "invalid" },
  { pickupContact: { ...snapshot.pickupContact, privateField: "unexpected" } },
  { receipt: { choice: "InSession", email: "unexpected@example.invalid" } },
  { policies: Array.from({ length: 21 }, () => ({})) },
])("rejects malformed or scope-bearing request before owner invocation", async (change) => {
  const f = await setup();
  expect((await f.send({ ...f.body, ...change })).status).toBe(400);
  expect(f.save).not.toHaveBeenCalled();
});
it.each([
  { origin: "https://foreign.example" },
  { "sec-fetch-site": "cross-site" },
  { "x-csrf-token": "" },
  { "idempotency-key": "invalid" },
  { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "t".repeat(43) },
])("rejects invalid credential or origin transport before owner invocation", async (headers) => {
  const f = await setup();
  expect((await f.send(f.body, headers)).status).toBe(400);
  expect(f.save).not.toHaveBeenCalled();
});
it.each([
  [new CartError("CART_PERMISSION_DENIED"), 404],
  [new CartError("CART_VERSION_CONFLICT"), 409],
  [new CartError("CART_IDEMPOTENCY_CONFLICT"), 409],
  [new CartError("CART_SELECTION_INVALID"), 422],
  [new CartError("CART_QUOTE_EXPIRED"), 422],
  [new CheckoutDetailsError(), 422],
  [new Error("private synthetic failure"), 503],
] as const)("maps refusal without exposing private error data", async (error, status) => {
  const f = await setup();
  f.save.mockRejectedValue(error);
  const result = await f.send();
  expect(result.status).toBe(status);
  expect(JSON.stringify(result.payload)).not.toContain("private synthetic");
});
it("keeps uncertain saves recoverable through the same key and payload", async () => {
  const f = await setup();
  f.save
    .mockRejectedValueOnce(new Error("synthetic lost acknowledgement"))
    .mockResolvedValueOnce({ status: "AlreadySaved", snapshot });
  const first = await f.send();
  expect(first.status).toBe(503);
  expect(first.retryAfter).toBe("5");
  expect((await f.send()).status).toBe(200);
  expect(f.save.mock.calls[1]).toEqual(f.save.mock.calls[0]);
});
it.each(["detailsVersion", "cartReference", "quoteReference", "receipt"] as const)(
  "rejects an owner acknowledgement for different %s",
  async (field) => {
    const f = await setup();
    f.save.mockResolvedValue({
      status: "Saved",
      snapshot: {
        ...snapshot,
        [field]:
          field === "detailsVersion"
            ? 2
            : field === "receipt"
              ? { choice: "InSession", email: null }
              : id(99),
      },
    });
    expect((await f.send()).status).toBe(503);
  },
);
it("keeps an unconfigured runtime unavailable", async () => {
  const f = await setup(false);
  expect((await f.send()).status).toBe(503);
});

it("returns saved form values only through the authorized current read projection", async () => {
  const f = await setup();
  const result = await f.sendCurrent();
  expect(result.status).toBe(200);
  const serialized = JSON.stringify(result.payload);
  expect(serialized).toContain("+12025550123");
  expect(serialized).toContain("receipt@example.invalid");
  for (const privateScope of [id(2), id(3), id(4)]) expect(serialized).not.toContain(privateScope);
  expect(f.save).not.toHaveBeenCalled();
});
it("preserves older saved Cart version in the current read", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    cartReference: id(5),
    cartVersion: 4,
    orderType: "Pickup",
    details: snapshot,
  });
  const result = await f.sendCurrent({ cartReference: id(5), cartVersion: 4 });
  expect(result.status).toBe(200);
  expect(result.payload).toMatchObject({
    checkout: { cartVersion: 4, details: { cartVersion: 3 } },
  });
});
it("returns null without manufacturing first details", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    cartReference: id(5),
    cartVersion: 3,
    orderType: "Pickup",
    details: null,
  });
  expect((await f.sendCurrent()).payload).toMatchObject({ checkout: { details: null } });
  expect(f.save).not.toHaveBeenCalled();
});
it("denies reading after current authority is lost", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new CartError("CART_PERMISSION_DENIED"));
  const result = await f.sendCurrent();
  expect(result.status).toBe(404);
  expect(JSON.stringify(result.payload)).not.toContain("+12025550123");
});
it("rejects malformed current read before owner access", async () => {
  const f = await setup();
  expect((await f.sendCurrent({ cartReference: id(5), cartVersion: 0 })).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});

it("returns explicit current policy requirements through the private query", async () => {
  const f = await setup();
  expect((await f.sendPolicy()).payload).toEqual({
    schemaVersion: 1,
    policy: {
      cartReference: snapshot.cartReference,
      cartVersion: snapshot.cartVersion,
      orderType: snapshot.orderType,
      checkedAt: snapshot.recordedAt,
      validUntil: "2026-09-11T00:05:00.000Z",
      documents: [],
    },
  });
  expect(f.save).not.toHaveBeenCalled();
});
it("does not replace unavailable policy authority with no documents", async () => {
  const f = await setup();
  f.policy.mockRejectedValue(new CartError("CART_DEPENDENCY_UNAVAILABLE"));
  expect((await f.sendPolicy()).status).toBe(503);
});
it("rejects an unprojected policy result", async () => {
  const f = await setup();
  f.policy.mockResolvedValue({
    cartReference: id(99),
    cartVersion: 3,
    orderType: "Pickup",
    checkedAt: snapshot.recordedAt,
    validUntil: "2026-09-11T00:05:00.000Z",
    documents: [],
  });
  expect((await f.sendPolicy()).status).toBe(503);
});

it("projects a versioned policy document as plain text without extra owner fields", async () => {
  const f = await setup();
  const document = {
    documentReference: id(90),
    documentVersion: 2,
    documentDigest: "sha256:" + "a".repeat(64),
    purposeCode: "ORDER_TERMS",
    title: "Synthetic fixture",
    bodyText: "Synthetic text only; no Store approval.",
  };
  f.policy.mockResolvedValue({
    cartReference: snapshot.cartReference,
    cartVersion: snapshot.cartVersion,
    orderType: snapshot.orderType,
    checkedAt: snapshot.recordedAt,
    validUntil: "2026-09-11T00:05:00.000Z",
    documents: [document],
  });
  expect((await f.sendPolicy()).payload).toMatchObject({ policy: { documents: [document] } });
});
