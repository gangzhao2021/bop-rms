export type ReservationClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class ReservationClientError extends Error {
  constructor(readonly code: ReservationClientErrorCode) {
    super("Reservation view is unavailable");
    this.name = "ReservationClientError";
  }
}
export type ReservationScreenId = "RES-CALENDAR" | "RES-LIST" | "RES-DETAIL" | "RES-CREATE-EDIT";
export interface ReservationCapacityBandView {
  readonly areaCode: string;
  readonly startAt: string;
  readonly endAt: string;
  readonly availableCapacity: number;
  readonly heldCapacity: number;
  readonly closureCode: string | null;
}
export interface ReservationItemView {
  readonly reservationReference: string;
  readonly startAt: string;
  readonly expectedEndAt: string;
  readonly partySize: number;
  readonly customerDisplayName: string;
  readonly contactSummary: string;
  readonly status:
    "Pending" | "Confirmed" | "CheckedIn" | "Seated" | "Cancelled" | "NoShow" | "Expired";
  readonly depositOutcome: "NotRequired" | "Pending" | "Satisfied" | "Failed" | "Indeterminate";
  readonly guaranteeStatus: "None" | "Required" | "Satisfied" | "Unresolved";
  readonly source: "Staff" | "Customer";
  readonly accessibilityRequestCodes: readonly string[];
  readonly specialRequestCode: string | null;
  readonly capacityHoldReference: string;
  readonly capacityHoldExpiresAt: string;
  readonly revisionNumber: number;
  readonly notificationSummary: "NotRequested" | "Pending" | "Delivered" | "Failed" | "Unavailable";
  readonly diningSessionReference: string | null;
  readonly lateOrNoShow: boolean;
}
export interface ReservationView {
  readonly screenId: ReservationScreenId;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale";
  readonly capacityBands: readonly ReservationCapacityBandView[];
  readonly tableAreaHints: readonly string[];
  readonly waitlistCount: number;
  readonly items: readonly ReservationItemView[];
}
export interface ReservationProjectionClient {
  load(screenId: ReservationScreenId, reference?: string): Promise<unknown>;
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const instant = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const safe = /^[^\p{Cc}\p{Cf}<>{}$]{1,120}$/u;
function object(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new ReservationClientError("Unavailable");
  return value as Record<string, unknown>;
}
function reference(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !uuid.test(value))
    throw new ReservationClientError("Unavailable");
  return value;
}
function time(value: unknown) {
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    throw new ReservationClientError("Unavailable");
  return value;
}
function controlled(value: unknown) {
  if (typeof value !== "string" || !code.test(value))
    throw new ReservationClientError("Unavailable");
  return value;
}
function text(value: unknown) {
  if (
    typeof value !== "string" ||
    !safe.test(value) ||
    value.trim() !== value ||
    /https?:\/\//iu.test(value)
  )
    throw new ReservationClientError("Unavailable");
  return value;
}
function integer(value: unknown) {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new ReservationClientError("Unavailable");
  return value as number;
}
function positive(value: unknown) {
  const parsed = integer(value);
  if (parsed < 1) throw new ReservationClientError("Unavailable");
  return parsed;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new ReservationClientError("Unavailable");
  return value as T;
}
function band(value: unknown): ReservationCapacityBandView {
  const raw = object(value, [
    "areaCode",
    "startAt",
    "endAt",
    "availableCapacity",
    "heldCapacity",
    "closureCode",
  ]);
  const startAt = time(raw.startAt);
  const endAt = time(raw.endAt);
  if (Date.parse(endAt) <= Date.parse(startAt)) throw new ReservationClientError("Unavailable");
  return Object.freeze({
    areaCode: controlled(raw.areaCode),
    startAt,
    endAt,
    availableCapacity: integer(raw.availableCapacity),
    heldCapacity: integer(raw.heldCapacity),
    closureCode: raw.closureCode === null ? null : controlled(raw.closureCode),
  });
}
function item(value: unknown): ReservationItemView {
  const raw = object(value, [
    "reservationReference",
    "startAt",
    "expectedEndAt",
    "partySize",
    "customerDisplayName",
    "contactSummary",
    "status",
    "depositOutcome",
    "guaranteeStatus",
    "source",
    "accessibilityRequestCodes",
    "specialRequestCode",
    "capacityHoldReference",
    "capacityHoldExpiresAt",
    "revisionNumber",
    "notificationSummary",
    "diningSessionReference",
    "lateOrNoShow",
  ]);
  if (
    !Array.isArray(raw.accessibilityRequestCodes) ||
    raw.accessibilityRequestCodes.length > 16 ||
    typeof raw.lateOrNoShow !== "boolean"
  )
    throw new ReservationClientError("Unavailable");
  const attributes = raw.accessibilityRequestCodes.map(controlled).sort();
  if (new Set(attributes).size !== attributes.length)
    throw new ReservationClientError("Unavailable");
  const startAt = time(raw.startAt);
  const expectedEndAt = time(raw.expectedEndAt);
  const status = oneOf(raw.status, [
    "Pending",
    "Confirmed",
    "CheckedIn",
    "Seated",
    "Cancelled",
    "NoShow",
    "Expired",
  ]);
  const depositOutcome = oneOf(raw.depositOutcome, [
    "NotRequired",
    "Pending",
    "Satisfied",
    "Failed",
    "Indeterminate",
  ]);
  const guaranteeStatus = oneOf(raw.guaranteeStatus, [
    "None",
    "Required",
    "Satisfied",
    "Unresolved",
  ]);
  const diningSessionReference = reference(raw.diningSessionReference, true);
  if (Date.parse(expectedEndAt) <= Date.parse(startAt))
    throw new ReservationClientError("Unavailable");
  if (
    (depositOutcome === "NotRequired") !== (guaranteeStatus === "None") ||
    (depositOutcome === "Satisfied") !== (guaranteeStatus === "Satisfied") ||
    (status === "Seated") !== (diningSessionReference !== null)
  )
    throw new ReservationClientError("Unavailable");
  return Object.freeze({
    reservationReference: reference(raw.reservationReference) as string,
    startAt,
    expectedEndAt,
    partySize: positive(raw.partySize),
    customerDisplayName: text(raw.customerDisplayName),
    contactSummary: text(raw.contactSummary),
    status,
    depositOutcome,
    guaranteeStatus,
    source: oneOf(raw.source, ["Staff", "Customer"]),
    accessibilityRequestCodes: Object.freeze(attributes),
    specialRequestCode: raw.specialRequestCode === null ? null : controlled(raw.specialRequestCode),
    capacityHoldReference: reference(raw.capacityHoldReference) as string,
    capacityHoldExpiresAt: time(raw.capacityHoldExpiresAt),
    revisionNumber: positive(raw.revisionNumber),
    notificationSummary: oneOf(raw.notificationSummary, [
      "NotRequested",
      "Pending",
      "Delivered",
      "Failed",
      "Unavailable",
    ]),
    diningSessionReference,
    lateOrNoShow: raw.lateOrNoShow,
  });
}
export function parseReservationView(
  value: unknown,
  expectedScreenId?: ReservationScreenId,
): ReservationView {
  const raw = object(value, [
    "screenId",
    "asOfUtc",
    "freshness",
    "capacityBands",
    "tableAreaHints",
    "waitlistCount",
    "items",
  ]);
  const screenId = oneOf(raw.screenId, [
    "RES-CALENDAR",
    "RES-LIST",
    "RES-DETAIL",
    "RES-CREATE-EDIT",
  ]);
  if (
    (expectedScreenId !== undefined && screenId !== expectedScreenId) ||
    !Array.isArray(raw.capacityBands) ||
    !Array.isArray(raw.tableAreaHints) ||
    !Array.isArray(raw.items)
  )
    throw new ReservationClientError("Unavailable");
  const items = raw.items.map(item);
  const hints = raw.tableAreaHints.map(controlled).sort();
  if (
    new Set(items.map((entry) => entry.reservationReference)).size !== items.length ||
    new Set(hints).size !== hints.length ||
    (screenId === "RES-DETAIL" && items.length !== 1)
  )
    throw new ReservationClientError("Unavailable");
  return Object.freeze({
    screenId,
    asOfUtc: time(raw.asOfUtc),
    freshness: oneOf(raw.freshness, ["Current", "Stale"]),
    capacityBands: Object.freeze(raw.capacityBands.map(band)),
    tableAreaHints: Object.freeze(hints),
    waitlistCount: integer(raw.waitlistCount),
    items: Object.freeze(items),
  });
}
export const unavailableReservationProjectionClient: ReservationProjectionClient = Object.freeze({
  async load() {
    throw new ReservationClientError(navigator.onLine ? "Unavailable" : "Offline");
  },
});
