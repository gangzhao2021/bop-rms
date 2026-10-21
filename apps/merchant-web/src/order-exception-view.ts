/** WP-2423 C2: the order exception projection shape and parser, shared by Home and the exception page. */
export interface OrderExceptionItem {
  readonly exceptionReference: string;
  readonly orderReference: string | null;
  /** WP-2423: the order number staff use (null when unlinked or not this Store's). */
  readonly orderNumber: string | null;
  readonly kind:
    | "DiningUnpaidBatch"
    | "PaymentReconciliationDifference"
    | "CaptureDeadlineExceeded"
    | "PaidWithoutFulfillableOrder";
  readonly severity: "High" | "Critical";
  readonly status: "Open" | "Acknowledged" | "Assigned" | "Resolved";
  readonly providerState: "NotApplicable" | "Pending" | "Unknown" | "Confirmed";
  readonly compensationStatus: "NotRequested" | "Pending" | "Completed";
  readonly sourceOwner: "Dining" | "Payment";
  readonly createdAt: string;
  readonly dueAt: string;
  readonly ownerStatus: "Unassigned" | "Assigned";
  readonly sourceFinal: boolean;
  /** WP-2423: what a payment reconciliation difference is about (absent from older servers). */
  readonly reconciliation?: OrderExceptionReconciliation;
}
/** WP-2423: a business day's totals, one payment, or a charge that matches no order. */
export type OrderExceptionReconciliation =
  | {
      readonly type: "BusinessDayTotals";
      readonly businessDate: string | null;
      readonly captured: { readonly storeMinor: string; readonly providerMinor: string | null };
      readonly refunded: { readonly storeMinor: string; readonly providerMinor: string | null };
      readonly checkedAt: string;
      readonly resolvedAt: string | null;
    }
  /** One payment's check differed; resolvedAt once a later check of it matched the Provider. */
  | { readonly type: "Payment"; readonly resolvedAt: string | null }
  | { readonly type: "UnmatchedCharge" }
  /** WP-2423 D3: the server could not read what this difference is about. */
  | { readonly type: "Unavailable" };

export interface OrderExceptionView {
  readonly screenId: "OPS-ORDER-EXCEPTION";
  readonly projectionName: "merchant_order_exception_v1";
  readonly storeLabel: string;
  readonly businessDate: string;
  readonly projectedAt: string;
  readonly freshnessStatus: "Fresh" | "Stale";
  /** WP-2423: the cursor of the next older page of resolved cases (null: no older ones). */
  readonly olderResolvedBefore: string | null;
  readonly items: readonly OrderExceptionItem[];
}
export interface OrderExceptionClient {
  /** `resolvedBefore` reads an older page of resolved cases (every open case comes each time). */
  load(signal?: AbortSignal, resolvedBefore?: string): Promise<unknown>;
}

/**
 * DEC-EXCEPTION-CONFIRMED-REFUND-DUE (WP-2423): the guest's refund is already confirmed by the
 * payment provider; only the store's check remains, due by the end of the business day.
 */
export function isRefundedAwaitingCheck(item: OrderExceptionItem): boolean {
  return (
    item.kind === "PaidWithoutFulfillableOrder" &&
    item.providerState === "Confirmed" &&
    item.status !== "Resolved"
  );
}
/**
 * WP-2423: an open case is overdue once the projection's time is past its due time. The card,
 * the "Overdue only" filter and Home all use this one rule.
 */
export function isExceptionOverdue(item: OrderExceptionItem, projectedAt: string): boolean {
  return item.status !== "Resolved" && Date.parse(projectedAt) > Date.parse(item.dueAt);
}
/**
 * WP-2423 UI refresh: how long an unresolved case has been open, as of the projection's time
 * ("Open 25 min", "Open 3 h 10 min", "Open 2 days"); null once resolved.
 */
export function exceptionOpenForText(item: OrderExceptionItem, projectedAt: string): string | null {
  if (item.status === "Resolved") return null;
  const minutes = Math.floor((Date.parse(projectedAt) - Date.parse(item.createdAt)) / 60_000);
  if (!Number.isFinite(minutes) || minutes < 0) return null;
  if (minutes < 1) return "Open less than a minute";
  if (minutes < 60) return `Open ${minutes} min`;
  if (minutes < 24 * 60)
    return `Open ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} min`;
  const days = Math.floor(minutes / (24 * 60));
  return `Open ${days} ${days === 1 ? "day" : "days"}`;
}
const REF = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SAFE = /^[^\p{Cc}\p{Cf}]{1,100}$/u;
function exact(value: unknown, keys: readonly string[]) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    throw new Error("ORDER_EXCEPTION_INVALID");
  const output: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable)
      throw new Error("ORDER_EXCEPTION_INVALID");
    output[key] = descriptor.value;
  }
  return output;
}
function ref(value: unknown) {
  if (typeof value !== "string" || !REF.test(value)) throw new Error("ORDER_EXCEPTION_INVALID");
  return value;
}
function instant(value: unknown) {
  if (typeof value !== "string" || !INSTANT.test(value) || new Date(value).toISOString() !== value)
    throw new Error("ORDER_EXCEPTION_INVALID");
  return value;
}
function businessDate(value: unknown) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value))
    throw new Error("ORDER_EXCEPTION_INVALID");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value)
    throw new Error("ORDER_EXCEPTION_INVALID");
  return value;
}
const MINOR = /^(0|[1-9][0-9]{0,15})$/u;
function reconciliation(value: unknown): OrderExceptionReconciliation {
  const type = (value as { type?: unknown } | null)?.type;
  if (type === "Payment") {
    const raw = exact(value, ["type", "resolvedAt"]);
    return Object.freeze({
      type,
      resolvedAt: raw.resolvedAt === null ? null : instant(raw.resolvedAt),
    });
  }
  if (type === "UnmatchedCharge" || type === "Unavailable") {
    exact(value, ["type"]);
    return Object.freeze({ type });
  }
  const raw = exact(value, [
    "type",
    "businessDate",
    "captured",
    "refunded",
    "checkedAt",
    "resolvedAt",
  ]);
  if (raw.type !== "BusinessDayTotals") throw new Error("ORDER_EXCEPTION_INVALID");
  const pair = (input: unknown) => {
    const p = exact(input, ["storeMinor", "providerMinor"]);
    if (
      typeof p.storeMinor !== "string" ||
      !MINOR.test(p.storeMinor) ||
      (p.providerMinor !== null &&
        (typeof p.providerMinor !== "string" || !MINOR.test(p.providerMinor)))
    )
      throw new Error("ORDER_EXCEPTION_INVALID");
    return Object.freeze({ storeMinor: p.storeMinor, providerMinor: p.providerMinor });
  };
  return Object.freeze({
    type: "BusinessDayTotals",
    businessDate: raw.businessDate === null ? null : businessDate(raw.businessDate),
    captured: pair(raw.captured),
    refunded: pair(raw.refunded),
    checkedAt: instant(raw.checkedAt),
    resolvedAt: raw.resolvedAt === null ? null : instant(raw.resolvedAt),
  });
}
export function parseOrderExceptionView(value: unknown): OrderExceptionView {
  const paged =
    value !== null && typeof value === "object" && Object.hasOwn(value, "olderResolvedBefore");
  const input = exact(value, [
    ...(paged ? ["olderResolvedBefore"] : []),
    "screenId",
    "projectionName",
    "storeLabel",
    "businessDate",
    "projectedAt",
    "freshnessStatus",
    "items",
  ]);
  const parsedBusinessDate = businessDate(input.businessDate);
  if (
    input.screenId !== "OPS-ORDER-EXCEPTION" ||
    input.projectionName !== "merchant_order_exception_v1" ||
    typeof input.storeLabel !== "string" ||
    !SAFE.test(input.storeLabel) ||
    !["Fresh", "Stale"].includes(String(input.freshnessStatus)) ||
    !Array.isArray(input.items) ||
    input.items.length > 2000
  )
    throw new Error("ORDER_EXCEPTION_INVALID");
  const items = Object.freeze(
    input.items.map((value) => {
      const hasDetail =
        value !== null && typeof value === "object" && Object.hasOwn(value, "reconciliation");
      const row = exact(value, [
        ...(hasDetail ? ["reconciliation"] : []),
        "exceptionReference",
        "orderReference",
        "orderNumber",
        "kind",
        "severity",
        "status",
        "providerState",
        "compensationStatus",
        "sourceOwner",
        "createdAt",
        "dueAt",
        "ownerStatus",
        "sourceFinal",
      ]);
      if (
        ![
          "DiningUnpaidBatch",
          "PaymentReconciliationDifference",
          "CaptureDeadlineExceeded",
          "PaidWithoutFulfillableOrder",
        ].includes(String(row.kind)) ||
        !["High", "Critical"].includes(String(row.severity)) ||
        !["Open", "Acknowledged", "Assigned", "Resolved"].includes(String(row.status)) ||
        !["NotApplicable", "Pending", "Unknown", "Confirmed"].includes(String(row.providerState)) ||
        !["NotRequested", "Pending", "Completed"].includes(String(row.compensationStatus)) ||
        !["Dining", "Payment"].includes(String(row.sourceOwner)) ||
        !["Unassigned", "Assigned"].includes(String(row.ownerStatus)) ||
        typeof row.sourceFinal !== "boolean" ||
        (row.status === "Resolved") !== row.sourceFinal ||
        (hasDetail && row.kind !== "PaymentReconciliationDifference") ||
        (row.orderNumber !== null &&
          (row.orderReference === null ||
            typeof row.orderNumber !== "string" ||
            !/^[A-Z0-9][A-Z0-9-]{0,39}$/u.test(row.orderNumber)))
      )
        throw new Error("ORDER_EXCEPTION_INVALID");
      return Object.freeze({
        ...row,
        exceptionReference: ref(row.exceptionReference),
        orderReference:
          row.orderReference === null &&
          row.kind === "PaymentReconciliationDifference" &&
          row.sourceOwner === "Payment"
            ? null
            : ref(row.orderReference),
        createdAt: instant(row.createdAt),
        dueAt: instant(row.dueAt),
        ...(hasDetail ? { reconciliation: reconciliation(row.reconciliation) } : {}),
      }) as unknown as OrderExceptionItem;
    }),
  );
  if (new Set(items.map((item) => item.exceptionReference)).size !== items.length)
    throw new Error("ORDER_EXCEPTION_INVALID");
  return Object.freeze({
    screenId: "OPS-ORDER-EXCEPTION",
    projectionName: "merchant_order_exception_v1",
    storeLabel: input.storeLabel,
    businessDate: parsedBusinessDate,
    projectedAt: instant(input.projectedAt),
    freshnessStatus: input.freshnessStatus as "Fresh" | "Stale",
    olderResolvedBefore:
      !paged || input.olderResolvedBefore === null ? null : ref(input.olderResolvedBefore),
    items,
  });
}
