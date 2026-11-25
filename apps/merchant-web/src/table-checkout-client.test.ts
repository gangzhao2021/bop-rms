import { describe, expect, it } from "vitest";
import {
  cashTotalMinor,
  createTableCheckoutClient,
  parseTableBill,
} from "./table-checkout-client.js";
import { dollarsToMinor } from "./TableCheckout.js";

describe("DEC-DINE-IN-PAY-LATER table checkout amounts", () => {
  it("rounds cash to 5 cents exactly as Payment does, for every last digit", () => {
    expect([0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n].map((d) => cashTotalMinor(3840n + d))).toEqual([
      3840n,
      3840n,
      3840n,
      3845n,
      3845n,
      3845n,
      3845n,
      3845n,
      3850n,
      3850n,
    ]);
  });
  it("reads typed dollars as cents, never as a float", () => {
    expect(dollarsToMinor("50")).toBe(5000n);
    expect(dollarsToMinor("38.4")).toBe(3840n);
    expect(dollarsToMinor("38.45")).toBe(3845n);
    expect(dollarsToMinor("38.456")).toBeNull();
    expect(dollarsToMinor("-1")).toBeNull();
    expect(dollarsToMinor("")).toBeNull();
  });
  it("refuses a bill it can't read", () => {
    expect(() => parseTableBill({})).toThrow();
    expect(() =>
      parseTableBill({
        diningSessionReference: "01909969-0000-7000-8000-000000000002",
        sessionPhase: "Closing",
        sessionVersion: 7,
        paymentTiming: "PayLater",
        tableLabel: "T2",
        orderReference: null,
        rounds: [],
        owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
        consistent: true,
        settlement: { method: "Bitcoin" },
      }),
    ).toThrow();
  });
});

describe("WP-2423 item 8 ⑤: rounds waiting for staff OK at checkout", () => {
  const ref = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const base = {
    diningSessionReference: ref(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "T5",
    orderReference: ref(3),
    rounds: [],
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    settlement: null,
  };
  it("reads them strictly, and none from an older server", () => {
    expect(parseTableBill(base).waitingRounds).toEqual([]);
    const round = {
      orderReference: ref(3),
      orderBatchReference: ref(9),
      heldAt: "2026-11-06T04:17:00.000Z",
      reason: "PhoneRapid",
      itemCount: 2,
      totalMinor: "1495",
      orderedBy: 2,
    };
    expect(parseTableBill({ ...base, waitingRounds: [round] }).waitingRounds).toEqual([round]);
    for (const broken of [
      { ...round, totalMinor: "14.95" },
      { ...round, reason: "Other" },
      { ...round, orderBatchReference: "nine" },
    ])
      expect(() => parseTableBill({ ...base, waitingRounds: [broken] })).toThrow();
  });
  it("sends the amount staff saw with the payment, and says when a round still waits", async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ error: "rounds_waiting" }), { status: 409 });
    }) as unknown as typeof fetch;
    const client = createTableCheckoutClient(fetcher);
    await expect(
      client.settle("A".repeat(43), {
        operationReference: ref(40),
        diningSessionReference: ref(2),
        method: "CardMachine",
        tip: { kind: "None" },
        tenderedMinor: null,
        slipReference: null,
        takenAt: null,
        owedMinor: "9596",
      }),
    ).rejects.toMatchObject({ code: "RoundsWaiting" });
    expect(calls[0]?.url).toBe("/merchant/dining/table-settle");
    expect(calls[0]?.body).toMatchObject({ owedMinor: "9596", recordedAfterOutage: false });
  });
});

describe("b25 (live24): dishes taken off the bill, named at checkout", () => {
  const ref = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const round = {
    roundNumber: 1,
    items: [],
    subtotalMinor: "0",
    taxMinor: "0",
    totalMinor: "0",
    paid: false,
  };
  const bill = (rounds: unknown[]) => ({
    diningSessionReference: ref(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "T5",
    orderReference: ref(3),
    rounds,
    owed: { subtotalMinor: "0", taxMinor: "0", totalMinor: "0" },
    consistent: true,
    settlement: null,
  });
  it("reads them strictly, and none from an older server", () => {
    expect(parseTableBill(bill([round])).rounds[0]?.takenOffDishes).toEqual([]);
    const dish = { orderItemReference: ref(9), quantity: 2, displayName: "Edamame" };
    expect(
      parseTableBill(bill([{ ...round, takenOffDishes: [dish] }])).rounds[0]?.takenOffDishes,
    ).toEqual([dish]);
    for (const broken of [
      { ...dish, quantity: 0 },
      { ...dish, orderItemReference: "nine" },
      { ...dish, displayName: 7 },
    ])
      expect(() => parseTableBill(bill([{ ...round, takenOffDishes: [broken] }]))).toThrow();
    expect(() => parseTableBill(bill([{ ...round, takenOffDishes: "Edamame" }]))).toThrow();
  });
});

describe("batch 60: a line comped in part, at checkout", () => {
  const ref = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const noodles = (reduction: unknown) => ({
    orderItemReference: ref(9),
    quantity: 2,
    displayName: "Beef noodles (TEST)",
    subtotalMinor: "2500",
    totalMinor: "1412",
    reduction,
  });
  const bill = (item: unknown) => ({
    diningSessionReference: ref(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "L59S B",
    orderReference: ref(3),
    rounds: [
      {
        roundNumber: 1,
        items: [item],
        subtotalMinor: "1250",
        taxMinor: "162",
        totalMinor: "1412",
        paid: false,
      },
    ],
    owed: { subtotalMinor: "1250", taxMinor: "162", totalMinor: "1412" },
    consistent: true,
    settlement: null,
  });
  const comp = { kind: "Comp", percent: null, amountMinor: "1413", netMinor: "1250" };
  it("reads how many of the line's dishes were comped, and only for a comp", () => {
    expect(
      parseTableBill(bill(noodles({ ...comp, compedQuantity: 1 }))).rounds[0]?.items[0]?.reduction,
    ).toMatchObject({ kind: "Comp", compedQuantity: 1, netMinor: "1250" });
    expect(parseTableBill(bill(noodles(comp))).rounds[0]?.items[0]?.reduction).not.toHaveProperty(
      "compedQuantity",
    );
    for (const broken of [
      { ...comp, compedQuantity: 0 },
      { ...comp, compedQuantity: 1.5 },
      { ...comp, compedQuantity: "1" },
      { ...comp, kind: "Percent", percent: 50, compedQuantity: 1 },
    ])
      expect(() => parseTableBill(bill(noodles(broken)))).toThrow();
  });
});

describe("b63 review (T15): a dish's options at checkout", () => {
  const ref = (n: number) => "01909969-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const dish = (options: unknown) => ({
    orderItemReference: ref(9),
    quantity: 1,
    displayName: "Hot and sour soup (TEST)",
    ...(options === undefined ? {} : { options }),
    subtotalMinor: "800",
    totalMinor: "904",
    reduction: null,
  });
  const bill = (item: unknown) => ({
    diningSessionReference: ref(2),
    sessionPhase: "Closing",
    sessionVersion: 7,
    paymentTiming: "PayLater",
    tableLabel: "T5",
    orderReference: ref(3),
    rounds: [
      {
        roundNumber: 1,
        items: [item],
        subtotalMinor: "800",
        taxMinor: "104",
        totalMinor: "904",
        paid: false,
      },
    ],
    owed: { subtotalMinor: "800", taxMinor: "104", totalMinor: "904" },
    consistent: true,
    settlement: null,
  });
  it("reads them strictly, and none from an older server", () => {
    const options = [
      { name: "Hot", quantity: 1 },
      { name: "Extra egg", quantity: 2 },
    ];
    expect(parseTableBill(bill(dish(options))).rounds[0]?.items[0]?.options).toEqual(options);
    expect(parseTableBill(bill(dish(undefined))).rounds[0]?.items[0]?.options).toEqual([]);
    for (const broken of [[{ name: "Hot", quantity: 0 }], [{ name: 7, quantity: 1 }], "Hot"])
      expect(() => parseTableBill(bill(dish(broken)))).toThrow();
  });
});
