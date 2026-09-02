export type InventoryClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class InventoryClientError extends Error {
  constructor(readonly code: InventoryClientErrorCode) {
    super("Inventory view is unavailable");
    this.name = "InventoryClientError";
  }
}

export type InventoryScreenId =
  "INV-STOCK-OVERVIEW" | "INV-ITEM-LIST" | "INV-ITEM-DETAIL" | "INV-ITEM-CREATE" | "INV-ITEM-EDIT";
export interface InventoryItemView {
  readonly itemReference: string;
  readonly localizedName: string;
  readonly internalCode: string;
  readonly itemType:
    "RawMaterial" | "Packaging" | "SemiFinished" | "FinishedGood" | "NonFoodSupply";
  readonly lifecycle: "Active" | "Inactive" | "Archived";
  readonly baseUnitCode: string;
  readonly trackingMode: "Disabled" | "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
  readonly negativeStockPolicy: "Block" | "ManagerOverride" | "AllowWithWarning";
  readonly quantities: {
    readonly onHand: string;
    readonly reserved: string;
    readonly available: string;
    readonly inTransit: string;
    readonly unitCode: string;
  } | null;
  readonly reorderStatus: "Hidden" | "Healthy" | "BelowReorder" | "MissingPolicy";
  readonly preferredSupplierSummary: string;
  readonly recipeUsageCount: number | null;
  readonly skuMappingCount: number | null;
  readonly updatedAt: string;
}
export interface InventoryView {
  readonly screenId: InventoryScreenId;
  readonly projectionName:
    "inventory_item_search_v1" | "inventory_item_detail_v1" | "inventory_stock_overview_v1";
  readonly projectionVersion: 1;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  } | null;
  readonly selectedItemReference: string | null;
  readonly items: readonly InventoryItemView[];
}
export interface InventoryProjectionClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimal = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const code = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
function object(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new InventoryClientError("Unavailable");
  return value as Record<string, unknown>;
}
function reference(value: unknown) {
  if (typeof value !== "string" || !uuid.test(value)) throw new InventoryClientError("Unavailable");
  return value;
}
function text(value: unknown) {
  if (typeof value !== "string" || !safe.test(value) || value.trim() !== value)
    throw new InventoryClientError("Unavailable");
  return value;
}
function controlled(value: unknown) {
  if (typeof value !== "string" || !code.test(value)) throw new InventoryClientError("Unavailable");
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryClientError("Unavailable");
  return value as T;
}
function count(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InventoryClientError("Unavailable");
  return value as number;
}
function item(value: unknown): InventoryItemView {
  const raw = object(value, [
    "itemReference",
    "localizedName",
    "internalCode",
    "itemType",
    "lifecycle",
    "baseUnitCode",
    "trackingMode",
    "negativeStockPolicy",
    "quantities",
    "reorderStatus",
    "preferredSupplierSummary",
    "recipeUsageCount",
    "skuMappingCount",
    "updatedAt",
  ]);
  let quantities: InventoryItemView["quantities"] = null;
  if (raw.quantities !== null) {
    const q = object(raw.quantities, ["onHand", "reserved", "available", "inTransit", "unitCode"]);
    for (const field of ["onHand", "reserved", "available", "inTransit"])
      if (typeof q[field] !== "string" || !decimal.test(q[field]))
        throw new InventoryClientError("Unavailable");
    quantities = Object.freeze({
      onHand: q.onHand as string,
      reserved: q.reserved as string,
      available: q.available as string,
      inTransit: q.inTransit as string,
      unitCode: controlled(q.unitCode),
    });
  }
  if (
    typeof raw.updatedAt !== "string" ||
    !instant.test(raw.updatedAt) ||
    new Date(Date.parse(raw.updatedAt)).toISOString() !== raw.updatedAt
  )
    throw new InventoryClientError("Unavailable");
  return Object.freeze({
    itemReference: reference(raw.itemReference),
    localizedName: text(raw.localizedName),
    internalCode: controlled(raw.internalCode),
    itemType: oneOf(raw.itemType, [
      "RawMaterial",
      "Packaging",
      "SemiFinished",
      "FinishedGood",
      "NonFoodSupply",
    ]),
    lifecycle: oneOf(raw.lifecycle, ["Active", "Inactive", "Archived"]),
    baseUnitCode: controlled(raw.baseUnitCode),
    trackingMode: oneOf(raw.trackingMode, [
      "Disabled",
      "NoLot",
      "LotOptional",
      "LotRequired",
      "LotExpiryRequired",
    ]),
    negativeStockPolicy: oneOf(raw.negativeStockPolicy, [
      "Block",
      "ManagerOverride",
      "AllowWithWarning",
    ]),
    quantities,
    reorderStatus: oneOf(raw.reorderStatus, ["Hidden", "Healthy", "BelowReorder", "MissingPolicy"]),
    preferredSupplierSummary: text(raw.preferredSupplierSummary),
    recipeUsageCount: raw.recipeUsageCount === null ? null : count(raw.recipeUsageCount),
    skuMappingCount: raw.skuMappingCount === null ? null : count(raw.skuMappingCount),
    updatedAt: raw.updatedAt,
  });
}
export function parseInventoryView(value: unknown): InventoryView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "asOfUtc",
    "freshness",
    "partial",
    "stockScope",
    "selectedItemReference",
    "items",
  ]);
  const screenId = oneOf(raw.screenId, [
    "INV-STOCK-OVERVIEW",
    "INV-ITEM-LIST",
    "INV-ITEM-DETAIL",
    "INV-ITEM-CREATE",
    "INV-ITEM-EDIT",
  ]);
  const projectionName = oneOf(raw.projectionName, [
    "inventory_item_search_v1",
    "inventory_item_detail_v1",
    "inventory_stock_overview_v1",
  ]);
  if (
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    typeof raw.asOfUtc !== "string" ||
    !instant.test(raw.asOfUtc) ||
    !Array.isArray(raw.items) ||
    raw.items.length > 200
  )
    throw new InventoryClientError("Unavailable");
  const items = Object.freeze(raw.items.map(item));
  let stockScope: InventoryView["stockScope"] = null;
  if (raw.stockScope !== null) {
    const scope = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
    stockScope = Object.freeze({
      scopeType: oneOf(scope.scopeType, ["Store", "StockSite", "Location"]),
      scopeReference: reference(scope.scopeReference),
      scopeLabel: text(scope.scopeLabel),
    });
  }
  if (
    (screenId === "INV-STOCK-OVERVIEW" && stockScope === null) ||
    (stockScope === null &&
      items.some((entry) => entry.quantities !== null || entry.reorderStatus !== "Hidden")) ||
    (stockScope !== null && items.some((entry) => entry.quantities === null))
  )
    throw new InventoryClientError("Unavailable");
  const selectedItemReference =
    raw.selectedItemReference === null ? null : reference(raw.selectedItemReference);
  if (
    ["INV-ITEM-DETAIL", "INV-ITEM-EDIT"].includes(screenId) &&
    (!selectedItemReference ||
      !items.some((entry) => entry.itemReference === selectedItemReference))
  )
    throw new InventoryClientError("Unavailable");
  return Object.freeze({
    screenId,
    projectionName,
    projectionVersion: 1,
    asOfUtc: raw.asOfUtc,
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    stockScope,
    selectedItemReference,
    items,
  });
}
export const unavailableInventoryClient: InventoryProjectionClient = Object.freeze({
  async load() {
    throw new InventoryClientError("Unavailable");
  },
});
