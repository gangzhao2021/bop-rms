import { expect, it } from "vitest";
import { parseTablePaymentView } from "./table-payment-client.js";

const body = (payment: Record<string, unknown>) => ({
  schemaVersion: 1,
  payment: {
    tableLabel: "12",
    checkingOut: true,
    rounds: [
      {
        roundNumber: 1,
        items: [{ displayName: "TEST noodles", subtotalMinor: "1800" }],
        totalMinor: "2034",
      },
    ],
    owed: { subtotalMinor: "1800", taxMinor: "234", totalMinor: "2034" },
    consistent: true,
    state: "NotPaid",
    attempt: null,
    receipt: null,
    ...payment,
  },
});

it("DEC-DINE-IN-PAY-LATER S4: reads the table's bill and its phone payment", () => {
  const view = parseTablePaymentView(body({}));
  expect(view.owed.totalMinor).toBe("2034");
  expect(view.state).toBe("NotPaid");
  const paying = parseTablePaymentView(
    body({ state: "Paying", attempt: { totalMinor: "2304", tipMinor: "270" } }),
  );
  expect(paying.attempt).toEqual({ totalMinor: "2304", tipMinor: "270", partNumber: null });
  const paid = parseTablePaymentView(
    body({
      state: "Paid",
      receipt: {
        method: "Online",
        roundsMinor: "2034",
        tipMinor: "270",
        roundingMinor: "0",
        totalMinor: "2304",
        paidAt: "2026-10-27T20:00:00.000Z",
      },
    }),
  );
  expect(paid.receipt?.method).toBe("Online");
});

it("refuses an unknown state, method or a malformed amount", () => {
  expect(() => parseTablePaymentView(body({ state: "Refunded" }))).toThrow();
  expect(() =>
    parseTablePaymentView(body({ owed: { subtotalMinor: "1.5", taxMinor: "0", totalMinor: "0" } })),
  ).toThrow();
  expect(() =>
    parseTablePaymentView(
      body({
        state: "Paid",
        receipt: {
          method: "Bitcoin",
          roundsMinor: "1",
          tipMinor: "0",
          roundingMinor: "0",
          totalMinor: "1",
          paidAt: "x",
        },
      }),
    ),
  ).toThrow();
  expect(() => parseTablePaymentView({ schemaVersion: 2, payment: {} })).toThrow();
});

it("WP-2423 item 8 ④: reads a split bill's parts and which part this guest is paying", () => {
  const value = {
    schemaVersion: 1,
    payment: {
      tableLabel: "8",
      checkingOut: true,
      rounds: [],
      owed: { subtotalMinor: "5600", taxMinor: "728", totalMinor: "6328" },
      consistent: true,
      state: "Paying",
      attempt: { totalMinor: "3164", tipMinor: "0", partNumber: 2 },
      receipt: null,
      split: {
        mode: "Even",
        paidParts: 1,
        remainingMinor: "6328",
        parts: [
          { partNumber: 1, amountMinor: "3164", subtotalMinor: "2800", status: "Paid" },
          { partNumber: 2, amountMinor: "3164", subtotalMinor: "2800", status: "Mine" },
          { partNumber: 3, amountMinor: "3164", subtotalMinor: "2800", status: "ToPay" },
        ],
      },
    },
  };
  const view = parseTablePaymentView(value);
  expect(view.attempt?.partNumber).toBe(2);
  expect(view.split?.parts.map((part) => part.status)).toEqual(["Paid", "Mine", "ToPay"]);
  const wrong = structuredClone(value);
  (wrong.payment.split.parts[2] as { status: string }).status = "Whatever";
  expect(() => parseTablePaymentView(wrong)).toThrow();
});

it("WP-2423 item 8 ⑦: reads the Store's tip percentages or tips off (older servers: 10/15/18)", () => {
  expect(parseTablePaymentView(body({})).tips).toEqual({
    enabled: true,
    tierPercents: [10, 15, 18],
  });
  expect(
    parseTablePaymentView(body({ tips: { enabled: false, tierPercents: [12, 15, 20] } })).tips,
  ).toEqual({ enabled: false, tierPercents: [12, 15, 20] });
  for (const tierPercents of [
    [10, 10, 18],
    [0, 15, 18],
    [10, 15, 51],
    [10, 15],
  ])
    expect(() => parseTablePaymentView(body({ tips: { enabled: true, tierPercents } }))).toThrow();
});
