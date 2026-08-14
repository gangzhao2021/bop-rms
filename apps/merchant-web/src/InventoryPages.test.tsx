import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { InventoryScreen, InventoryState } from "./InventoryPages.js";
import { InventoryClientError, parseInventoryView } from "./inventory-pages.js";

const id = (n: number) => `018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function projection(screenId = "INV-STOCK-OVERVIEW", overrides: Record<string, unknown> = {}) {
  const scoped = screenId === "INV-STOCK-OVERVIEW";
  return {
    screenId,
    projectionName: scoped
      ? "inventory_stock_overview_v1"
      : screenId === "INV-ITEM-DETAIL" || screenId === "INV-ITEM-EDIT"
        ? "inventory_item_detail_v1"
        : "inventory_item_search_v1",
    projectionVersion: 1,
    asOfUtc: "2026-09-21T12:00:00.000Z",
    freshness: "Current",
    partial: false,
    stockScope: scoped
      ? { scopeType: "Store", scopeReference: id(4), scopeLabel: "Authorized Store scope" }
      : null,
    selectedItemReference: ["INV-ITEM-DETAIL", "INV-ITEM-EDIT"].includes(screenId) ? id(10) : null,
    items: [
      {
        itemReference: id(10),
        localizedName: "Synthetic ingredient",
        internalCode: "ITEM_01",
        itemType: "RawMaterial",
        lifecycle: "Active",
        baseUnitCode: "KG",
        trackingMode: "LotExpiryRequired",
        negativeStockPolicy: "Block",
        quantities: scoped
          ? {
              onHand: "12.5000",
              reserved: "2.0000",
              available: "10.5000",
              inTransit: "3.0000",
              unitCode: "KG",
            }
          : null,
        reorderStatus: scoped ? "Healthy" : "Hidden",
        preferredSupplierSummary: "Unavailable",
        recipeUsageCount: 2,
        skuMappingCount: 1,
        updatedAt: "2026-09-21T11:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

describe("Inventory primary screens", () => {
  it("strictly parses scoped quantity and identity-only projections", () => {
    expect(parseInventoryView(projection())).toMatchObject({
      stockScope: { scopeType: "Store" },
      items: [{ quantities: { unitCode: "KG" } }],
    });
    expect(parseInventoryView(projection("INV-ITEM-LIST"))).toMatchObject({
      stockScope: null,
      items: [{ quantities: null, reorderStatus: "Hidden" }],
    });
    expect(() => parseInventoryView({ ...projection(), unexpected: true })).toThrow(
      InventoryClientError,
    );
  });
  it("renders Stock Overview scope, value + unit, filters and disabled later workflows", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryScreen view={parseInventoryView(projection())} />
      </MemoryRouter>,
    );
    for (const text of [
      "Ledger-owned quantity",
      "Authorized Store scope",
      "12.5000 on hand",
      "KG",
      "Item / internal code / barcode / supplier item code",
      "Adjust / waste / transfer",
    ])
      expect(html).toContain(text);
    expect(html).toMatch(/<button disabled="">Start count<\/button>/u);
  });
  it("renders Item detail ownership, policy, history and Procurement boundary", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryScreen view={parseInventoryView(projection("INV-ITEM-DETAIL"))} />
      </MemoryRouter>,
    );
    for (const text of [
      "Units and Conversions",
      "Tracking and Lot / Expiry",
      "Reorder Policies",
      "History / masked Audit / Compare",
      "Procurement-owned",
      "Duplicate without identity / balance",
    ])
      expect(html).toContain(text);
  });
  it("renders create/edit configuration without quantity input", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryScreen
          view={parseInventoryView(
            projection("INV-ITEM-CREATE", { items: [], selectedItemReference: null }),
          )}
        />
      </MemoryRouter>,
    );
    expect(html).toContain("Identity, units and tracking policy");
    expect(html).toContain("Quantity and opening balance are never Item fields");
    expect(html).not.toContain("On Hand Quantity");
  });
  it("covers all mandatory failure/offline states", () => {
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
            <InventoryState state={state} />
          </MemoryRouter>,
        ),
      ).toContain("status");
  });
});
