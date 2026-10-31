import { describe, expect, it } from "vitest";
import { cashTotalMinor, parseTableBill } from "./table-checkout-client.js";
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
