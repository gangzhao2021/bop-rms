import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, it, expect, vi } from "vitest";
import { OrderStatusProjectionError } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerPickupCodeHandler } from "./customer-pickup-code.js";
const servers: Server[] = [];
const id = "0190fa48-0000-7000-8000-000000000001";
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
async function setup(enabled = true) {
  const read = vi.fn().mockResolvedValue({
    schemaVersion: 1,
    status: "Ready",
    orderReference: id,
    orderNumber: "11",
    storeDisplayName: "DEMO Store",
    pickupInstruction: "Show staff",
    generation: 1,
    proofKind: "Opaque",
    proofValue: "A".repeat(22),
    observedAt: "2026-09-20T06:00:00.000Z",
    expiresAt: "2026-09-20T07:00:00.000Z",
    privateMetadata: "never serialize",
  });
  const app = createApp(
    enabled
      ? {
          customerPickupCode: new CustomerPickupCodeHandler({
            allowedOrigin: "https://store.example",
            port: { read },
          }),
        }
      : {},
  );
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/orders/${id}/pickup-code`;
  const headers = {
    "sec-fetch-site": "same-origin",
    origin: "https://store.example",
    cookie: "__Host-bop-guest=" + "A".repeat(43),
    "x-csrf-token": "B".repeat(43),
  };
  return {
    read,
    request: (extra: Record<string, string> = {}, suffix = "") =>
      fetch(url + suffix, { headers: { ...headers, ...extra } }),
  };
}
it("returns only explicit proof fields and forbids caching", async () => {
  const f = await setup(),
    response = await f.request();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).not.toHaveProperty("privateMetadata");
});
it("rejects cross-origin, absent CSRF, duplicate cookie and query injection before querying", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://other.example" },
    { "x-csrf-token": "" },
    { cookie: "__Host-bop-guest=" + "A".repeat(43) + "; __Host-bop-guest=" + "B".repeat(43) },
  ])
    expect((await f.request(headers)).status).toBe(400);
  expect((await f.request({}, "?proof=forbidden")).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
it("conceals unauthorized order existence and fails safely when unconfigured", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED"));
  expect((await f.request()).status).toBe(404);
  const off = await setup(false);
  expect((await off.request()).status).toBe(503);
});
it("rejects a proof bound to a different order", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    status: "NotReady",
    orderReference: "0190fa48-0000-7000-8000-000000000002",
  });
  expect((await f.request()).status).toBe(503);
});
