import { expect, it } from "vitest";
import { findInternalText, staticText } from "../e2e/internal-text-patterns.js";

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

it("flags an amount written with its currency code and keeps the app's money format", () => {
  for (const text of ["Oat beverage + CAD 0.75", "Total CAD $14.68", "From CAD5.25"])
    expect(findInternalText([text]), text).not.toEqual([]);
  expect(
    findInternalText(["Oat beverage + $0.75", "From $5.25", "Tip ($)", "No extra charge"]),
  ).toEqual([]);
});

it("flags the currency code in a label guests read", () => {
  expect(findInternalText(["Tip (CAD)"])).not.toEqual([]);
});

it("flags an internal state read aloud and keeps the plain announcements", () => {
  for (const text of ["Cart state ready", "Cart state command-pending", "Order state Accepted"])
    expect(findInternalText([text]), text).not.toEqual([]);
  expect(
    findInternalText([
      "Your cart is up to date.",
      "Updating your cart…",
      "Couldn’t update your cart. Try again.",
      "You’re offline. Your cart can’t be changed until you reconnect.",
    ]),
  ).toEqual([]);
});

it("scans text only a screen reader hears in rendered markup", () => {
  const html =
    '<main><h1>Your cart</h1><div class="sr-only" role="status" aria-live="polite">Cart state ready</div></main>';
  expect(findInternalText([staticText(html)])).not.toEqual([]);
});
