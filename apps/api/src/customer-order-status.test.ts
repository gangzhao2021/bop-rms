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
  const received = vi.fn().mockResolvedValue(null);
  const tableOrder = vi.fn().mockResolvedValue(false);
  const server = createServer(
    createApp(
      enabled
        ? {
            customerOrderStatus: new CustomerOrderStatusHandler({
              allowedOrigin: "https://pilot.example",
              port: { read, received, tableOrder },
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
    received,
    tableOrder,
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
it("WP-2423 Q12: serializes only the time a pickup was cancelled for an unpaid payment window", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      pickup: null,
      unpaidCancellation: { cancelledAt: "2026-09-12T11:40:00.000Z", reasonCode: "private" },
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.unpaidCancellation).toEqual({
    cancelledAt: "2026-09-12T11:40:00.000Z",
  });
  expect(JSON.stringify(body)).not.toContain("private");
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      unpaidCancellation: null,
    },
  });
  const open = (await (await f.send()).json()) as typeof body;
  expect(open.status.sources.unpaidCancellation).toBeNull();
});
it("WP-2423 Q6: serializes only customer-safe store cancellations with their refund status", async () => {
  const f = await setup();
  const cancellation = {
    orderBatchReference: "0190fa01-0000-7000-8000-000000000002",
    cancelledAt: "2026-09-12T11:40:00.000Z",
    reason: "SoldOut",
    refundStatus: "Pending",
  };
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      staffCancellations: [{ ...cancellation, actorReference: "private" }],
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.staffCancellations).toEqual([cancellation]);
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423 Q6 step 2a: serializes item cancellations with refund amount; a failed refund shows as pending", async () => {
  const f = await setup();
  const cancellation = {
    orderBatchReference: "0190fa01-0000-7000-8000-000000000002",
    orderItemReferences: ["0190fa01-0000-7000-8000-000000000003"],
    cancelledAt: "2026-09-12T11:40:00.000Z",
    reason: "SoldOut",
  };
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      itemCancellations: [
        {
          ...cancellation,
          refundStatus: "Failed",
          refundAmount: { amountMinor: 565n, currencyCode: "CAD" },
          actorReference: "private",
        },
      ],
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.itemCancellations).toEqual([
    {
      ...cancellation,
      refundStatus: "Pending",
      refundAmount: { amountMinor: "565", currencyCode: "CAD" },
    },
  ]);
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423 Q6: serializes unpaid dine-in rounds and their automatic cancellation", async () => {
  const f = await setup();
  const failed = {
    orderBatchReference: "0190fa01-0000-7000-8000-000000000002",
    status: "Failed",
    cancelsAt: "2026-09-12T12:30:00.000Z",
  };
  const cancelled = {
    orderBatchReference: "0190fa01-0000-7000-8000-000000000004",
    cancelledAt: "2026-09-12T11:50:00.000Z",
    // WP-2423: a manager cancelled it (the guest is told the store did, not a failed payment).
    byStore: true,
  };
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      batchPayments: [{ ...failed, actorReference: "private" }],
      unpaidCancellations: [{ ...cancelled, operationReference: "private" }],
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.batchPayments).toEqual([failed]);
  expect(body.status.sources.unpaidCancellations).toEqual([cancelled]);
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423 Q10: serializes only the Store's published phone and address", async () => {
  const f = await setup();
  const storeContact = {
    phone: "+14165550123",
    addressLines: ["DEMO 100 Test Street"],
    locality: "Toronto",
    regionCode: "ON",
    postalCode: "M5V 1A1",
  };
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      storeContact: { ...storeContact, ownerEmail: "private" },
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.storeContact).toEqual(storeContact);
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423 D5: serializes each item's price before tax and its tax as exact decimals", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      itemPrices: [
        {
          orderItemReference: id(4),
          subtotal: { amountMinor: 1000n, currencyCode: "CAD" },
          tax: { amountMinor: 130n, currencyCode: "CAD" },
          quoteInputDigest: "private",
        },
      ],
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.itemPrices).toEqual([
    {
      orderItemReference: id(4),
      subtotal: { amountMinor: "1000", currencyCode: "CAD" },
      tax: { amountMinor: "130", currencyCode: "CAD" },
    },
  ]);
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423 (v15 aa3d9fac D2): serializes each paid round's tip as an exact decimal", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      tips: [
        {
          orderBatchReference: id(3),
          amount: { amountMinor: 135n, currencyCode: "CAD" },
          paymentIntentReference: "private",
        },
      ],
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.tips).toEqual([
    { orderBatchReference: id(3), amount: { amountMinor: "135", currencyCode: "CAD" } },
  ]);
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423 (v15 3cd0f8dd H1/M3): serializes card-machine rounds and confirmed refunds as decimals", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: [
        {
          status: "Succeeded",
          occurredAt: "2026-09-12T11:00:00.000Z",
          amount: { amountMinor: 544n, currencyCode: "CAD" },
          freshnessStatus: "Fresh",
        },
        {
          status: "Succeeded",
          occurredAt: "2026-09-12T11:05:00.000Z",
          amount: { amountMinor: 537n, currencyCode: "CAD" },
          freshnessStatus: "Fresh",
          method: "CardMachine",
          orderBatchReference: id(3),
          slipReference: "private",
        },
      ],
      refunds: {
        refunded: { amountMinor: 736n, currencyCode: "CAD" },
        entries: [
          {
            kind: "Refund",
            orderItemReferences: [id(4)],
            total: { amountMinor: 736n, currencyCode: "CAD" },
            tip: { amountMinor: 86n, currencyCode: "CAD" },
            refundReference: "private",
          },
        ],
      },
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.payments).toEqual([
    {
      status: "Succeeded",
      occurredAt: "2026-09-12T11:00:00.000Z",
      freshnessStatus: "Fresh",
      amount: { amountMinor: "544", currencyCode: "CAD" },
    },
    {
      status: "Succeeded",
      occurredAt: "2026-09-12T11:05:00.000Z",
      freshnessStatus: "Fresh",
      amount: { amountMinor: "537", currencyCode: "CAD" },
      method: "CardMachine",
      orderBatchReference: id(3),
    },
  ]);
  expect(body.status.sources.refunds).toEqual({
    refunded: { amountMinor: "736", currencyCode: "CAD" },
    entries: [
      {
        kind: "Refund",
        orderItemReferences: [id(4)],
        total: { amountMinor: "736", currencyCode: "CAD" },
        tip: { amountMinor: "86", currencyCode: "CAD" },
      },
    ],
  });
  expect(JSON.stringify(body)).not.toContain("private");
});
it("WP-2423: serializes each item's chosen options with what they added, and the guest's note", async () => {
  const f = await setup();
  f.read.mockResolvedValue({
    ...f.result,
    sources: {
      checkedAt: "2026-09-12T12:00:00.000Z",
      kitchen: null,
      payments: null,
      itemPrices: [
        {
          orderItemReference: id(4),
          subtotal: { amountMinor: 400n, currencyCode: "CAD" },
          tax: { amountMinor: 52n, currencyCode: "CAD" },
          options: [
            {
              displayName: "Whipped cream",
              quantity: 1,
              amount: { amountMinor: 50n, currencyCode: "CAD" },
            },
          ],
          customerNote: "Less sweet",
        },
      ],
    },
  });
  const body = (await (await f.send()).json()) as {
    status: { sources: Record<string, unknown> };
  };
  expect(body.status.sources.itemPrices).toEqual([
    {
      orderItemReference: id(4),
      subtotal: { amountMinor: "400", currencyCode: "CAD" },
      tax: { amountMinor: "52", currencyCode: "CAD" },
      options: [
        {
          displayName: "Whipped cream",
          quantity: 1,
          amount: { amountMinor: "50", currencyCode: "CAD" },
        },
      ],
      customerNote: "Less sweet",
    },
  ]);
});
it("WP-2423: answers 'received' for the guest's own order while its status projection catches up", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_NOT_FOUND"));
  f.received.mockResolvedValue({
    orderReference: id(31),
    orderNumber: "1001",
    orderType: "Pickup",
    submittedAt: "2026-09-12T11:00:00.000Z",
    checkedAt: "2026-09-12T11:00:04.000Z",
    guestSessionReference: "private",
  });
  const response = await f.send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    received: {
      orderReference: id(31),
      orderNumber: "1001",
      orderType: "Pickup",
      submittedAt: "2026-09-12T11:00:00.000Z",
      checkedAt: "2026-09-12T11:00:04.000Z",
    },
  });
  expect(f.received).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    orderReference: id(31),
  });
});
it("WP-2423: still refuses an unknown order, another guest's order and failed authorization", async () => {
  const f = await setup();
  // Unknown order or one this guest did not place: the owner record lookup answers null.
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_NOT_FOUND"));
  f.received.mockResolvedValue(null);
  let response = await f.send();
  expect(response.status).toBe(404);
  expect(await response.text()).not.toContain("received");
  // A record for a different order is never shown.
  f.received.mockResolvedValue({
    orderReference: id(99),
    orderNumber: "1002",
    orderType: "Pickup",
    submittedAt: "2026-09-12T11:00:00.000Z",
    checkedAt: "2026-09-12T11:00:04.000Z",
  });
  expect((await f.send()).status).toBe(404);
  f.received.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED"));
  expect((await f.send()).status).toBe(404);
  f.received.mockRejectedValue(new Error("private SQL credentials"));
  response = await f.send();
  expect(response.status).toBe(503);
  expect(await response.text()).not.toContain("private");
  // A projection that exists but belongs to another guest is refused without the fallback.
  f.received.mockClear();
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED"));
  expect((await f.send()).status).toBe(404);
  expect(f.received).not.toHaveBeenCalled();
});
it("46940b76 L5: tells a guest at the open table that another guest there placed the order", async () => {
  const f = await setup();
  f.read.mockRejectedValue(new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED"));
  f.tableOrder.mockResolvedValue(true);
  const response = await f.send();
  expect(response.status).toBe(404);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({
    schemaVersion: 1,
    error: { code: "order_status_table_order", messageKey: "customer.order.status.table_order" },
  });
  expect(f.tableOrder).toHaveBeenCalledWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    orderReference: id(31),
  });
  // Not the table's order: refused exactly as before; a failing check is a 503 without detail.
  f.tableOrder.mockResolvedValue(false);
  let refused = await f.send();
  expect(refused.status).toBe(404);
  expect(await refused.text()).toContain("order_status_not_found");
  f.tableOrder.mockRejectedValue(new Error("private SQL credentials"));
  refused = await f.send();
  expect(refused.status).toBe(503);
  expect(await refused.text()).not.toContain("private");
});
