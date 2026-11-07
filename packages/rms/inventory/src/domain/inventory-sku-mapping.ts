import {
  InventoryItemError,
  parseInventoryReference,
  parseInventoryInstant,
  type InventoryItemType,
  type InventoryLifecycle,
} from "./inventory-item.js";
export interface InventorySkuMappingTarget {
  readonly productReference: string;
  readonly productVersionReference: string;
  readonly skuReference: string;
  readonly catalogConfigurationDigest: string;
}
export interface InventorySkuMappingCommand {
  readonly purpose: "InventorySkuMappingManagement";
  readonly permission: "inventory.item.update";
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly occurredAt: string;
  readonly mappingReference: string;
  readonly itemReference: string;
  readonly expectedMappingVersion: number;
  readonly expectedItemVersion: number;
  readonly configurationOperationReference: string;
  readonly action: "Set" | "Clear";
  readonly target: InventorySkuMappingTarget | null;
  readonly reasonCode: string;
}
export interface InventorySkuMappingVersion {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly mappingReference: string;
  readonly itemReference: string;
  readonly mappingVersion: number;
  readonly sourceItemVersion: number;
  readonly sourceConfigurationOperationReference: string;
  readonly action: "Set" | "Clear";
  readonly target: InventorySkuMappingTarget | null;
  readonly operationReference: string;
  readonly mappingIntentDigest: string;
  readonly actorReference: string;
  readonly occurredAt: string;
  readonly reasonCode: string;
}
export interface InventorySkuMappingCurrentItem {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly itemReference: string;
  readonly itemType: InventoryItemType;
  readonly lifecycle: InventoryLifecycle;
  readonly itemVersion: number;
  readonly configurationOperationReference: string;
  readonly recordedAt: string;
  readonly coverage: "CurrentConfiguration";
  readonly observedAt: string;
}
export interface InventorySkuMappingHeldSku {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly operationReference: string;
  readonly mappingIntentDigest: string;
  readonly productReference: string;
  readonly productVersionReference: string;
  readonly skuReference: string;
  readonly catalogConfigurationDigest: string;
  readonly coverage: "HeldCurrentSku";
  readonly observedAt: string;
}
const error = (code: InventoryItemError["code"] = "INVENTORY_ITEM_INVALID"): never => {
  throw new InventoryItemError(code);
};
export function inventorySkuMappingObject(
  v: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !v ||
    typeof v !== "object" ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== keys.length
  )
    return error();
  const r: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(v, key);
    if (!d?.enumerable || !("value" in d)) return error();
    r[key] = d.value;
  }
  return r;
}
function integer(v: unknown, min: number, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min || v > max) return error();
  return v;
}
export function inventorySkuMappingDigest(v: unknown): string {
  if (typeof v !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v)) return error();
  return v;
}
function reason(v: unknown): string {
  if (typeof v !== "string" || !/^[A-Z][A-Z0-9_]{0,63}$/.test(v)) return error();
  return v;
}
function target(v: unknown): InventorySkuMappingTarget {
  const t = inventorySkuMappingObject(v, [
    "productReference",
    "productVersionReference",
    "skuReference",
    "catalogConfigurationDigest",
  ]);
  return Object.freeze({
    productReference: parseInventoryReference(t.productReference),
    productVersionReference: parseInventoryReference(t.productVersionReference),
    skuReference: parseInventoryReference(t.skuReference),
    catalogConfigurationDigest: inventorySkuMappingDigest(t.catalogConfigurationDigest),
  });
}
export function parseInventorySkuMappingCommand(value: unknown): InventorySkuMappingCommand {
  try {
    const r = inventorySkuMappingObject(value, [
      "purpose",
      "permission",
      "tenantReference",
      "brandReference",
      "actorReference",
      "operationReference",
      "occurredAt",
      "mappingReference",
      "itemReference",
      "expectedMappingVersion",
      "expectedItemVersion",
      "configurationOperationReference",
      "action",
      "target",
      "reasonCode",
    ]);
    if (
      r.purpose !== "InventorySkuMappingManagement" ||
      r.permission !== "inventory.item.update" ||
      (r.action !== "Set" && r.action !== "Clear") ||
      (r.action === "Clear") !== (r.target === null)
    )
      return error();
    return Object.freeze({
      purpose: r.purpose,
      permission: r.permission,
      tenantReference: parseInventoryReference(r.tenantReference),
      brandReference: parseInventoryReference(r.brandReference),
      actorReference: parseInventoryReference(r.actorReference),
      operationReference: parseInventoryReference(r.operationReference),
      occurredAt: parseInventoryInstant(r.occurredAt),
      mappingReference: parseInventoryReference(r.mappingReference),
      itemReference: parseInventoryReference(r.itemReference),
      expectedMappingVersion: integer(r.expectedMappingVersion, 0, 2147483647),
      expectedItemVersion: integer(r.expectedItemVersion, 1),
      configurationOperationReference: parseInventoryReference(r.configurationOperationReference),
      action: r.action,
      target: r.target === null ? null : target(r.target),
      reasonCode: reason(r.reasonCode),
    });
  } catch {
    return error();
  }
}
export function parseInventorySkuMappingVersion(value: unknown): InventorySkuMappingVersion {
  try {
    const r = inventorySkuMappingObject(value, [
      "tenantReference",
      "brandReference",
      "mappingReference",
      "itemReference",
      "mappingVersion",
      "sourceItemVersion",
      "sourceConfigurationOperationReference",
      "action",
      "target",
      "operationReference",
      "mappingIntentDigest",
      "actorReference",
      "occurredAt",
      "reasonCode",
    ]);
    if (
      (r.action !== "Set" && r.action !== "Clear") ||
      (r.action === "Clear") !== (r.target === null)
    )
      return error();
    return Object.freeze({
      tenantReference: parseInventoryReference(r.tenantReference),
      brandReference: parseInventoryReference(r.brandReference),
      mappingReference: parseInventoryReference(r.mappingReference),
      itemReference: parseInventoryReference(r.itemReference),
      mappingVersion: integer(r.mappingVersion, 1, 2147483647),
      sourceItemVersion: integer(r.sourceItemVersion, 1),
      sourceConfigurationOperationReference: parseInventoryReference(
        r.sourceConfigurationOperationReference,
      ),
      action: r.action,
      target: r.target === null ? null : target(r.target),
      operationReference: parseInventoryReference(r.operationReference),
      mappingIntentDigest: inventorySkuMappingDigest(r.mappingIntentDigest),
      actorReference: parseInventoryReference(r.actorReference),
      occurredAt: parseInventoryInstant(r.occurredAt),
      reasonCode: reason(r.reasonCode),
    });
  } catch {
    return error();
  }
}
export function parseInventorySkuMappingCurrentItem(
  value: unknown,
): InventorySkuMappingCurrentItem {
  try {
    const r = inventorySkuMappingObject(value, [
      "tenantReference",
      "brandReference",
      "itemReference",
      "itemType",
      "lifecycle",
      "itemVersion",
      "configurationOperationReference",
      "recordedAt",
      "coverage",
      "observedAt",
    ]);
    if (
      r.coverage !== "CurrentConfiguration" ||
      typeof r.itemType !== "string" ||
      !["RawMaterial", "Packaging", "SemiFinished", "FinishedGood", "NonFoodSupply"].includes(
        r.itemType,
      ) ||
      typeof r.lifecycle !== "string" ||
      !["Active", "Inactive", "Archived"].includes(r.lifecycle)
    )
      return error();
    return Object.freeze({
      tenantReference: parseInventoryReference(r.tenantReference),
      brandReference: parseInventoryReference(r.brandReference),
      itemReference: parseInventoryReference(r.itemReference),
      itemType: r.itemType as InventoryItemType,
      lifecycle: r.lifecycle as InventoryLifecycle,
      itemVersion: integer(r.itemVersion, 1),
      configurationOperationReference: parseInventoryReference(r.configurationOperationReference),
      recordedAt: parseInventoryInstant(r.recordedAt),
      coverage: r.coverage,
      observedAt: parseInventoryInstant(r.observedAt),
    });
  } catch {
    return error();
  }
}
export function parseInventorySkuMappingHeldSku(value: unknown): InventorySkuMappingHeldSku {
  try {
    const r = inventorySkuMappingObject(value, [
      "tenantReference",
      "brandReference",
      "actorReference",
      "operationReference",
      "mappingIntentDigest",
      "productReference",
      "productVersionReference",
      "skuReference",
      "catalogConfigurationDigest",
      "coverage",
      "observedAt",
    ]);
    if (r.coverage !== "HeldCurrentSku") return error();
    return Object.freeze({
      tenantReference: parseInventoryReference(r.tenantReference),
      brandReference: parseInventoryReference(r.brandReference),
      actorReference: parseInventoryReference(r.actorReference),
      operationReference: parseInventoryReference(r.operationReference),
      mappingIntentDigest: inventorySkuMappingDigest(r.mappingIntentDigest),
      productReference: parseInventoryReference(r.productReference),
      productVersionReference: parseInventoryReference(r.productVersionReference),
      skuReference: parseInventoryReference(r.skuReference),
      catalogConfigurationDigest: inventorySkuMappingDigest(r.catalogConfigurationDigest),
      coverage: r.coverage,
      observedAt: parseInventoryInstant(r.observedAt),
    });
  } catch {
    return error();
  }
}
/** Pure owning child configuration plan. Infrastructure must supply actual current
 * Item and held public SKU facts in one RC UoW, plus audit/idempotency/exclusive fencing. */
export function planInventorySkuMappingVersion(
  input: InventorySkuMappingCommand,
  beforeValue: InventorySkuMappingVersion | null,
  itemValue: InventorySkuMappingCurrentItem,
  skuValue: InventorySkuMappingHeldSku | null,
  intentValue: string,
  nowValue: string,
): InventorySkuMappingVersion {
  const command = parseInventorySkuMappingCommand(input),
    before = beforeValue === null ? null : parseInventorySkuMappingVersion(beforeValue),
    item = parseInventorySkuMappingCurrentItem(itemValue),
    intent = inventorySkuMappingDigest(intentValue),
    now = parseInventoryInstant(nowValue);
  const unavailable = () => error("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE"),
    conflict = () => error("INVENTORY_ITEM_CONFLICT");
  const fresh = (time: string) => {
    if (time > now || Date.parse(now) - Date.parse(time) > 5000) return unavailable();
  };
  fresh(item.observedAt);
  fresh(command.occurredAt);
  if (
    item.tenantReference !== command.tenantReference ||
    item.brandReference !== command.brandReference ||
    item.itemReference !== command.itemReference ||
    item.recordedAt > item.observedAt
  )
    return unavailable();
  if (item.itemType !== "FinishedGood" || item.lifecycle === "Archived") return error();
  if (
    item.itemVersion !== command.expectedItemVersion ||
    item.configurationOperationReference !== command.configurationOperationReference
  )
    return conflict();
  if (command.occurredAt < item.recordedAt) return conflict();
  if (
    before &&
    (before.tenantReference !== command.tenantReference ||
      before.brandReference !== command.brandReference ||
      before.itemReference !== command.itemReference ||
      before.mappingReference !== command.mappingReference)
  )
    return conflict();
  if (
    before &&
    (before.sourceItemVersion > item.itemVersion ||
      (before.sourceItemVersion === item.itemVersion &&
        before.sourceConfigurationOperationReference !== item.configurationOperationReference))
  )
    return conflict();
  if (before?.operationReference === command.operationReference)
    return error("INVENTORY_ITEM_IDEMPOTENCY_CONFLICT");
  if (
    (before?.mappingVersion ?? 0) !== command.expectedMappingVersion ||
    command.expectedMappingVersion === 2147483647 ||
    (before && command.occurredAt < before.occurredAt)
  )
    return conflict();
  if (command.action === "Set") {
    if (skuValue === null || command.target === null) return unavailable();
    const sku = parseInventorySkuMappingHeldSku(skuValue);
    fresh(sku.observedAt);
    if (
      sku.tenantReference !== command.tenantReference ||
      sku.brandReference !== command.brandReference ||
      sku.actorReference !== command.actorReference ||
      sku.operationReference !== command.operationReference ||
      sku.mappingIntentDigest !== intent ||
      sku.productReference !== command.target.productReference ||
      sku.productVersionReference !== command.target.productVersionReference ||
      sku.skuReference !== command.target.skuReference ||
      sku.catalogConfigurationDigest !== command.target.catalogConfigurationDigest
    )
      return unavailable();
  } else if (skuValue !== null) return unavailable();
  return Object.freeze({
    tenantReference: command.tenantReference,
    brandReference: command.brandReference,
    mappingReference: command.mappingReference,
    itemReference: command.itemReference,
    mappingVersion: command.expectedMappingVersion + 1,
    sourceItemVersion: item.itemVersion,
    sourceConfigurationOperationReference: item.configurationOperationReference,
    action: command.action,
    target: command.target,
    operationReference: command.operationReference,
    mappingIntentDigest: intent,
    actorReference: command.actorReference,
    occurredAt: command.occurredAt,
    reasonCode: command.reasonCode,
  });
}
