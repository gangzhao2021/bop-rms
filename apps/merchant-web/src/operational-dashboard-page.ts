export type OperationalDashboardClientErrorCode =
  | "PermissionDenied"
  | "NotFound"
  | "FeatureDisabled"
  | "Stale"
  | "Conflict"
  | "CommandFailed"
  | "Offline"
  | "Unavailable";

export class OperationalDashboardClientError extends Error {
  constructor(readonly code: OperationalDashboardClientErrorCode) {
    super("Operational Dashboard unavailable");
    this.name = "OperationalDashboardClientError";
  }
}

type Completeness = "Complete" | "Partial" | "Stale";
type SourceStatus = "Present" | "Empty" | "Stale" | "Unavailable";
type SourceName =
  | "merchant_order_queue_v1"
  | "payment_operations_v1"
  | "kitchen_operations_v1"
  | "fulfillment_operations_v1"
  | "merchant_order_exception_v1";

interface ScopeOption {
  readonly brandReference: string;
  readonly brandLabel: string;
  readonly storeReference: string;
  readonly storeLabel: string;
}

interface LineageItem {
  readonly sourceName: SourceName;
  readonly sourceCheckpoint: string | null;
  readonly asOfUtc: string | null;
  readonly status: SourceStatus;
  readonly drillTarget: string | null;
}

export interface OperationalDashboardView {
  readonly screenId: "RPT-OPS-DASHBOARD";
  readonly queryName: "reporting_operations_dashboard_v1";
  readonly queryVersion: 1;
  readonly scope: ScopeOption & { readonly tenantReference: string };
  readonly authorizedScopes: readonly ScopeOption[];
  readonly businessDate: string;
  readonly timezone: string;
  readonly currencyCode: "CAD";
  readonly sourceChannel: "All" | "Api" | "Pos" | "Qr" | "Web";
  readonly orderType: "All" | "DineIn" | "Pickup";
  readonly generatedAt: string;
  readonly dataAsOfUtc: string | null;
  readonly completenessStatus: Completeness;
  readonly permissions: {
    readonly mayChangeScope: boolean;
    readonly mayDrill: boolean;
    readonly maySaveView: boolean;
    readonly mayExport: boolean;
    readonly maySchedule: boolean;
  };
  readonly metricVersions: {
    readonly sales: "captured_sales.v1";
    readonly orders: "order_count.v1";
    readonly payments: "payment_operations_count.v1";
    readonly kitchen: "kitchen_work_count.v1";
    readonly fulfillment: "fulfillment_count.v1";
    readonly exceptions: "order_exception_count.v1";
  };
  readonly lineage: readonly LineageItem[];
  readonly sales: {
    readonly capturedAmountMinor: string;
    readonly refundedAmountMinor: string;
    readonly netCapturedAmountMinor: string;
  } | null;
  readonly orders: {
    readonly total: number;
    readonly open: number;
    readonly fulfilled: number;
    readonly rejected: number;
    readonly cancelled: number;
  } | null;
  readonly payments: {
    readonly attempts: number;
    readonly pending: number;
    readonly providerUnknown: number;
    readonly reconciliationDifferences: number;
  } | null;
  readonly kitchen: {
    readonly workItems: number;
    readonly queued: number;
    readonly inProgress: number;
    readonly completed: number;
    readonly exceptions: number;
  } | null;
  readonly fulfillment: {
    readonly fulfillments: number;
    readonly pending: number;
    readonly ready: number;
    readonly inProgress: number;
    readonly completed: number;
    readonly exceptions: number;
  } | null;
  readonly exceptions: { readonly open: number; readonly critical: number } | null;
}

export interface OperationalDashboardClient {
  load(): Promise<unknown>;
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const safeText = /^[^<>{}$\p{Cc}\p{Cf}]{1,160}$/u;
const minorUnits = /^-?(?:0|[1-9]\d{0,30})$/u;
const businessDatePattern = /^\d{4}-\d{2}-\d{2}$/u;
const timezonePattern = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;
const drillTargets = new Set([
  "/operations/orders",
  "/app/operations/payments",
  "/operations/kitchen",
  "/operations/pickup",
  "/operations/order-exceptions",
]);

const fail = (): never => {
  throw new OperationalDashboardClientError("Unavailable");
};
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
const ref = (value: unknown) => (typeof value === "string" && uuid.test(value) ? value : fail());
const text = (value: unknown) =>
  typeof value === "string" && value.trim() === value && safeText.test(value) ? value : fail();
const instant = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  new Date(Date.parse(value)).toISOString() === value
    ? value
    : fail();
const integer = (value: unknown) =>
  Number.isSafeInteger(value) && (value as number) >= 0 ? (value as number) : fail();
const oneOf = <T extends string>(value: unknown, values: readonly T[]) =>
  typeof value === "string" && values.includes(value as T) ? (value as T) : fail();
const permissionObject = (value: unknown) => {
  const parsed = object(value, [
    "mayChangeScope",
    "mayDrill",
    "maySaveView",
    "mayExport",
    "maySchedule",
  ]);
  if (Object.values(parsed).some((entry) => typeof entry !== "boolean")) fail();
  return parsed as unknown as OperationalDashboardView["permissions"];
};
const scopeOption = (value: unknown): ScopeOption => {
  const parsed = object(value, ["brandReference", "brandLabel", "storeReference", "storeLabel"]);
  return Object.freeze({
    brandReference: ref(parsed.brandReference),
    brandLabel: text(parsed.brandLabel),
    storeReference: ref(parsed.storeReference),
    storeLabel: text(parsed.storeLabel),
  });
};
const counts = <T extends readonly string[]>(value: unknown, fields: T) => {
  const parsed = object(value, fields);
  return Object.freeze(Object.fromEntries(fields.map((field) => [field, integer(parsed[field])])));
};

export function parseOperationalDashboardView(value: unknown): OperationalDashboardView {
  const raw = object(value, [
    "screenId",
    "queryName",
    "queryVersion",
    "scope",
    "authorizedScopes",
    "businessDate",
    "timezone",
    "currencyCode",
    "sourceChannel",
    "orderType",
    "generatedAt",
    "dataAsOfUtc",
    "completenessStatus",
    "permissions",
    "metricVersions",
    "lineage",
    "sales",
    "orders",
    "payments",
    "kitchen",
    "fulfillment",
    "exceptions",
  ]);
  if (
    raw.screenId !== "RPT-OPS-DASHBOARD" ||
    raw.queryName !== "reporting_operations_dashboard_v1" ||
    raw.queryVersion !== 1 ||
    raw.currencyCode !== "CAD" ||
    !Array.isArray(raw.authorizedScopes) ||
    raw.authorizedScopes.length > 100 ||
    !Array.isArray(raw.lineage) ||
    raw.lineage.length !== 5 ||
    typeof raw.businessDate !== "string" ||
    !businessDatePattern.test(raw.businessDate) ||
    typeof raw.timezone !== "string" ||
    !timezonePattern.test(raw.timezone)
  )
    fail();
  const businessDate = raw.businessDate as string;
  const timezone = raw.timezone as string;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format(0);
  } catch {
    fail();
  }
  const selectedRaw = object(raw.scope, [
    "tenantReference",
    "brandReference",
    "brandLabel",
    "storeReference",
    "storeLabel",
  ]);
  const selected = Object.freeze({
    tenantReference: ref(selectedRaw.tenantReference),
    brandReference: ref(selectedRaw.brandReference),
    brandLabel: text(selectedRaw.brandLabel),
    storeReference: ref(selectedRaw.storeReference),
    storeLabel: text(selectedRaw.storeLabel),
  });
  const authorizedScopes = Object.freeze((raw.authorizedScopes as unknown[]).map(scopeOption));
  if (
    !authorizedScopes.some(
      (scope) =>
        scope.brandReference === selected.brandReference &&
        scope.storeReference === selected.storeReference &&
        scope.brandLabel === selected.brandLabel &&
        scope.storeLabel === selected.storeLabel,
    )
  )
    fail();
  const permissions = permissionObject(raw.permissions);
  if (!permissions.mayChangeScope && authorizedScopes.length !== 1) fail();
  const versions = object(raw.metricVersions, [
    "sales",
    "orders",
    "payments",
    "kitchen",
    "fulfillment",
    "exceptions",
  ]);
  if (
    versions.sales !== "captured_sales.v1" ||
    versions.orders !== "order_count.v1" ||
    versions.payments !== "payment_operations_count.v1" ||
    versions.kitchen !== "kitchen_work_count.v1" ||
    versions.fulfillment !== "fulfillment_count.v1" ||
    versions.exceptions !== "order_exception_count.v1"
  )
    fail();
  const seen = new Set<SourceName>();
  const lineage = Object.freeze(
    (raw.lineage as unknown[]).map((value) => {
      const item = object(value, [
        "sourceName",
        "sourceCheckpoint",
        "asOfUtc",
        "status",
        "drillTarget",
      ]);
      const sourceName = oneOf(item.sourceName, [
        "merchant_order_queue_v1",
        "payment_operations_v1",
        "kitchen_operations_v1",
        "fulfillment_operations_v1",
        "merchant_order_exception_v1",
      ]);
      if (seen.has(sourceName)) fail();
      seen.add(sourceName);
      const status = oneOf(item.status, ["Present", "Empty", "Stale", "Unavailable"]);
      const sourceCheckpoint = item.sourceCheckpoint === null ? null : ref(item.sourceCheckpoint);
      const asOfUtc = item.asOfUtc === null ? null : instant(item.asOfUtc);
      const drillTarget = item.drillTarget === null ? null : text(item.drillTarget);
      if (
        (status === "Unavailable" && (sourceCheckpoint !== null || asOfUtc !== null)) ||
        (status !== "Unavailable" && (sourceCheckpoint === null || asOfUtc === null)) ||
        (!permissions.mayDrill && drillTarget !== null) ||
        (drillTarget !== null && !drillTargets.has(drillTarget))
      )
        fail();
      return Object.freeze({ sourceName, sourceCheckpoint, asOfUtc, status, drillTarget });
    }),
  );
  const salesRaw =
    raw.sales === null
      ? null
      : object(raw.sales, ["capturedAmountMinor", "refundedAmountMinor", "netCapturedAmountMinor"]);
  const sales =
    salesRaw === null
      ? null
      : Object.freeze({
          capturedAmountMinor:
            typeof salesRaw.capturedAmountMinor === "string" &&
            minorUnits.test(salesRaw.capturedAmountMinor)
              ? salesRaw.capturedAmountMinor
              : fail(),
          refundedAmountMinor:
            typeof salesRaw.refundedAmountMinor === "string" &&
            minorUnits.test(salesRaw.refundedAmountMinor)
              ? salesRaw.refundedAmountMinor
              : fail(),
          netCapturedAmountMinor:
            typeof salesRaw.netCapturedAmountMinor === "string" &&
            minorUnits.test(salesRaw.netCapturedAmountMinor)
              ? salesRaw.netCapturedAmountMinor
              : fail(),
        });
  if (
    sales !== null &&
    BigInt(sales.capturedAmountMinor) - BigInt(sales.refundedAmountMinor) !==
      BigInt(sales.netCapturedAmountMinor)
  )
    fail();
  const orders =
    raw.orders === null
      ? null
      : (counts(raw.orders, ["total", "open", "fulfilled", "rejected", "cancelled"]) as NonNullable<
          OperationalDashboardView["orders"]
        >);
  const payments =
    raw.payments === null
      ? null
      : (counts(raw.payments, [
          "attempts",
          "pending",
          "providerUnknown",
          "reconciliationDifferences",
        ]) as NonNullable<OperationalDashboardView["payments"]>);
  const kitchen =
    raw.kitchen === null
      ? null
      : (counts(raw.kitchen, [
          "workItems",
          "queued",
          "inProgress",
          "completed",
          "exceptions",
        ]) as NonNullable<OperationalDashboardView["kitchen"]>);
  const fulfillment =
    raw.fulfillment === null
      ? null
      : (counts(raw.fulfillment, [
          "fulfillments",
          "pending",
          "ready",
          "inProgress",
          "completed",
          "exceptions",
        ]) as NonNullable<OperationalDashboardView["fulfillment"]>);
  const exceptions =
    raw.exceptions === null
      ? null
      : (counts(raw.exceptions, ["open", "critical"]) as NonNullable<
          OperationalDashboardView["exceptions"]
        >);
  const completenessStatus = oneOf(raw.completenessStatus, ["Complete", "Partial", "Stale"]);
  const sourceStatus = new Map(lineage.map((item) => [item.sourceName, item.status]));
  if (
    (lineage.some((item) => item.status === "Unavailable") && completenessStatus !== "Partial") ||
    (lineage.some((item) => item.status === "Stale") && completenessStatus === "Complete") ||
    (completenessStatus === "Complete" &&
      [sales, orders, payments, kitchen, fulfillment, exceptions].some(
        (metric) => metric === null,
      )) ||
    (sourceStatus.get("merchant_order_queue_v1") === "Unavailable" &&
      [orders, sales, payments, kitchen, fulfillment, exceptions].some(
        (metric) => metric !== null,
      )) ||
    (sourceStatus.get("payment_operations_v1") === "Unavailable" &&
      (sales !== null || payments !== null)) ||
    (sourceStatus.get("kitchen_operations_v1") === "Unavailable" && kitchen !== null) ||
    (sourceStatus.get("fulfillment_operations_v1") === "Unavailable" && fulfillment !== null) ||
    (sourceStatus.get("merchant_order_exception_v1") === "Unavailable" && exceptions !== null) ||
    (orders !== null &&
      orders.open + orders.fulfilled + orders.rejected + orders.cancelled > orders.total) ||
    (payments !== null &&
      [payments.pending, payments.providerUnknown, payments.reconciliationDifferences].some(
        (value) => value > payments.attempts,
      )) ||
    (kitchen !== null &&
      kitchen.queued + kitchen.inProgress + kitchen.completed > kitchen.workItems) ||
    (fulfillment !== null &&
      fulfillment.pending + fulfillment.ready + fulfillment.inProgress + fulfillment.completed >
        fulfillment.fulfillments) ||
    (exceptions !== null && exceptions.critical > exceptions.open)
  )
    fail();
  return Object.freeze({
    screenId: "RPT-OPS-DASHBOARD",
    queryName: "reporting_operations_dashboard_v1",
    queryVersion: 1,
    scope: selected,
    authorizedScopes,
    businessDate,
    timezone,
    currencyCode: "CAD",
    sourceChannel: oneOf(raw.sourceChannel, ["All", "Api", "Pos", "Qr", "Web"]),
    orderType: oneOf(raw.orderType, ["All", "DineIn", "Pickup"]),
    generatedAt: instant(raw.generatedAt),
    dataAsOfUtc: raw.dataAsOfUtc === null ? null : instant(raw.dataAsOfUtc),
    completenessStatus,
    permissions,
    metricVersions: versions as unknown as OperationalDashboardView["metricVersions"],
    lineage,
    sales,
    orders,
    payments,
    kitchen,
    fulfillment,
    exceptions,
  });
}

export const unavailableOperationalDashboardClient: OperationalDashboardClient = {
  load: async () => {
    throw new OperationalDashboardClientError("Unavailable");
  },
};
