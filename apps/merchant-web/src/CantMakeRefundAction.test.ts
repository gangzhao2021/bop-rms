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
