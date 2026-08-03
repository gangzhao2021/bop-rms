import { resolveStoreBusinessDate } from "@rms/store";
import { describe, expect, it } from "vitest";
import { createOrderNumberAllocation, OrderNumberError } from "../index.js";

const id = (value: number) => `018f5000-0000-7000-8000-${value.toString(16).padStart(12, "0")}`;
const occurredAt = "2026-08-02T08:00:00.000Z";
const resolution = resolveStoreBusinessDate({
  occurredAt,
  configuration: {
    configurationReference: id(1),
    configurationVersion: 2,
    brandReference: id(2),
    storeReference: id(3),
    timeZone: "America/Toronto",
    businessDayStartLocalTime: "04:00:00",
    businessDayStartSource: "PlatformDefault",
    contentDigest: `sha256:${"b".repeat(64)}`,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveUntil: null,
  },
});

describe("Order Number", () => {
  it("creates a closed immutable decimal allocation from Store evidence", () => {
    const allocation = createOrderNumberAllocation({
      orderReference: id(4),
      allocatedAt: occurredAt,
      sequence: 42n,
      businessDateResolution: resolution,
    });
    expect(allocation.orderNumber).toBe("42");
    expect(allocation.businessDate).toBe("2026-08-02");
    expect(Object.isFrozen(allocation)).toBe(true);
    expect(Object.isFrozen(allocation.businessDateResolution)).toBe(true);
  });

  it("accepts closed evidence independently of object insertion order", () => {
    const reordered = Object.fromEntries(Object.entries(resolution).reverse());
    expect(
      createOrderNumberAllocation({
        orderReference: id(4),
        allocatedAt: occurredAt,
        sequence: 1n,
        businessDateResolution: reordered,
      }).orderNumber,
    ).toBe("1");
  });

  it("rejects number input, clock drift and altered resolution evidence", () => {
    for (const input of [
      { sequence: 0n },
      { sequence: 1 },
      { allocatedAt: "2026-08-02T08:00:00.001Z" },
      { businessDateResolution: { ...resolution, businessDate: "2026-08-01" } },
    ])
      expect(() =>
        createOrderNumberAllocation({
          orderReference: id(4),
          allocatedAt: occurredAt,
          sequence: 1n,
          businessDateResolution: resolution,
          ...input,
        }),
      ).toThrow(OrderNumberError);
  });
});
