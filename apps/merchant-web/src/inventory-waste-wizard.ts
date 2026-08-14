export type InventoryWasteClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class InventoryWasteClientError extends Error {
  constructor(readonly code: InventoryWasteClientErrorCode) {
    super("Inventory Waste Wizard is unavailable");
    this.name = "InventoryWasteClientError";
  }
}

export interface InventoryWasteView {
  readonly screenId: "INV-WASTE-WIZARD";
  readonly projectionName: "inventory_waste_wizard_v1";
  readonly projectionVersion: 1;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  };
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly waste: {
    readonly wasteReference: string | null;
    readonly itemReference: string;
    readonly itemName: string;
    readonly internalCode: string;
    readonly lotReference: string | null;
    readonly expiryDate: string | null;
    readonly locationReference: string;
    readonly locationLabel: string;
    readonly quantity: string | null;
    readonly unitCode: string;
    readonly baseQuantityDelta: string | null;
    readonly baseUnitCode: string;
    readonly conversionMultiplier: string;
    readonly reasonCode: string | null;
    readonly sourceType: "Inventory" | "Kitchen" | "FoodSafetyIncident";
    readonly sourceReference: string | null;
    readonly evidenceReferences: readonly string[] | null;
    readonly approvalRequirement: "Required" | "NotRequired" | null;
    readonly approvalPolicyReference: string | null;
    readonly costSummary: {
      readonly minorUnits: string;
      readonly currencyCode: string;
    } | null;
    readonly currentOnHand: string;
    readonly currentReserved: string;
    readonly currentAvailable: string;
    readonly currentInTransit: string;
    readonly projectedOnHand: string | null;
    readonly projectedAvailable: string | null;
    readonly balanceVersion: number;
    readonly negativeStockPolicy: "Block" | "ManagerOverride" | "AllowWithWarning";
    readonly warnings: readonly string[];
    readonly status:
      "Draft" | "Validated" | "Submitted" | "Approved" | "Rejected" | "Cancelled" | "Posted";
    readonly submittedByDisplay: string | null;
    readonly approvedByDisplay: string | null;
    readonly movementReference: string | null;
    readonly aggregateVersion: number | null;
  };
}

export interface InventoryWasteProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const date = /^\d{4}-\d{2}-\d{2}$/u;
const signed = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const positive = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const codePattern = /^[A-Z0-9][A-Z0-9_-]{0,63}$/u;
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
    throw new InventoryWasteClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryWasteClientError("Unavailable");
  return value;
}

function nullableReference(value: unknown) {
  return value === null ? null : reference(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new InventoryWasteClientError("Unavailable");
  return value;
}

function nullableText(value: unknown) {
  return value === null ? null : text(value);
}

function code(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value))
    throw new InventoryWasteClientError("Unavailable");
  return value;
}

function nullableCode(value: unknown) {
  return value === null ? null : code(value);
}

function quantity(value: unknown, pattern = signed): string {
  if (typeof value !== "string" || !pattern.test(value))
    throw new InventoryWasteClientError("Unavailable");
  return value;
}

function nullableQuantity(value: unknown) {
  return value === null ? null : quantity(value);
}

function utc(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryWasteClientError("Unavailable");
  return value;
}

function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !date.test(value) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    throw new InventoryWasteClientError("Unavailable");
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryWasteClientError("Unavailable");
  return value as T;
}

function positiveInteger(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new InventoryWasteClientError("Unavailable");
  return value as number;
}

function waste(value: unknown): InventoryWasteView["waste"] {
  const raw = object(value, [
    "wasteReference",
    "itemReference",
    "itemName",
    "internalCode",
    "lotReference",
    "expiryDate",
    "locationReference",
    "locationLabel",
    "quantity",
    "unitCode",
    "baseQuantityDelta",
    "baseUnitCode",
    "conversionMultiplier",
    "reasonCode",
    "sourceType",
    "sourceReference",
    "evidenceReferences",
    "approvalRequirement",
    "approvalPolicyReference",
    "costSummary",
    "currentOnHand",
    "currentReserved",
    "currentAvailable",
    "currentInTransit",
    "projectedOnHand",
    "projectedAvailable",
    "balanceVersion",
    "negativeStockPolicy",
    "warnings",
    "status",
    "submittedByDisplay",
    "approvedByDisplay",
    "movementReference",
    "aggregateVersion",
  ]);
  const status = oneOf(raw.status, [
    "Draft",
    "Validated",
    "Submitted",
    "Approved",
    "Rejected",
    "Cancelled",
    "Posted",
  ]);
  const wasteQuantity = raw.quantity === null ? null : quantity(raw.quantity, positive);
  const baseQuantityDelta = nullableQuantity(raw.baseQuantityDelta);
  const wasteReference = nullableReference(raw.wasteReference);
  const conversionMultiplier = quantity(raw.conversionMultiplier, positive);
  const sourceType = oneOf(raw.sourceType, ["Inventory", "Kitchen", "FoodSafetyIncident"]);
  const sourceReference = nullableReference(raw.sourceReference);
  const approvalRequirement =
    raw.approvalRequirement === null
      ? null
      : oneOf(raw.approvalRequirement, ["Required", "NotRequired"]);
  const approvalPolicyReference = nullableReference(raw.approvalPolicyReference);
  if (
    !Array.isArray(raw.warnings) ||
    raw.warnings.length > 20 ||
    raw.warnings.some((entry) => typeof entry !== "string" || !codePattern.test(entry)) ||
    (raw.evidenceReferences !== null &&
      (!Array.isArray(raw.evidenceReferences) ||
        raw.evidenceReferences.length > 20 ||
        raw.evidenceReferences.some((entry) => typeof entry !== "string" || !uuid.test(entry)))) ||
    (status === "Draft" &&
      (wasteReference !== null || wasteQuantity !== null || baseQuantityDelta !== null)) ||
    (status !== "Draft" &&
      (wasteReference === null ||
        wasteQuantity === null ||
        baseQuantityDelta === null ||
        raw.aggregateVersion === null)) ||
    (status === "Posted") !== (raw.movementReference !== null) ||
    (sourceType === "Inventory") !== (sourceReference === null) ||
    (status === "Draft") !== (approvalRequirement === null) ||
    (approvalRequirement === null) !== (approvalPolicyReference === null) ||
    /^0(?:\.0+)?$/u.test(conversionMultiplier)
  )
    throw new InventoryWasteClientError("Unavailable");
  return Object.freeze({
    wasteReference,
    itemReference: reference(raw.itemReference),
    itemName: text(raw.itemName),
    internalCode: code(raw.internalCode),
    lotReference: nullableReference(raw.lotReference),
    expiryDate: nullableDate(raw.expiryDate),
    locationReference: reference(raw.locationReference),
    locationLabel: text(raw.locationLabel),
    quantity: wasteQuantity,
    unitCode: code(raw.unitCode),
    baseQuantityDelta,
    baseUnitCode: code(raw.baseUnitCode),
    conversionMultiplier,
    reasonCode: nullableCode(raw.reasonCode),
    sourceType,
    sourceReference,
    evidenceReferences:
      raw.evidenceReferences === null
        ? null
        : Object.freeze((raw.evidenceReferences as unknown[]).map(reference)),
    approvalRequirement,
    approvalPolicyReference,
    costSummary: parseCostSummary(raw.costSummary),
    currentOnHand: quantity(raw.currentOnHand),
    currentReserved: quantity(raw.currentReserved, positive),
    currentAvailable: quantity(raw.currentAvailable),
    currentInTransit: quantity(raw.currentInTransit, positive),
    projectedOnHand: nullableQuantity(raw.projectedOnHand),
    projectedAvailable: nullableQuantity(raw.projectedAvailable),
    balanceVersion: positiveInteger(raw.balanceVersion),
    negativeStockPolicy: oneOf(raw.negativeStockPolicy, [
      "Block",
      "ManagerOverride",
      "AllowWithWarning",
    ]),
    warnings: Object.freeze(raw.warnings as string[]),
    status,
    submittedByDisplay: nullableText(raw.submittedByDisplay),
    approvedByDisplay: nullableText(raw.approvedByDisplay),
    movementReference: nullableReference(raw.movementReference),
    aggregateVersion: raw.aggregateVersion === null ? null : positiveInteger(raw.aggregateVersion),
  });
}

function parseCostSummary(value: unknown): InventoryWasteView["waste"]["costSummary"] {
  if (value === null) return null;
  const raw = object(value, ["minorUnits", "currencyCode"]);
  if (
    typeof raw.minorUnits !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(raw.minorUnits) ||
    typeof raw.currencyCode !== "string" ||
    !/^[A-Z]{3}$/u.test(raw.currencyCode)
  )
    throw new InventoryWasteClientError("Unavailable");
  return Object.freeze({ minorUnits: raw.minorUnits, currencyCode: raw.currencyCode });
}

export function parseInventoryWasteView(value: unknown): InventoryWasteView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "waste",
  ]);
  if (
    raw.screenId !== "INV-WASTE-WIZARD" ||
    raw.projectionName !== "inventory_waste_wizard_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean"
  )
    throw new InventoryWasteClientError("Unavailable");
  const stockScope = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  return Object.freeze({
    screenId: "INV-WASTE-WIZARD",
    projectionName: "inventory_waste_wizard_v1",
    projectionVersion: 1,
    stockScope: Object.freeze({
      scopeType: oneOf(stockScope.scopeType, ["Store", "StockSite", "Location"]),
      scopeReference: reference(stockScope.scopeReference),
      scopeLabel: text(stockScope.scopeLabel),
    }),
    asOfUtc: utc(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    waste: waste(raw.waste),
  });
}

export const unavailableInventoryWasteClient: InventoryWasteProjectionClient = Object.freeze({
  async load() {
    throw new InventoryWasteClientError("Unavailable");
  },
});
