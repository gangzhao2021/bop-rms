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
