export type DeliveryDetailClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class DeliveryDetailClientError extends Error {
  constructor(readonly code: DeliveryDetailClientErrorCode) {
    super("Delivery detail unavailable");
    this.name = "DeliveryDetailClientError";
  }
}
export interface DeliveryDetailView {
  readonly projectionName: "delivery_task_detail_v1";
  readonly projectionVersion: 1;
  readonly screenId: "FUL-DELIVERY-DETAIL";
  readonly taskReference: string;
  readonly orderReference: string;
  readonly aggregateVersion: number;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly executionStatus: string;
  readonly assignmentStatus: string;
  readonly maskedAddress: string;
  readonly maskedContact: string;
  readonly requestedWindow: { readonly startUtc: string; readonly endUtc: string };
  readonly confirmedWindow: { readonly startUtc: string; readonly endUtc: string };
  readonly feeMinor: number;
  readonly currency: string;
  readonly providerOrCourierReference: string | null;
  readonly proofReferences: readonly string[];
  readonly contactAttemptReferences: readonly string[];
  readonly timelineReferences: readonly string[];
  readonly permissions: {
    readonly mayRevise: boolean;
    readonly mayDispatch: boolean;
    readonly mayCancel: boolean;
    readonly mayReassign: boolean;
    readonly mayRecordException: boolean;
  };
}
export interface DeliveryDetailClient {
  load(): Promise<unknown>;
}
const fail = (): never => {
    throw new DeliveryDetailClientError("Unavailable");
  },
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (value: unknown, fields: readonly string[]) => {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !fields.includes(key))
  )
    fail();
  return value as Record<string, unknown>;
};
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail()),
  text = (value: unknown, max = 160) =>
    typeof value === "string" &&
    value.trim() === value &&
    value.length <= max &&
    /^[^<>{}$\p{Cc}\p{Cf}]+$/u.test(value)
      ? value
      : fail(),
  integer = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail(),
  instant = (value: unknown) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
      ? value
      : fail(),
  references = (value: unknown) =>
    Array.isArray(value) && value.length <= 200 ? Object.freeze(value.map(ref)) : fail();
const window = (value: unknown) => {
  const parsed = object(value, ["startUtc", "endUtc"]),
    startUtc = instant(parsed.startUtc),
    endUtc = instant(parsed.endUtc);
  if (startUtc >= endUtc) fail();
  return Object.freeze({ startUtc, endUtc });
};
export function parseDeliveryDetailView(value: unknown): DeliveryDetailView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "taskReference",
    "orderReference",
    "aggregateVersion",
    "asOfUtc",
    "freshness",
    "partial",
    "executionStatus",
    "assignmentStatus",
    "maskedAddress",
    "maskedContact",
    "requestedWindow",
    "confirmedWindow",
    "feeMinor",
    "currency",
    "providerOrCourierReference",
    "proofReferences",
    "contactAttemptReferences",
    "timelineReferences",
    "permissions",
  ]);
  if (
    raw.projectionName !== "delivery_task_detail_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "FUL-DELIVERY-DETAIL" ||
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean"
  )
    fail();
  const permissions = object(raw.permissions, [
    "mayRevise",
    "mayDispatch",
    "mayCancel",
    "mayReassign",
    "mayRecordException",
  ]);
  if (Object.values(permissions).some((item) => typeof item !== "boolean")) fail();
  return Object.freeze({
    projectionName: "delivery_task_detail_v1",
    projectionVersion: 1,
    screenId: "FUL-DELIVERY-DETAIL",
    taskReference: ref(raw.taskReference),
    orderReference: ref(raw.orderReference),
    aggregateVersion: integer(raw.aggregateVersion),
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as DeliveryDetailView["freshness"],
    partial: raw.partial as boolean,
    executionStatus: text(raw.executionStatus, 40),
    assignmentStatus: text(raw.assignmentStatus, 40),
    maskedAddress: text(raw.maskedAddress),
    maskedContact: text(raw.maskedContact),
    requestedWindow: window(raw.requestedWindow),
    confirmedWindow: window(raw.confirmedWindow),
    feeMinor: integer(raw.feeMinor),
    currency: text(raw.currency, 3),
    providerOrCourierReference:
      raw.providerOrCourierReference === null ? null : ref(raw.providerOrCourierReference),
    proofReferences: references(raw.proofReferences),
    contactAttemptReferences: references(raw.contactAttemptReferences),
    timelineReferences: references(raw.timelineReferences),
    permissions: permissions as unknown as DeliveryDetailView["permissions"],
  });
}
export const unavailableDeliveryDetailClient: DeliveryDetailClient = Object.freeze({
  async load() {
    throw new DeliveryDetailClientError("FeatureDisabled");
  },
});
