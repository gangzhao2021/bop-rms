import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { CustomerDiningTablePaymentHandler } from "./customer-dining-table-payment.js";
import { DiningTableOnlinePaymentError } from "./dining-table-online-payment.js";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
const bill = {
  diningSessionReference: "s",
  sessionPhase: "Closing",
  sessionVersion: 3,
  paymentTiming: "PayLater",
  tableLabel: "12",
  orderReference: "o",
  rounds: [
    {
      roundNumber: 1,
      orderBatchReference: "b",
      submissionReference: "x",
      items: [{ displayName: "TEST noodles", subtotalMinor: "1800", totalMinor: "2034" }],
      subtotalMinor: "1800",
      taxMinor: "234",
      totalMinor: "2034",
      taxRoundingMinor: "-1",
      paid: false,
    },
  ],
  taxRoundingMinor: "-1",
  owed: { subtotalMinor: "1800", taxMinor: "234", totalMinor: "2034" },
  consistent: true,
  tips: { enabled: true, tierPercents: [10, 15, 18] },
  settlement: null,
  split: null,
  writeOff: null,
  onlinePayment: null,
};
async function setup() {
  const port = {
    read: vi.fn().mockResolvedValue({ bill, attempt: null }),
    start: vi.fn().mockResolvedValue({
      bill,
      attempt: {
        onlinePaymentReference: "p",
        operationReference: "op",
        providerIntentReference: "pi_x",
        totalMinor: "2304",
        tipMinor: "270",
        mine: true,
      },
    }),
    handoff: vi.fn(),
    ownAttempt: vi.fn(),
  };
  const handler = new CustomerDiningTablePaymentHandler({
    allowedOrigin: "https://pilot.example",
    port: port as never,
  });
  const app = express();
  app.post("/api/v1/dine-in/table-payment", ...handler.handler());
  const server = createServer(app);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url =
    "http://127.0.0.1:" + (server.address() as AddressInfo).port + "/api/v1/dine-in/table-payment";
  const send = (body: unknown, headers: Record<string, string> = {}) =>
    fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "sec-fetch-site": "same-origin",
        cookie: "__Host-bop-guest=" + "s".repeat(43),
        "x-csrf-token": "c".repeat(43),
        ...headers,
      },
      body: JSON.stringify(body),
    });
  return { port, send };
}

it("DEC-DINE-IN-PAY-LATER S4: answers the guest's table payment in public fields only", async () => {
  const f = await setup();
  const response = await f.send({
    action: "Start",
    operationReference: "01909968-0000-7000-8000-000000000001",
    tip: { kind: "Percent", percent: 15 },
  });
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  const text = await response.text();
  expect(JSON.parse(text).payment).toMatchObject({
    state: "Paying",
    attempt: { totalMinor: "2304", tipMinor: "270" },
    // WP-2423 DEC-TAX-WHOLE-RECEIPT: the tax rounding still owed, for its own line.
    owed: { totalMinor: "2034", taxRoundingMinor: "-1" },
  });
  // No references, Provider identifiers or internal codes reach the guest.
  expect(text).not.toMatch(/pi_x|"p"|orderBatchReference|diningSessionReference|onlinePayment/u);
  expect(f.port.start).toHaveBeenCalledWith(
    { sessionCredential: "s".repeat(43), csrfCredential: "c".repeat(43) },
    {
      action: "Start",
      operationReference: "01909968-0000-7000-8000-000000000001",
      tip: { kind: "Percent", percent: 15 },
      // WP-2423 item 8 ④: no part — the whole table.
      partNumber: null,
    },
  );
});

it("refuses a chosen amount or table, a cross-site request and an unknown tip", async () => {
  const f = await setup();
  for (const body of [
    { action: "Start", operationReference: "not-a-reference", tip: { kind: "None" } },
    {
      action: "Start",
      operationReference: "01909968-0000-7000-8000-000000000001",
      tip: { kind: "Percent", percent: 99 },
    },
    { action: "Read", totalMinor: "1" },
    { action: "Pay" },
  ])
    expect((await f.send(body)).status).toBe(400);
  expect((await f.send({ action: "Read" }, { "sec-fetch-site": "cross-site" })).status).toBe(400);
  expect(f.port.read).not.toHaveBeenCalled();
});

it("says plainly when another guest is paying or the table already paid", async () => {
  const f = await setup();
  f.port.start.mockRejectedValueOnce(
    new DiningTableOnlinePaymentError("TABLE_ONLINE_PAYMENT_ANOTHER_GUEST_PAYING"),
  );
  const busy = await f.send({
    action: "Start",
    operationReference: "01909968-0000-7000-8000-000000000001",
    tip: { kind: "None" },
  });
  expect(busy.status).toBe(409);
  expect(((await busy.json()) as { error: { code: string } }).error.code).toBe(
    "table_another_guest_paying",
  );
  f.port.read.mockRejectedValueOnce(new Error("private SQL detail"));
  const down = await f.send({ action: "Read" });
  expect(down.status).toBe(503);
  expect(await down.text()).not.toContain("private");
});
