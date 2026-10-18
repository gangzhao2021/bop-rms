import { describe, expect, it } from "vitest";
import { createInventoryItem, transitionInventoryItem } from "../domain/inventory-item.js";
import { parseInventoryItemSnapshot } from "../domain/inventory-item-snapshot.js";

const id = (n: number) => "018fa700-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const instant = "2026-09-11T10:00:00.000Z";
function item() {
  return createInventoryItem({
    itemReference: id(1),
    tenantReference: id(2),
    brandReference: id(3),
    internalCode: "SYNTHETIC_ITEM",
    itemType: "RawMaterial",
    localizedNames: { en: "Synthetic ingredient" },
    baseUnit: {
      unitCode: "KG",
      dimension: "Mass",
      displayPrecision: 2,
      ledgerPrecision: 4,
      roundingMode: "HalfEven",
    },
    trackingPolicy: {
      stockTrackingEnabled: true,
      lotTrackingMode: "NoLot",
      defaultShelfLifeDays: null,
      expiryWarningDays: null,
      issuePolicy: "FIFO",
      negativeStockPolicy: "Block",
    },
    occurredAt: instant,
    actorReference: id(4),
  });
}
function policy() {
  return {
    policyReference: id(6),
    scopeType: "Store",
    scopeReference: id(7),
    reorderPoint: "1.000001",
    safetyStock: "0",
    targetStockLevel: "999999999999999999.000001",
    minimumOrderQuantityHint: null,
    orderMultipleHint: null,
    leadTimeDaysHint: 0,
    preferredSupplierMappingReference: null,
    enabled: true,
    effectiveFrom: instant,
    effectiveUntil: null,
    overrideSource: "Store",
  };
}
function version() {
  return {
    ...item(),
    aggregateVersion: 2,
    reorderPolicies: [policy()],
    unitConversions: [
      {
        conversionReference: id(8),
        fromUnitCode: "G",
        toBaseUnitCode: "KG",
        multiplier: "0.001",
        effectiveFrom: instant,
        reasonCode: "CONFIGURED",
        status: "Active",
      },
    ],
  };
}

describe("Inventory Item persistence snapshot", () => {
  it("round trips creation and a real lifecycle transition", () => {
    const original = item();
    const active = transitionInventoryItem(original, "Active", {
      expectedVersion: 1,
      hasOpenWork: false,
      hasNonZeroStock: false,
      occurredAt: instant,
      actorReference: id(4),
    });
    expect(parseInventoryItemSnapshot(JSON.parse(JSON.stringify(original)))).toEqual(original);
    expect(parseInventoryItemSnapshot(JSON.parse(JSON.stringify(active)))).toEqual(active);
  });
  it("preserves exact decimals and detaches and freezes nested persisted values", () => {
    const raw = version();
    const result = parseInventoryItemSnapshot(raw);
    expect(result.reorderPolicies[0]?.targetStockLevel).toBe("999999999999999999.000001");
    for (const entry of raw.reorderPolicies) entry.targetStockLevel = "0";
    expect(result.reorderPolicies[0]?.targetStockLevel).toBe("999999999999999999.000001");
    for (const value of [
      result,
      result.localizedNames,
      result.baseUnit,
      result.trackingPolicy,
      result.reorderPolicies,
      result.reorderPolicies[0],
      result.unitConversions,
      result.unitConversions[0],
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it.each([
    { aggregateVersion: 0 },
    { aggregateVersion: Number.MAX_SAFE_INTEGER + 1 },
    { updatedAt: "2026-09-10T10:00:00.000Z" },
    { brandReference: "foreign" },
    { lifecycle: "Deleted" },
    { hasMovementHistory: "false" },
    { unexpected: true },
    { aggregateVersion: 1, lifecycle: "Active" },
  ])("rejects malformed aggregate metadata %j", (change) => {
    expect(() => parseInventoryItemSnapshot({ ...item(), ...change })).toThrow(
      "Inventory Item operation failed",
    );
  });
  it("rejects nested accessors without executing them", () => {
    let reads = 0;
    const unit = { ...item().baseUnit };
    Object.defineProperty(unit, "unitCode", {
      enumerable: true,
      get() {
        reads += 1;
        return "KG";
      },
    });
    expect(() => parseInventoryItemSnapshot({ ...item(), baseUnit: unit })).toThrow();
    expect(reads).toBe(0);
  });
  it("rejects inherited, extra and sparse records", () => {
    expect(() => parseInventoryItemSnapshot(Object.create(item()))).toThrow();
    expect(() =>
      parseInventoryItemSnapshot({ ...item(), baseUnit: { ...item().baseUnit, private: 1 } }),
    ).toThrow();
    expect(() =>
      parseInventoryItemSnapshot({ ...version(), reorderPolicies: new Array(1) }),
    ).toThrow();
  });
  it.each([
    { multiplier: "0" },
    { multiplier: "0.0000001" },
    { toBaseUnitCode: "L" },
    { status: "Unknown" },
    { effectiveFrom: "yesterday" },
  ])("rejects invalid conversion %j", (change) => {
    const raw = version();
    expect(() =>
      parseInventoryItemSnapshot({
        ...raw,
        unitConversions: [{ ...raw.unitConversions[0], ...change }],
      }),
    ).toThrow();
  });
  it.each([
    { targetStockLevel: "1" },
    { effectiveUntil: instant },
    { leadTimeDaysHint: -1 },
    { minimumOrderQuantityHint: "0" },
    { orderMultipleHint: "0.000" },
    { scopeType: "Tenant" },
    { enabled: "true" },
  ])("rejects invalid reorder policy %j", (change) => {
    expect(() =>
      parseInventoryItemSnapshot({ ...version(), reorderPolicies: [{ ...policy(), ...change }] }),
    ).toThrow();
  });
  it("rejects duplicate conversion identities and reorder scopes", () => {
    const raw = version();
    expect(() =>
      parseInventoryItemSnapshot({
        ...raw,
        unitConversions: [...raw.unitConversions, ...raw.unitConversions],
      }),
    ).toThrow();
    expect(() =>
      parseInventoryItemSnapshot({
        ...raw,
        reorderPolicies: [policy(), { ...policy(), policyReference: id(9) }],
      }),
    ).toThrow();
  });
});
