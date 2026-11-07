import { describe, expect, it } from "vitest";
import { parseTablePayments } from "./TablePaymentPanel.js";

const payment = {
  partNumber: null,
  method: "Online",
  roundsMinor: "4000",
  tipMinor: "600",
  roundingMinor: "0",
  totalMinor: "4600",
  takenAt: "2026-11-02T20:00:00.000Z",
  recordedAfterOutage: false,
  cashRefunds: [],
  onlineRefunds: [
    {
      amountMinor: "1000",
      reasonCode: "FOOD_ISSUE",
      requestedAt: "2026-11-02T20:10:00.000Z",
      state: "Sending",
    },
  ],
  refundableMinor: "3600",
};

describe("parseTablePayments", () => {
  it("reads the whole table's payment and its refunds to the card", () => {
    const [read] = parseTablePayments({ payment, parts: [] });
    expect(read?.partNumber).toBeNull();
    expect(read?.onlineRefunds[0]?.state).toBe("Sending");
    expect(read?.refundableMinor).toBe("3600");
  });
  it("reads each paid part of a split bill", () => {
    expect(
      parseTablePayments({
        payment: null,
        parts: [
          { ...payment, partNumber: 1 },
          { ...payment, partNumber: 2, method: "Cash" },
        ],
      }).map((read) => [read.partNumber, read.method]),
    ).toEqual([
      [1, "Online"],
      [2, "Cash"],
    ]);
  });
  it("shows nothing for a table with no payment", () => {
    expect(parseTablePayments({ payment: null, parts: [] })).toEqual([]);
  });
  it("refuses an unknown refund state or a money value that is not a whole number", () => {
    expect(() =>
      parseTablePayments({
        payment: { ...payment, onlineRefunds: [{ ...payment.onlineRefunds[0], state: "Other" }] },
      }),
    ).toThrow();
    expect(() => parseTablePayments({ payment: { ...payment, totalMinor: "46.00" } })).toThrow();
  });
});
