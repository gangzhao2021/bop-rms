import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, it, expect, vi } from "vitest";
import { GuestSessionError } from "@bop/identity";
import { createApp } from "./app.js";
import { createCustomerSessionBootstrapHandler } from "./customer-session-bootstrap.js";
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function setup(enabled = true) {
  const read = vi.fn().mockResolvedValue("B".repeat(43));
  const readEndedVisit = vi
    .fn()
    .mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const server = createServer(
    createApp(
      enabled
        ? {
            customerSessionBootstrap: createCustomerSessionBootstrapHandler({
              allowedOrigin: "https://store.example",
              port: { read, readEndedVisit },
            }),
          }
        : {},
    ),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/customer/session/csrf`;
  const headers = {
    "sec-fetch-site": "same-origin",
    "x-bop-session-bootstrap": "1",
    origin: "https://store.example",
    cookie: "__Host-bop-guest=" + "A".repeat(43),
  };
  return {
    read,
    readEndedVisit,
    request: (extra: Record<string, string> = {}, suffix = "") =>
      fetch(url + suffix, { headers: { ...headers, ...extra } }),
  };
}
it("returns only no-store foreground CSRF without setting or exposing a session cookie", async () => {
  const f = await setup(),
    r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.json()).toEqual({ schemaVersion: 1, csrfToken: "B".repeat(43) });
});
it("rejects cross-origin, navigation, missing marker, duplicate cookie and query input before authentication", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://other.example" },
    { "sec-fetch-site": "cross-site" },
    { "sec-fetch-site": "none" },
    { "x-bop-session-bootstrap": "" },
    { cookie: "__Host-bop-guest=" + "A".repeat(43) + "; __Host-bop-guest=" + "A".repeat(43) },
  ])
    expect((await f.request(headers)).status).toBe(400);
  expect((await f.request({}, "?session=untrusted")).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
it("answers a first visit without a Guest Session cookie with an empty 204, issuing nothing", async () => {
  const f = await setup();
  const r = await f.request({ cookie: "" });
  expect(r.status).toBe(204);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.text()).toBe("");
  expect(f.read).not.toHaveBeenCalled();
  // Without a cookie the request-shape checks still apply first.
  expect((await f.request({ cookie: "", "sec-fetch-site": "cross-site" })).status).toBe(400);
  expect((await f.request({ cookie: "", "x-bop-session-bootstrap": "" })).status).toBe(400);
  expect((await f.request({ cookie: "other=1" })).status).toBe(204);
  expect((await f.request({ cookie: "__Host-bop-guest=short" })).status).toBe(400);
});
it("answers an ended or expired visit like a first visit: an empty 204 with no token", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const r = await f.request();
  expect(r.status).toBe(204);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  expect(await r.text()).toBe("");
  expect(f.read).toHaveBeenCalledTimes(1);
});
it("WP-2423 (v15 3cd0f8dd M5): gives a visit that ended its receipt access, nothing else", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const order = {
    orderReference: "018f8a00-0000-7000-8000-000000000016",
    orderNumber: "22",
    orderType: "DineIn",
  };
  f.readEndedVisit.mockResolvedValue({
    csrfToken: "C".repeat(43),
    order,
    receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(r.headers.get("cache-control")).toBe("no-store");
  expect(r.headers.get("set-cookie")).toBeNull();
  // No csrfToken at the top level: an older page treats it as nothing to restore.
  expect(await r.json()).toEqual({
    schemaVersion: 1,
    endedVisit: {
      csrfToken: "C".repeat(43),
      order,
      receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
    },
  });
  expect(f.readEndedVisit).toHaveBeenCalledWith("A".repeat(43));
  // Malformed owner output is never passed on.
  f.readEndedVisit.mockResolvedValue({
    csrfToken: "C".repeat(43),
    order: { ...order, orderType: "Delivery" },
    receiptAvailableUntil: "2026-10-18T18:01:49.437Z",
  });
  expect((await f.request()).status).toBe(204);
  // A visit with no order (or past the 24 h bound) has nothing to restore.
  f.readEndedVisit.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  expect((await f.request()).status).toBe(204);
});
it("conceals other Session failures and fails safely without configuration", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_VERSION_CONFLICT"));
  const r = await f.request();
  expect(r.status).toBe(401);
  expect(JSON.stringify(await r.json())).not.toContain("A".repeat(43));
  f.read.mockRejectedValue(new Error("database down"));
  expect((await f.request()).status).toBe(503);
  expect((await (await setup(false)).request()).status).toBe(503);
});

it("returns whitelisted public menu context from the authenticated bootstrap port", async () => {
  const f = await setup();
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "DineIn",
    locale: "en-CA",
    brandDisplayName: "DEMO Brand",
    storeDisplayName: "DEMO Store",
  };
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    menuContext: { ...menuContext, privateReference: "must-not-leak" },
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  expect(await r.json()).toEqual({ schemaVersion: 1, csrfToken: "B".repeat(43), menuContext });
});

it("whitelists a recovery reference and refuses malformed owner output", async () => {
  const f = await setup();
  const checkoutSessionReference = "0190fa21-0000-7000-8000-000000000002";
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    checkoutSessionReference,
    paymentOperationReference: "hidden",
  });
  expect(await (await f.request()).json()).toEqual({
    schemaVersion: 1,
    csrfToken: "B".repeat(43),
    checkoutSessionReference,
  });
  f.read.mockResolvedValue({ csrfToken: "B".repeat(43), checkoutSessionReference: "invalid" });
  expect((await f.request()).status).toBe(503);
});

it("WP-2423 Q10: returns the Session's latest order so a reopened app can continue it", async () => {
  const f = await setup();
  const menuContext = {
    publicStoreReference: "0190fa21-0000-7000-8000-000000000001",
    channel: "Pickup",
    locale: "en-CA",
    brandDisplayName: "DEMO Brand",
    storeDisplayName: "DEMO Store",
  };
  const currentOrder = {
    orderReference: "0190fa21-0000-7000-8000-000000000003",
    orderNumber: "12",
    orderType: "Pickup",
  };
  f.read.mockResolvedValue({
    csrfToken: "B".repeat(43),
    currentOrder: { ...currentOrder, guestSessionReference: "must-not-leak" },
    menuContext,
  });
  const r = await f.request();
  expect(r.status).toBe(200);
  const body = await r.json();
  expect(body).toEqual({ schemaVersion: 1, csrfToken: "B".repeat(43), currentOrder, menuContext });
  for (const malformed of [
    { ...currentOrder, orderNumber: "0" },
    { ...currentOrder, orderType: "Delivery" },
    { ...currentOrder, orderReference: "not-a-reference" },
  ]) {
    f.read.mockResolvedValue({ csrfToken: "B".repeat(43), currentOrder: malformed, menuContext });
    expect((await f.request()).status).toBe(503);
  }
});
