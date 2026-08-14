import type { InventoryStockOverview, StockScope } from "../../contracts/stock-overview.js";
import type { InventoryReference } from "../../domain/inventory-item.js";

export interface StockOverviewPorts {
  readonly authorization: {
    authorize(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly actorReference: InventoryReference;
      readonly purpose: "InventoryStockRead";
      readonly permission: "inventory.manage";
      readonly stockScope: StockScope | null;
      readonly includeQuantities: boolean;
    }): Promise<{ readonly authorized: true; readonly costVisible: boolean } | null>;
  };
  readonly projection: {
    query(input: {
      readonly tenantReference: InventoryReference;
      readonly brandReference: InventoryReference;
      readonly stockScope: StockScope | null;
      readonly includeQuantities: boolean;
      readonly search: string | null;
      readonly quantityFilter: "BelowReorder" | "OutOfStock" | "HasOnHand" | null;
      readonly sort: "Name" | "UpdatedAt" | "Available" | "OnHand" | "ReorderStatus";
    }): Promise<InventoryStockOverview>;
  };
}
