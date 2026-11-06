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
