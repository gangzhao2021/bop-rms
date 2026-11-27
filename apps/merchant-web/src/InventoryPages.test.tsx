import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import {
  InventoryItemListUnavailable,
  InventoryItemDetailUnavailable,
  InventoryItemFormUnavailable,
  InventoryOverviewUnavailable,
  InventoryScreen,
  InventoryState,
} from "./InventoryPages.js";
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
  it("renders the Item List source boundary without sample data or enabled controls", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryItemListUnavailable />
      </MemoryRouter>,
    );
    expect(html).toContain("INV-ITEM-LIST · PHASE 2");
    expect(html).toContain("ITEM PROJECTION UNAVAILABLE");
    expect(html).toContain(
      "Store scope, Ledger quantity, reorder, usage, supplier and history facts are unavailable.",
    );
    expect(html).toContain("Item / code");
    expect(html).toContain("Store scope / quantity");
    expect(html).not.toContain("Synthetic ingredient");
    expect(html).not.toContain("12.5000");
    expect(html).toMatch(/<fieldset class="inventory-item-list-filters" disabled="">/u);
    expect(html).toMatch(/<button type="button" disabled=""/u);
  });
  it("renders the Item Detail Review hierarchy without sample facts or enabled actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryItemDetailUnavailable />
      </MemoryRouter>,
    );
    for (const text of [
      "INV-ITEM-DETAIL · PHASE 2",
      "AUTHORIZED ITEM DETAIL QUERY UNAVAILABLE",
      "Units &amp; conversions",
      "Tracking &amp; lot / expiry",
      "Stock by location · scope required",
      "Scope-gated balance fields",
      "Supplier mappings",
      "Recipe / SKU usage",
      "Movements, counts &amp; history",
      "Registered actions · unavailable",
      "not an Accepted Screen",
    ])
      expect(html).toContain(text);
    expect(html).not.toContain("Synthetic ingredient");
    expect(html).not.toContain("12.5000");
    expect(html).not.toContain("Authorized Store scope");
    expect(html).toMatch(/<button type="button" disabled=""/u);
  });
  it("renders Create and Edit source boundaries without quantity fields or enabled actions", () => {
    for (const mode of ["CREATE", "EDIT"] as const) {
      const html = renderToStaticMarkup(
        <MemoryRouter>
          <InventoryItemFormUnavailable mode={mode} />
        </MemoryRouter>,
      );
      for (const text of [
        `INV-ITEM-${mode} · PHASE 2`,
        "AUTHORIZED ITEM SOURCE UNAVAILABLE",
        "Identity and handling",
        "Internal code",
        "Localized name",
        "Item type / category",
        "Tracking mode",
        "Lot / expiry policy",
        "Negative stock policy",
        "Reorder policy · Store scoped",
        "Quantity and opening balance are never Item fields.",
        "DESIGN REVIEW ONLY · NOT AN ACCEPTED SCREEN",
      ])
        expect(html).toContain(text);
      expect(html).not.toContain("Synthetic ingredient");
      expect(html).not.toContain("<input");
      expect(html).not.toContain("Opening balance</dt>");
      expect(html).toMatch(/<button[^>]*disabled=""/u);
    }
  });
  it("renders the Stock Overview source boundary without sample data or enabled controls", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <InventoryOverviewUnavailable />
      </MemoryRouter>,
    );
    expect(html).toContain("INV-STOCK-OVERVIEW · PHASE 2");
    expect(html).toContain("Stock projection unavailable");
    expect(html).toContain("Store scope unavailable · freshness unavailable");
    expect(html).toContain("On hand");
    expect(html).toContain("Reserved");
    expect(html).toContain("Available");
    expect(html).toContain("Inventory value remains separately permission-gated.");
    expect(html).not.toContain("Synthetic ingredient");
    expect(html).not.toContain("12.5000");
    expect(html).toMatch(/<fieldset class="inventory-overview-filters" disabled="">/u);
    expect(html).toMatch(/<button type="button" disabled=""/u);
  });
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
      "Adjust stock",
      "Waste / transfer",
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
