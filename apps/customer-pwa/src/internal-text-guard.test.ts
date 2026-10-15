import { expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";

it("flags the placeholder and doubled period guests saw on the order page on v15", () => {
  for (const text of [
    "Kitchen status\tNot available yet",
    "Valid until 9:46 p.m..",
    "Payment\tPayment updates unavailable",
    "Reason: ORDER_ADDITIONAL_PAYMENT_CAPTURED",
  ])
    expect(findInternalText([text]), text).not.toEqual([]);
});

it("accepts the guest wording that replaced them", () => {
  expect(
    findInternalText([
      "Kitchen status\tNot started yet",
      "Show this code to staff to collect your order. Valid until 9:46 p.m.",
      "It will be cancelled at 9:46 p.m. Ask a staff member if you need help.",
      "Payment\tPayment received $25.98",
      "Reason: An additional payment was added to this order.",
    ]),
  ).toEqual([]);
});

it("flags the capitalized role on the item page and keeps the plain wording", () => {
  expect(
    findInternalText([
      "Do not put allergy or medical information in the preparation note; ask Staff.",
    ]),
  ).not.toEqual([]);
  expect(
    findInternalText([
      "Do not put allergy or medical information in the preparation note; ask staff.",
      "Plain preparation requests only. Do not enter allergy, medical or other sensitive details; ask staff for assistance.",
      "No allergen-free claim is made. Ask staff before ordering.",
    ]),
  ).toEqual([]);
});
