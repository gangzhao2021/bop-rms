import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { deriveDefaultPickupCapacityUnits } from "../index.js";
const id = (n: number) => "01902402-0000-7000-8000-" + String(n).padStart(12, "0");
const source = {
  brandReference: id(1),
  storeReference: id(2),
  guestSessionReference: id(3),
  cartReference: id(4),
  cartVersion: 1,
  quoteReference: id(5),
  quoteInputDigest: "sha256:" + "a".repeat(64),
  quoteAttachmentReference: id(6),
  observedAt: "2026-09-10T12:00:00.000Z",
  validUntil: "2026-09-10T12:05:00.000Z",
} as Parameters<typeof deriveDefaultPickupCapacityUnits>[0];
const policy = { mode: "PerFulfillment", ruleVersion: 1 };
const hash = (value: string) => "sha256:" + createHash("sha256").update(value).digest("hex");
describe("canonical default Pickup capacity units", () => {
  it("produces one unit with stable original-source provenance", () => {
    const result = deriveDefaultPickupCapacityUnits(source, policy, hash);
    expect(result.units).toBe(1);
    expect(result.unitsRuleVersion).toBe(1);
    expect(
      deriveDefaultPickupCapacityUnits(
        { ...source, observedAt: "2026-09-10T12:01:00.000Z" as never },
        policy,
        hash,
      ),
    ).toEqual(result);
    expect(
      deriveDefaultPickupCapacityUnits({ ...source, cartVersion: 2 }, policy, hash)
        .unitsInputDigest,
    ).not.toBe(result.unitsInputDigest);
  });
  it.each([
    null,
    {},
    { mode: "Weighted", ruleVersion: 1 },
    { mode: "PerFulfillment", ruleVersion: 2 },
  ])("does not silently substitute for unavailable or weighted policy", (value) => {
    expect(() => deriveDefaultPickupCapacityUnits(source, value, hash)).toThrow();
  });
});
