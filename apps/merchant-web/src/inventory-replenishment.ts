export type InventoryReplenishmentClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "ValidationFailed"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class InventoryReplenishmentClientError extends Error {
  constructor(readonly code: InventoryReplenishmentClientErrorCode) {
    super("Inventory Replenishment view is unavailable");
    this.name = "InventoryReplenishmentClientError";
  }
}

export interface InventoryReplenishmentRow {
  readonly needReference: string;
  readonly needVersion: number;
  readonly itemReference: string;
  readonly itemName: string;
  readonly internalCode: string;
  readonly available: string;
  readonly reorderPoint: string;
  readonly safetyStock: string;
  readonly forecastQuantity: string;
  readonly forecastReference: string;
  readonly forecastAsOfUtc: string;
  readonly suggestedQuantity: string;
  readonly baseUnitCode: string;
  readonly requiredBy: string;
  readonly urgency: "Low" | "Normal" | "High" | "Critical";
  readonly reasonCode: string;
  readonly preferredSupplierMappingReference: string | null;
  readonly preferredSupplierReference: string | null;
  readonly preferredSupplierSummary: string | null;
  readonly status: "Open" | "Acknowledged" | "RequisitionDraftCreated" | "Dismissed";
  readonly requisitionReference: string | null;
}

export interface InventoryReplenishmentView {
  readonly screenId: "INV-REPLENISHMENT";
  readonly projectionName: "inventory_replenishment_v1";
  readonly projectionVersion: 1;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  };
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly supplierSummary: boolean;
    readonly acknowledge: boolean;
    readonly dismiss: boolean;
    readonly createRequisitionDraft: boolean;
  };
  readonly rows: readonly InventoryReplenishmentRow[];
  readonly nextCursor: string | null;
}

export interface InventoryReplenishmentProjectionClient {
  load(): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const decimalPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
const codePattern = /^[A-Z][A-Z0-9_]{0,63}$/u;
const unitPattern = /^[A-Z0-9][A-Z0-9_-]{0,31}$/u;
const cursorPattern = /^[A-Za-z0-9_-]{1,200}$/u;
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
    throw new InventoryReplenishmentClientError("Unavailable");
  return value as Record<string, unknown>;
}
function ref(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryReplenishmentClientError("Unavailable");
  return value;
}
const nullableRef = (value: unknown) => (value === null ? null : ref(value));
function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new InventoryReplenishmentClientError("Unavailable");
  return value;
}
const nullableText = (value: unknown) => (value === null ? null : text(value));
function decimal(value: unknown): string {
  if (typeof value !== "string" || !decimalPattern.test(value))
    throw new InventoryReplenishmentClientError("Unavailable");
  return value;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryReplenishmentClientError("Unavailable");
  return value as T;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryReplenishmentClientError("Unavailable");
  return value;
}
function date(value: unknown): string {
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value
  )
    throw new InventoryReplenishmentClientError("Unavailable");
  return value;
}
function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new InventoryReplenishmentClientError("Unavailable");
  return value as number;
}

function row(value: unknown, supplierVisible: boolean): InventoryReplenishmentRow {
  const raw = object(value, [
    "needReference",
    "needVersion",
    "itemReference",
    "itemName",
    "internalCode",
    "available",
    "reorderPoint",
    "safetyStock",
    "forecastQuantity",
    "forecastReference",
    "forecastAsOfUtc",
    "suggestedQuantity",
    "baseUnitCode",
    "requiredBy",
    "urgency",
    "reasonCode",
    "preferredSupplierMappingReference",
    "preferredSupplierReference",
    "preferredSupplierSummary",
    "status",
    "requisitionReference",
  ]);
  const mapping = nullableRef(raw.preferredSupplierMappingReference);
  const supplier = nullableRef(raw.preferredSupplierReference);
  const summary = nullableText(raw.preferredSupplierSummary);
  const requisition = nullableRef(raw.requisitionReference);
  const status = oneOf(raw.status, [
    "Open",
    "Acknowledged",
    "RequisitionDraftCreated",
    "Dismissed",
  ]);
  if (
    (!supplierVisible && (mapping !== null || supplier !== null || summary !== null)) ||
    (mapping === null) !== (supplier === null) ||
    (supplier === null) !== (summary === null) ||
    (status === "RequisitionDraftCreated") !== (requisition !== null)
  )
    throw new InventoryReplenishmentClientError("Unavailable");
  return Object.freeze({
    needReference: ref(raw.needReference),
    needVersion: integer(raw.needVersion),
    itemReference: ref(raw.itemReference),
    itemName: text(raw.itemName),
    internalCode: text(raw.internalCode),
    available: decimal(raw.available),
    reorderPoint: decimal(raw.reorderPoint),
    safetyStock: decimal(raw.safetyStock),
    forecastQuantity: decimal(raw.forecastQuantity),
    forecastReference: ref(raw.forecastReference),
    forecastAsOfUtc: instant(raw.forecastAsOfUtc),
    suggestedQuantity: decimal(raw.suggestedQuantity),
    baseUnitCode: oneOf(raw.baseUnitCode, [
      typeof raw.baseUnitCode === "string" && unitPattern.test(raw.baseUnitCode)
        ? raw.baseUnitCode
        : "__INVALID__",
    ]),
    requiredBy: date(raw.requiredBy),
    urgency: oneOf(raw.urgency, ["Low", "Normal", "High", "Critical"]),
    reasonCode: oneOf(raw.reasonCode, [
      typeof raw.reasonCode === "string" && codePattern.test(raw.reasonCode)
        ? raw.reasonCode
        : "__INVALID__",
    ]),
    preferredSupplierMappingReference: mapping,
    preferredSupplierReference: supplier,
    preferredSupplierSummary: summary,
    status,
    requisitionReference: requisition,
  });
}

export function parseInventoryReplenishmentView(value: unknown): InventoryReplenishmentView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
    "nextCursor",
  ]);
  if (
    raw.screenId !== "INV-REPLENISHMENT" ||
    raw.projectionName !== "inventory_replenishment_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200 ||
    (raw.nextCursor !== null &&
      (typeof raw.nextCursor !== "string" || !cursorPattern.test(raw.nextCursor)))
  )
    throw new InventoryReplenishmentClientError("Unavailable");
  const scope = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  const access = object(raw.permissions, [
    "supplierSummary",
    "acknowledge",
    "dismiss",
    "createRequisitionDraft",
  ]);
  if (
    typeof access.supplierSummary !== "boolean" ||
    typeof access.acknowledge !== "boolean" ||
    typeof access.dismiss !== "boolean" ||
    typeof access.createRequisitionDraft !== "boolean"
  )
    throw new InventoryReplenishmentClientError("Unavailable");
  const permissions = Object.freeze({
    supplierSummary: access.supplierSummary,
    acknowledge: access.acknowledge,
    dismiss: access.dismiss,
    createRequisitionDraft: access.createRequisitionDraft,
  });
  return Object.freeze({
    screenId: "INV-REPLENISHMENT",
    projectionName: "inventory_replenishment_v1",
    projectionVersion: 1,
    stockScope: Object.freeze({
      scopeType: oneOf(scope.scopeType, ["Store", "StockSite", "Location"]),
      scopeReference: ref(scope.scopeReference),
      scopeLabel: text(scope.scopeLabel),
    }),
    asOfUtc: instant(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    permissions,
    rows: Object.freeze(raw.rows.map((entry) => row(entry, permissions.supplierSummary))),
    nextCursor: raw.nextCursor as string | null,
  });
}

export const unavailableInventoryReplenishmentClient: InventoryReplenishmentProjectionClient =
  Object.freeze({
    async load() {
      throw new InventoryReplenishmentClientError("Unavailable");
    },
  });
