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
  expect(paying.attempt).toEqual({ totalMinor: "2304", tipMinor: "270" });
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
