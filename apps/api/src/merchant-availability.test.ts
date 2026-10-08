import { describe, expect, it } from "vitest";
import { parseAvailabilityRule } from "@rms/catalog";
import {
  itemAvailability,
  MerchantAvailabilityError,
  parseAvailabilityCommandBody,
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
});
