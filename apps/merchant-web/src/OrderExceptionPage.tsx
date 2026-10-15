import { ReconciliationFollowUpAction } from "./ReconciliationFollowUpAction.js";
import { CompensationReconciliationAction } from "./CompensationReconciliationAction.js";
import { UnmatchedCaptureRefundAction } from "./UnmatchedCaptureRefundAction.js";
import { createOrderExceptionClient } from "./order-exception-client.js";
import { StatePanel } from "@bop-rms/ui";
import { Freshness, SourceTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { businessDateText } from "./StoreBusinessDay.js";
import { formatSettlementMoney } from "./SettlementPage.js";
import { Link } from "react-router";

/** Staff labels for the exception kinds and states the projection carries. */
export const exceptionKindLabel: Record<OrderExceptionItem["kind"], string> = {
  DiningUnpaidBatch: "Unpaid dine-in batch",
  PaymentReconciliationDifference: "Payment reconciliation difference",
  CaptureDeadlineExceeded: "Capture deadline exceeded",
  PaidWithoutFulfillableOrder: "Paid without a fulfillable order",
};
const providerStateLabel: Record<OrderExceptionItem["providerState"], string> = {
  // Shown as "Payment provider status".
  NotApplicable: "Not applicable",
  Pending: "Pending",
  Unknown: "Unknown",
  Confirmed: "Confirmed",
};
const compensationLabel: Record<OrderExceptionItem["compensationStatus"], string> = {
  NotRequested: "Not requested",
  Pending: "Pending",
  Completed: "Completed",
};
import { useEffect, useRef, useState, type Ref } from "react";

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
  | { readonly type: "Payment" }
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
  readonly items: readonly OrderExceptionItem[];
}
export interface OrderExceptionClient {
  load(signal?: AbortSignal): Promise<unknown>;
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
  if (type === "Payment" || type === "UnmatchedCharge" || type === "Unavailable") {
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
  const input = exact(value, [
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
    input.items.length > 500
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
    items,
  });
}
export function OrderExceptionScreen({
  view,
  onRefresh,
  refreshButtonRef,
  csrf,
}: {
  readonly view: OrderExceptionView;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: Ref<HTMLButtonElement>;
  readonly csrf?: string | undefined;
}) {
  const [kindFilter, setKindFilter] = useState("All");
  const [severityFilter, setSeverityFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [ownerFilter, setOwnerFilter] = useState("All");
  const [providerFilter, setProviderFilter] = useState("All");
  const [overdueOnly, setOverdueOnly] = useState(false);
  const readOnly = view.freshnessStatus !== "Fresh";
  const items = view.items.filter(
    (item) =>
      (kindFilter === "All" || item.kind === kindFilter) &&
      (severityFilter === "All" || item.severity === severityFilter) &&
      (statusFilter === "All" || item.status === statusFilter) &&
      (ownerFilter === "All" || item.ownerStatus === ownerFilter) &&
      (providerFilter === "All" || item.providerState === providerFilter) &&
      (!overdueOnly ||
        (item.status !== "Resolved" && Date.parse(view.projectedAt) > Date.parse(item.dueAt))),
  );
  const hasFilters =
    kindFilter !== "All" ||
    severityFilter !== "All" ||
    statusFilter !== "All" ||
    ownerFilter !== "All" ||
    providerFilter !== "All" ||
    overdueOnly;
  const visibleReferences = new Set(items.map((item) => item.exceptionReference));
  return (
    <WorkspacePage
      className="order-exception-page"
      title="Exceptions"
      meta={`${view.storeLabel} · Business date ${businessDateText(view.businessDate)}`}
      status={<Freshness status={view.freshnessStatus} at={view.projectedAt} />}
      actions={
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          Refresh
        </button>
      }
    >
      <>
        {readOnly ? (
          <StatePanel heading="Data may be out of date" tone="offline" status>
            <p>Refresh before taking an action.</p>
          </StatePanel>
        ) : null}
        <div className="list-filters order-exception-filters">
          <label>
            Type
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.currentTarget.value)}
            >
              <option value="All">All</option>
              {(Object.keys(exceptionKindLabel) as OrderExceptionItem["kind"][]).map((kind) => (
                <option key={kind} value={kind}>
                  {exceptionKindLabel[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.currentTarget.value)}
            >
              <option>All</option>
              <option>High</option>
              <option>Critical</option>
            </select>
          </label>
          <label>
            Status
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.currentTarget.value)}
            >
              <option>All</option>
              <option>Open</option>
              <option>Acknowledged</option>
              <option>Assigned</option>
              <option>Resolved</option>
            </select>
          </label>
          <label>
            Owner
            <select
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.currentTarget.value)}
            >
              <option>All</option>
              <option>Unassigned</option>
              <option>Assigned</option>
            </select>
          </label>
          <label>
            Payment provider status
            <select
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.currentTarget.value)}
            >
              <option value="All">All</option>
              <option value="NotApplicable">Not applicable</option>
              <option value="Pending">Pending</option>
              <option value="Unknown">Unknown</option>
              <option value="Confirmed">Confirmed</option>
            </select>
          </label>
          <label className="order-exception-overdue-filter">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(event) => setOverdueOnly(event.currentTarget.checked)}
            />
            Overdue only
          </label>
          <button
            type="button"
            disabled={!hasFilters}
            onClick={() => {
              setKindFilter("All");
              setSeverityFilter("All");
              setStatusFilter("All");
              setOwnerFilter("All");
              setProviderFilter("All");
              setOverdueOnly(false);
            }}
          >
            Clear filters
          </button>
        </div>
        {items.length === 0 ? (
          <StatePanel
            heading={
              view.items.length === 0
                ? "No exceptions in this view"
                : "No exceptions match these filters"
            }
            tone="neutral"
            status
          >
            <p>
              {view.items.length === 0
                ? "There are no open exceptions for this Store."
                : "No exception on this page matches the filters."}
            </p>
          </StatePanel>
        ) : null}
        <div className="store-card-grid">
          {view.items.map((item) => (
            <article
              className="store-card order-exception__card"
              hidden={!visibleReferences.has(item.exceptionReference)}
              key={item.exceptionReference}
            >
              <OrderExceptionCard item={item} csrf={csrf} readOnly={readOnly} />
            </article>
          ))}
        </div>
      </>
    </WorkspacePage>
  );
}
/** "Refunds: the payment provider has $22.60 more than the store" — which side differed and by how much. */
function totalsDifference(
  label: string,
  pair: { readonly storeMinor: string; readonly providerMinor: string | null },
): string | null {
  if (pair.providerMinor === null)
    return `${label}: the payment provider's figure could not be read`;
  const gap = BigInt(pair.providerMinor) - BigInt(pair.storeMinor);
  if (gap === 0n) return null;
  return `${label}: the payment provider has ${formatSettlementMoney(
    (gap < 0n ? -gap : gap).toString(),
  )} ${gap > 0n ? "more" : "less"} than the store`;
}
const settlementLink = (businessDate: string | null) =>
  businessDate === null
    ? "/app/operations/payment-reconciliation"
    : `/app/operations/payment-reconciliation?businessDate=${businessDate}`;

/** WP-2423: one exception card, worded for what the exception is about. */
function OrderExceptionCard({
  item,
  csrf,
  readOnly,
}: {
  readonly item: OrderExceptionItem;
  readonly csrf: string | undefined;
  readonly readOnly: boolean;
}) {
  const detail = item.reconciliation;
  const payment = item.kind === "PaymentReconciliationDifference" && item.sourceOwner === "Payment";
  const header = (title: string) => (
    <header>
      <div>
        <p className="bop-eyebrow order-exception__severity" data-severity={item.severity}>
          {item.severity} · due <SourceTime instant={item.dueAt} />
        </p>
        <h3>{title}</h3>
      </div>
      <strong className="order-exception__status" data-status={item.status}>
        {item.status}
      </strong>
    </header>
  );
  if (payment && detail?.type === "Unavailable") {
    // WP-2423 D3: never guess the kind of difference (and its actions) without its details.
    return (
      <>
        {header(exceptionKindLabel[item.kind])}
        <dl>
          <div>
            <dt>Created</dt>
            <dd>
              <SourceTime instant={item.createdAt} />
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{item.ownerStatus}</dd>
          </div>
        </dl>
        <p role="note">
          The details of this payment difference could not be loaded, so what to do next is not
          shown. Refresh the page to try again.
        </p>
      </>
    );
  }
  if (payment && detail?.type === "BusinessDayTotals") {
    const day = detail.businessDate === null ? null : businessDateText(detail.businessDate);
    const differences = [
      totalsDifference("Payments taken", detail.captured),
      totalsDifference("Refunds", detail.refunded),
    ].filter((text): text is string => text !== null);
    return (
      <>
        {header("Business day totals differ from the payment provider")}
        <dl>
          <div>
            <dt>Business day</dt>
            <dd>{day ?? "Shown in Settlement"}</dd>
          </div>
          <div>
            <dt>Found</dt>
            <dd>
              <SourceTime instant={detail.checkedAt} />
            </dd>
          </div>
          <div>
            <dt>Payments taken (store / payment provider)</dt>
            <dd>
              {formatSettlementMoney(detail.captured.storeMinor)} /{" "}
              {detail.captured.providerMinor === null
                ? "could not be read"
                : formatSettlementMoney(detail.captured.providerMinor)}
            </dd>
          </div>
          <div>
            <dt>Refunds (store / payment provider)</dt>
            <dd>
              {formatSettlementMoney(detail.refunded.storeMinor)} /{" "}
              {detail.refunded.providerMinor === null
                ? "could not be read"
                : formatSettlementMoney(detail.refunded.providerMinor)}
            </dd>
          </div>
          <div>
            <dt>Owner</dt>
            <dd>{item.ownerStatus}</dd>
          </div>
        </dl>
        {differences.length > 0 ? (
          <ul className="order-exception__differences">
            {differences.map((text) => (
              <li key={text}>{text}.</li>
            ))}
          </ul>
        ) : null}
        {detail.resolvedAt !== null ? (
          <p role="note">
            Resolved: the day was checked again <SourceTime instant={detail.resolvedAt} /> and now
            matches the payment provider&apos;s statement. Nothing more to do; both checks stay in
            the day&apos;s history.
          </p>
        ) : (
          <p>
            The store&apos;s totals for {day ?? "this business day"} do not match the payment
            provider&apos;s statement. Settlement explains the difference and what to do.
          </p>
        )}
        <p>
          <Link to={settlementLink(detail.businessDate)}>
            {day === null ? "Open Settlement" : `Open Settlement for ${day}`}
          </Link>
        </p>
        {csrf ? (
          <ReconciliationFollowUpAction
            key={item.exceptionReference + ":" + csrf}
            exceptionReference={item.exceptionReference}
            csrf={csrf}
            readOnly={readOnly || item.sourceFinal}
            closed={item.sourceFinal}
            showChargeDetails={false}
          />
        ) : null}
      </>
    );
  }
  const unmatched = payment && item.orderReference === null && detail?.type !== "Payment";
  return (
    <>
      {header(
        unmatched && detail?.type === "UnmatchedCharge"
          ? "Charge that matches no order"
          : exceptionKindLabel[item.kind],
      )}
      <dl>
        <div>
          <dt>Created</dt>
          <dd>
            <SourceTime instant={item.createdAt} />
          </dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd>
            {item.orderReference === null
              ? "No matching order"
              : item.orderNumber !== null
                ? `Order ${item.orderNumber}`
                : "Linked order · order number not shown"}
          </dd>
        </div>
        <div>
          <dt>Payment provider status</dt>
          <dd>{providerStateLabel[item.providerState]}</dd>
        </div>
        <div>
          <dt>Compensation</dt>
          <dd>{compensationLabel[item.compensationStatus]}</dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{item.ownerStatus}</dd>
        </div>
      </dl>
      {csrf &&
      item.kind === "PaidWithoutFulfillableOrder" &&
      item.sourceOwner === "Payment" &&
      item.orderReference !== null ? (
        <CompensationReconciliationAction
          orderReference={item.orderReference}
          caseReference={item.exceptionReference}
          csrf={csrf}
          readOnly={readOnly}
        />
      ) : null}
      {csrf && payment ? (
        <ReconciliationFollowUpAction
          key={item.exceptionReference + ":" + csrf}
          exceptionReference={item.exceptionReference}
          csrf={csrf}
          readOnly={readOnly || item.sourceFinal}
          closed={item.sourceFinal}
          showChargeDetails={unmatched}
        />
      ) : null}
      {item.orderReference === null ? (
        <p>
          {detail?.type === "UnmatchedCharge"
            ? "The payment provider took this charge, but it matches no order or payment in this store. Review it below and refund it if no order was paid by it."
            : "No order is linked to this payment difference. Review it with the payment provider's records."}
        </p>
      ) : null}
      {csrf && unmatched ? (
        <UnmatchedCaptureRefundAction
          key={item.exceptionReference + ":refund:" + csrf}
          exceptionReference={item.exceptionReference}
          csrf={csrf}
          readOnly={readOnly}
        />
      ) : null}
    </>
  );
}
const defaultExceptionClient = createOrderExceptionClient();
export function OrderExceptionPage({
  client = defaultExceptionClient,
  csrf,
}: {
  readonly client?: OrderExceptionClient;
  readonly csrf?: string | undefined;
}) {
  const recoveryButton = useRef<HTMLButtonElement>(null);
  const [generation, setGeneration] = useState(0);
  const refresh = () => setGeneration((current) => current + 1);
  const [state, setState] = useState<{
    client: OrderExceptionClient;
    generation: number;
    view: OrderExceptionView | null;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void client
      .load(controller.signal)
      .then(parseOrderExceptionView)
      .then((view) => {
        if (active) setState({ client, generation, view });
      })
      .catch(() => {
        if (active) setState({ client, generation, view: null });
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [client, generation]);
  useEffect(() => {
    if (
      generation > 0 &&
      state?.client === client &&
      state.generation === generation &&
      document.activeElement === document.body
    )
      recoveryButton.current?.focus();
  }, [client, generation, state]);
  if (state?.client !== client || state.generation !== generation)
    return (
      <WorkspacePage className="order-exception-page" title="Exceptions">
        <StatePanel heading="Loading exceptions" tone="neutral" status>
          <p>Reading the Store's exceptions…</p>
        </StatePanel>
      </WorkspacePage>
    );
  return state.view ? (
    <OrderExceptionScreen
      view={state.view}
      onRefresh={refresh}
      refreshButtonRef={recoveryButton}
      csrf={csrf}
    />
  ) : (
    <WorkspacePage className="order-exception-page" title="Exceptions">
      <StatePanel heading="Exceptions unavailable" tone="error" status>
        <p>Exceptions could not be loaded. No action was sent.</p>
        <button ref={recoveryButton} onClick={refresh}>
          Retry loading exceptions
        </button>
      </StatePanel>
    </WorkspacePage>
  );
}
