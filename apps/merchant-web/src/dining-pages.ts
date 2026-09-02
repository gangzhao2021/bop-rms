export type DiningClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class DiningClientError extends Error {
  constructor(readonly code: DiningClientErrorCode) {
    super("Dining view is unavailable");
    this.name = "DiningClientError";
  }
}

export interface DiningFloorItemView {
  readonly tableReference: string;
  readonly stableLabel: string;
  readonly areaCode: string;
  readonly capacity: number;
  readonly tableState: "Available" | "Occupied" | "TemporarilyBlocked" | "Closing";
  readonly diningSessionReference: string | null;
  readonly partySize: number | null;
  readonly elapsedSeconds: number | null;
  readonly orderSummary: "None" | "Open" | "Closing" | "Complete" | "Unavailable";
  readonly paymentSummary: "NotReported" | "Pending" | "Paid" | "Indeterminate" | "Unavailable";
  readonly reservationHandoffReference: string | null;
  readonly waitlistHandoffReference: string | null;
  readonly ownerSummary: string;
  readonly attention: "None" | "Warning" | "Urgent";
}

export interface DiningFloorView {
  readonly screenId: "DIN-FLOOR-BOARD";
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale";
  readonly items: readonly DiningFloorItemView[];
}

export interface DiningTableItemView {
  readonly tableReference: string;
  readonly stableLabel: string;
  readonly areaCode: string;
  readonly capacity: number;
  readonly accessibilityAttributes: readonly string[];
  readonly lifecycle: "Draft" | "Published";
  readonly qrStatus: "Inactive" | "Active" | "Revoked";
  readonly qrVersion: number;
  readonly operationalState: "Available" | "TemporarilyBlocked";
  readonly currentDiningSessionReference: string | null;
  readonly aggregateVersion: number;
}

export interface DiningTableListView {
  readonly screenId: "DIN-TABLE-LIST";
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale";
  readonly items: readonly DiningTableItemView[];
}

export interface DiningProjectionClient {
  loadFloor(): Promise<unknown>;
  loadTables(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const controlledCode = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const safeLabel = /^[^\p{Cc}\p{Cf}<>{}$]{1,40}$/u;

function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new DiningClientError("Unavailable");
  return value as Record<string, unknown>;
}

function reference(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !uuid.test(value)) throw new DiningClientError("Unavailable");
  return value;
}

function code(value: unknown) {
  if (typeof value !== "string" || !controlledCode.test(value))
    throw new DiningClientError("Unavailable");
  return value;
}

function label(value: unknown) {
  if (
    typeof value !== "string" ||
    !safeLabel.test(value) ||
    value.trim() !== value ||
    /https?:\/\//iu.test(value)
  )
    throw new DiningClientError("Unavailable");
  return value;
}

function integer(value: unknown): number;
function integer(value: unknown, nullable: true): number | null;
function integer(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new DiningClientError("Unavailable");
  return value as number;
}

function positive(value: unknown) {
  const parsed = integer(value);
  if (parsed < 1) throw new DiningClientError("Unavailable");
  return parsed;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new DiningClientError("Unavailable");
  return value as T;
}

function header(
  value: unknown,
  screenId: DiningFloorView["screenId"] | DiningTableListView["screenId"],
) {
  const raw = object(value, ["screenId", "asOfUtc", "freshness", "items"]);
  if (
    raw.screenId !== screenId ||
    typeof raw.asOfUtc !== "string" ||
    !instant.test(raw.asOfUtc) ||
    !Number.isFinite(Date.parse(raw.asOfUtc)) ||
    !Array.isArray(raw.items)
  )
    throw new DiningClientError("Unavailable");
  return {
    asOfUtc: raw.asOfUtc,
    freshness: oneOf(raw.freshness, ["Current", "Stale"]),
    items: raw.items,
  } as const;
}

function parseFloorItem(value: unknown): DiningFloorItemView {
  const raw = object(value, [
    "tableReference",
    "stableLabel",
    "areaCode",
    "capacity",
    "tableState",
    "diningSessionReference",
    "partySize",
    "elapsedSeconds",
    "orderSummary",
    "paymentSummary",
    "reservationHandoffReference",
    "waitlistHandoffReference",
    "ownerSummary",
    "attention",
  ]);
  const session = reference(raw.diningSessionReference, true);
  const partySize = integer(raw.partySize, true);
  const elapsedSeconds = integer(raw.elapsedSeconds, true);
  const capacity = positive(raw.capacity);
  const tableState = oneOf(raw.tableState, [
    "Available",
    "Occupied",
    "TemporarilyBlocked",
    "Closing",
  ]);
  if (
    (session === null) !== (partySize === null) ||
    (session === null) !== (elapsedSeconds === null) ||
    (session === null) !== (tableState === "Available" || tableState === "TemporarilyBlocked") ||
    (partySize !== null && partySize > capacity)
  )
    throw new DiningClientError("Unavailable");
  return Object.freeze({
    tableReference: reference(raw.tableReference) as string,
    stableLabel: label(raw.stableLabel),
    areaCode: code(raw.areaCode),
    capacity,
    tableState,
    diningSessionReference: session,
    partySize,
    elapsedSeconds,
    orderSummary: oneOf(raw.orderSummary, ["None", "Open", "Closing", "Complete", "Unavailable"]),
    paymentSummary: oneOf(raw.paymentSummary, [
      "NotReported",
      "Pending",
      "Paid",
      "Indeterminate",
      "Unavailable",
    ]),
    reservationHandoffReference: reference(raw.reservationHandoffReference, true),
    waitlistHandoffReference: reference(raw.waitlistHandoffReference, true),
    ownerSummary: code(raw.ownerSummary),
    attention: oneOf(raw.attention, ["None", "Warning", "Urgent"]),
  });
}

export function parseDiningFloorView(value: unknown): DiningFloorView {
  const raw = header(value, "DIN-FLOOR-BOARD");
  const items = raw.items.map(parseFloorItem);
  if (new Set(items.map((item) => item.tableReference)).size !== items.length)
    throw new DiningClientError("Unavailable");
  return Object.freeze({
    screenId: "DIN-FLOOR-BOARD",
    asOfUtc: raw.asOfUtc,
    freshness: raw.freshness,
    items: Object.freeze(items),
  });
}

function parseTableItem(value: unknown): DiningTableItemView {
  const raw = object(value, [
    "tableReference",
    "stableLabel",
    "areaCode",
    "capacity",
    "accessibilityAttributes",
    "lifecycle",
    "qrStatus",
    "qrVersion",
    "operationalState",
    "currentDiningSessionReference",
    "aggregateVersion",
  ]);
  if (!Array.isArray(raw.accessibilityAttributes) || raw.accessibilityAttributes.length > 16)
    throw new DiningClientError("Unavailable");
  const attributes = raw.accessibilityAttributes.map(code).sort();
  if (new Set(attributes).size !== attributes.length) throw new DiningClientError("Unavailable");
  const lifecycle = oneOf(raw.lifecycle, ["Draft", "Published"]);
  const qrStatus = oneOf(raw.qrStatus, ["Inactive", "Active", "Revoked"]);
  const qrVersion = integer(raw.qrVersion);
  const currentDiningSessionReference = reference(raw.currentDiningSessionReference, true);
  if (
    (qrStatus === "Inactive") !== (qrVersion === 0) ||
    (lifecycle === "Draft" && (qrStatus !== "Inactive" || currentDiningSessionReference !== null))
  )
    throw new DiningClientError("Unavailable");
  return Object.freeze({
    tableReference: reference(raw.tableReference) as string,
    stableLabel: label(raw.stableLabel),
    areaCode: code(raw.areaCode),
    capacity: positive(raw.capacity),
    accessibilityAttributes: Object.freeze(attributes),
    lifecycle,
    qrStatus,
    qrVersion,
    operationalState: oneOf(raw.operationalState, ["Available", "TemporarilyBlocked"]),
    currentDiningSessionReference,
    aggregateVersion: positive(raw.aggregateVersion),
  });
}

export function parseDiningTableListView(value: unknown): DiningTableListView {
  const raw = header(value, "DIN-TABLE-LIST");
  const items = raw.items.map(parseTableItem);
  if (new Set(items.map((item) => item.tableReference)).size !== items.length)
    throw new DiningClientError("Unavailable");
  return Object.freeze({
    screenId: "DIN-TABLE-LIST",
    asOfUtc: raw.asOfUtc,
    freshness: raw.freshness,
    items: Object.freeze(items),
  });
}

export const unavailableDiningProjectionClient: DiningProjectionClient = Object.freeze({
  async loadFloor() {
    throw new DiningClientError(navigator.onLine ? "Unavailable" : "Offline");
  },
  async loadTables() {
    throw new DiningClientError(navigator.onLine ? "Unavailable" : "Offline");
  },
});
