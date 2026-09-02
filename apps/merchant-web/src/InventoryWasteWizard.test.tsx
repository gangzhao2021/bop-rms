import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InventoryWasteState, InventoryWasteWizard } from "./InventoryWasteWizard.js";
import { InventoryWasteClientError, parseInventoryWasteView } from "./inventory-waste-wizard.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    screenId: "INV-WASTE-WIZARD",
    projectionName: "inventory_waste_wizard_v1",
    projectionVersion: 1,
    stockScope: { scopeType: "Location", scopeReference: id(5), scopeLabel: "Authorized fridge" },
    asOfUtc: "2026-08-14T12:00:00.000Z",
    freshness: "Current",
    partial: false,
    waste: {
      wasteReference: id(10),
      itemReference: id(20),
      itemName: "Synthetic ingredient",
      internalCode: "ITEM_01",
      lotReference: id(21),
      expiryDate: "2026-12-31",
      locationReference: id(5),
      locationLabel: "Authorized fridge",
      quantity: "2",
      unitCode: "KG",
      baseQuantityDelta: "-2",
      baseUnitCode: "KG",
      conversionMultiplier: "1",
      reasonCode: "SPOILAGE",
      sourceType: "FoodSafetyIncident",
      sourceReference: id(31),
      evidenceReferences: [id(30)],
      approvalRequirement: "Required",
      approvalPolicyReference: id(32),
      costSummary: { minorUnits: "1250", currencyCode: "CAD" },
      currentOnHand: "10",
      currentReserved: "2",
      currentAvailable: "8",
      currentInTransit: "0",
      projectedOnHand: "8",
      projectedAvailable: "6",
      balanceVersion: 7,
      negativeStockPolicy: "Block",
      warnings: [],
      status: "Submitted",
      submittedByDisplay: "Authorized submitter",
      approvedByDisplay: null,
      movementReference: null,
      aggregateVersion: 2,
    },
    ...overrides,
  };
}

describe("Inventory Waste Wizard", () => {
  it("strictly parses one scoped contextual projection", () => {
    expect(parseInventoryWasteView(projection())).toMatchObject({
      screenId: "INV-WASTE-WIZARD",
      waste: { status: "Submitted", balanceVersion: 7 },
    });
    expect(() => parseInventoryWasteView({ ...projection(), extra: true })).toThrow(
      InventoryWasteClientError,
    );
  });

  it("rejects a posted state without its immutable Movement reference", () => {
    const value = projection();
    expect(() =>
      parseInventoryWasteView({
        ...value,
        waste: { ...value.waste, status: "Posted" },
      }),
    ).toThrow(InventoryWasteClientError);
  });

  it("renders scope, source Balance, impact, evidence and segregation", () => {
    const html = renderToStaticMarkup(
      <InventoryWasteWizard view={parseInventoryWasteView(projection())} />,
    );
    for (const text of [
      "operational entry",
      "Authorized fridge",
      "On Hand 10",
      "FoodSafetyIncident",
      "CAD minor units 1250",
      "Independent approval is required",
      "Post one immutable Movement",
    ])
      expect(html).toContain(text);
  });

  it("keeps stale source impact read-only", () => {
    const html = renderToStaticMarkup(
      <InventoryWasteWizard view={parseInventoryWasteView(projection({ freshness: "Stale" }))} />,
    );
    expect(html).toContain("Source stale / partial — posting disabled");
  });

  it("covers every mandatory contextual failure state", () => {
    for (const state of [
      "Loading",
      "Empty",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<InventoryWasteState state={state} />)).toContain("status");
  });
});
