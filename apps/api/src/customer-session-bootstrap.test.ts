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
  const server = createServer(
    createApp(
      enabled
        ? {
            customerSessionBootstrap: createCustomerSessionBootstrapHandler({
              allowedOrigin: "https://store.example",
              port: { read },
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
it("conceals absent sessions and fails safely without configuration", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const r = await f.request();
  expect(r.status).toBe(401);
  expect(JSON.stringify(await r.json())).not.toContain("A".repeat(43));
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
