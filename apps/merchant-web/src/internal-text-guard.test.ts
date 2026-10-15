import { expect, it } from "vitest";
import { findInternalText } from "../e2e/internal-text-patterns.js";

it("flags the internal tokens that reached staff and guest screens on v15", () => {
  const old = [
    "Training Store · PROFILE_CURRENT",
    "ServiceCharge configuration",
    "OrderNumber | IssuedAt | PaymentStatus | RefundedTotal",
    "Template effective until UTC (optional)",
    "Exact UUIDv7 reference",
    "Pickup credential",
    "Masked recipient label",
    "Kitchen status\tNot available yet",
    "Valid until 9:46 p.m..",
    "Unavailable",
    "Order 01909985-0000-7000-8000-000000000001",
  ];
  for (const text of old) expect(findInternalText([text]), text).not.toEqual([]);
});

it("accepts plain staff and guest language and reviewed exceptions", () => {
  expect(
    findInternalText([
      "Service charge\nOrder number · Issued · Payment status\nValid until 9:46 p.m.",
      "Loading…\nPay with Apple Pay",
      "Order 7 is ready for pickup.",
    ]),
  ).toEqual([]);
  expect(findInternalText(["Mark sold out: Unavailable today"], [/Unavailable today/u])).toEqual(
    [],
  );
});

it("flags contract seconds, raw time zone identifiers and retired setup jargon seen on v15", () => {
  const cases: readonly (readonly [string, string])[] = [
    ["Wait times are whole seconds from 0 to 86400.", "seconds unit"],
    ["Enter a whole number from 0 to 86,400 for each wait time.", "seconds unit"],
    ["Order cutoff seconds", "seconds unit"],
    ["Lead time seconds", "seconds unit"],
    ["Africa/Abidjan", "time zone identifier"],
    ["Times are in America/Toronto.", "time zone identifier"],
    ["America/Argentina/Salta", "time zone identifier"],
    ["Etc/GMT+5", "time zone identifier"],
    ["Fee contexts", "configuration jargon"],
    [
      "Draft configuration only. These selections do not set fees, rates or effective policy.",
      "configuration jargon",
    ],
    ["A Draft does not publish a template, bind Store configuration.", "configuration jargon"],
    ["Do not put allergy information in the note; ask Staff.", "capitalized role"],
  ];
  for (const [text, rule] of cases)
    expect(
      findInternalText([text]).map((finding) => finding.rule),
      text,
    ).toContain(rule);
});

it("keeps the new rules narrow: plain minutes, zone names, ordinary slashes and seconds pass", () => {
  expect(
    findInternalText([
      "Wait times are in whole minutes, up to 24 hours (1,440 minutes).",
      "Last orders (minutes before closing)\nPreparation time (minutes)",
      "Saved as 1 minute 30 seconds. It stays as saved unless you change it here.",
      "Eastern Time (Toronto, Ottawa and Montréal)",
      "Greenwich Mean Time (Abidjan)",
      "New Zealand Time (McMurdo)",
      "Service charge and/or tip · Dine in/Pickup",
      "This page refreshes every 30 seconds.",
      "Fees\nTax settings\nPayment settings\nReceipt settings",
      "Ask staff for help. Tell staff about allergies before ordering.",
      "Saving does not change the live Store.",
    ]),
  ).toEqual([]);
});
