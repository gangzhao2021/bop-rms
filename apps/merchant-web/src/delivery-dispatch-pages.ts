export type DeliveryDispatchClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class DeliveryDispatchClientError extends Error {
  constructor(readonly code: DeliveryDispatchClientErrorCode) {
    super("Delivery dispatch unavailable");
    this.name = "DeliveryDispatchClientError";
  }
}
type Execution =
  "Planned" | "AtStore" | "PickedUp" | "EnRoute" | "Delivered" | "Failed" | "Cancelled";
type Assignment =
  "Unassigned" | "Searching" | "Offered" | "Assigned" | "Accepted" | "ReassignmentRequired";
export interface DeliveryDispatchView {
  readonly projectionName: "delivery_task_queue_v1";
  readonly projectionVersion: 1;
  readonly screenId: "FUL-DELIVERY-DISPATCH";
  readonly storeLabel: string;
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayAssign: boolean;
    readonly mayAccept: boolean;
    readonly mayStart: boolean;
    readonly mayReassign: boolean;
    readonly mayOpenException: boolean;
  };
  readonly rows: readonly {
    readonly taskReference: string;
    readonly orderReference: string;
    readonly aggregateVersion: number;
    readonly executionStatus: Execution;
    readonly assignmentStatus: Assignment;
    readonly confirmedWindowReference: string;
    readonly zoneReference: string;
    readonly providerOrCourierReference: string | null;
    readonly handoffState: "NotReady" | "Ready" | "HandedOff";
    readonly ageSeconds: number;
    readonly overdue: boolean;
    readonly openExceptionCount: number;
  }[];
}
export interface DeliveryDispatchClient {
  load(): Promise<unknown>;
}
const fail = (): never => {
    throw new DeliveryDispatchClientError("Unavailable");
  },
  uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const object = (v: unknown, f: readonly string[]) => {
  if (
    !v ||
    typeof v !== "object" ||
    Array.isArray(v) ||
    Object.getPrototypeOf(v) !== Object.prototype ||
    Reflect.ownKeys(v).length !== f.length ||
    Reflect.ownKeys(v).some((k) => typeof k !== "string" || !f.includes(k))
  )
    fail();
  return v as Record<string, unknown>;
};
const ref = (v: unknown) => (typeof v === "string" && uuid.test(v) ? v : fail()),
  text = (v: unknown) =>
    typeof v === "string" && v.trim() === v && /^[^\p{Cc}\p{Cf}<>{}$]{1,200}$/u.test(v)
      ? v
      : fail(),
  integer = (v: unknown) =>
    Number.isSafeInteger(v) && (v as number) >= 0 ? (v as number) : fail(),
  instant = (v: unknown) =>
    typeof v === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(v) &&
    new Date(Date.parse(v)).toISOString() === v
      ? v
      : fail();
export function parseDeliveryDispatchView(value: unknown): DeliveryDispatchView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "storeLabel",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
  ]);
  if (
    raw.projectionName !== "delivery_task_queue_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "FUL-DELIVERY-DISPATCH" ||
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 500
  )
    fail();
  const p = object(raw.permissions, [
    "mayAssign",
    "mayAccept",
    "mayStart",
    "mayReassign",
    "mayOpenException",
  ]);
  if (Object.values(p).some((v) => typeof v !== "boolean")) fail();
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((v) => {
      const r = object(v, [
        "taskReference",
        "orderReference",
        "aggregateVersion",
        "executionStatus",
        "assignmentStatus",
        "confirmedWindowReference",
        "zoneReference",
        "providerOrCourierReference",
        "handoffState",
        "ageSeconds",
        "overdue",
        "openExceptionCount",
      ]);
      if (
        !["Planned", "AtStore", "PickedUp", "EnRoute", "Delivered", "Failed", "Cancelled"].includes(
          r.executionStatus as string,
        ) ||
        ![
          "Unassigned",
          "Searching",
          "Offered",
          "Assigned",
          "Accepted",
          "ReassignmentRequired",
        ].includes(r.assignmentStatus as string) ||
        !["NotReady", "Ready", "HandedOff"].includes(r.handoffState as string) ||
        typeof r.overdue !== "boolean"
      )
        fail();
      return Object.freeze({
        taskReference: ref(r.taskReference),
        orderReference: ref(r.orderReference),
        aggregateVersion: integer(r.aggregateVersion),
        executionStatus: r.executionStatus as Execution,
        assignmentStatus: r.assignmentStatus as Assignment,
        confirmedWindowReference: ref(r.confirmedWindowReference),
        zoneReference: ref(r.zoneReference),
        providerOrCourierReference:
          r.providerOrCourierReference === null ? null : ref(r.providerOrCourierReference),
        handoffState: r.handoffState as "NotReady" | "Ready" | "HandedOff",
        ageSeconds: integer(r.ageSeconds),
        overdue: r.overdue as boolean,
        openExceptionCount: integer(r.openExceptionCount),
      });
    }),
  );
  return Object.freeze({
    projectionName: "delivery_task_queue_v1",
    projectionVersion: 1,
    screenId: "FUL-DELIVERY-DISPATCH",
    storeLabel: text(raw.storeLabel),
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as DeliveryDispatchView["freshness"],
    partial: raw.partial as boolean,
    permissions: p as unknown as DeliveryDispatchView["permissions"],
    rows,
  });
}
export const unavailableDeliveryDispatchClient: DeliveryDispatchClient = Object.freeze({
  async load() {
    throw new DeliveryDispatchClientError("FeatureDisabled");
  },
});
