export type DeliveryExceptionClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "Validation"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";
export class DeliveryExceptionClientError extends Error {
  constructor(readonly code: DeliveryExceptionClientErrorCode) {
    super("Delivery exception unavailable");
    this.name = "DeliveryExceptionClientError";
  }
}
type Lifecycle = "Open" | "Contacting" | "ActionRequired" | "Escalated" | "Resolved";
export interface DeliveryExceptionView {
  readonly projectionName: "delivery_exception_workbench_v1";
  readonly projectionVersion: 1;
  readonly screenId: "FUL-DELIVERY-EXCEPTION";
  readonly asOfUtc: string;
  readonly freshness: "Current" | "Stale" | "Rebuilding";
  readonly partial: boolean;
  readonly permissions: {
    readonly mayAcknowledge: boolean;
    readonly mayAssign: boolean;
    readonly mayReroute: boolean;
    readonly mayRequestCancel: boolean;
    readonly mayHandoffSupport: boolean;
    readonly mayResolve: boolean;
  };
  readonly rows: readonly {
    readonly exceptionReference: string;
    readonly taskReference: string;
    readonly orderReference: string;
    readonly aggregateVersion: number;
    readonly lifecycle: Lifecycle;
    readonly severity: "AtRisk" | "Delayed" | "Critical";
    readonly reason: string;
    readonly ownerReference: string | null;
    readonly providerReference: string | null;
    readonly resolutionDeadline: string;
    readonly overdue: boolean;
    readonly customerImpact: "None" | "Delayed" | "ActionRequired";
    readonly resolutionOrCompensationReference: string | null;
  }[];
}
export interface DeliveryExceptionClient {
  load(): Promise<unknown>;
}
const fail = (): never => {
    throw new DeliveryExceptionClientError("Unavailable");
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
  instant = (value: unknown) =>
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
    new Date(Date.parse(value)).toISOString() === value
      ? value
      : fail(),
  integer = (value: unknown) =>
    Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail(),
  reason = (value: unknown) =>
    typeof value === "string" && /^[A-Z][A-Z0-9_]{1,63}$/u.test(value) ? value : fail();
export function parseDeliveryExceptionView(value: unknown): DeliveryExceptionView {
  const raw = object(value, [
    "projectionName",
    "projectionVersion",
    "screenId",
    "asOfUtc",
    "freshness",
    "partial",
    "permissions",
    "rows",
  ]);
  if (
    raw.projectionName !== "delivery_exception_workbench_v1" ||
    raw.projectionVersion !== 1 ||
    raw.screenId !== "FUL-DELIVERY-EXCEPTION" ||
    !["Current", "Stale", "Rebuilding"].includes(raw.freshness as string) ||
    typeof raw.partial !== "boolean" ||
    !Array.isArray(raw.rows) ||
    raw.rows.length > 500
  )
    fail();
  const permissions = object(raw.permissions, [
    "mayAcknowledge",
    "mayAssign",
    "mayReroute",
    "mayRequestCancel",
    "mayHandoffSupport",
    "mayResolve",
  ]);
  if (Object.values(permissions).some((item) => typeof item !== "boolean")) fail();
  const rows = Object.freeze(
    (raw.rows as unknown[]).map((value) => {
      const row = object(value, [
        "exceptionReference",
        "taskReference",
        "orderReference",
        "aggregateVersion",
        "lifecycle",
        "severity",
        "reason",
        "ownerReference",
        "providerReference",
        "resolutionDeadline",
        "overdue",
        "customerImpact",
        "resolutionOrCompensationReference",
      ]);
      if (
        !["Open", "Contacting", "ActionRequired", "Escalated", "Resolved"].includes(
          row.lifecycle as string,
        ) ||
        !["AtRisk", "Delayed", "Critical"].includes(row.severity as string) ||
        !["None", "Delayed", "ActionRequired"].includes(row.customerImpact as string) ||
        typeof row.overdue !== "boolean"
      )
        fail();
      return Object.freeze({
        exceptionReference: ref(row.exceptionReference),
        taskReference: ref(row.taskReference),
        orderReference: ref(row.orderReference),
        aggregateVersion: integer(row.aggregateVersion),
        lifecycle: row.lifecycle as Lifecycle,
        severity: row.severity as "AtRisk" | "Delayed" | "Critical",
        reason: reason(row.reason),
        ownerReference: row.ownerReference === null ? null : ref(row.ownerReference),
        providerReference: row.providerReference === null ? null : ref(row.providerReference),
        resolutionDeadline: instant(row.resolutionDeadline),
        overdue: row.overdue as boolean,
        customerImpact: row.customerImpact as "None" | "Delayed" | "ActionRequired",
        resolutionOrCompensationReference:
          row.resolutionOrCompensationReference === null
            ? null
            : ref(row.resolutionOrCompensationReference),
      });
    }),
  );
  return Object.freeze({
    projectionName: "delivery_exception_workbench_v1",
    projectionVersion: 1,
    screenId: "FUL-DELIVERY-EXCEPTION",
    asOfUtc: instant(raw.asOfUtc),
    freshness: raw.freshness as DeliveryExceptionView["freshness"],
    partial: raw.partial as boolean,
    permissions: permissions as unknown as DeliveryExceptionView["permissions"],
    rows,
  });
}
export const unavailableDeliveryExceptionClient: DeliveryExceptionClient = Object.freeze({
  async load() {
    throw new DeliveryExceptionClientError("FeatureDisabled");
  },
});
