import { describe, expect, it, vi } from "vitest";
import {
  queryStockOverview,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryStockOverview,
  type StockOverviewPorts,
} from "../index.js";

const id = (n: number) =>
  parseInventoryReference(`018fa700-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const quantity = (value: string) => ({ value: parseInventoryDecimal(value), unitCode: "KG" });
function view(scoped = true): InventoryStockOverview {
  return {
    projectionName: "inventory_stock_overview_v1",
    projectionVersion: 1,
    tenantReference: id(1),
    brandReference: id(2),
    stockScope: scoped ? { scopeType: "Store", scopeReference: id(4) } : null,
    quantityVisibility: scoped ? "Scoped" : "IdentityOnly",
    projectedAt: parseInventoryInstant("2026-09-21T12:00:00.000Z"),
    freshness: "Current",
    rows: [
      {
        itemReference: id(10),
        localizedName: "Synthetic ingredient",
        internalCode: "ITEM_01",
        baseUnitCode: "KG",
        lifecycle: "Active",
        trackingMode: "LotExpiryRequired",
        onHand: scoped ? quantity("12.5000") : null,
        reserved: scoped ? quantity("2.0000") : null,
        available: scoped ? quantity("10.5000") : null,
        inTransit: scoped ? quantity("3.0000") : null,
        reorderStatus: scoped ? "Healthy" : "Hidden",
        alerts: [],
      },
    ],
  };
}
function query(stockScope: unknown, includeQuantities = true) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purpose: "InventoryStockRead",
    permission: "inventory.manage",
    stockScope,
    includeQuantities,
    search: null,
    quantityFilter: null,
    sort: includeQuantities ? "Available" : "Name",
  };
}
function ports(result: InventoryStockOverview): StockOverviewPorts {
  return {
    authorization: {
      authorize: vi.fn(async () => ({ authorized: true as const, costVisible: false })),
    },
    projection: { query: vi.fn(async () => result) },
  };
}

describe("explicit Stock Scope contract", () => {
  it("requires one scope for quantity columns, filters and sorting", async () => {
    const adapter = ports(view());
    await expect(queryStockOverview(query(null), adapter)).rejects.toMatchObject({
      code: "INV_STOCK_SCOPE_REQUIRED",
    });
    expect(adapter.authorization.authorize).not.toHaveBeenCalled();
  });

  it("returns value + unit only for the exact authorized scope", async () => {
    const adapter = ports(view());
    const result = await queryStockOverview(
      query({ scopeType: "Store", scopeReference: id(4) }),
      adapter,
    );
    expect(result.rows[0]?.available).toEqual({ value: "10.5000", unitCode: "KG" });
    expect(adapter.authorization.authorize).toHaveBeenCalledBefore(
      adapter.projection.query as never,
    );
  });

  it("allows identity-only listing without inventing Brand-wide quantities", async () => {
    const result = await queryStockOverview(query(null, false), ports(view(false)));
    expect(result).toMatchObject({ quantityVisibility: "IdentityOnly", stockScope: null });
    expect(result.rows[0]?.onHand).toBeNull();
    expect(result.rows[0]?.reorderStatus).toBe("Hidden");
  });

  it("rejects a projection that leaks scoped quantities into identity-only results", async () => {
    await expect(queryStockOverview(query(null, false), ports(view()))).rejects.toMatchObject({
      code: "INV_STOCK_PROJECTION_INVALID",
    });
  });
});
