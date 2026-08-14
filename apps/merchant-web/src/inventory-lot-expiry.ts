export type InventoryLotExpiryClientErrorCode =
  | "Empty"
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class InventoryLotExpiryClientError extends Error {
  constructor(readonly code: InventoryLotExpiryClientErrorCode) {
    super("Inventory Lot / Expiry view is unavailable");
    this.name = "InventoryLotExpiryClientError";
  }
}

export interface InventoryLotExpiryRow {
  readonly itemReference: string;
  readonly itemName: string;
  readonly internalCode: string;
  readonly barcode: string | null;
  readonly lotReference: string;
  readonly lotCode: string;
  readonly expiryDate: string | null;
  readonly receivedAt: string;
  readonly receivedQuantity: string;
  readonly locationReference: string;
  readonly locationLabel: string;
  readonly onHand: string;
  readonly reserved: string;
  readonly unitCode: string;
  readonly status: "Available" | "Expired" | "Depleted" | "Quarantined";
  readonly holdReference: string | null;
  readonly holdVersion: number;
  readonly holdReasonCode: string | null;
  readonly supplierReference: string | null;
  readonly supplierLabel: string | null;
  readonly receiptReference: string | null;
  readonly fefoException: boolean;
}

export interface InventoryLotTrace {
  readonly lotReference: string;
  readonly locationReference: string;
  readonly receiptReference: string | null;
  readonly supplierReference: string | null;
  readonly movementReferences: readonly string[];
  readonly complianceTraceReference: string | null;
  readonly wasteHref: string;
  readonly transferHref: string;
  readonly countHref: string;
}

export interface InventoryLotExpiryView {
  readonly screenId: "INV-LOT-EXPIRY";
  readonly projectionName: "inventory_lot_expiry_v1";
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
    readonly supplierTrace: boolean;
    readonly complianceTrace: boolean;
    readonly manageHold: boolean;
  };
  readonly rows: readonly InventoryLotExpiryRow[];
  readonly trace: InventoryLotTrace | null;
  readonly nextCursor: string | null;
}

export interface InventoryLotExpiryProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const datePattern = /^\d{4}-\d{2}-\d{2}$/u;
const quantityPattern = /^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
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
    throw new InventoryLotExpiryClientError("Unavailable");
  return value as Record<string, unknown>;
}

function ref(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryLotExpiryClientError("Unavailable");
  return value;
}

function nullableRef(value: unknown): string | null {
  return value === null ? null : ref(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new InventoryLotExpiryClientError("Unavailable");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function quantity(value: unknown): string {
  if (typeof value !== "string" || !quantityPattern.test(value))
    throw new InventoryLotExpiryClientError("Unavailable");
  return value;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryLotExpiryClientError("Unavailable");
  return value as T;
}

function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryLotExpiryClientError("Unavailable");
  return value;
}

function nullableDate(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    !datePattern.test(value) ||
    !Number.isFinite(Date.parse(`${value}T00:00:00.000Z`)) ||
    new Date(Date.parse(`${value}T00:00:00.000Z`)).toISOString().slice(0, 10) !== value
  )
    throw new InventoryLotExpiryClientError("Unavailable");
  return value;
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InventoryLotExpiryClientError("Unavailable");
  return value as number;
}

function href(value: unknown, route: string): string {
  if (typeof value !== "string" || !value.startsWith(`${route}?`) || value.includes("#"))
    throw new InventoryLotExpiryClientError("Unavailable");
  return value;
}

function row(value: unknown, permissions: InventoryLotExpiryView["permissions"]) {
  const raw = object(value, [
    "itemReference",
    "itemName",
    "internalCode",
    "barcode",
    "lotReference",
    "lotCode",
    "expiryDate",
    "receivedAt",
    "receivedQuantity",
    "locationReference",
    "locationLabel",
    "onHand",
    "reserved",
    "unitCode",
    "status",
    "holdReference",
    "holdVersion",
    "holdReasonCode",
    "supplierReference",
    "supplierLabel",
    "receiptReference",
    "fefoException",
  ]);
  const status = oneOf(raw.status, ["Available", "Expired", "Depleted", "Quarantined"]);
  const holdReference = nullableRef(raw.holdReference);
  const holdVersion = integer(raw.holdVersion);
  const holdReasonCode =
    raw.holdReasonCode === null
      ? null
      : oneOf(raw.holdReasonCode, [
          typeof raw.holdReasonCode === "string" && codePattern.test(raw.holdReasonCode)
            ? raw.holdReasonCode
            : "__INVALID__",
        ]);
  const supplierReference = nullableRef(raw.supplierReference);
  const supplierLabel = nullableText(raw.supplierLabel);
  const receiptReference = nullableRef(raw.receiptReference);
  if (
    typeof raw.fefoException !== "boolean" ||
    (raw.barcode !== null &&
      (typeof raw.barcode !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(raw.barcode))) ||
    (status === "Quarantined") !== (holdReference !== null) ||
    (holdReference === null && (holdVersion !== 0 || holdReasonCode !== null)) ||
    (holdReference !== null && (holdVersion < 1 || holdReasonCode === null)) ||
    (supplierReference === null) !== (supplierLabel === null) ||
    (!permissions.supplierTrace &&
      (supplierReference !== null || supplierLabel !== null || receiptReference !== null))
  )
    throw new InventoryLotExpiryClientError("Unavailable");
  return Object.freeze({
    itemReference: ref(raw.itemReference),
    itemName: text(raw.itemName),
    internalCode: text(raw.internalCode),
    barcode: raw.barcode as string | null,
    lotReference: ref(raw.lotReference),
    lotCode: text(raw.lotCode),
    expiryDate: nullableDate(raw.expiryDate),
    receivedAt: instant(raw.receivedAt),
    receivedQuantity: quantity(raw.receivedQuantity),
    locationReference: ref(raw.locationReference),
    locationLabel: text(raw.locationLabel),
    onHand: quantity(raw.onHand),
    reserved: quantity(raw.reserved),
    unitCode: oneOf(raw.unitCode, [
      typeof raw.unitCode === "string" && unitPattern.test(raw.unitCode)
        ? raw.unitCode
        : "__INVALID__",
    ]),
    status,
    holdReference,
    holdVersion,
    holdReasonCode,
    supplierReference,
    supplierLabel,
    receiptReference,
    fefoException: raw.fefoException,
  });
}

export function parseInventoryLotExpiryView(value: unknown): InventoryLotExpiryView {
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
    "trace",
    "nextCursor",
  ]);
  if (
    raw.screenId !== "INV-LOT-EXPIRY" ||
    raw.projectionName !== "inventory_lot_expiry_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 200 ||
    (raw.nextCursor !== null &&
      (typeof raw.nextCursor !== "string" || !cursorPattern.test(raw.nextCursor)))
  )
    throw new InventoryLotExpiryClientError("Unavailable");
  const scope = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  const access = object(raw.permissions, ["supplierTrace", "complianceTrace", "manageHold"]);
  if (
    typeof access.supplierTrace !== "boolean" ||
    typeof access.complianceTrace !== "boolean" ||
    typeof access.manageHold !== "boolean"
  )
    throw new InventoryLotExpiryClientError("Unavailable");
  const permissions = Object.freeze({
    supplierTrace: access.supplierTrace,
    complianceTrace: access.complianceTrace,
    manageHold: access.manageHold,
  });
  let trace: InventoryLotTrace | null = null;
  if (raw.trace !== null) {
    const source = object(raw.trace, [
      "lotReference",
      "locationReference",
      "receiptReference",
      "supplierReference",
      "movementReferences",
      "complianceTraceReference",
      "wasteHref",
      "transferHref",
      "countHref",
    ]);
    if (
      !Array.isArray(source.movementReferences) ||
      source.movementReferences.length > 500 ||
      (!permissions.supplierTrace &&
        (source.receiptReference !== null || source.supplierReference !== null)) ||
      (!permissions.complianceTrace && source.complianceTraceReference !== null)
    )
      throw new InventoryLotExpiryClientError("Unavailable");
    trace = Object.freeze({
      lotReference: ref(source.lotReference),
      locationReference: ref(source.locationReference),
      receiptReference: nullableRef(source.receiptReference),
      supplierReference: nullableRef(source.supplierReference),
      movementReferences: Object.freeze(source.movementReferences.map(ref)),
      complianceTraceReference: nullableRef(source.complianceTraceReference),
      wasteHref: href(source.wasteHref, "/operations/inventory/waste/new"),
      transferHref: href(source.transferHref, "/operations/inventory/transfers"),
      countHref: href(source.countHref, "/operations/inventory/counts"),
    });
  }
  const rows = Object.freeze(raw.rows.map((entry) => row(entry, permissions)));
  if (
    trace !== null &&
    !rows.some(
      (entry) =>
        entry.lotReference === trace?.lotReference &&
        entry.locationReference === trace.locationReference,
    )
  )
    throw new InventoryLotExpiryClientError("Unavailable");
  return Object.freeze({
    screenId: "INV-LOT-EXPIRY",
    projectionName: "inventory_lot_expiry_v1",
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
    rows,
    trace,
    nextCursor: raw.nextCursor as string | null,
  });
}

export const unavailableInventoryLotExpiryClient: InventoryLotExpiryProjectionClient =
  Object.freeze({
    async load() {
      throw new InventoryLotExpiryClientError("Unavailable");
    },
  });
