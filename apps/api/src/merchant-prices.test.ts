import { describe, expect, it } from "vitest";
import {
  localBoundary,
  parsePriceCommandBody,
  priceDraftCode,
  storeLocalDate,
} from "./merchant-prices.js";

const id = (n: number) => "01909a1c-0000-7000-8000-" + n.toString(16).padStart(12, "0");
describe("WP-2423 price command body", () => {
  it("accepts each price action", () => {
    expect(
      parsePriceCommandBody({
        action: "CreateDraft",
        operationReference: id(1),
        copyFrom: null,
        purpose: "PriceChange",
      }),
    ).toMatchObject({ purpose: "PriceChange" });
    expect(
      parsePriceCommandBody({
        action: "Rebase",
        operationReference: id(1),
        priceBookReference: id(2),
        expectedAggregateVersion: 3,
      }).action,
    ).toBe("Rebase");
    // WP-2423 M124: the server names a draft; a client still sending a code is refused.
    for (const bad of [
      { action: "CreateDraft", operationReference: id(1), stableCode: "X", copyFrom: null },
      {
        action: "CreateDraft",
        operationReference: id(1),
        stableCode: "X",
        copyFrom: null,
        purpose: "PriceChange",
      },
      { action: "CreateDraft", operationReference: id(1), copyFrom: null, purpose: "Other" },
    ])
      expect(() => parsePriceCommandBody(bad)).toThrow();
    expect(
      parsePriceCommandBody({
        action: "SaveDraft",
        operationReference: id(1),
        priceBookReference: id(2),
        expectedAggregateVersion: 1,
        prices: [{ sellableReference: id(3), amountMinor: "450" }],
      }).action,
    ).toBe("SaveDraft");
    for (const action of ["Publish", "Discard"])
      expect(
        parsePriceCommandBody({
          action,
          operationReference: id(1),
          priceBookReference: id(2),
          expectedAggregateVersion: 2,
        }).action,
      ).toBe(action);
    expect(
      parsePriceCommandBody({
        action: "AssignToStore",
        operationReference: id(1),
        priceBookReference: id(2),
      }).action,
    ).toBe("AssignToStore");
  });
  it.each([
    ["a decimal amount", [{ sellableReference: id(3), amountMinor: "4.50" }]],
    ["a negative amount", [{ sellableReference: id(3), amountMinor: "-450" }]],
    ["an amount above 99,999.99", [{ sellableReference: id(3), amountMinor: "10000000" }]],
    [
      "a size priced twice",
      [
        { sellableReference: id(3), amountMinor: "450" },
        { sellableReference: id(3), amountMinor: "500" },
      ],
    ],
  ])("refuses %s", (_label, prices) => {
    expect(() =>
      parsePriceCommandBody({
        action: "SaveDraft",
        operationReference: id(1),
        priceBookReference: id(2),
        expectedAggregateVersion: 1,
        prices,
      }),
    ).toThrow(expect.objectContaining({ code: "Invalid" }));
  });
  it("forms local boundaries with the exact offset of that instant", () => {
    expect(localBoundary("2026-10-07T16:05:00.123Z", "America/Toronto")).toEqual({
      instant: "2026-10-07T16:05:00.123Z",
      localDateTime: "2026-10-07T12:05:00.123",
      utcOffsetMinutes: -240,
    });
    expect(localBoundary("2026-12-07T16:05:00.000Z", "America/Toronto").utcOffsetMinutes).toBe(
      -300,
    );
  });
});

describe("WP-2423 M150: names carry the Store's own date", () => {
  it("23:22 in Toronto on Nov 4 is Nov 4, not UTC's Nov 5", () => {
    expect(storeLocalDate("2026-11-05T04:22:00.000Z", "America/Toronto")).toBe("20261104");
    expect(
      priceDraftCode("MenuListing", id(9), "2026-11-05T04:22:00.000Z", "America/Toronto"),
    ).toMatch(/^MENU-20261104-[0-9A-F]{6}$/u);
    expect(
      priceDraftCode("PriceChange", id(9), "2026-11-05T04:22:00.000Z", "America/Toronto"),
    ).toMatch(/^PRICES-20261104-[0-9A-F]{6}$/u);
  });
});
