import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import express from "express";
import { afterEach, expect, it, vi } from "vitest";
import { createPostgresOrderPricedAmountSource } from "@rms/ordering";
import { GuestSessionError } from "@bop/identity";
import { guestOwnPaymentView } from "../test-support/guest-bill-closed-by-staff.js";
import {
  CustomerDiningTablePaymentHandler,
  customerOwnPaymentBody,
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
    ownPayment: vi.fn(),
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

// Batch 43 (v15 b42 live 18:44:18Z): a guest's bill read waited on the Order's fence while staff
// closed the table, then found the guest no longer at it. The guest got 503 "try again" and a
// level-50 CUSTOMER_DINING_TABLE_PAYMENT_FAILED ORDER_PRICED_AMOUNT_UNAVAILABLE line; 2 s later the
// same phone was told the table was gone (404) and read its settled receipt. Now the first answer
// is the refusal itself.
it("batch 43: a bill read that finds the guest's table closed under it is 'not found', not 503", async () => {
  const f = await setup();
  const id = (n: number) => "0190faec-0000-7000-8000-" + String(n).padStart(12, "0");
  const closedUnderRead = await createPostgresOrderPricedAmountSource({
    brandReference: id(1),
    storeReference: id(2),
    authorize: async () => false,
  })({ query: async () => ({ rows: [] }) } as never, {
    orderReference: id(3),
    observedAt: "2026-11-21T18:44:17.941Z",
  }).then(
    () => null,
    (error: unknown) => error,
  );
  const lines: string[] = [];
  const write = vi.spyOn(process.stderr, "write").mockImplementation((line) => {
    lines.push(String(line));
    return true;
  });
  try {
    f.port.read.mockRejectedValueOnce(closedUnderRead);
    const answer = await f.send({ action: "Read" });
    expect(answer.status).toBe(404);
    expect(((await answer.json()) as { error: { code: string } }).error.code).toBe(
      "table_not_found",
    );
  } finally {
    write.mockRestore();
  }
  expect(lines.filter((line) => line.includes("CUSTOMER_DINING_TABLE_PAYMENT_FAILED"))).toEqual([]);
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

// Batch 63 (design review D62B-03, F05): a dine-in guest could not keep a receipt: no Store name or
// address and no date, though the pickup receipt has them. The settled receipt says who it is
// from (the Store's published names and address) and when the bill was paid (its last payment).
it("batch 63: a settled receipt names the Store, its address and when the bill was paid", () => {
  const merchant = {
    brandDisplayName: "Test Merchant 2 - not production",
    storeDisplayName: "Test Merchant 2 Main - not production",
    address: {
      addressLines: ["100 Test Street"],
      locality: "Toronto",
      regionCode: "ON",
      postalCode: "M5V 1A1",
      countryCode: "CA",
    },
  };
  const paid = (partNumber: number, recordedAt: string) => ({
    partNumber,
    payment: {
      method: "Online",
      tipMinor: "0",
      roundingMinor: "0",
      totalMinor: "1413",
      recordedAt,
    },
  });
  const view = (withMerchant: boolean) =>
    ({
      ...(withMerchant ? { merchant } : {}),
      ownPayments: [],
      bill: {
        tableLabel: "T1",
        taxRoundingMinor: "0",
        settlement: null,
        split: {
          paidInFull: true,
          parts: [paid(1, "2026-11-24T00:35:02.000Z"), paid(2, "2026-11-24T00:34:40.000Z")],
        },
        rounds: [],
      },
    }) as never;
  const body = customerSettledTableReceiptBody(view(true));
  expect(body.receipt).toMatchObject({ merchant, paidAt: "2026-11-24T00:35:02.000Z" });
  // The Store's profile could not be read: the receipt is the same, without its header.
  expect(customerSettledTableReceiptBody(view(false)).receipt).not.toHaveProperty("merchant");
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

it("batch 60: a settled receipt says how many of a line's dishes were on the house", () => {
  const body = customerSettledTableReceiptBody({
    bill: {
      tableLabel: "L59S B",
      taxRoundingMinor: "0",
      settlement: {
        method: "CardMachine",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "1412",
        recordedAt: "2026-11-24T18:00:00.000Z",
      },
      split: null,
      rounds: [
        {
          roundNumber: 1,
          fromTableLabel: null,
          subtotalMinor: "1250",
          taxMinor: "162",
          totalMinor: "1412",
          items: [
            {
              displayName: "Beef noodles (TEST)",
              quantity: 2,
              subtotalMinor: "2500",
              totalMinor: "1412",
              reduction: {
                kind: "Comp",
                percent: null,
                amountMinor: "1413",
                netMinor: "1250",
                compedQuantity: 1,
              },
            },
            {
              displayName: "Tea",
              quantity: 2,
              subtotalMinor: "0",
              totalMinor: "0",
              reduction: { kind: "Comp", percent: null, amountMinor: "452", netMinor: "400" },
            },
          ],
        },
      ],
    },
  } as never);
  expect(body.receipt.rounds[0]?.items).toEqual([
    {
      displayName: "Beef noodles (TEST)",
      subtotalMinor: "2500",
      reduced: "Comp",
      quantity: 2,
      compedQuantity: 1,
    },
    { displayName: "Tea", subtotalMinor: "0", reduced: "Comp", quantity: 2 },
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

// Batch 61 (v15 b60 live, CRT60 B order 46 and C order 49): by dish, phone A paid $14.13 and
// phone B $14.12, a manager refunded all (or $8.00) of A, staff closed and cleaned the table.
// The ended receipt listed both parts' amounts to both phones (第 1 份 … $14.13 / 第 2 份 …
// $14.12). Each phone now gets its own part with its own refunds, and only a count of the rest.
it("batch 61: a settled receipt paid by dish lists the asking phone's own part only, with its refunds", () => {
  for (const refunds of ["Full", "Eight"] as const) {
    const back = refunds === "Full" ? "1413" : "800";
    const payer = customerSettledTableReceiptBody(
      guestOwnPaymentView("by-dish-both-paid", true, "Closed", refunds),
    ).receipt;
    expect(payer).toMatchObject({
      paidMinor: "2825",
      refundedMinor: back,
      split: true,
      paymentCount: 2,
    });
    expect(payer.payments).toEqual([
      {
        partNumber: 1,
        method: "Online",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "1413",
        paidAt: "2026-11-24T00:34:40.000Z",
        yours: true,
        refundedMinor: back,
      },
    ]);
    const other = customerSettledTableReceiptBody(
      guestOwnPaymentView("by-dish-both-paid", false, "Closed", refunds),
    ).receipt;
    expect(other.payments).toEqual([
      {
        partNumber: 2,
        method: "Online",
        tipMinor: "0",
        roundingMinor: "0",
        totalMinor: "1412",
        paidAt: "2026-11-24T00:35:02.000Z",
        yours: true,
      },
    ]);
    // The table's totals stay whole (every guest shares them); A's part is never itemised to B.
    expect(other).toMatchObject({ paidMinor: "2825", refundedMinor: back, paymentCount: 2 });
    expect(JSON.stringify(other.payments)).not.toMatch(/1413|"800"|refund/u);
  }
  // A refund still on its way is said apart; a refused one moved nothing.
  const partial = customerSettledTableReceiptBody(
    guestOwnPaymentView("by-dish-both-paid", true, "Closed", "Partial"),
  ).receipt;
  expect(partial.payments[0]).toMatchObject({ refundedMinor: "800", refundPendingMinor: "300" });
  // A phone that paid no part sees the count and the table's totals, no part at all.
  const none = customerSettledTableReceiptBody({
    ...guestOwnPaymentView("by-dish-both-paid", true, "Closed", "Full"),
    ownPayments: [],
  }).receipt;
  expect(none.payments).toEqual([]);
  expect(none.paymentCount).toBe(2);
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

it("b39: a merged table's bill split by rounds says which table's rounds each part pays", () => {
  const round = (roundNumber: number, fromTableLabel: string | null) => ({
    roundNumber,
    fromTableLabel,
    items: [],
    subtotalMinor: "100",
    taxMinor: "13",
    totalMinor: "113",
    taxRoundingMinor: "0",
    paid: false,
  });
  const view = (mode: string, merged: boolean) =>
    ({
      attempt: null,
      bill: {
        tableLabel: "H4",
        sessionPhase: "Closing",
        tips: { enabled: false, tierPercents: [] },
        consistent: true,
        owed: { subtotalMinor: "400", taxMinor: "52", totalMinor: "452" },
        settlement: null,
        writeOff: null,
        onlinePayment: null,
        split: {
          mode,
          stale: false,
          dishChoices: [],
          paidParts: 0,
          remainingMinor: "452",
          parts: [
            [1, [1, 3]],
            [2, [2, 4]],
          ].map(([partNumber, roundNumbers]) => ({
            partNumber,
            amountMinor: "226",
            subtotalMinor: "200",
            taxMinor: "26",
            roundNumbers,
            dishes: [],
            guestPaying: false,
            payment: null,
          })),
        },
        rounds: [
          round(1, null),
          round(2, merged ? "H6" : null),
          round(3, null),
          round(4, merged ? "H6" : null),
        ],
      },
    }) as never;
  expect(
    customerTablePaymentBody(view("ByRounds", true)).payment.split?.parts.map((part) => [
      (part as { tables?: unknown }).tables,
      (part as { roundNumbers?: unknown }).roundNumbers,
    ]),
  ).toEqual([
    [["H4"], [1, 3]],
    [["H6"], [2, 4]],
  ]);
  // Nothing merged, or split another way: nothing more is said.
  for (const [mode, merged] of [
    ["ByRounds", false],
    ["Even", true],
  ] as const)
    expect(customerTablePaymentBody(view(mode, merged)).payment.split?.parts[0]).not.toHaveProperty(
      "tables",
    );
});

// Batch 56 (v15 b55 live, guest-closed-bill-menu-cart): a guest who paid part of a bill (their dish
// by phone, L55 CB2 order 76; part 1 of staff's even split in 2, L55 CB3 order 80) and whose
// staff then closed the rest saw only the table's "Paid $14.13": no "you paid", no method and no
// receipt on any page — the table-payment read said only "Closed" with receipt null, and the
// settled receipt read refuses a written-off bill. The views are v15's (split plan part 1,
// captured 1413, tip 0; 1412 written off).
it("batch 56: the payer's own receipt says what it paid for, never that the table paid in full", () => {
  const even = customerOwnPaymentBody(guestOwnPaymentView("half-split-written-off", true));
  expect(even).toEqual({
    schemaVersion: 1,
    ownPayment: {
      tableLabel: "L54 GB5 (TEST)",
      restClosedByStaff: true,
      tablePaidInFull: false,
      payments: [
        {
          covers: "Part",
          partNumber: 1,
          partCount: 2,
          dishes: [],
          subtotalMinor: "1250",
          taxMinor: "163",
          paidForMinor: "1413",
          tipMinor: "0",
          totalMinor: "1413",
          method: "Online",
          paidAt: "2026-11-24T00:34:40.000Z",
          refunds: [],
          refundedMinor: "0",
        },
      ],
      totalMinor: "1413",
      refundedMinor: "0",
      netMinor: "1413",
    },
  });
  const byDish = customerOwnPaymentBody(guestOwnPaymentView("by-dish-written-off", true));
  expect(byDish.ownPayment.payments).toEqual([
    expect.objectContaining({
      covers: "Dishes",
      partNumber: 1,
      // Guests' own parts grow as they pay: never "of how many".
      partCount: null,
      dishes: [{ displayName: "Beef noodles (TEST)", quantity: 1, shared: false }],
      totalMinor: "1413",
    }),
  ]);
  // Only this phone's payment: never part 2, other guests' amounts, references or Provider ids.
  for (const body of [even, byDish])
    expect(JSON.stringify(body)).not.toMatch(
      /1412|0198b054|orderReference|guestSession|pi_|provider|tendered|actor/iu,
    );
});

// Batch 57 (WP-2423 Q36, b56 remaining): staff refunded part of the payer's own phone payment and
// its own receipt still read only "Total paid by you $14.13" — no refund, no net. Payment's refund
// records in v15's shapes: $5.00 Succeeded, $3.00 with no Provider answer yet, $2.00 refused.
it("batch 57: the payer's own receipt lists each refund of its payment and what it paid net", () => {
  const partial = customerOwnPaymentBody(
    guestOwnPaymentView("half-split-written-off", true, "Closed", "Partial"),
  ).ownPayment;
  expect(partial.payments[0]?.refunds).toEqual([
    {
      amountMinor: "500",
      status: "Refunded",
      requestedAt: "2026-11-24T00:40:17.521Z",
      answeredAt: "2026-11-24T00:40:17.565Z",
    },
    {
      amountMinor: "300",
      status: "Pending",
      requestedAt: "2026-11-24T00:41:02.104Z",
      answeredAt: null,
    },
    {
      amountMinor: "200",
      status: "Failed",
      requestedAt: "2026-11-24T00:41:40.250Z",
      answeredAt: "2026-11-24T00:41:40.311Z",
    },
  ]);
  // A refused refund moved nothing: it is listed, not taken off.
  expect(partial.payments[0]?.refundedMinor).toBe("800");
  expect([partial.totalMinor, partial.refundedMinor, partial.netMinor]).toEqual([
    "1413",
    "800",
    "613",
  ]);
  const full = customerOwnPaymentBody(
    guestOwnPaymentView("by-dish-written-off", true, "Closing", "Full"),
  ).ownPayment;
  expect([full.refundedMinor, full.netMinor]).toEqual(["1413", "0"]);
  // Never the reason, who approved it, or any reference.
  for (const body of [partial, full])
    expect(JSON.stringify(body)).not.toMatch(
      /reason|FOOD_ISSUE|approved|0198b054|onlineRefund|re_|provider|actor/iu,
    );
});

it("batch 56: the payer reads its own receipt; a phone that paid nothing is told not found", async () => {
  const f = await setup();
  f.port.ownPayment.mockResolvedValue(guestOwnPaymentView("half-split-written-off", true));
  const mine = await f.send({ action: "OwnPayment", locale: "zh-Hans" });
  expect(mine.status).toBe(200);
  expect(mine.headers.get("cache-control")).toBe("no-store");
  expect(((await mine.json()) as { ownPayment: unknown }).ownPayment).toMatchObject({
    totalMinor: "1413",
    restClosedByStaff: true,
  });
  expect(f.port.ownPayment).toHaveBeenCalledWith(
    { sessionCredential: "s".repeat(43), csrfCredential: "c".repeat(43) },
    "zh-Hans",
  );
  f.port.ownPayment.mockRejectedValue(new GuestSessionError("GUEST_SESSION_UNAVAILABLE"));
  const other = await f.send({ action: "OwnPayment" });
  expect(other.status).toBe(404);
  expect(await other.json()).toEqual({ schemaVersion: 1, error: { code: "table_not_found" } });
  // Nothing else is taken with it.
  expect((await f.send({ action: "OwnPayment", partNumber: 2 })).status).toBe(400);
});
