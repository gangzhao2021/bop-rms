import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { CheckoutSessionServiceError } from "@rms/ordering";
import { createApp } from "./app.js";
import {
  CustomerCheckoutSessionHandler,
  CustomerCheckoutSessionReadHandler,
  type CustomerCheckoutSessionReadPort,
  type CustomerCheckoutSessionPort,
} from "./customer-checkout-session.js";
const id = (n: number) => `018f5400-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T15:00:00.000Z";
const until = "2026-08-02T15:05:00.000Z";
const hash = `sha256:${"a".repeat(64)}`;
function fixture(quoteVersion = 1) {
  const binding = {
    brandReference: id(1),
    storeReference: id(2),
    cartReference: id(3),
    cartVersion: 4,
    quoteReference: id(4),
    orderType: "Pickup",
    sourceChannel: "Qr",
  };
  return {
    schemaVersion: 1,
    checkoutSessionReference: id(10),
    createOperationReference: id(11),
    submissionReference: id(12),
    paymentOperationReference: id(13),
    createdAt: at,
    validation: {
      ...binding,
      validationReference: id(5),
      validationIntentHash: hash,
      guestSessionReference: id(6),
      quoteVersion,
      quoteInputDigest: hash,
      catalogLines: [
        {
          cartItemReference: id(7),
          sellableReference: id(8),
          menuVersionReference: id(9),
          productVersionReference: id(14),
          validatedAt: at,
        },
      ],
      fulfillment: {
        ...binding,
        status: "Accepted",
        evidenceReference: id(15),
        evidenceVersion: 1,
        evidenceDigest: hash,
        checkedAt: at,
        validUntil: until,
      },
      validatedAt: at,
      validUntil: until,
    },
  };
}

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(version: 1 | 2 = 1, enabled = true) {
  const session = fixture(version);
  const create = vi
    .fn<CustomerCheckoutSessionPort["create"]>()
    .mockResolvedValue({ status: "Created", session });
  const server = createServer(
    createApp(
      enabled
        ? {
            customerCheckoutSession: new CustomerCheckoutSessionHandler({
              port: { quoteVersion: version, create },
              allowedOrigin: "https://customer.example",
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" +
    (server.address() as AddressInfo).port +
    "/api/v1/carts/" +
    id(3) +
    "/checkout-sessions";
  const body = { cartVersion: 4, quoteReference: id(4) };
  const headers = {
    origin: "https://customer.example",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "idempotency-key": id(11),
    "x-csrf-token": "c".repeat(43),
    cookie: "__Host-bop-guest=" + "s".repeat(43),
  };
  const send = (payload: unknown = body, overrides: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: { ...headers, ...overrides },
      body: JSON.stringify(payload),
    });
  return { create, session, send, body };
}
it.each([1, 2] as const)(
  "projects exact version %s and recovers original without internal IDs",
  async (version) => {
    const f = await setup(version);
    const response = await f.send();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    const body = await response.json();
    expect(body).toEqual({
      schemaVersion: 1,
      session: {
        checkoutSessionReference: id(10),
        cartReference: id(3),
        cartVersion: 4,
        quoteReference: id(4),
        quoteVersion: version,
        createdAt: at,
      },
    });
    expect(f.create).toHaveBeenCalledWith({
      sessionCredential: "s".repeat(43),
      csrfCredential: "c".repeat(43),
      command: {
        createOperationReference: id(11),
        cartReference: id(3),
        cartVersion: 4,
        quoteReference: id(4),
        quoteVersion: version,
      },
    });
    f.create.mockResolvedValue({ status: "AlreadyCreated", session: f.session });
    const replay = await f.send();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual(body);
  },
);
it("rejects untrusted request fields, cross-origin, missing CSRF and duplicate cookies before composition", async () => {
  const f = await setup();
  for (const payload of [
    { ...f.body, paymentOperationReference: id(90) },
    { ...f.body, cartVersion: 0 },
    { ...f.body, quoteVersion: 2 },
  ]) {
    expect((await f.send(payload)).status).toBe(400);
  }
  for (const headers of [
    { origin: "https://foreign.example" },
    { "x-csrf-token": "" },
    { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "s".repeat(43) },
    { "idempotency-key": "invalid" },
  ]) {
    expect((await f.send(f.body, headers)).status).toBe(400);
  }
  expect(f.create).not.toHaveBeenCalled();
});
it.each([
  ["INPUT_INVALID", 400],
  ["PERMISSION_DENIED", 404],
  ["INTENT_CONFLICT", 409],
  ["DEPENDENCY_UNAVAILABLE", 503],
] as const)("maps %s without exposing owner errors", async (code, status) => {
  const f = await setup();
  f.create.mockRejectedValue(new CheckoutSessionServiceError(code));
  const response = await f.send();
  expect(response.status).toBe(status);
  expect(await response.text()).not.toContain("guestSessionReference");
  if (status === 503) expect(response.headers.get("retry-after")).toBe("5");
});
it("rejects foreign operation and malformed owner results", async () => {
  const f = await setup();
  for (const session of [
    { ...f.session, createOperationReference: id(90) },
    { ...f.session, clientSecret: "never-return" },
    { ...f.session, validation: { ...f.session.validation, quoteVersion: 2 } },
  ]) {
    f.create.mockResolvedValue({ status: "Created", session });
    const response = await f.send();
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("never-return");
  }
});
it("fails closed when runtime composition is unavailable", async () => {
  const f = await setup(1, false);
  expect((await f.send()).status).toBe(503);
});

it("reads a current-authorized session through GET without disclosing owner operations", async () => {
  const session = fixture();
  const read = vi.fn<CustomerCheckoutSessionReadPort["read"]>().mockResolvedValue(session);
  const server = createServer(
    createApp({
      customerCheckoutSessionRead: new CustomerCheckoutSessionReadHandler({
        port: { read },
        allowedOrigin: "https://customer.example",
      }),
    }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" +
    (server.address() as AddressInfo).port +
    "/api/v1/checkout-sessions/" +
    id(10);
  const headers = {
    "sec-fetch-site": "same-origin",
    "x-csrf-token": "c".repeat(43),
    cookie: "__Host-bop-guest=" + "s".repeat(43),
  };
  const response = await fetch(url, { headers });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    session: {
      checkoutSessionReference: id(10),
      cartReference: id(3),
      cartVersion: 4,
      quoteReference: id(4),
      quoteVersion: 1,
      createdAt: at,
    },
  });
  expect(read).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    checkoutSessionReference: id(10),
  });
  read.mockClear();
  expect((await fetch(url + "?scope=other", { headers })).status).toBe(400);
  expect(
    (await fetch(url, { headers: { ...headers, origin: "https://foreign.example" } })).status,
  ).toBe(400);
  expect((await fetch(url, { headers: { ...headers, "x-csrf-token": "" } })).status).toBe(400);
  expect(read).not.toHaveBeenCalled();
  read.mockRejectedValue(new CheckoutSessionServiceError("PERMISSION_DENIED"));
  expect((await fetch(url, { headers })).status).toBe(404);
  read.mockResolvedValue({ ...session, checkoutSessionReference: id(90) });
  expect((await fetch(url, { headers })).status).toBe(503);
});
