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

it("flags machine dates and times however they are joined, as on the v15 sold-out page", () => {
  for (const text of [
    "Source as of 2026-10-14 22:11",
    "Source as of 2026-10-14T22:11",
    "Updated 2026-10-14T22:11:05.123Z",
    "Business day 2026-10-14",
  ])
    expect(
      findInternalText([text]).map((finding) => finding.rule),
      text,
    ).toContain("timestamp");
  expect(
    findInternalText([
      "Checked 10:11 PM today",
      "Submitted Oct 14, 2026, 10:08 PM",
      "Order 2026 · Call (604) 555-0166",
      "Table 12 · 2 guests",
    ]),
  ).toEqual([]);
});

it("flags Provider and internal record references such as the v15 settlement statement id", () => {
  for (const text of [
    "Statement simset_20261014_9df991b5c0ffee",
    "Charge ch_3NxSYNTHETIC1 refunded",
    "Refund re_1AbcSYNTHETIC",
  ])
    expect(
      findInternalText([text]).map((finding) => finding.rule),
      text,
    ).toContain("internal reference");
  // Ordinary words with an underscore-free form or no digit stay allowed.
  expect(
    findInternalText([
      "Provider statement for Wed, Oct 14",
      "Refund of an unmatched provider charge",
    ]),
  ).toEqual([]);
});

it("WP-2423 item 7: flags amounts written with a currency code, as on the v15 refund pages", () => {
  for (const text of [
    "Refund CAD 27.40",
    "Requested CAD 11.30; confirmed CAD 0.00",
    "CAD $1,284.60",
  ])
    expect(
      findInternalText([text]).map((finding) => finding.rule),
      text,
    ).toContain("currency code amount");
  expect(
    findInternalText([
      "Refund $27.40 on the store's card machine",
      "Unit cost ($)",
      "Standard cost per kg ($)",
      "Refunds above $100 for an order",
    ]),
  ).toEqual([]);
});

it("flags the currency code staff met as a word on the v15 recipe and price book pages", () => {
  for (const text of [
    "Standard cost (CAD)",
    "Standard cost (CAD per unit)",
    "Price (CAD)",
    "Draft · version 2 · prices in CAD, before tax, the same for pickup and dine-in",
  ])
    expect(
      findInternalText([text]).map((finding) => finding.rule),
      text,
    ).toContain("currency code");
  expect(
    findInternalText([
      "Standard cost\nStandard cost per unit\nPrice\n$4.50",
      "Draft · version 2 · prices before tax, the same for pickup and dine-in",
      "Cadence\nDecaf\ncadmium",
    ]),
  ).toEqual([]);
});

it("v15 run: flags a person named by an identifier fragment, as on the stock count pages", () => {
  expect(
    findInternalText(["Counting · counted by Staff 0100 · 0 of 3 lines counted"]).map(
      (finding) => finding.rule,
    ),
  ).toContain("identifier fragment");
  expect(
    findInternalText([
      "Counting · counted by You · 0 of 3 lines counted",
      "Counted by Store owner",
      "Staff 2 of 4 on shift",
    ]),
  ).toEqual([]);
  expect(
    findInternalText(["Counted by Unnamed staff member"]).map((finding) => finding.rule),
  ).toContain("unnamed person");
});
