export type WaitlistClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class WaitlistClientError extends Error {
  constructor(readonly code: WaitlistClientErrorCode) {
    super("Waitlist view is unavailable");
    this.name = "WaitlistClientError";
  }
}
export type WaitlistScreenId = "WAIT-BOARD" | "WAIT-ENTRY";
export interface WaitlistTimelineItemView {
  readonly actionCode: string;
  readonly actorSummary: string;
  readonly occurredAt: string;
}
export interface WaitlistEntryView {
  readonly waitlistEntryReference: string;
  readonly dynamicPosition: number;
  readonly partySize: number;
  readonly customerDisplayName: string;
  readonly contactState: "Verified" | "Unverified" | "Unavailable";
  readonly contactSummary: string;
  readonly status:
    "Waiting" | "CheckedIn" | "Called" | "Ready" | "Seated" | "Missed" | "Cancelled" | "Expired";
  readonly joinMode: "Remote" | "WalkIn";
  readonly areaPreferenceCode: string | null;
  readonly seatingConstraintCodes: readonly string[];
  readonly joinedAt: string;
  readonly checkedInAt: string | null;
  readonly quotedMinimumMinutes: number;
  readonly quotedMaximumMinutes: number;
  readonly currentMinimumMinutes: number;
  readonly currentMaximumMinutes: number;
  readonly estimateCalculatedAt: string;
  readonly estimateCalculationVersion: string;
  readonly priorityKind: "Default" | "Policy" | "ManagerOverride";
  readonly priorityReasonCode: string | null;
  readonly responseDeadline: string | null;
  readonly readyExpiresAt: string | null;
  readonly readyExtensionUsed: boolean;
  readonly notificationStatus: "NotRequested" | "Pending" | "Delivered" | "Failed" | "Unavailable";
  readonly seatingEligibility: "Eligible" | "WaitingForReady" | "Ineligible" | "Unknown";
  readonly diningSessionReference: string | null;
  readonly overdue: boolean;
  readonly revisionNumber: number;
  readonly timeline: readonly WaitlistTimelineItemView[];
}
export interface WaitlistView {
  readonly screenId: WaitlistScreenId;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale";
  readonly entries: readonly WaitlistEntryView[];
}
export interface WaitlistProjectionClient {
  load(screenId: WaitlistScreenId, reference?: string): Promise<unknown>;
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
    throw new WaitlistClientError("Unavailable");
  return value as Record<string, unknown>;
}
function reference(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !uuid.test(value)) throw new WaitlistClientError("Unavailable");
  return value;
}
function time(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !instant.test(value) || !Number.isFinite(Date.parse(value)))
    throw new WaitlistClientError("Unavailable");
  return value;
}
function controlled(value: unknown, nullable = false) {
  if (nullable && value === null) return null;
  if (typeof value !== "string" || !code.test(value)) throw new WaitlistClientError("Unavailable");
  return value;
}
function text(value: unknown) {
  if (
    typeof value !== "string" ||
    !safe.test(value) ||
    value.trim() !== value ||
    /https?:\/\//iu.test(value)
  )
    throw new WaitlistClientError("Unavailable");
  return value;
}
function integer(value: unknown, positive = false) {
  if (!Number.isSafeInteger(value) || (value as number) < (positive ? 1 : 0))
    throw new WaitlistClientError("Unavailable");
  return value as number;
}
function oneOf<T extends string>(value: unknown, values: readonly T[]): T {
  if (typeof value !== "string" || !values.includes(value as T))
    throw new WaitlistClientError("Unavailable");
  return value as T;
}
function timelineItem(value: unknown): WaitlistTimelineItemView {
  const raw = object(value, ["actionCode", "actorSummary", "occurredAt"]);
  return Object.freeze({
    actionCode: controlled(raw.actionCode) as string,
    actorSummary: text(raw.actorSummary),
    occurredAt: time(raw.occurredAt) as string,
  });
}
function entry(value: unknown): WaitlistEntryView {
  const raw = object(value, [
    "waitlistEntryReference",
    "dynamicPosition",
    "partySize",
    "customerDisplayName",
    "contactState",
    "contactSummary",
    "status",
    "joinMode",
    "areaPreferenceCode",
    "seatingConstraintCodes",
    "joinedAt",
    "checkedInAt",
    "quotedMinimumMinutes",
    "quotedMaximumMinutes",
    "currentMinimumMinutes",
    "currentMaximumMinutes",
    "estimateCalculatedAt",
    "estimateCalculationVersion",
    "priorityKind",
    "priorityReasonCode",
    "responseDeadline",
    "readyExpiresAt",
    "readyExtensionUsed",
    "notificationStatus",
    "seatingEligibility",
    "diningSessionReference",
    "overdue",
    "revisionNumber",
    "timeline",
  ]);
  if (
    !Array.isArray(raw.seatingConstraintCodes) ||
    raw.seatingConstraintCodes.length > 16 ||
    !Array.isArray(raw.timeline) ||
    raw.timeline.length > 200 ||
    typeof raw.readyExtensionUsed !== "boolean" ||
    typeof raw.overdue !== "boolean"
  )
    throw new WaitlistClientError("Unavailable");
  const status = oneOf(raw.status, [
    "Waiting",
    "CheckedIn",
    "Called",
    "Ready",
    "Seated",
    "Missed",
    "Cancelled",
    "Expired",
  ]);
  const constraints = raw.seatingConstraintCodes.map((value) => controlled(value) as string).sort();
  const timeline = raw.timeline.map(timelineItem);
  const quotedMinimumMinutes = integer(raw.quotedMinimumMinutes, true);
  const quotedMaximumMinutes = integer(raw.quotedMaximumMinutes, true);
  const currentMinimumMinutes = integer(raw.currentMinimumMinutes, true);
  const currentMaximumMinutes = integer(raw.currentMaximumMinutes, true);
  const responseDeadline = time(raw.responseDeadline, true);
  const readyExpiresAt = time(raw.readyExpiresAt, true);
  const diningSessionReference = reference(raw.diningSessionReference, true);
  const priorityKind = oneOf(raw.priorityKind, ["Default", "Policy", "ManagerOverride"]);
  const priorityReasonCode = controlled(raw.priorityReasonCode, true);
  if (
    new Set(constraints).size !== constraints.length ||
    quotedMaximumMinutes < quotedMinimumMinutes ||
    currentMaximumMinutes < currentMinimumMinutes ||
    (["CheckedIn", "Ready", "Seated"].includes(status) && raw.checkedInAt === null) ||
    (["Called", "Ready", "Missed", "Seated"].includes(status) && responseDeadline === null) ||
    (["Ready", "Seated"].includes(status) && readyExpiresAt === null) ||
    (status === "Seated") !== (diningSessionReference !== null) ||
    (raw.seatingEligibility === "Eligible" && status !== "Ready") ||
    (raw.seatingEligibility === "WaitingForReady" && status === "Ready") ||
    (priorityKind === "Default") !== (priorityReasonCode === null) ||
    new Set(timeline.map((item) => `${item.actionCode}:${item.occurredAt}`)).size !==
      timeline.length
  )
    throw new WaitlistClientError("Unavailable");
  return Object.freeze({
    waitlistEntryReference: reference(raw.waitlistEntryReference) as string,
    dynamicPosition: integer(raw.dynamicPosition, true),
    partySize: integer(raw.partySize, true),
    customerDisplayName: text(raw.customerDisplayName),
    contactState: oneOf(raw.contactState, ["Verified", "Unverified", "Unavailable"]),
    contactSummary: text(raw.contactSummary),
    status,
    joinMode: oneOf(raw.joinMode, ["Remote", "WalkIn"]),
    areaPreferenceCode: controlled(raw.areaPreferenceCode, true),
    seatingConstraintCodes: Object.freeze(constraints),
    joinedAt: time(raw.joinedAt) as string,
    checkedInAt: time(raw.checkedInAt, true),
    quotedMinimumMinutes,
    quotedMaximumMinutes,
    currentMinimumMinutes,
    currentMaximumMinutes,
    estimateCalculatedAt: time(raw.estimateCalculatedAt) as string,
    estimateCalculationVersion: controlled(raw.estimateCalculationVersion) as string,
    priorityKind,
    priorityReasonCode,
    responseDeadline,
    readyExpiresAt,
    readyExtensionUsed: raw.readyExtensionUsed,
    notificationStatus: oneOf(raw.notificationStatus, [
      "NotRequested",
      "Pending",
      "Delivered",
      "Failed",
      "Unavailable",
    ]),
    seatingEligibility: oneOf(raw.seatingEligibility, [
      "Eligible",
      "WaitingForReady",
      "Ineligible",
      "Unknown",
    ]),
    diningSessionReference,
    overdue: raw.overdue,
    revisionNumber: integer(raw.revisionNumber, true),
    timeline: Object.freeze(timeline),
  });
}
export function parseWaitlistView(
  value: unknown,
  expectedScreenId?: WaitlistScreenId,
): WaitlistView {
  const raw = object(value, ["screenId", "asOfUtc", "freshness", "entries"]);
  const screenId = oneOf(raw.screenId, ["WAIT-BOARD", "WAIT-ENTRY"]);
  if (
    (expectedScreenId !== undefined && screenId !== expectedScreenId) ||
    !Array.isArray(raw.entries)
  )
    throw new WaitlistClientError("Unavailable");
  const entries = raw.entries.map(entry);
  if (
    new Set(entries.map((item) => item.waitlistEntryReference)).size !== entries.length ||
    new Set(entries.map((item) => item.dynamicPosition)).size !== entries.length ||
    entries.some((item, index) => {
      const previous = entries[index - 1];
      return previous !== undefined && item.dynamicPosition <= previous.dynamicPosition;
    }) ||
    (screenId === "WAIT-ENTRY" && entries.length !== 1)
  )
    throw new WaitlistClientError("Unavailable");
  return Object.freeze({
    screenId,
    asOfUtc: time(raw.asOfUtc) as string,
    freshness: oneOf(raw.freshness, ["Current", "Stale"]),
    entries: Object.freeze(entries),
  });
}
export const unavailableWaitlistProjectionClient: WaitlistProjectionClient = Object.freeze({
  async load() {
    throw new WaitlistClientError(navigator.onLine ? "Unavailable" : "Offline");
  },
});
