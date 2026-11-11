import { expect, it } from "vitest";
import {
  cantMakeDoneText,
  parseCantMakeResult,
  type CantMakeResult,
} from "./CantMakeRefundAction.js";

const answer = (fields: Partial<CantMakeResult>): CantMakeResult => ({
  status: "Cancelled",
  refundStatus: "Pending",
  refundMethod: "Online",
  refundAmountMinor: "2340",
  ...fields,
});

it("says what the server answered: a refund still on its way is never said to be refunded", () => {
  const pending = cantMakeDoneText(answer({}), "Failed");
  expect(pending).toContain("Refund pending: $23.40");
  expect(pending).not.toMatch(/Refunded|in full/u);
  // The answer's amount, not an older, larger one the dialog read.
  const stale = {
    refundMethod: "Online",
    paidInCash: false,
    paidMinor: "3000",
    refundMinor: "3000",
  } as const;
  const partial = cantMakeDoneText(answer({ refundAmountMinor: "1050" }), stale);
  expect(partial).toContain("$10.50, what was left of the payment");
  expect(partial).not.toContain("$30.00");
  expect(partial).not.toContain("in full");
  expect(
    cantMakeDoneText(answer({ refundStatus: "Refunded", status: "AlreadyCancelled" }), stale),
  ).toContain("Refunded $23.40, what was left of the payment");
});

it("nothing left to return is said plainly; the card machine is told what to refund", () => {
  for (const nothing of [
    answer({ refundAmountMinor: "0", refundStatus: "Refunded" }),
    answer({ refundMethod: "CardMachine", refundStatus: "Refunded", refundAmountMinor: "1450" }),
  ]) {
    const text = cantMakeDoneText(nothing, "Failed");
    expect(text).toContain("nothing more was refunded");
    expect(text).not.toMatch(/Refunded \$|Refund pending/u);
  }
  expect(
    cantMakeDoneText(answer({ refundMethod: "CardMachine", refundAmountMinor: "1450" }), "Failed"),
  ).toBe("Cancelled. Refund $14.50 on the card machine. The guest is told.");
});

it("an unreadable answer falls back to the dialog's amount, and still says pending", () => {
  const shown = {
    refundMethod: "Online",
    paidInCash: false,
    paidMinor: "2000",
    refundMinor: "1500",
  } as const;
  const text = cantMakeDoneText(null, shown);
  expect(text).toContain("Refund pending: $15.00, what was left of the payment");
  expect(cantMakeDoneText(null, "Failed")).toContain(
    "Refund pending: what was left of the payment",
  );
  expect(cantMakeDoneText(null, { ...shown, refundMinor: "0" })).toContain(
    "nothing more was refunded",
  );
  // A replay without an amount: no number is guessed.
  expect(cantMakeDoneText(answer({ refundAmountMinor: null }), "Failed")).not.toMatch(/\$/u);
});

it("reads only a well-formed answer", () => {
  expect(parseCantMakeResult(answer({}))).toEqual(answer({}));
  expect(parseCantMakeResult({ ...answer({}), refundStatus: "Done" })).toBeNull();
  expect(parseCantMakeResult({ ...answer({}), refundAmountMinor: "-1" })).toBeNull();
  expect(parseCantMakeResult({ ...answer({}), refundAmountMinor: 2340 })).toBeNull();
  expect(parseCantMakeResult(null)).toBeNull();
});

it("v15 batch 8: a counter cash payment is given back in cash from the drawer, never on the machine", () => {
  // The dialog's amount is the server's whole nickels ($10.75 for a $10.74 order).
  const shown = {
    refundMethod: "CardMachine",
    paidInCash: true,
    paidMinor: "1075",
    refundMinor: "1075",
  } as const;
  const text = cantMakeDoneText(
    answer({ refundMethod: "CardMachine", refundAmountMinor: "1074" }),
    shown,
  );
  expect(text).toBe(
    "Cancelled. Give back $10.75 in cash from the drawer, in whole nickels, then record it on the order. The guest is told.",
  );
  expect(cantMakeDoneText(null, shown)).not.toMatch(/card machine/u);
  expect(
    cantMakeDoneText(
      answer({ refundMethod: "CardMachine", refundStatus: "Refunded", status: "AlreadyCancelled" }),
      shown,
    ),
  ).toBe("Cancelled. $10.75 was given back in cash. The guest is told.");
});
