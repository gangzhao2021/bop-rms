import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { OrderStatusProjectionError } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerOrderStatusHandler } from "./customer-order-status.js";
const servers: Server[] = [];
const id = (n: number) => "0198a001-0000-7000-8000-" + n.toString(16).padStart(12, "0");
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
async function setup(enabled = true) {
  const result = {
    projectionName: "ordering_order_status_v1",
    projectionVersion: 1,
    sourceCheckpoint: id(2),
    projectedAt: "2026-09-12T12:00:00.000Z",
    freshnessStatus: "Fresh",
    order: {
      orderReference: id(31),
      orderNumber: "1001",
      orderType: "Pickup",
      canonicalPhase: "Submitted",
      paymentStatus: "NotReported",
      kitchenStatus: "Unavailable",
      fulfillmentStatus: "Unavailable",
      fulfilledAt: null,
      eta: null,
      submittedAt: "2026-09-12T11:00:00.000Z",
      batches: [
        {
          orderBatchReference: id(3),
          submittedAt: "2026-09-12T11:00:00.000Z",
          items: [
            {
              orderItemReference: id(4),
              displayName: "Synthetic bowl",
              quantity: 1,
              lineTotal: { amountMinor: 9223372036854775807n, currencyCode: "CAD" },
            },
          ],
        },
      ],
    },
  };
  const read = vi.fn().mockResolvedValue(result);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerOrderStatus: new CustomerOrderStatusHandler({
              allowedOrigin: "https://pilot.example",
              port: { read },
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
    "/api/v1/orders/" +
    id(31) +
    "/status";
  return {
    read,
    result,
    send: (headers: Record<string, string> = {}, query = "") =>
      fetch(url + query, {
        headers: {
          "sec-fetch-site": "same-origin",
          cookie: "__Host-bop-guest=" + "s".repeat(43),
          "x-csrf-token": "c".repeat(43),
          ...headers,
        },
      }),
  };
}
it("returns only the scoped closed result with no-store/no-referrer, without requiring GET Origin", async () => {
  const f = await setup(),
    response = await f.send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  expect(await response.json()).toEqual(
    JSON.parse(
      JSON.stringify({ schemaVersion: 1, status: f.result }, (_key, value) =>
        typeof value === "bigint" ? value.toString() : value,
      ),
    ),
  );
  expect(f.read).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    orderReference: id(31),
  });
});
it("rejects foreign origins, missing metadata/CSRF, duplicate cookies and caller query before reads", async () => {
  const f = await setup();
  for (const headers of [
    { origin: "https://foreign.example" },
    { "sec-fetch-site": "cross-site" },
    { "x-csrf-token": "" },
    { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "s".repeat(43) },
  ])
    expect((await f.send(headers)).status).toBe(400);
  expect((await f.send({}, "?paid=true")).status).toBe(400);
  expect(f.read).not.toHaveBeenCalled();
});
it("rejects a different order or invalid money and bounds dependency errors", async () => {
  const f = await setup();
  f.read.mockResolvedValue({ ...f.result, order: { ...f.result.order, orderReference: id(99) } });
  expect((await f.send()).status).toBe(503);
  const item = f.result.order.batches[0]?.items[0];
  if (!item) throw new Error("missing synthetic item");
  item.lineTotal.amountMinor = 9223372036854775808n;
  f.read.mockResolvedValue(f.result);
  expect((await f.send()).status).toBe(503);
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED"));
  expect((await f.send()).status).toBe(404);
  f.read.mockRejectedValue(new Error("private SQL credentials"));
  const response = await f.send();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
});
it("only serializes customer-safe fields and fails closed when unconfigured", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    internal: "private",
    order: { ...f.result.order, guestSessionReference: "private" },
  });
  const response = await f.send();
  expect(response.status).toBe(200);
  expect(await response.text()).not.toContain("private");
  expect((await (await setup(false)).send()).status).toBe(503);
});
it("WP-2423: serializes only the not-collected time of a pickup source", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      pickup: { notCollectedAt: "2026-09-12T11:59:00.000Z", actorReference: "private" },
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.pickup).toEqual({ notCollectedAt: "2026-09-12T11:59:00.000Z" });
  expect(JSON.stringify(body)).not.toContain("private");
  f.read.mockResolvedValue({
    ...f.result,
    sources: { checkedAt: "2026-09-12T12:00:00.000Z", kitchen: null, payments: null },
  });
  const without = (await (await f.send()).json()) as typeof body;
  expect(without.status.sources).not.toHaveProperty("pickup");
});
