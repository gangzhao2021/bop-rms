import { expect, it } from "vitest";
import { cantMakeDoneText } from "./CantMakeRefundAction.js";

it("says the amount the dialog showed, never 'in full' for what was left of the payment", () => {
  const partial = cantMakeDoneText({
    refundMethod: "Online",
    paidMinor: "2000",
    refundMinor: "1500",
  });
  expect(partial).toContain("$15.00");
  expect(partial).toContain("what was left of the payment");
  expect(partial).not.toContain("in full");
  expect(
    cantMakeDoneText({ refundMethod: "Online", paidMinor: "2000", refundMinor: "2000" }),
  ).toContain("Refunded $20.00 in full");
});

it("nothing left to return is said plainly, and an unread amount is not guessed", () => {
  const nothing = cantMakeDoneText({ refundMethod: "Online", paidMinor: "2000", refundMinor: "0" });
  expect(nothing).toContain("nothing more was refunded");
  expect(nothing).not.toMatch(/Refunded \$/u);
  for (const preview of ["Failed", "Checking"] as const) {
    const text = cantMakeDoneText(preview);
    expect(text).toContain("What was left of the payment is refunded");
    expect(text).not.toContain("in full");
  }
});
