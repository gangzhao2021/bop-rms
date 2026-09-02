import type { FulfillmentOperationalProjection } from "./fulfillment-operational.js";
import type { KitchenOperationalProjection } from "./kitchen-operational.js";
import type { OrderExceptionProjection } from "./order-exception.js";
import type { OrderOperationalProjection } from "./order-operational.js";
import type { PaymentOperationalProjection } from "./payment-operational.js";
import {
  assertProjectionScope,
  projectionExact,
  projectionFail,
  projectionInstant,
  projectionReference,
  validateBusinessDate,
} from "./projection-contract.js";

export const operationalDashboardQueryName = "reporting_operations_dashboard_v1" as const;
export const operationalDashboardPermission = "reporting.read" as const;

type Scope = Readonly<{
  tenantReference: string;
  brandReference: string;
  storeReference: string;
}>;

export interface OperationalDashboardQuery extends Scope {
  readonly queryReference: string;
  readonly permission: typeof operationalDashboardPermission;
  readonly purpose: "OperationalReporting";
  readonly businessDate: string;
  readonly timezone: string;
  readonly currencyCode: "CAD";
  readonly sourceChannel: "All" | "Api" | "Pos" | "Qr" | "Web";
  readonly orderType: "All" | "DineIn" | "Pickup";
  readonly requestedAt: string;
  readonly requestedByActorReference: string;
}

export interface OperationalDashboardLineage {
  readonly sourceName:
    | "merchant_order_queue_v1"
    | "payment_operations_v1"
    | "kitchen_operations_v1"
    | "fulfillment_operations_v1"
    | "merchant_order_exception_v1";
  readonly sourceCheckpoint: string | null;
  readonly asOfUtc: string | null;
  readonly status: "Present" | "Empty" | "Stale" | "Unavailable";
}

export interface OperationalDashboardResult extends Scope {
  readonly queryName: typeof operationalDashboardQueryName;
  readonly queryVersion: 1;
  readonly queryReference: string;
  readonly businessDate: string;
  readonly timezone: string;
  readonly currencyCode: "CAD";
  readonly sourceChannel: OperationalDashboardQuery["sourceChannel"];
  readonly orderType: OperationalDashboardQuery["orderType"];
  readonly generatedAt: string;
  readonly dataAsOfUtc: string | null;
  readonly completenessStatus: "Complete" | "Partial" | "Stale";
  readonly metricVersions: Readonly<{
    sales: "captured_sales.v1";
    orders: "order_count.v1";
    payments: "payment_operations_count.v1";
    kitchen: "kitchen_work_count.v1";
    fulfillment: "fulfillment_count.v1";
    exceptions: "order_exception_count.v1";
  }>;
  readonly lineage: readonly OperationalDashboardLineage[];
  readonly sales: Readonly<{
    capturedAmountMinor: string;
    refundedAmountMinor: string;
    netCapturedAmountMinor: string;
  }> | null;
  readonly orders: Readonly<{
    total: number;
    open: number;
    fulfilled: number;
    rejected: number;
    cancelled: number;
  }> | null;
  readonly payments: Readonly<{
    attempts: number;
    pending: number;
    providerUnknown: number;
    reconciliationDifferences: number;
  }> | null;
  readonly kitchen: Readonly<{
    workItems: number;
    queued: number;
    inProgress: number;
    completed: number;
    exceptions: number;
  }> | null;
  readonly fulfillment: Readonly<{
    fulfillments: number;
    pending: number;
    ready: number;
    inProgress: number;
    completed: number;
    exceptions: number;
  }> | null;
  readonly exceptions: Readonly<{
    open: number;
    critical: number;
  }> | null;
}

export interface OperationalDashboardSources {
  readonly order: OrderOperationalProjection | null;
  readonly payment: PaymentOperationalProjection | null;
  readonly kitchen: KitchenOperationalProjection | null;
  readonly fulfillment: FulfillmentOperationalProjection | null;
  readonly exception: OrderExceptionProjection | null;
}

const TIMEZONE = /^[A-Za-z_+-]+(?:\/[A-Za-z0-9_+-]+)+$/u;

export function parseOperationalDashboardQuery(value: unknown): OperationalDashboardQuery {
  const raw = projectionExact(value, [
    "queryReference",
    "permission",
    "purpose",
    "tenantReference",
    "brandReference",
    "storeReference",
    "businessDate",
    "timezone",
    "currencyCode",
    "sourceChannel",
    "orderType",
    "requestedAt",
    "requestedByActorReference",
  ]);
  if (
    raw.permission !== operationalDashboardPermission ||
    raw.purpose !== "OperationalReporting" ||
    typeof raw.timezone !== "string" ||
    !TIMEZONE.test(raw.timezone) ||
    raw.currencyCode !== "CAD" ||
    !["All", "Api", "Pos", "Qr", "Web"].includes(String(raw.sourceChannel)) ||
    !["All", "DineIn", "Pickup"].includes(String(raw.orderType))
  )
    return projectionFail("INPUT_INVALID");
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: raw.timezone }).format(0);
  } catch {
    return projectionFail("INPUT_INVALID");
  }
  return Object.freeze({
    queryReference: projectionReference(raw.queryReference),
    permission: operationalDashboardPermission,
    purpose: "OperationalReporting",
    tenantReference: projectionReference(raw.tenantReference),
    brandReference: projectionReference(raw.brandReference),
    storeReference: projectionReference(raw.storeReference),
    businessDate: validateBusinessDate(raw.businessDate),
    timezone: raw.timezone,
    currencyCode: "CAD",
    sourceChannel: raw.sourceChannel,
    orderType: raw.orderType,
    requestedAt: projectionInstant(raw.requestedAt),
    requestedByActorReference: projectionReference(raw.requestedByActorReference),
  }) as OperationalDashboardQuery;
}

function sourceLineage(
  sourceName: OperationalDashboardLineage["sourceName"],
  source:
    | OrderOperationalProjection
    | PaymentOperationalProjection
    | KitchenOperationalProjection
    | FulfillmentOperationalProjection
    | OrderExceptionProjection
    | null,
): OperationalDashboardLineage {
  if (source === null)
    return Object.freeze({
      sourceName,
      sourceCheckpoint: null,
      asOfUtc: null,
      status: "Unavailable",
    });
  const sourceCheckpoint =
    "sourceCheckpoint" in source ? source.sourceCheckpoint : source.checkpointReference;
  const asOfUtc = "asOfUtc" in source ? source.asOfUtc : source.projectedAt;
  return Object.freeze({
    sourceName,
    sourceCheckpoint,
    asOfUtc,
    status:
      source.freshnessStatus === "Stale" ? "Stale" : source.initializedEmpty ? "Empty" : "Present",
  });
}

function validateSource(
  source: OperationalDashboardSources[keyof OperationalDashboardSources],
  scope: Scope,
  businessDate: string,
): void {
  if (source === null) return;
  assertProjectionScope(source, scope);
  if (source.businessDate !== businessDate) projectionFail("SCOPE_MISMATCH");
}

const count = <T>(items: readonly T[], predicate: (item: T) => boolean) =>
  items.reduce((total, item) => total + (predicate(item) ? 1 : 0), 0);

export function buildOperationalDashboardQuery(input: {
  readonly query: unknown;
  readonly authorizedPermissions: readonly string[];
  readonly sources: OperationalDashboardSources;
  readonly generatedAt: string;
}): OperationalDashboardResult {
  const query = parseOperationalDashboardQuery(input.query);
  if (!input.authorizedPermissions.includes(operationalDashboardPermission))
    projectionFail("PERMISSION_DENIED");
  const generatedAt = projectionInstant(input.generatedAt);
  if (Date.parse(generatedAt) < Date.parse(query.requestedAt)) projectionFail("INPUT_INVALID");
  const scope = {
    tenantReference: query.tenantReference,
    brandReference: query.brandReference,
    storeReference: query.storeReference,
  };
  for (const source of Object.values(input.sources))
    validateSource(source, scope, query.businessDate);
  if (input.sources.kitchen?.stationReference !== null && input.sources.kitchen !== null)
    projectionFail("SCOPE_MISMATCH");

  const lineage = Object.freeze([
    sourceLineage("merchant_order_queue_v1", input.sources.order),
    sourceLineage("payment_operations_v1", input.sources.payment),
    sourceLineage("kitchen_operations_v1", input.sources.kitchen),
    sourceLineage("fulfillment_operations_v1", input.sources.fulfillment),
    sourceLineage("merchant_order_exception_v1", input.sources.exception),
  ]);
  const availableTimes = lineage.flatMap((item) => (item.asOfUtc === null ? [] : [item.asOfUtc]));
  const dataAsOfUtc =
    availableTimes.length === 0
      ? null
      : availableTimes.reduce((oldest, value) =>
          Date.parse(value) < Date.parse(oldest) ? value : oldest,
        );
  const completenessStatus = lineage.some((item) => item.status === "Unavailable")
    ? "Partial"
    : lineage.some((item) => item.status === "Stale")
      ? "Stale"
      : "Complete";

  const selectedOrders = input.sources.order?.rows.filter(
    (row) =>
      (query.sourceChannel === "All" || row.sourceChannel === query.sourceChannel) &&
      (query.orderType === "All" || row.orderType === query.orderType),
  );
  const selectedReferences = new Set(selectedOrders?.map((row) => row.orderReference) ?? []);
  if (input.sources.order !== null) {
    const knownReferences = new Set(input.sources.order.rows.map((row) => row.orderReference));
    const hasUnknownOrder = [
      ...(input.sources.payment?.rows ?? []),
      ...(input.sources.kitchen?.rows ?? []),
      ...(input.sources.fulfillment?.rows ?? []),
      ...(input.sources.exception?.rows ?? []),
    ].some((row) => !knownReferences.has(row.orderReference));
    if (hasUnknownOrder) projectionFail("SOURCE_CONFLICT");
  }
  const dependentRows = <T extends { readonly orderReference: string }>(rows: readonly T[]) =>
    rows.filter((row) => selectedReferences.has(row.orderReference));
  const paymentRows =
    selectedOrders === undefined || input.sources.payment === null
      ? null
      : dependentRows(input.sources.payment.rows);
  const kitchenRows =
    selectedOrders === undefined || input.sources.kitchen === null
      ? null
      : dependentRows(input.sources.kitchen.rows);
  const fulfillmentRows =
    selectedOrders === undefined || input.sources.fulfillment === null
      ? null
      : dependentRows(input.sources.fulfillment.rows);
  const exceptionRows =
    selectedOrders === undefined || input.sources.exception === null
      ? null
      : dependentRows(input.sources.exception.rows);

  const captured = paymentRows?.reduce((total, row) => total + BigInt(row.capturedAmountMinor), 0n);
  const refunded = paymentRows?.reduce((total, row) => total + BigInt(row.refundedAmountMinor), 0n);
  return Object.freeze({
    queryName: operationalDashboardQueryName,
    queryVersion: 1,
    queryReference: query.queryReference,
    ...scope,
    businessDate: query.businessDate,
    timezone: query.timezone,
    currencyCode: "CAD",
    sourceChannel: query.sourceChannel,
    orderType: query.orderType,
    generatedAt,
    dataAsOfUtc,
    completenessStatus,
    metricVersions: Object.freeze({
      sales: "captured_sales.v1",
      orders: "order_count.v1",
      payments: "payment_operations_count.v1",
      kitchen: "kitchen_work_count.v1",
      fulfillment: "fulfillment_count.v1",
      exceptions: "order_exception_count.v1",
    }),
    lineage,
    sales:
      captured === undefined || refunded === undefined
        ? null
        : Object.freeze({
            capturedAmountMinor: captured.toString(),
            refundedAmountMinor: refunded.toString(),
            netCapturedAmountMinor: (captured - refunded).toString(),
          }),
    orders:
      selectedOrders === undefined
        ? null
        : Object.freeze({
            total: selectedOrders.length,
            open: count(selectedOrders, (row) => ["Submitted", "Confirmed"].includes(row.phase)),
            fulfilled: count(selectedOrders, (row) => row.phase === "Fulfilled"),
            rejected: count(selectedOrders, (row) => row.phase === "Rejected"),
            cancelled: count(selectedOrders, (row) => row.phase === "Cancelled"),
          }),
    payments:
      paymentRows === null
        ? null
        : Object.freeze({
            attempts: paymentRows.length,
            pending: count(paymentRows, (row) =>
              ["Created", "Pending", "Authorized"].includes(row.state),
            ),
            providerUnknown: count(paymentRows, (row) => row.providerState === "Unknown"),
            reconciliationDifferences: count(
              paymentRows,
              (row) => row.reconciliationStatus === "Difference",
            ),
          }),
    kitchen:
      kitchenRows === null
        ? null
        : Object.freeze({
            workItems: kitchenRows.length,
            queued: count(kitchenRows, (row) => row.status === "Queued"),
            inProgress: count(kitchenRows, (row) => row.status === "InProgress"),
            completed: count(kitchenRows, (row) => row.status === "Completed"),
            exceptions: count(kitchenRows, (row) => row.exceptionReference !== null),
          }),
    fulfillment:
      fulfillmentRows === null
        ? null
        : Object.freeze({
            fulfillments: fulfillmentRows.length,
            pending: count(fulfillmentRows, (row) => row.phase === "Pending"),
            ready: count(fulfillmentRows, (row) => row.phase === "Ready"),
            inProgress: count(fulfillmentRows, (row) => row.phase === "InProgress"),
            completed: count(fulfillmentRows, (row) => row.phase === "Completed"),
            exceptions: count(fulfillmentRows, (row) => row.exceptionReference !== null),
          }),
    exceptions:
      exceptionRows === null
        ? null
        : Object.freeze({
            open: count(exceptionRows, (row) => row.status !== "Resolved"),
            critical: count(
              exceptionRows,
              (row) => row.status !== "Resolved" && row.severity === "Critical",
            ),
          }),
  });
}
