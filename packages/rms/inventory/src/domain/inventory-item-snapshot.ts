import {
  createInventoryItem,
  compareInventoryDecimals,
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryInstant,
  parseInventoryReference,
  type InventoryItemAggregate,
  type InventoryReorderPolicy,
  type InventoryUnitConversion,
} from "./inventory-item.js";

function invalid(): never {
  throw new InventoryItemError("INVENTORY_ITEM_INVALID");
}

function object(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return invalid();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    result[field] = descriptor.value;
  }
  return result;
}

function integer(value: unknown, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return invalid();
  return value as number;
}

function flag(value: unknown): boolean {
  if (typeof value !== "boolean") return invalid();
  return value;
}

function choice<T extends string>(value: unknown, options: readonly T[]): T {
  if (typeof value !== "string" || !options.includes(value as T)) return invalid();
  return value as T;
}

function code(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Z0-9][A-Z0-9_-]{0,63}$/u.test(value)) return invalid();
  return value;
}

function array<T>(value: unknown, parse: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) return invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) return invalid();
  const output: T[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor || !descriptor.enumerable || !("value" in descriptor)) return invalid();
    output.push(parse(descriptor.value));
  }
  return Object.freeze(output);
}

function conversion(value: unknown): InventoryUnitConversion {
  const raw = object(value, [
    "conversionReference",
    "fromUnitCode",
    "toBaseUnitCode",
    "multiplier",
    "effectiveFrom",
    "reasonCode",
    "status",
  ]);
  const multiplier = parseInventoryDecimal(raw.multiplier);
  if (compareInventoryDecimals(multiplier, parseInventoryDecimal("0")) <= 0) return invalid();
  return Object.freeze({
    conversionReference: parseInventoryReference(raw.conversionReference),
    fromUnitCode: code(raw.fromUnitCode),
    toBaseUnitCode: code(raw.toBaseUnitCode),
    multiplier,
    effectiveFrom: parseInventoryInstant(raw.effectiveFrom),
    reasonCode: code(raw.reasonCode),
    status: choice(raw.status, ["Active", "Retired"]),
  });
}

function positiveHint(value: unknown) {
  if (value === null) return null;
  const quantity = parseInventoryDecimal(value);
  if (compareInventoryDecimals(quantity, parseInventoryDecimal("0")) <= 0) return invalid();
  return quantity;
}

function reorder(value: unknown): InventoryReorderPolicy {
  const raw = object(value, [
    "policyReference",
    "scopeType",
    "scopeReference",
    "reorderPoint",
    "safetyStock",
    "targetStockLevel",
    "minimumOrderQuantityHint",
    "orderMultipleHint",
    "leadTimeDaysHint",
    "preferredSupplierMappingReference",
    "enabled",
    "effectiveFrom",
    "effectiveUntil",
    "overrideSource",
  ]);
  const reorderPoint = parseInventoryDecimal(raw.reorderPoint);
  const targetStockLevel = parseInventoryDecimal(raw.targetStockLevel);
  const effectiveFrom = parseInventoryInstant(raw.effectiveFrom);
  const effectiveUntil =
    raw.effectiveUntil === null ? null : parseInventoryInstant(raw.effectiveUntil);
  if (
    compareInventoryDecimals(targetStockLevel, reorderPoint) < 0 ||
    (effectiveUntil !== null && effectiveUntil <= effectiveFrom)
  )
    return invalid();
  return Object.freeze({
    policyReference: parseInventoryReference(raw.policyReference),
    scopeType: choice(raw.scopeType, ["Store", "StockSite", "Location"]),
    scopeReference: parseInventoryReference(raw.scopeReference),
    reorderPoint,
    safetyStock: parseInventoryDecimal(raw.safetyStock),
    targetStockLevel,
    minimumOrderQuantityHint: positiveHint(raw.minimumOrderQuantityHint),
    orderMultipleHint: positiveHint(raw.orderMultipleHint),
    leadTimeDaysHint: raw.leadTimeDaysHint === null ? null : integer(raw.leadTimeDaysHint, 0),
    preferredSupplierMappingReference:
      raw.preferredSupplierMappingReference === null
        ? null
        : parseInventoryReference(raw.preferredSupplierMappingReference),
    enabled: flag(raw.enabled),
    effectiveFrom,
    effectiveUntil,
    overrideSource: choice(raw.overrideSource, ["Brand", "Store", "Site", "Location"]),
  });
}

/** Decode owner persistence JSON; callers must separately enforce scope and column bindings. */
export function parseInventoryItemSnapshot(value: unknown): InventoryItemAggregate {
  const raw = object(value, [
    "itemReference",
    "tenantReference",
    "brandReference",
    "internalCode",
    "itemType",
    "localizedNames",
    "baseUnit",
    "trackingPolicy",
    "lifecycle",
    "hasMovementHistory",
    "unitConversions",
    "reorderPolicies",
    "aggregateVersion",
    "createdAt",
    "createdBy",
    "updatedAt",
    "updatedBy",
  ]);
  const unit = object(raw.baseUnit, [
    "unitCode",
    "dimension",
    "displayPrecision",
    "ledgerPrecision",
    "roundingMode",
  ]);
  const tracking = object(raw.trackingPolicy, [
    "stockTrackingEnabled",
    "lotTrackingMode",
    "defaultShelfLifeDays",
    "expiryWarningDays",
    "issuePolicy",
    "negativeStockPolicy",
  ]);
  if (
    raw.localizedNames === null ||
    typeof raw.localizedNames !== "object" ||
    Array.isArray(raw.localizedNames)
  )
    return invalid();
  const nameKeys = Reflect.ownKeys(raw.localizedNames);
  if (nameKeys.some((key) => typeof key !== "string")) return invalid();
  const names = object(raw.localizedNames, nameKeys as string[]);
  const initial = createInventoryItem({
    itemReference: raw.itemReference,
    tenantReference: raw.tenantReference,
    brandReference: raw.brandReference,
    internalCode: raw.internalCode,
    itemType: raw.itemType,
    baseUnit: unit,
    trackingPolicy: tracking,
    localizedNames: names,
    occurredAt: raw.createdAt,
    actorReference: raw.createdBy,
  });
  const aggregateVersion = integer(raw.aggregateVersion, 1);
  const updatedAt = parseInventoryInstant(raw.updatedAt);
  const updatedBy = parseInventoryReference(raw.updatedBy);
  const lifecycle = choice(raw.lifecycle, ["Active", "Inactive", "Archived"]);
  const hasMovementHistory = flag(raw.hasMovementHistory);
  const unitConversions = array(raw.unitConversions, conversion);
  const reorderPolicies = array(raw.reorderPolicies, reorder);
  if (
    updatedAt < initial.createdAt ||
    new Set(unitConversions.map((entry) => entry.conversionReference)).size !==
      unitConversions.length ||
    unitConversions.some((entry) => entry.toBaseUnitCode !== initial.baseUnit.unitCode) ||
    new Set(reorderPolicies.map((entry) => entry.policyReference)).size !==
      reorderPolicies.length ||
    new Set(reorderPolicies.map((entry) => entry.scopeType + ":" + entry.scopeReference)).size !==
      reorderPolicies.length ||
    (aggregateVersion === 1 &&
      (updatedAt !== initial.createdAt ||
        updatedBy !== initial.createdBy ||
        lifecycle !== "Inactive" ||
        hasMovementHistory ||
        unitConversions.length > 0 ||
        reorderPolicies.length > 0))
  )
    return invalid();
  return Object.freeze({
    ...initial,
    aggregateVersion,
    updatedAt,
    updatedBy,
    lifecycle,
    hasMovementHistory,
    unitConversions,
    reorderPolicies,
  });
}
