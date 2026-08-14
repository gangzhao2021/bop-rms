import type {
  InventoryDecimal,
  InventoryInstant,
  InventoryReference,
} from "../domain/inventory-item.js";

export interface StockScope {
  readonly scopeType: "Store" | "StockSite" | "Location";
  readonly scopeReference: InventoryReference;
}

export interface StockQuantityView {
  readonly value: InventoryDecimal;
  readonly unitCode: string;
}

export interface InventoryStockOverviewRow {
  readonly itemReference: InventoryReference;
  readonly localizedName: string;
  readonly internalCode: string;
  readonly baseUnitCode: string;
  readonly lifecycle: "Active" | "Inactive" | "Archived";
  readonly trackingMode: "Disabled" | "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
  readonly onHand: StockQuantityView | null;
  readonly reserved: StockQuantityView | null;
  readonly available: StockQuantityView | null;
  readonly inTransit: StockQuantityView | null;
  readonly reorderStatus: "Hidden" | "Healthy" | "BelowReorder" | "MissingPolicy";
  readonly alerts: readonly (
    "ExpiryRisk" | "NegativeStock" | "CountRequired" | "UnitConversionMissing"
  )[];
}

export interface InventoryStockOverview {
  readonly projectionName: "inventory_stock_overview_v1";
  readonly projectionVersion: 1;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly stockScope: StockScope | null;
  readonly quantityVisibility: "IdentityOnly" | "Scoped";
  readonly projectedAt: InventoryInstant;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly rows: readonly InventoryStockOverviewRow[];
}

export class InventoryStockOverviewError extends Error {
  constructor(
    readonly code:
      | "INV_STOCK_QUERY_INVALID"
      | "INV_STOCK_SCOPE_REQUIRED"
      | "INV_STOCK_PERMISSION_DENIED"
      | "INV_STOCK_PROJECTION_INVALID"
      | "INV_STOCK_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Inventory Stock Overview is unavailable");
    this.name = "InventoryStockOverviewError";
  }
}
