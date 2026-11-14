import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import {
  CustomerDiningTablePaymentHandler,
  customerSettledTableReceiptBody,
  customerTablePaymentBody,
} from "./customer-dining-table-payment.js";
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
    settledReceipt: vi.fn().mockResolvedValue({
      bill: {
        ...bill,
        rounds: bill.rounds.map((round) => ({
          ...round,
          fromTableLabel: null,
          items: round.items.map((item) => ({ ...item, reduction: null })),
        })),
      },
      attempt: null,
    }),
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
      operationReference: "01909968-0000-7000-8000-000000000001",
      tip: { kind: "Percent", percent: 15 },
      // WP-2423 item 8 ④: no part — the whole table.
      partNumber: null,
      // WP-2423 同桌结账: no dishes chosen — the whole table.
      choice: null,
    },
    null,
  );
});

it("WP-2423 同桌结账: a guest pays only what they added or dishes they choose; nothing else", async () => {
  const f = await setup();
  const start = (choice: unknown) =>
    f.send({
      action: "Start",
      operationReference: "01909968-0000-7000-8000-000000000001",
      tip: { kind: "None" },
      choice,
    });
  expect((await start({ kind: "Mine" })).status).toBe(200);
  expect(f.port.start).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({ choice: { kind: "Mine" }, partNumber: null }),
    null,
  );
  const dish = "01909968-0000-7000-8000-0000000000d1";
  expect(
    (await start({ kind: "Chosen", dishes: [{ orderItemReference: dish, quantity: 2 }] })).status,
  ).toBe(200);
  expect(f.port.start).toHaveBeenLastCalledWith(
    expect.anything(),
    expect.objectContaining({
      choice: { kind: "Chosen", dishes: [{ orderItemReference: dish, quantity: 2 }] },
    }),
    null,
  );
  expect((await start({ kind: "Rest" })).status).toBe(200);
  const calls = f.port.start.mock.calls.length;
  for (const choice of [
    { kind: "Everything" },
    { kind: "Mine", amountMinor: "1" },
    { kind: "Chosen", dishes: [] },
    { kind: "Chosen", dishes: [{ orderItemReference: dish, quantity: 0 }] },
    { kind: "Chosen", dishes: [{ orderItemReference: "dumplings", quantity: 1 }] },
    {
      kind: "Chosen",
      dishes: [
        { orderItemReference: dish, quantity: 1 },
        { orderItemReference: dish, quantity: 1 },
      ],
    },
    { kind: "Chosen", dishes: [{ orderItemReference: dish, quantity: 1, priceMinor: "1" }] },
  ])
    expect((await start(choice)).status, JSON.stringify(choice)).toBe(400);
  expect(f.port.start.mock.calls.length).toBe(calls);
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

it("Owner 2026-11-03: a settled receipt is read in the language the guest chose", async () => {
  const f = await setup();
  expect((await f.send({ action: "SettledReceipt", locale: "zh-Hans-CA" })).status).toBe(200);
  expect(f.port.settledReceipt).toHaveBeenLastCalledWith(expect.anything(), "zh-Hans-CA");
  expect((await f.send({ action: "SettledReceipt" })).status).toBe(200);
  expect(f.port.settledReceipt).toHaveBeenLastCalledWith(expect.anything(), null);
  expect((await f.send({ action: "SettledReceipt", locale: "<zh>" })).status).toBe(400);
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

// WP-2423 取舍 18: the receipt says what points took off, and marks those dishes; a manager's comp
// on the same bill isn't counted as points.
it("v15 2026-11-02: the receipt while the table is still open says what points took off", () => {
  const body = customerTablePaymentBody({
    attempt: null,
    bill: {
      tableLabel: "T1",
      sessionPhase: "Active",
      tips: { enabled: true, tierPercents: [10, 15, 18] },
      consistent: true,
      owed: { subtotalMinor: "0", taxMinor: "0", taxRoundingMinor: "0", totalMinor: "0" },
      split: null,
      settlement: {
        method: "Cash",
        roundsMinor: "4366",
        tipMinor: "0",
        roundingMinor: "-1",
        totalMinor: "4365",
        recordedAt: "2026-11-02T18:00:00.000Z",
      },
      rounds: [
        {
          roundNumber: 1,
          totalMinor: "4366",
          taxRoundingMinor: "0",
          items: [
            {
              displayName: "Noodles",
              subtotalMinor: "3000",
              totalMinor: "3051",
              reduction: { kind: "Amount", percent: null, amountMinor: "339", points: true },
            },
            {
              displayName: "Tea",
              subtotalMinor: "1000",
              totalMinor: "0",
              reduction: { kind: "Comp", percent: null, amountMinor: "1130" },
            },
          ],
        },
      ],
    },
  } as never);
  expect(body.payment.receipt?.pointsUsedMinor).toBe("339");
});

it("a settled receipt says what points took off, apart from a manager's comp", () => {
  const item = (displayName: string, reduction: unknown) => ({
    displayName,
    subtotalMinor: "2000",
    totalMinor: "2260",
    reduction,
  });
  const body = customerSettledTableReceiptBody({
    bill: {
      tableLabel: "T1",
      taxRoundingMinor: "0",
      settlement: {
        method: "Cash",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "4000",
        recordedAt: "2026-11-02T18:00:00.000Z",
      },
      split: null,
      rounds: [
        {
          roundNumber: 1,
          fromTableLabel: null,
          subtotalMinor: "3700",
          taxMinor: "300",
          totalMinor: "4000",
          items: [
            item("Noodles", { kind: "Amount", percent: null, amountMinor: "339", points: true }),
            item("Tea", { kind: "Comp", percent: null, amountMinor: "2260" }),
            item("Rice", null),
          ],
        },
      ],
    },
  } as never);
  expect(body.receipt.pointsUsedMinor).toBe("339");
  expect(body.receipt.rounds[0]?.items.map((entry) => entry.reduced)).toEqual([
    "Points",
    "Comp",
    null,
  ]);
});

it("Owner 2026-11-03: a settled receipt says what went back, and says nothing while nothing has", () => {
  const view = (refundedMinor?: string) =>
    ({
      bill: {
        tableLabel: "T1",
        taxRoundingMinor: "0",
        ...(refundedMinor === undefined ? {} : { refundedMinor }),
        settlement: {
          method: "Cash",
          tipMinor: "0",
          roundingMinor: "0",
          totalMinor: "1795",
          recordedAt: "2026-11-03T18:00:00.000Z",
        },
        split: null,
        rounds: [],
      },
    }) as never;
  expect(customerSettledTableReceiptBody(view("300")).receipt).toMatchObject({
    refundedMinor: "300",
  });
  expect(customerSettledTableReceiptBody(view()).receipt).not.toHaveProperty("refundedMinor");
});

it("M92: a declined phone payment for a part says it failed, while that part is still unpaid", () => {
  const part = (partNumber: number, paid: boolean) => ({
    partNumber,
    amountMinor: "2346",
    subtotalMinor: "2076",
    taxMinor: "270",
    roundNumbers: [1],
    dishes: [],
    guestPaying: false,
    payment: paid
      ? { method: "Online", tipMinor: "0", roundingMinor: "0", totalMinor: "2346" }
      : null,
  });
  const view = (lastOwnDeclined: unknown, paid = false) =>
    ({
      attempt: null,
      lastOwnDeclined,
      bill: {
        tableLabel: "T1",
        sessionPhase: "Closing",
        tips: { enabled: false, tierPercents: [] },
        consistent: true,
        owed: { subtotalMinor: "4152", taxMinor: "540", taxRoundingMinor: "0", totalMinor: "4692" },
        settlement: null,
        writeOff: null,
        onlinePayment: null,
        split: {
          mode: "Even",
          stale: false,
          dishChoices: [],
          paidParts: paid ? 1 : 0,
          remainingMinor: paid ? "2346" : "4692",
          parts: [part(1, paid), part(2, false)],
        },
        rounds: [],
      },
    }) as never;
  expect(customerTablePaymentBody(view({ partNumber: 1 })).payment.state).toBe("Failed");
  // Paid since (another card worked), or nothing was declined: not a failure.
  expect(customerTablePaymentBody(view({ partNumber: 1 }, true)).payment.state).toBe("NotPaid");
  expect(customerTablePaymentBody(view(null)).payment.state).toBe("NotPaid");
});

it("v15 b12: a split the bill changed under says so to the guest, so no old part is offered", () => {
  const view = (stale: boolean) =>
    ({
      attempt: null,
      bill: {
        tableLabel: "T1",
        sessionPhase: "Closing",
        tips: { enabled: false, tierPercents: [] },
        consistent: !stale,
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        settlement: null,
        writeOff: null,
        onlinePayment: null,
        split: {
          mode: "Even",
          stale,
          dishChoices: [],
          paidParts: 0,
          remainingMinor: "0",
          parts: [1, 2].map((partNumber) => ({
            partNumber,
            amountMinor: "1413",
            subtotalMinor: "1250",
            taxMinor: "163",
            roundNumbers: [1],
            dishes: [],
            guestPaying: false,
            payment: null,
          })),
        },
        rounds: [],
      },
    }) as never;
  expect(customerTablePaymentBody(view(true)).payment.split).toMatchObject({
    stale: true,
    remainingMinor: "0",
  });
  // Whether the bill matches the Order apart from the split is passed on only when it is said.
  expect(customerTablePaymentBody(view(true)).payment).not.toHaveProperty(
    "matchesOrderApartFromSplit",
  );
  const said = view(true) as { bill: Record<string, unknown> };
  said.bill.matchesOrderApartFromSplit = true;
  expect(customerTablePaymentBody(said as never).payment).toMatchObject({
    consistent: false,
    matchesOrderApartFromSplit: true,
  });
  expect(customerTablePaymentBody(view(false)).payment.split).toMatchObject({ stale: false });
});
