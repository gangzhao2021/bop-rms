import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { DigitalReceiptError, parseDigitalReceiptChain } from "@rms/ordering";
import { createApp } from "./app.js";
import { CustomerReceiptHandler } from "./customer-receipt.js";
const id = (n: number) => "0190ec05-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-12T12:00:00.000Z";
const money = (amountMinor: bigint) => ({ amountMinor, currencyCode: "CAD" });
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
async function setup(
  enabled = true,
  financial?: import("./customer-receipt-financial.js").CustomerReceiptFinancialView | null,
) {
  const chain = parseDigitalReceiptChain({
    orderReference: id(1),
    records: [
      {
        recordReference: id(2),
        version: 1,
        kind: "Original",
        recordedAt: at,
        previousRecordReference: null,
        reasonCode: null,
        snapshot: {
          receiptReference: id(3),
          orderReference: id(1),
          guestSessionReference: id(4),
          operatingEntityReference: id(5),
          operatingEntityDisplayName: "Synthetic issuer",
          brandReference: id(6),
          storeReference: id(7),
          storeDisplayName: "Synthetic Store",
          orderNumber: "1",
          issuedAt: at,
          locale: "en-CA",
          templateVersion: "RECEIPT_V1",
          lines: [
            {
              lineReference: id(8),
              displayName: "Synthetic item",
              quantity: 1,
              lineTotal: money(100n),
            },
          ],
          subtotal: money(100n),
          tax: money(13n),
          tip: money(0n),
          total: money(114n),
          adjustments: { discount: money(1n), fee: money(2n) },
          paymentStatus: "Paid",
          refundedTotal: money(0n),
        },
      },
    ],
  });
  const read = vi.fn().mockResolvedValue(chain);
  const readView = vi.fn().mockImplementation(async () => ({ chain, financial }));
  const server = createServer(
    createApp(
      enabled
        ? {
            customerReceipt: new CustomerReceiptHandler({
              allowedOrigin: "https://pilot.example",
              port: { read, ...(financial === undefined ? {} : { readView }) },
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
    id(1) +
    "/receipt";
  return {
    read,
    readView,
    chain,
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
it("serializes only immutable customer receipt fields and exact decimal amounts", async () => {
  const test = await setup();
  const response = await test.send();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  const body = await response.json();
  expect(body).toMatchObject({
    receipt: {
      orderReference: id(1),
      freshnessStatus: "Stale",
      deliveryStatus: "Unavailable",
      supportEligible: false,
      cancellationEligible: false,
      records: [
        {
          snapshot: {
            total: { amountMinor: "114" },
            adjustments: { discount: { amountMinor: "1" }, fee: { amountMinor: "2" } },
          },
        },
      ],
    },
  });
  const encoded = JSON.stringify(body);
  for (const key of [
    "guestSessionReference",
    "operatingEntityReference",
    "brandReference",
    "storeReference",
    "templateVersion",
    "previousRecordReference",
  ])
    expect(encoded).not.toContain(key);
  expect(test.read).toHaveBeenCalledExactlyOnceWith({
    sessionCredential: "s".repeat(43),
    csrfCredential: "c".repeat(43),
    orderReference: id(1),
  });
});
it("rejects cross-origin, duplicate cookies and extraneous query data before owner access", async () => {
  const test = await setup();
  for (const headers of [
    { "sec-fetch-site": "cross-site" },
    { cookie: "__Host-bop-guest=" + "s".repeat(43) + "; __Host-bop-guest=" + "s".repeat(43) },
    { "x-csrf-token": "" },
  ]) {
    expect((await test.send(headers)).status).toBe(400);
  }
  expect((await test.send({}, "?guest=" + id(4))).status).toBe(400);
  expect(test.read).not.toHaveBeenCalled();
});
it("does not disclose permission failures or unconfigured dependencies", async () => {
  const test = await setup();
  test.read.mockRejectedValue(new DigitalReceiptError("DIGITAL_RECEIPT_PERMISSION_DENIED"));
  expect((await test.send()).status).toBe(404);
  test.read.mockResolvedValue({ ...test.chain, orderReference: id(99) });
  expect((await test.send()).status).toBe(503);
  const absent = await setup(false);
  expect((await absent.send()).status).toBe(503);
});

it("serializes separate financial facts without rewriting immutable receipts", async () => {
  const test = await setup(true, {
    observedAt: at,
    currencyCode: "CAD",
    capturedMinor: 114n,
    confirmedRefundMinor: 10n,
    pendingRefundMinor: 20n,
    unresolvedAttemptCount: 1,
  });
  const response = await test.send();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({
    receipt: {
      financial: {
        observedAt: at,
        currencyCode: "CAD",
        capturedMinor: "114",
        confirmedRefundMinor: "10",
        pendingRefundMinor: "20",
        unresolvedAttemptCount: 1,
      },
      records: [{ snapshot: { refundedTotal: { amountMinor: "0" } } }],
      freshnessStatus: "Stale",
    },
  });
  expect(test.read).not.toHaveBeenCalled();
  expect(test.readView).toHaveBeenCalledTimes(1);
});
it("returns authorized history when optional financial source is unavailable", async () => {
  const test = await setup(true, null);
  const response = await test.send();
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body).toMatchObject({ receipt: { financial: null, records: [{ version: 1 }] } });
});
