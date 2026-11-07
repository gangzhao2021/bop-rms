import { describe, expect, it } from "vitest";
import { parseAvailabilityRule } from "@rms/catalog";
import { merchantNavigationActions } from "./merchant-bff.js";
import {
  stockSoldOutView,
  itemAvailability,
  MerchantAvailabilityError,
  optionStatus,
  parseAvailabilityCommandBody,
  stockAnswer,
} from "./merchant-availability.js";

const id = (n: number) => "01909a1f-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
const at = "2026-10-08T12:00:00.000Z";
const rule = (n: number, change: Record<string, unknown>) =>
  parseAvailabilityRule({
    ruleReference: id(n),
    brandReference: id(1),
    internalCode: "RULE_" + n,
    aggregateVersion: 2,
    lifecycle: "Active",
    sellableReference: id(3),
    sellableType: "Sku",
    storeReference: id(2),
    channelCodes: [],
    orderTypeCodes: [],
    effectiveFrom: "2026-10-01T00:00:00.000Z",
    effectiveUntil: null,
    decision: "Available",
    priority: 100,
    reasonCode: "STORE_OFFERED",
    createdAt: "2026-10-01T00:00:00.000Z",
    createdByActorReference: id(9),
    updatedAt: "2026-10-01T00:00:00.000Z",
    ...change,
  });
describe("WP-2423 item availability", () => {
  it("parses the four commands and rejects anything else", () => {
    const base = { operationReference: id(4), skuReference: id(3) };
    for (const action of ["Offer", "StopOffering", "BackInStock"])
      expect(parseAvailabilityCommandBody({ action, ...base }).action).toBe(action);
    expect(
      parseAvailabilityCommandBody({ action: "SoldOut", ...base, until: "EndOfDay" }),
    ).toMatchObject({ until: "EndOfDay" });
    for (const body of [
      { action: "SoldOut", ...base },
      { action: "SoldOut", ...base, until: "Tomorrow" },
      { action: "Offer", ...base, storeReference: id(2) },
      { action: "Offer", operationReference: "x", skuReference: id(3) },
      { action: "Delete", ...base },
    ])
      expect(() => parseAvailabilityCommandBody(body)).toThrow(MerchantAvailabilityError);
  });
  it("derives the Store status from offers and sold-out marks", () => {
    expect(itemAvailability([], scope, id(3), at)).toEqual({
      status: "NotOffered",
      soldOutUntil: null,
    });
    const offer = rule(10, {});
    expect(itemAvailability([offer], scope, id(3), at).status).toBe("Available");
    const today = rule(11, {
      decision: "Unavailable",
      priority: 900,
      reasonCode: "SOLD_OUT",
      effectiveUntil: "2026-10-09T04:00:00.000Z",
    });
    expect(itemAvailability([offer, today], scope, id(3), at)).toEqual({
      status: "SoldOut",
      soldOutUntil: "2026-10-09T04:00:00.000Z",
    });
    expect(itemAvailability([offer, today], scope, id(3), "2026-10-09T05:00:00.000Z").status).toBe(
      "Available",
    );
    expect(
      itemAvailability([offer, { ...today, lifecycle: "Inactive" }], scope, id(3), at).status,
    ).toBe("Available");
    const pickupOnly = rule(12, { orderTypeCodes: ["PICKUP"] });
    expect(itemAvailability([pickupOnly], scope, id(3), at).status).toBe("Varies");
  });
  it("admits Item availability for the floor staff's sold-out mark (WP-2423 Q17)", () => {
    expect(
      merchantNavigationActions({ screenId: "CAT-AVAILABILITY", permission: "catalog.sku.read" }),
    ).toEqual(["catalog.sku.read", "catalog.sku.sold_out.mark"]);
    expect(
      merchantNavigationActions({ screenId: "CAT-MENU-LIST", permission: "catalog.menu.read" }),
    ).toEqual(["catalog.menu.read"]);
  });
});

describe("WP-2423 (2026-10-16) stock reason on the item availability page", () => {
  const milk = {
    itemReference: "0190a7c4-0000-7000-8000-000000000011",
    name: "Whole milk 3.25%",
    unitCode: "L",
    displayPrecision: 3,
    required: "0.24",
    onHand: "2.8",
    reserved: "2.8",
    available: "0",
    holdingSubmissionCount: 11,
  };
  it("lists only the short ingredients of an item guests see sold out from stock", () => {
    const sugar = { ...milk, name: "Sugar", available: "4.8", reserved: "0" };
    expect(stockSoldOutView({ status: "Unavailable", shortages: [milk, sugar] })).toEqual({
      ingredients: [
        {
          name: "Whole milk 3.25%",
          unitCode: "L",
          displayPrecision: 3,
          required: "0.24",
          onHand: "2.8",
          reserved: "2.8",
          available: "0",
          openOrderCount: 11,
        },
      ],
    });
    expect(stockSoldOutView({ status: "Available", shortages: [] })).toBeNull();
    // DEC-BRAND-MULTI-STORE (coordinator 2026-10-31): a new Store before its first delivery says so.
    expect(
      stockSoldOutView({ status: "Unavailable", shortages: [milk], noStockReceived: true }),
    ).toEqual({ noStockReceived: true, ingredients: [] });
    expect(stockSoldOutView({ status: "Indeterminate", shortages: [] })).toBeNull();
    expect(stockSoldOutView(undefined)).toBeNull();
  });
});

describe("WP-2423 (M24, M78) choices sold out at the Store, and what stock says", () => {
  it("takes a choice's sold-out and back-on commands, and nothing else on them", () => {
    expect(
      parseAvailabilityCommandBody({
        action: "OptionSoldOut",
        operationReference: id(20),
        optionReference: id(21),
        until: "EndOfDay",
      }),
    ).toEqual({
      action: "OptionSoldOut",
      operationReference: id(20),
      optionReference: id(21),
      until: "EndOfDay",
    });
    expect(
      parseAvailabilityCommandBody({
        action: "OptionBackOn",
        operationReference: id(20),
        optionReference: id(21),
      }).action,
    ).toBe("OptionBackOn");
    for (const body of [
      { action: "OptionSoldOut", operationReference: id(20), optionReference: id(21) },
      {
        action: "OptionBackOn",
        operationReference: id(20),
        optionReference: id(21),
        until: "EndOfDay",
      },
      {
        action: "OptionSoldOut",
        operationReference: id(20),
        skuReference: id(21),
        until: "EndOfDay",
      },
    ])
      expect(() => parseAvailabilityCommandBody(body)).toThrow(MerchantAvailabilityError);
  });
  it("says a choice's status from its current mark", () => {
    expect(optionStatus(undefined)).toEqual({ status: "Available", soldOutUntil: null });
    const mark = {
      optionReference: id(21),
      version: 1,
      soldOut: true,
      soldOutUntil: "2026-10-09T08:00:00.000Z",
      inEffect: true,
    };
    expect(optionStatus(mark)).toEqual({
      status: "SoldOut",
      soldOutUntil: "2026-10-09T08:00:00.000Z",
    });
    expect(optionStatus({ ...mark, inEffect: false }).status).toBe("Available");
  });
  it("tells short stock from stock that was not read", () => {
    expect(stockAnswer({ status: "Unavailable", shortages: [] })).toBe("Short");
    expect(stockAnswer({ status: "Available", shortages: [] })).toBe("Enough");
    expect(stockAnswer({ status: "Indeterminate", shortages: [] })).toBe("Unknown");
    expect(stockAnswer({ status: "Indeterminate", shortages: [], failed: true })).toBe("Unknown");
    expect(stockAnswer(undefined)).toBe("Unknown");
  });
});
