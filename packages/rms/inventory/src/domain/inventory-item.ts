export type InventoryReference = string & { readonly __inventoryReference: unique symbol };
export type InventoryInstant = string & { readonly __inventoryInstant: unique symbol };
export type InventoryDecimal = string & { readonly __inventoryDecimal: unique symbol };
export type InventoryItemType =
  "RawMaterial" | "Packaging" | "SemiFinished" | "FinishedGood" | "NonFoodSupply";
export type InventoryLifecycle = "Active" | "Inactive" | "Archived";
export type MeasurementDimension = "Count" | "Mass" | "Volume" | "Length" | "Area" | "Other";
export type LotTrackingMode = "NoLot" | "LotOptional" | "LotRequired" | "LotExpiryRequired";
export type NegativeStockPolicy = "Block" | "ManagerOverride" | "AllowWithWarning";

export interface InventoryUnit {
  readonly unitCode: string;
  readonly dimension: MeasurementDimension;
  readonly displayPrecision: number;
  readonly ledgerPrecision: number;
  readonly roundingMode: "HalfEven" | "HalfUp" | "Down";
}

export interface InventoryTrackingPolicy {
  readonly stockTrackingEnabled: boolean;
  readonly lotTrackingMode: LotTrackingMode;
  readonly defaultShelfLifeDays: number | null;
  readonly expiryWarningDays: number | null;
  readonly issuePolicy: "FIFO" | "FEFO" | "PolicyDefined";
  readonly negativeStockPolicy: NegativeStockPolicy;
}

export interface InventoryUnitConversion {
  readonly conversionReference: InventoryReference;
  readonly fromUnitCode: string;
  readonly toBaseUnitCode: string;
  readonly multiplier: InventoryDecimal;
  readonly effectiveFrom: InventoryInstant;
  readonly reasonCode: string;
  readonly status: "Active" | "Retired";
}

export interface InventoryReorderPolicy {
  readonly policyReference: InventoryReference;
  readonly scopeType: "Store" | "StockSite" | "Location";
  readonly scopeReference: InventoryReference;
  readonly reorderPoint: InventoryDecimal;
  readonly safetyStock: InventoryDecimal;
  readonly targetStockLevel: InventoryDecimal;
  readonly minimumOrderQuantityHint: InventoryDecimal | null;
  readonly orderMultipleHint: InventoryDecimal | null;
  readonly leadTimeDaysHint: number | null;
  readonly preferredSupplierMappingReference: InventoryReference | null;
  readonly enabled: boolean;
  readonly effectiveFrom: InventoryInstant;
  readonly effectiveUntil: InventoryInstant | null;
  readonly overrideSource: "Brand" | "Store" | "Site" | "Location";
}

export interface InventoryItemAggregate {
  readonly itemReference: InventoryReference;
  readonly tenantReference: InventoryReference;
  readonly brandReference: InventoryReference;
  readonly internalCode: string;
  readonly itemType: InventoryItemType;
  readonly localizedNames: Readonly<Record<string, string>>;
  readonly baseUnit: InventoryUnit;
  readonly trackingPolicy: InventoryTrackingPolicy;
  readonly lifecycle: InventoryLifecycle;
  readonly hasMovementHistory: boolean;
  readonly unitConversions: readonly InventoryUnitConversion[];
  readonly reorderPolicies: readonly InventoryReorderPolicy[];
  readonly aggregateVersion: number;
  readonly createdAt: InventoryInstant;
  readonly createdBy: InventoryReference;
  readonly updatedAt: InventoryInstant;
  readonly updatedBy: InventoryReference;
}

export class InventoryItemError extends Error {
  constructor(
    readonly code:
      | "INVENTORY_ITEM_INVALID"
      | "INVENTORY_ITEM_PERMISSION_DENIED"
      | "INVENTORY_ITEM_NOT_FOUND"
      | "INVENTORY_ITEM_CONFLICT"
      | "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT"
      | "INVENTORY_ITEM_BASE_UNIT_LOCKED"
      | "INVENTORY_ITEM_POLICY_MIGRATION_REQUIRED"
      | "INVENTORY_ITEM_ARCHIVE_BLOCKED"
      | "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
  ) {
    super("Inventory Item operation failed");
    this.name = "InventoryItemError";
  }
}

const referencePattern = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;

function invalid(): never {
  throw new InventoryItemError("INVENTORY_ITEM_INVALID");
}

function exactObject(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    return invalid();
  return value as Record<string, unknown>;
}

export function parseInventoryReference(value: unknown): InventoryReference {
  if (typeof value !== "string" || !referencePattern.test(value)) return invalid();
  return value as InventoryReference;
}

export function parseInventoryInstant(value: unknown): InventoryInstant {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    return invalid();
  return value as InventoryInstant;
}

export function parseInventoryDecimal(value: unknown): InventoryDecimal {
  if (typeof value !== "string" || !decimalPattern.test(value)) return invalid();
  return value as InventoryDecimal;
}

export function compareInventoryDecimals(left: InventoryDecimal, right: InventoryDecimal): number {
  const scale = (value: string) => {
    const [whole, fraction = ""] = value.split(".");
    return BigInt(`${whole}${fraction.padEnd(6, "0")}`);
  };
  const a = scale(left);
  const b = scale(right);
  return a < b ? -1 : a > b ? 1 : 0;
}

function controlledCode(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value)) return invalid();
  return value;
}

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum)
    return invalid();
  return value as number;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T)) return invalid();
  return value as T;
}

export function parseInventoryUnit(value: unknown): InventoryUnit {
  const raw = exactObject(value, [
    "unitCode",
    "dimension",
    "displayPrecision",
    "ledgerPrecision",
    "roundingMode",
  ]);
  return Object.freeze({
    unitCode: controlledCode(raw.unitCode),
    dimension: oneOf(raw.dimension, ["Count", "Mass", "Volume", "Length", "Area", "Other"]),
    displayPrecision: integer(raw.displayPrecision, 0, 6),
    ledgerPrecision: integer(raw.ledgerPrecision, 0, 6),
    roundingMode: oneOf(raw.roundingMode, ["HalfEven", "HalfUp", "Down"]),
  });
}

export function parseTrackingPolicy(value: unknown): InventoryTrackingPolicy {
  const raw = exactObject(value, [
    "stockTrackingEnabled",
    "lotTrackingMode",
    "defaultShelfLifeDays",
    "expiryWarningDays",
    "issuePolicy",
    "negativeStockPolicy",
  ]);
  if (typeof raw.stockTrackingEnabled !== "boolean") return invalid();
  const lotTrackingMode = oneOf(raw.lotTrackingMode, [
    "NoLot",
    "LotOptional",
    "LotRequired",
    "LotExpiryRequired",
  ]);
  const defaultShelfLifeDays =
    raw.defaultShelfLifeDays === null ? null : integer(raw.defaultShelfLifeDays, 1, 36500);
  const expiryWarningDays =
    raw.expiryWarningDays === null ? null : integer(raw.expiryWarningDays, 0, 36500);
  const issuePolicy = oneOf(raw.issuePolicy, ["FIFO", "FEFO", "PolicyDefined"]);
  if (
    (lotTrackingMode === "LotExpiryRequired" &&
      (defaultShelfLifeDays === null || expiryWarningDays === null || issuePolicy !== "FEFO")) ||
    (!raw.stockTrackingEnabled && lotTrackingMode !== "NoLot")
  )
    return invalid();
  return Object.freeze({
    stockTrackingEnabled: raw.stockTrackingEnabled,
    lotTrackingMode,
    defaultShelfLifeDays,
    expiryWarningDays,
    issuePolicy,
    negativeStockPolicy: oneOf(raw.negativeStockPolicy, [
      "Block",
      "ManagerOverride",
      "AllowWithWarning",
    ]),
  });
}

export function parseLocalizedNames(value: unknown): Readonly<Record<string, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const entries = Object.entries(value);
  if (entries.length < 1 || entries.length > 20) return invalid();
  const output: Record<string, string> = {};
  for (const [locale, name] of entries) {
    if (
      !/^[a-z]{2}(?:-[A-Z]{2})?$/u.test(locale) ||
      typeof name !== "string" ||
      name.trim() !== name ||
      name.length < 1 ||
      name.length > 120 ||
      /[<>]/u.test(name)
    )
      return invalid();
    output[locale] = name.normalize("NFC");
  }
  return Object.freeze(output);
}

export function createInventoryItem(input: {
  readonly itemReference: unknown;
  readonly tenantReference: unknown;
  readonly brandReference: unknown;
  readonly internalCode: unknown;
  readonly itemType: unknown;
  readonly localizedNames: unknown;
  readonly baseUnit: unknown;
  readonly trackingPolicy: unknown;
  readonly occurredAt: unknown;
  readonly actorReference: unknown;
}): InventoryItemAggregate {
  const occurredAt = parseInventoryInstant(input.occurredAt);
  const actorReference = parseInventoryReference(input.actorReference);
  return Object.freeze({
    itemReference: parseInventoryReference(input.itemReference),
    tenantReference: parseInventoryReference(input.tenantReference),
    brandReference: parseInventoryReference(input.brandReference),
    internalCode: controlledCode(input.internalCode),
    itemType: oneOf(input.itemType, [
      "RawMaterial",
      "Packaging",
      "SemiFinished",
      "FinishedGood",
      "NonFoodSupply",
    ]),
    localizedNames: parseLocalizedNames(input.localizedNames),
    baseUnit: parseInventoryUnit(input.baseUnit),
    trackingPolicy: parseTrackingPolicy(input.trackingPolicy),
    lifecycle: "Inactive",
    hasMovementHistory: false,
    unitConversions: Object.freeze([]),
    reorderPolicies: Object.freeze([]),
    aggregateVersion: 1,
    createdAt: occurredAt,
    createdBy: actorReference,
    updatedAt: occurredAt,
    updatedBy: actorReference,
  });
}

export function updateInventoryItem(
  item: InventoryItemAggregate,
  input: {
    readonly expectedVersion: number;
    readonly localizedNames: unknown;
    readonly baseUnit: unknown;
    readonly trackingPolicy: unknown;
    readonly migrationPlanReference: unknown;
    readonly occurredAt: unknown;
    readonly actorReference: unknown;
  },
): InventoryItemAggregate {
  if (item.aggregateVersion !== input.expectedVersion)
    throw new InventoryItemError("INVENTORY_ITEM_CONFLICT");
  const baseUnit = parseInventoryUnit(input.baseUnit);
  const trackingPolicy = parseTrackingPolicy(input.trackingPolicy);
  if (item.hasMovementHistory && JSON.stringify(baseUnit) !== JSON.stringify(item.baseUnit))
    throw new InventoryItemError("INVENTORY_ITEM_BASE_UNIT_LOCKED");
  if (
    item.hasMovementHistory &&
    JSON.stringify(trackingPolicy) !== JSON.stringify(item.trackingPolicy) &&
    input.migrationPlanReference === null
  )
    throw new InventoryItemError("INVENTORY_ITEM_POLICY_MIGRATION_REQUIRED");
  if (input.migrationPlanReference !== null) parseInventoryReference(input.migrationPlanReference);
  return Object.freeze({
    ...item,
    localizedNames: parseLocalizedNames(input.localizedNames),
    baseUnit,
    trackingPolicy,
    aggregateVersion: item.aggregateVersion + 1,
    updatedAt: parseInventoryInstant(input.occurredAt),
    updatedBy: parseInventoryReference(input.actorReference),
  });
}

export function transitionInventoryItem(
  item: InventoryItemAggregate,
  target: InventoryLifecycle,
  input: {
    readonly expectedVersion: number;
    readonly hasOpenWork: boolean;
    readonly hasNonZeroStock: boolean;
    readonly occurredAt: unknown;
    readonly actorReference: unknown;
  },
): InventoryItemAggregate {
  if (item.aggregateVersion !== input.expectedVersion)
    throw new InventoryItemError("INVENTORY_ITEM_CONFLICT");
  const allowed =
    (item.lifecycle === "Inactive" && ["Active", "Archived"].includes(target)) ||
    (item.lifecycle === "Active" && target === "Inactive") ||
    (item.lifecycle === "Archived" && target === "Inactive");
  if (!allowed || (target === "Archived" && (input.hasOpenWork || input.hasNonZeroStock)))
    throw new InventoryItemError("INVENTORY_ITEM_ARCHIVE_BLOCKED");
  return Object.freeze({
    ...item,
    lifecycle: target,
    aggregateVersion: item.aggregateVersion + 1,
    updatedAt: parseInventoryInstant(input.occurredAt),
    updatedBy: parseInventoryReference(input.actorReference),
  });
}

export function setReorderPolicy(
  item: InventoryItemAggregate,
  policy: InventoryReorderPolicy,
  expectedVersion: number,
  occurredAt: unknown,
  actorReference: unknown,
): InventoryItemAggregate {
  if (item.aggregateVersion !== expectedVersion)
    throw new InventoryItemError("INVENTORY_ITEM_CONFLICT");
  if (compareInventoryDecimals(policy.targetStockLevel, policy.reorderPoint) < 0) return invalid();
  if (
    policy.effectiveUntil !== null &&
    Date.parse(policy.effectiveUntil) <= Date.parse(policy.effectiveFrom)
  )
    return invalid();
  const retained = item.reorderPolicies.filter(
    (current) =>
      current.scopeType !== policy.scopeType || current.scopeReference !== policy.scopeReference,
  );
  return Object.freeze({
    ...item,
    reorderPolicies: Object.freeze([...retained, Object.freeze(policy)]),
    aggregateVersion: item.aggregateVersion + 1,
    updatedAt: parseInventoryInstant(occurredAt),
    updatedBy: parseInventoryReference(actorReference),
  });
}
