import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InventoryAdjustmentState,
  InventoryAdjustmentWizard,
} from "./InventoryAdjustmentWizard.js";
import {
  InventoryAdjustmentClientError,
  parseInventoryAdjustmentView,
} from "./inventory-adjustment-wizard.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    screenId: "INV-ADJUSTMENT-WIZARD",
    projectionName: "inventory_adjustment_wizard_v1",
    projectionVersion: 1,
    stockScope: { scopeType: "Location", scopeReference: id(5), scopeLabel: "Authorized fridge" },
    asOfUtc: "2026-08-14T12:00:00.000Z",
    freshness: "Current",
    partial: false,
    adjustment: {
      adjustmentReference: id(10),
      itemReference: id(20),
      itemName: "Synthetic ingredient",
      internalCode: "ITEM_01",
      lotReference: id(21),
      expiryDate: "2026-12-31",
      locationReference: id(5),
      locationLabel: "Authorized fridge",
      quantityDelta: "2",
      unitCode: "KG",
      baseQuantityDelta: "2",
      baseUnitCode: "KG",
      conversionMultiplier: "1",
      reasonCode: "FOUND_STOCK",
      evidenceReferences: [id(30)],
      currentOnHand: "10",
      currentReserved: "2",
      currentAvailable: "8",
      currentInTransit: "0",
      projectedOnHand: "12",
      projectedAvailable: "10",
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

describe("Inventory Adjustment Wizard", () => {
  it("strictly parses one scoped contextual projection", () => {
    expect(parseInventoryAdjustmentView(projection())).toMatchObject({
      screenId: "INV-ADJUSTMENT-WIZARD",
      adjustment: { status: "Submitted", balanceVersion: 7 },
    });
    expect(() => parseInventoryAdjustmentView({ ...projection(), extra: true })).toThrow(
      InventoryAdjustmentClientError,
    );
  });

  it("rejects a posted state without its immutable Movement reference", () => {
    const value = projection();
    expect(() =>
      parseInventoryAdjustmentView({
        ...value,
        adjustment: { ...value.adjustment, status: "Posted" },
      }),
    ).toThrow(InventoryAdjustmentClientError);
  });

  it("renders scope, source Balance, impact, evidence and segregation", () => {
    const html = renderToStaticMarkup(
      <InventoryAdjustmentWizard view={parseInventoryAdjustmentView(projection())} />,
    );
    for (const text of [
      "contextual high-risk action",
      "Authorized fridge",
      "On Hand 10",
      "Independent approval is required",
      "Post one immutable Movement",
    ])
      expect(html).toContain(text);
  });

  it("keeps stale source impact read-only", () => {
    const html = renderToStaticMarkup(
      <InventoryAdjustmentWizard
        view={parseInventoryAdjustmentView(projection({ freshness: "Stale" }))}
      />,
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
      expect(renderToStaticMarkup(<InventoryAdjustmentState state={state} />)).toContain("status");
  });
});
