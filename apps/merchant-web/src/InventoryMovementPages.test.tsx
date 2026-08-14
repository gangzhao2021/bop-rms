import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { InventoryMovementScreen, InventoryMovementState } from "./InventoryMovementPages.js";
import {
  InventoryMovementClientError,
  parseInventoryMovementView,
} from "./inventory-movement-pages.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(
  screenId = "INV-MOVEMENT-LIST",
  overrides: Readonly<Record<string, unknown>> = {},
) {
  return {
    screenId,
    projectionName: "inventory_movement_explorer_v1",
    projectionVersion: 1,
    stockScope: {
      scopeType: "Store",
      scopeReference: id(4),
      scopeLabel: "Authorized Store scope",
    },
    asOfUtc: "2026-08-14T12:30:00.000Z",
    freshness: "Current",
    partial: false,
    selectedMovementReference: screenId === "INV-MOVEMENT-DETAIL" ? id(10) : null,
    selectedItemReference: screenId === "INV-ITEM-STOCK-HISTORY" ? id(20) : null,
    movements: [
      {
        movementReference: id(10),
        movementType: "Receive",
        itemReference: id(20),
        itemName: "Synthetic ingredient",
        internalCode: "ITEM_01",
        quantityDelta: "5.000000",
        unitCode: "KG",
        baseQuantityDelta: "5.000000",
        baseUnitCode: "KG",
        conversionMultiplier: "1",
        sourceScopeLabel: null,
        destinationScopeLabel: "Authorized Store scope",
        lotReference: id(30),
        expiryDate: "2026-12-31",
        businessSourceType: "GOODS_RECEIPT",
        businessSourceReference: id(40),
        reasonCode: "RECEIVED",
        performedByDisplay: "Authorized staff reference",
        occurredAt: "2026-08-14T12:00:00.000Z",
        balanceBefore: "0",
        balanceAfter: "5.000000",
        ledgerVersion: 2,
        auditReference: id(50),
        correctsMovementReference: null,
        correctedByMovementReference: null,
        correctable: true,
      },
    ],
    ...overrides,
  };
}

describe("Inventory Movement screens", () => {
  it("strictly parses one scoped immutable projection", () => {
    expect(parseInventoryMovementView(projection())).toMatchObject({
      projectionName: "inventory_movement_explorer_v1",
      stockScope: { scopeType: "Store" },
      movements: [{ movementType: "Receive", quantityDelta: "5.000000" }],
    });
    expect(() => parseInventoryMovementView({ ...projection(), stockScope: null })).toThrow(
      InventoryMovementClientError,
    );
    expect(() => parseInventoryMovementView({ ...projection(), unexpected: true })).toThrow(
      InventoryMovementClientError,
    );
  });

  it("renders explorer scope, filters, evidence and disabled corrective action", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryMovementScreen view={parseInventoryMovementView(projection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "Immutable Stock Ledger",
      "Authorized Store scope",
      "Movement / item / code / source reference",
      "5.000000 KG",
      "View immutable evidence",
      "Create compensating correction",
    ])
      expect(html).toContain(text);
    expect(html).toMatch(/<button disabled="">Scoped export<\/button>/u);
  });

  it("renders detail conversion, snapshots, source, Audit and correction chain", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryMovementScreen
          view={parseInventoryMovementView(projection("INV-MOVEMENT-DETAIL"))}
        />
      </MemoryRouter>,
    );
    for (const text of [
      "Immutable evidence and correction chain",
      "Conversion snapshot",
      "Balance 0 → 5.000000",
      "Audit:",
      "cannot be edited or deleted",
      "current Balance version",
    ])
      expect(html).toContain(text);
  });

  it("requires one Item for item-scoped Stock History", () => {
    expect(parseInventoryMovementView(projection("INV-ITEM-STOCK-HISTORY"))).toMatchObject({
      selectedItemReference: id(20),
    });
    expect(() =>
      parseInventoryMovementView(
        projection("INV-ITEM-STOCK-HISTORY", { selectedItemReference: null }),
      ),
    ).toThrow(InventoryMovementClientError);
  });

  it("covers mandatory permission, stale, conflict, failure and offline states", () => {
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <InventoryMovementState state={state} />
          </MemoryRouter>,
        ),
      ).toContain("status");
  });
});
