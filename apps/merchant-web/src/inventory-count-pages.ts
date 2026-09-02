export type InventoryCountClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class InventoryCountClientError extends Error {
  constructor(readonly code: InventoryCountClientErrorCode) {
    super("Inventory Count view is unavailable");
    this.name = "InventoryCountClientError";
  }
}

export type InventoryCountScreenId = "INV-COUNT-LIST" | "INV-COUNT-WORKBENCH";
export type InventoryCountStatus =
  "Draft" | "Assigned" | "InProgress" | "Submitted" | "Approved" | "Cancelled" | "Posted";

export interface InventoryCountLineView {
  readonly lineReference: string;
  readonly itemReference: string;
  readonly itemName: string;
  readonly internalCode: string;
  readonly lotReference: string | null;
  readonly locationLabel: string;
  readonly unitCode: string;
  readonly expectedQuantity: string | null;
  readonly countedQuantity: string | null;
  readonly variance: string | null;
  readonly varianceReasonCode: string | null;
  readonly recountNumber: number;
  readonly conflict: "None" | "BalanceChanged" | "UnitMissing" | "LotIncomplete";
  readonly movementReference: string | null;
}

export interface InventoryCountViewRow {
  readonly countReference: string;
  readonly countType: "Full" | "Cycle" | "Spot";
  readonly status: InventoryCountStatus;
  readonly expectedQuantityVisibility: "BlindUntilSubmit" | "Visible";
  readonly movementControl: "FreezeMovements" | "SnapshotOnly";
  readonly approvalPolicy: "Segregated" | "SelfAllowed";
  readonly snapshotReference: string;
  readonly snapshotCapturedAt: string;
  readonly assigneeDisplay: string | null;
  readonly submittedByDisplay: string | null;
  readonly approvedByDisplay: string | null;
  readonly dueAt: string | null;
  readonly totalLines: number;
  readonly countedLines: number;
  readonly varianceLines: number | null;
  readonly aggregateVersion: number;
  readonly lines: readonly InventoryCountLineView[];
}

export interface InventoryCountView {
  readonly screenId: InventoryCountScreenId;
  readonly projectionName: "inventory_count_workbench_v1";
  readonly projectionVersion: 1;
  readonly stockScope: {
    readonly scopeType: "Store" | "StockSite" | "Location";
    readonly scopeReference: string;
    readonly scopeLabel: string;
  };
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly selectedCountReference: string | null;
  readonly counts: readonly InventoryCountViewRow[];
}

export interface InventoryCountProjectionClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const decimal = /^-?(?:0|[1-9]\d*)(?:\.\d{1,6})?$/u;
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
    throw new InventoryCountClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !uuid.test(value))
    throw new InventoryCountClientError("Unavailable");
  return value;
}

function nullableReference(value: unknown): string | null {
  return value === null ? null : reference(value);
}

function text(value: unknown): string {
  if (typeof value !== "string" || value.trim() !== value || !safe.test(value))
    throw new InventoryCountClientError("Unavailable");
  return value;
}

function nullableText(value: unknown): string | null {
  return value === null ? null : text(value);
}

function code(value: unknown): string {
  if (typeof value !== "string" || !codePattern.test(value))
    throw new InventoryCountClientError("Unavailable");
  return value;
}

function quantity(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !decimal.test(value))
    throw new InventoryCountClientError("Unavailable");
  return value;
}

function utc(value: unknown): string {
  if (
    typeof value !== "string" ||
    !instant.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(Date.parse(value)).toISOString() !== value
  )
    throw new InventoryCountClientError("Unavailable");
  return value;
}

function nullableUtc(value: unknown): string | null {
  return value === null ? null : utc(value);
}

function integer(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new InventoryCountClientError("Unavailable");
  return value as number;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new InventoryCountClientError("Unavailable");
  return value as T;
}

function line(value: unknown, revealExpected: boolean): InventoryCountLineView {
  const raw = object(value, [
    "lineReference",
    "itemReference",
    "itemName",
    "internalCode",
    "lotReference",
    "locationLabel",
    "unitCode",
    "expectedQuantity",
    "countedQuantity",
    "variance",
    "varianceReasonCode",
    "recountNumber",
    "conflict",
    "movementReference",
  ]);
  const expectedQuantity = quantity(raw.expectedQuantity);
  const variance = quantity(raw.variance);
  if (
    (!revealExpected && (expectedQuantity !== null || variance !== null)) ||
    (revealExpected && expectedQuantity === null)
  )
    throw new InventoryCountClientError("Unavailable");
  return Object.freeze({
    lineReference: reference(raw.lineReference),
    itemReference: reference(raw.itemReference),
    itemName: text(raw.itemName),
    internalCode: code(raw.internalCode),
    lotReference: nullableReference(raw.lotReference),
    locationLabel: text(raw.locationLabel),
    unitCode: code(raw.unitCode),
    expectedQuantity,
    countedQuantity: quantity(raw.countedQuantity),
    variance,
    varianceReasonCode: raw.varianceReasonCode === null ? null : code(raw.varianceReasonCode),
    recountNumber: integer(raw.recountNumber),
    conflict: oneOf(raw.conflict, ["None", "BalanceChanged", "UnitMissing", "LotIncomplete"]),
    movementReference: nullableReference(raw.movementReference),
  });
}

function count(value: unknown): InventoryCountViewRow {
  const raw = object(value, [
    "countReference",
    "countType",
    "status",
    "expectedQuantityVisibility",
    "movementControl",
    "approvalPolicy",
    "snapshotReference",
    "snapshotCapturedAt",
    "assigneeDisplay",
    "submittedByDisplay",
    "approvedByDisplay",
    "dueAt",
    "totalLines",
    "countedLines",
    "varianceLines",
    "aggregateVersion",
    "lines",
  ]);
  const status = oneOf(raw.status, [
    "Draft",
    "Assigned",
    "InProgress",
    "Submitted",
    "Approved",
    "Cancelled",
    "Posted",
  ]);
  const expectedQuantityVisibility = oneOf(raw.expectedQuantityVisibility, [
    "BlindUntilSubmit",
    "Visible",
  ]);
  const revealExpected =
    expectedQuantityVisibility === "Visible" ||
    ["Submitted", "Approved", "Posted"].includes(status);
  if (!Array.isArray(raw.lines) || raw.lines.length > 500)
    throw new InventoryCountClientError("Unavailable");
  const totalLines = integer(raw.totalLines);
  const countedLines = integer(raw.countedLines);
  const varianceLines = raw.varianceLines === null ? null : integer(raw.varianceLines);
  const aggregateVersion = integer(raw.aggregateVersion);
  if (
    countedLines > totalLines ||
    (!revealExpected && varianceLines !== null) ||
    aggregateVersion < 1
  )
    throw new InventoryCountClientError("Unavailable");
  return Object.freeze({
    countReference: reference(raw.countReference),
    countType: oneOf(raw.countType, ["Full", "Cycle", "Spot"]),
    status,
    expectedQuantityVisibility,
    movementControl: oneOf(raw.movementControl, ["FreezeMovements", "SnapshotOnly"]),
    approvalPolicy: oneOf(raw.approvalPolicy, ["Segregated", "SelfAllowed"]),
    snapshotReference: reference(raw.snapshotReference),
    snapshotCapturedAt: utc(raw.snapshotCapturedAt),
    assigneeDisplay: nullableText(raw.assigneeDisplay),
    submittedByDisplay: nullableText(raw.submittedByDisplay),
    approvedByDisplay: nullableText(raw.approvedByDisplay),
    dueAt: nullableUtc(raw.dueAt),
    totalLines,
    countedLines,
    varianceLines,
    aggregateVersion,
    lines: Object.freeze(raw.lines.map((entry) => line(entry, revealExpected))),
  });
}

export function parseInventoryCountView(value: unknown): InventoryCountView {
  const raw = object(value, [
    "screenId",
    "projectionName",
    "projectionVersion",
    "stockScope",
    "asOfUtc",
    "freshness",
    "partial",
    "selectedCountReference",
    "counts",
  ]);
  if (
    raw.projectionName !== "inventory_count_workbench_v1" ||
    raw.projectionVersion !== 1 ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.counts) ||
    raw.counts.length > 200
  )
    throw new InventoryCountClientError("Unavailable");
  const screenId = oneOf(raw.screenId, ["INV-COUNT-LIST", "INV-COUNT-WORKBENCH"]);
  const scopeRaw = object(raw.stockScope, ["scopeType", "scopeReference", "scopeLabel"]);
  const counts = Object.freeze(raw.counts.map(count));
  const selectedCountReference = nullableReference(raw.selectedCountReference);
  if (
    screenId === "INV-COUNT-WORKBENCH" &&
    (!selectedCountReference ||
      !counts.some((entry) => entry.countReference === selectedCountReference))
  )
    throw new InventoryCountClientError("Unavailable");
  return Object.freeze({
    screenId,
    projectionName: "inventory_count_workbench_v1",
    projectionVersion: 1,
    stockScope: Object.freeze({
      scopeType: oneOf(scopeRaw.scopeType, ["Store", "StockSite", "Location"]),
      scopeReference: reference(scopeRaw.scopeReference),
      scopeLabel: text(scopeRaw.scopeLabel),
    }),
    asOfUtc: utc(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale", "Rebuilding"]),
    partial: raw.partial,
    selectedCountReference,
    counts,
  });
}

export const unavailableInventoryCountClient: InventoryCountProjectionClient = Object.freeze({
  async load() {
    throw new InventoryCountClientError("Unavailable");
  },
});
