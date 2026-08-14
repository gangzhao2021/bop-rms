import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  InventoryReplenishment,
  InventoryReplenishmentState,
} from "./InventoryReplenishmentPage.js";
import {
  InventoryReplenishmentClientError,
  parseInventoryReplenishmentView,
} from "./inventory-replenishment.js";
const id = (n: number) => `018fa800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    screenId: "INV-REPLENISHMENT",
    projectionName: "inventory_replenishment_v1",
    projectionVersion: 1,
    stockScope: { scopeType: "Store", scopeReference: id(10), scopeLabel: "Training Store" },
    asOfUtc: "2026-08-14T11:00:00.000Z",
    freshness: "Current",
    partial: false,
    permissions: {
      supplierSummary: true,
      acknowledge: true,
      dismiss: true,
      createRequisitionDraft: true,
    },
    rows: [
      {
        needReference: id(20),
        needVersion: 1,
        itemReference: id(30),
        itemName: "Tomatoes",
        internalCode: "ING-TOMATO",
        available: "4",
        reorderPoint: "10",
        safetyStock: "3",
        forecastQuantity: "2",
        forecastReference: id(31),
        forecastAsOfUtc: "2026-08-14T08:00:00.000Z",
        suggestedQuantity: "16",
        baseUnitCode: "KG",
        requiredBy: "2026-08-17",
        urgency: "High",
        reasonCode: "BELOW_REORDER",
        preferredSupplierMappingReference: id(40),
        preferredSupplierReference: id(41),
        preferredSupplierSummary: "Preferred supplier available",
        status: "Open",
        requisitionReference: null,
      },
    ],
    nextCursor: "NEXT",
    ...overrides,
  };
}
describe("Inventory Replenishment page", () => {
  it("strictly parses the scoped projection and rejects extra fields", () => {
    expect(parseInventoryReplenishmentView(projection())).toMatchObject({
      screenId: "INV-REPLENISHMENT",
      rows: [{ suggestedQuantity: "16", status: "Open" }],
    });
    expect(() => parseInventoryReplenishmentView({ ...projection(), extra: true })).toThrow(
      InventoryReplenishmentClientError,
    );
  });
  it("renders the complete registered workbench and no PO issue action", () => {
    const html = renderToStaticMarkup(
      <InventoryReplenishment view={parseInventoryReplenishmentView(projection())} />,
    );
    for (const text of [
      "INV-REPLENISHMENT",
      "Item / Code",
      "Store / Status / Urgency",
      "Supplier / Unmapped",
      "Available 4 · reorder 10 · safety 3 KG",
      "Forecast 2",
      "suggested 16 KG",
      "Preferred Supplier",
      "Acknowledge",
      "Create Requisition draft",
      "Dismiss with reason",
      "never approval or a Purchase Order issue",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain(">Issue Purchase Order<");
  });
  it("masks Supplier output and permission-trims every action", () => {
    const hidden = projection({
      permissions: {
        supplierSummary: false,
        acknowledge: false,
        dismiss: false,
        createRequisitionDraft: false,
      },
      rows: [
        {
          ...(projection().rows[0] as Record<string, unknown>),
          preferredSupplierMappingReference: null,
          preferredSupplierReference: null,
          preferredSupplierSummary: null,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <InventoryReplenishment view={parseInventoryReplenishmentView(hidden)} />,
    );
    expect(html).not.toContain("Preferred Supplier:");
    expect(html).not.toContain(">Acknowledge<");
    expect(html).not.toContain(">Create Requisition draft<");
    expect(html).not.toContain(">Dismiss with reason<");
  });
  it("makes stale projections read-only with an adjacent explanation", () => {
    const html = renderToStaticMarkup(
      <InventoryReplenishment
        view={parseInventoryReplenishmentView(projection({ freshness: "Stale" }))}
      />,
    );
    expect(html).toContain("Projection stale");
    expect(html).toContain("Actions require a current, complete source projection");
  });
  it("covers every mandatory page state", () => {
    for (const state of [
      "Loading",
      "Empty",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "ValidationFailed",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(renderToStaticMarkup(<InventoryReplenishmentState state={state} />)).toContain(
        "status",
      );
  });
});
