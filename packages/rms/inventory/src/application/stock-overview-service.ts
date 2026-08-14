import {
  InventoryStockOverviewError,
  type InventoryStockOverview,
  type StockScope,
} from "../contracts/stock-overview.js";
import {
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
} from "../domain/inventory-item.js";
import type { StockOverviewPorts } from "./ports/stock-overview-ports.js";

function fail(code: InventoryStockOverviewError["code"]): never {
  throw new InventoryStockOverviewError(code);
}

function exact(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return fail("INV_STOCK_QUERY_INVALID");
  return value as Record<string, unknown>;
}

function scope(value: unknown): StockScope | null {
  if (value === null) return null;
  const raw = exact(value, ["scopeType", "scopeReference"]);
  if (!["Store", "StockSite", "Location"].includes(String(raw.scopeType)))
    return fail("INV_STOCK_QUERY_INVALID");
  return Object.freeze({
    scopeType: raw.scopeType as StockScope["scopeType"],
    scopeReference: parseInventoryReference(raw.scopeReference),
  });
}

function validate(view: InventoryStockOverview, expectedScope: StockScope | null): void {
  try {
    if (
      view.projectionName !== "inventory_stock_overview_v1" ||
      view.projectionVersion !== 1 ||
      view.quantityVisibility !== (expectedScope === null ? "IdentityOnly" : "Scoped") ||
      (expectedScope === null) !== (view.stockScope === null) ||
      !["Current", "Stale", "Rebuilding"].includes(view.freshness) ||
      !Array.isArray(view.rows) ||
      view.rows.length > 200
    )
      return fail("INV_STOCK_PROJECTION_INVALID");
    parseInventoryInstant(view.projectedAt);
    if (
      expectedScope &&
      (view.stockScope?.scopeType !== expectedScope.scopeType ||
        view.stockScope.scopeReference !== expectedScope.scopeReference)
    )
      return fail("INV_STOCK_PROJECTION_INVALID");
    for (const row of view.rows) {
      parseInventoryReference(row.itemReference);
      const quantities = [row.onHand, row.reserved, row.available, row.inTransit];
      if (expectedScope === null) {
        if (quantities.some((quantity) => quantity !== null) || row.reorderStatus !== "Hidden")
          return fail("INV_STOCK_PROJECTION_INVALID");
      } else {
        if (quantities.some((quantity) => quantity === null))
          return fail("INV_STOCK_PROJECTION_INVALID");
        for (const quantity of quantities) {
          parseInventoryDecimal(quantity?.value);
          if (quantity?.unitCode !== row.baseUnitCode) return fail("INV_STOCK_PROJECTION_INVALID");
        }
      }
    }
  } catch (error) {
    if (error instanceof InventoryStockOverviewError) throw error;
    return fail("INV_STOCK_PROJECTION_INVALID");
  }
}

export async function queryStockOverview(value: unknown, ports: StockOverviewPorts) {
  const raw = exact(value, [
    "tenantReference",
    "brandReference",
    "actorReference",
    "purpose",
    "permission",
    "stockScope",
    "includeQuantities",
    "search",
    "quantityFilter",
    "sort",
  ]);
  if (
    raw.purpose !== "InventoryStockRead" ||
    raw.permission !== "inventory.manage" ||
    typeof raw.includeQuantities !== "boolean" ||
    (raw.search !== null &&
      (typeof raw.search !== "string" ||
        raw.search.trim() !== raw.search ||
        raw.search.length > 100)) ||
    ![null, "BelowReorder", "OutOfStock", "HasOnHand"].includes(raw.quantityFilter as never) ||
    !["Name", "UpdatedAt", "Available", "OnHand", "ReorderStatus"].includes(String(raw.sort))
  )
    return fail("INV_STOCK_QUERY_INVALID");
  const stockScope = scope(raw.stockScope);
  const needsScope =
    raw.includeQuantities ||
    raw.quantityFilter !== null ||
    ["Available", "OnHand", "ReorderStatus"].includes(String(raw.sort));
  if (needsScope && stockScope === null) return fail("INV_STOCK_SCOPE_REQUIRED");
  const input = {
    tenantReference: parseInventoryReference(raw.tenantReference),
    brandReference: parseInventoryReference(raw.brandReference),
    actorReference: parseInventoryReference(raw.actorReference),
    stockScope,
    includeQuantities: raw.includeQuantities,
    search: raw.search as string | null,
    quantityFilter: raw.quantityFilter as "BelowReorder" | "OutOfStock" | "HasOnHand" | null,
    sort: raw.sort as "Name" | "UpdatedAt" | "Available" | "OnHand" | "ReorderStatus",
  };
  let authorization;
  try {
    authorization = await ports.authorization.authorize({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      actorReference: input.actorReference,
      purpose: "InventoryStockRead",
      permission: "inventory.manage",
      stockScope,
      includeQuantities: input.includeQuantities,
    });
  } catch {
    return fail("INV_STOCK_DEPENDENCY_UNAVAILABLE");
  }
  if (!authorization?.authorized) return fail("INV_STOCK_PERMISSION_DENIED");
  try {
    const view = await ports.projection.query({
      tenantReference: input.tenantReference,
      brandReference: input.brandReference,
      stockScope,
      includeQuantities: input.includeQuantities,
      search: input.search,
      quantityFilter: input.quantityFilter,
      sort: input.sort,
    });
    if (
      view.tenantReference !== input.tenantReference ||
      view.brandReference !== input.brandReference
    )
      return fail("INV_STOCK_PROJECTION_INVALID");
    validate(view, stockScope);
    return view;
  } catch (error) {
    if (error instanceof InventoryStockOverviewError) throw error;
    return fail("INV_STOCK_DEPENDENCY_UNAVAILABLE");
  }
}
