import { expect, it } from "vitest";
import {
  checkoutTips,
  customTipCheck,
  priceChangesNeedAcceptance,
  priceHold,
  quotePricedLines,
} from "./checkout-decisions.js";

it("WP-2423 M114: no tip choices are known until the order is priced", () => {
  expect(checkoutTips(null)).toBeNull();
  expect(checkoutTips({ tips: { enabled: false, tierPercents: [10, 15, 18] } })).toEqual({
    enabled: false,
    tierPercents: [10, 15, 18],
  });
  // An older server's answer without tips: the default offer.
  expect(checkoutTips({})).toEqual({ enabled: true, tierPercents: [10, 15, 18] });
});

it("WP-2423 M132: a large typed tip is confirmed first, one above the order is refused", () => {
  expect(customTipCheck("195", "650")).toBe("ok"); // 30 %
  expect(customTipCheck("196", "650")).toBe("confirm");
  expect(customTipCheck("650", "650")).toBe("confirm");
  expect(customTipCheck("50000", "650")).toBe("too_large");
});

it("WP-2423 M125: the price hold counts down in 30-second steps, then every second", () => {
  const start = Date.parse("2026-08-11T14:00:00.000Z");
  const expiresAt = "2026-08-11T14:05:00.000Z";
  expect(priceHold(expiresAt, start)).toEqual({
    phase: "held",
    left: "5:00",
    nextUpdateMs: 30_000,
  });
  expect(priceHold(expiresAt, start + 100_500)).toMatchObject({
    left: "3:20",
    nextUpdateMs: 19_500,
  });
  expect(priceHold(expiresAt, start + 181_000)).toMatchObject({
    left: "1:59",
    nextUpdateMs: 1_000,
  });
  expect(priceHold(expiresAt, start + 240_000)).toMatchObject({
    phase: "last-minute",
    left: "1:00",
  });
  expect(priceHold(expiresAt, start + 300_000)).toEqual({
    phase: "ended",
    left: "0:00",
    nextUpdateMs: null,
  });
});

it("WP-2423 M74: a rise needs accepting, a decrease is only listed; lines come from the quote", () => {
  const change = {
    cartItemReference: "x",
    beforeMinor: 549n,
    afterMinor: 599n,
    currency: "CAD",
  };
  expect(priceChangesNeedAcceptance([{ ...change, direction: "up" }])).toBe(true);
  expect(priceChangesNeedAcceptance([{ ...change, direction: "down" }])).toBe(false);
  expect(
    quotePricedLines({
      lines: [
        { cartItemReference: "x", quantity: 2, subtotal: { amountMinor: "1198", currency: "CAD" } },
      ],
    }),
  ).toEqual([{ cartItemReference: "x", quantity: 2, amountMinor: 1198n, currency: "CAD" }]);
});
