import { describe, expect, it } from "vitest";
import {
  cashRefundNickel,
  parseTablePayments,
  sentRefundOf,
  tablePaymentRefundEnd,
  type TablePayment,
} from "./TablePaymentPanel.js";

describe("v15 M131: cash goes back in whole nickels", () => {
  it("rounds the Canadian way and never above what is left of the cash", () => {
    expect(
      [451n, 452n, 453n, 454n, 455n, 456n, 458n].map((v) => cashRefundNickel(v, 10_000n)),
    ).toEqual([450n, 450n, 455n, 455n, 455n, 455n, 460n]);
    expect(cashRefundNickel(1_003n, 1_000n)).toBe(1_000n);
    expect(cashRefundNickel(999n, 997n)).toBe(995n);
    expect(cashRefundNickel(2n, 10_000n)).toBe(0n);
  });
});

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
      byLabel: "Mei",
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

describe("b59 (live58): the card refund just made is the one its sentence follows", () => {
  const read = (states: readonly string[]) => {
    const [first] = parseTablePayments({
      payment: {
        ...payment,
        onlineRefunds: states.map((state, index) => ({
          amountMinor: "500",
          reasonCode: "CUSTOMER_REQUEST",
          requestedAt: `2026-11-24T13:4${index}:00.000Z`,
          state,
          byLabel: "You",
        })),
      },
    });
    if (first === undefined) throw new Error("no payment");
    return first;
  };
  it("follows the newest of that amount, as Payment answered it", () => {
    expect(
      sentRefundOf(read(["Refused", "Refunded"]), { amountMinor: "500", before: 1 })?.state,
    ).toBe("Refunded");
    expect(sentRefundOf(read(["Sending"]), { amountMinor: "500", before: 0 })?.state).toBe(
      "Sending",
    );
  });
  it("says nothing before the refund is listed or when none was made here", () => {
    expect(sentRefundOf(read(["Refunded"]), { amountMinor: "500", before: 1 })).toBeNull();
    expect(sentRefundOf(read(["Refunded"]), null)).toBeNull();
  });
});

describe("b61 (v15 b60 live, TM2 order 48): a payment refunded in full says so", () => {
  // Paid $32.00 on the guest's phone ($28.25 + $3.75 tip); $10.00 then $22.00 back to the card.
  const refund = (amountMinor: string, state: "Sending" | "Refunded" | "Refused") => ({
    amountMinor,
    reasonCode: "CUSTOMER_REQUEST" as const,
    requestedAt: "2026-11-24T22:56:00.000Z",
    byLabel: "You",
    state,
  });
  const paid = (refundableMinor: string, onlineRefunds: TablePayment["onlineRefunds"]) =>
    ({
      partNumber: null,
      method: "Online",
      roundsMinor: "2825",
      tipMinor: "375",
      roundingMinor: "0",
      totalMinor: "3200",
      takenAt: "2026-11-24T22:55:00.000Z",
      recordedAfterOutage: false,
      cashRefunds: [],
      cardRefunds: [],
      onlineRefunds,
      refundableMinor,
      canRefund: true,
    }) as TablePayment;
  it("everything went back: Fully refunded, no amount left and no timing line", () => {
    expect(
      tablePaymentRefundEnd(paid("0", [refund("1000", "Refunded"), refund("2200", "Refunded")])),
    ).toEqual({ fullyRefundedMinor: "3200", timingLine: false });
  });
  it("part went back: the amount left and the timing line stay", () => {
    expect(tablePaymentRefundEnd(paid("2200", [refund("1000", "Refunded")]))).toEqual({
      fullyRefundedMinor: null,
      timingLine: true,
    });
  });
  it("the last of it still on its way: not yet Fully refunded", () => {
    expect(
      tablePaymentRefundEnd(paid("0", [refund("1000", "Refunded"), refund("2200", "Sending")])),
    ).toEqual({ fullyRefundedMinor: null, timingLine: true });
  });
  it("cash given back in full counts, a refused refund never does", () => {
    const cash = {
      ...paid("0", [refund("500", "Refused")]),
      method: "Cash",
      cashRefunds: [
        {
          amountMinor: "3200",
          reasonCode: "FOOD_ISSUE",
          refundedAt: "2026-11-24T22:57:00.000Z",
          byLabel: "You",
        },
      ],
    } as TablePayment;
    expect(tablePaymentRefundEnd(cash)).toEqual({ fullyRefundedMinor: "3200", timingLine: false });
    expect(tablePaymentRefundEnd(paid("3200", []))).toEqual({
      fullyRefundedMinor: null,
      timingLine: false,
    });
  });
});
