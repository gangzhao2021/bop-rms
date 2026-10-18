import { ReconciliationFollowUpAction } from "./ReconciliationFollowUpAction.js";
import { CompensationReconciliationAction } from "./CompensationReconciliationAction.js";
import { UnmatchedCaptureRefundAction } from "./UnmatchedCaptureRefundAction.js";
import { createOrderExceptionClient } from "./order-exception-client.js";
import { StatePanel } from "@bop-rms/ui";
import { Freshness, SourceTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";
import { businessDateText } from "./StoreBusinessDay.js";
import { formatCad } from "./order-money.js";
import { Link } from "react-router";

/** Staff labels for the exception kinds and states the projection carries. */
export const exceptionKindLabel: Record<OrderExceptionItem["kind"], string> = {
  DiningUnpaidBatch: "Unpaid dine-in round",
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

export {
  parseOrderExceptionView,
  type OrderExceptionClient,
  type OrderExceptionItem,
  type OrderExceptionReconciliation,
  type OrderExceptionView,
} from "./order-exception-view.js";
import {
  isExceptionOverdue,
  isRefundedAwaitingCheck,
  parseOrderExceptionView,
  type OrderExceptionClient,
  type OrderExceptionItem,
  type OrderExceptionView,
} from "./order-exception-view.js";
export function OrderExceptionScreen({
  view,
  onRefresh,
  refreshButtonRef,
  csrf,
  onShowOlder,
  older = "Idle",
}: {
  readonly view: OrderExceptionView;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: Ref<HTMLButtonElement>;
  readonly csrf?: string | undefined;
  /** WP-2423: reads the next older page of resolved cases (view.olderResolvedBefore). */
  readonly onShowOlder?: () => void;
  readonly older?: "Idle" | "Loading" | "Failed";
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
      (!overdueOnly || isExceptionOverdue(item, view.projectedAt)),
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
              <OrderExceptionCard
                item={item}
                overdue={isExceptionOverdue(item, view.projectedAt)}
                csrf={csrf}
                readOnly={readOnly}
              />
            </article>
          ))}
        </div>
        {view.olderResolvedBefore !== null && onShowOlder ? (
          <div className="order-exception__older">
            <button type="button" disabled={older === "Loading"} onClick={onShowOlder}>
              {older === "Loading"
                ? "Loading older resolved exceptions…"
                : "Show older resolved exceptions"}
            </button>
            {older === "Failed" ? (
              <p role="status">Older resolved exceptions could not be loaded. Try again.</p>
            ) : null}
          </div>
        ) : null}
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
  return `${label}: the payment provider has ${formatCad(
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
  overdue,
  csrf,
  readOnly,
}: {
  readonly item: OrderExceptionItem;
  /** WP-2423: past its due time and still open (same rule as the filter and Home). */
  readonly overdue: boolean;
  readonly csrf: string | undefined;
  readonly readOnly: boolean;
}) {
  const detail = item.reconciliation;
  const payment = item.kind === "PaymentReconciliationDifference" && item.sourceOwner === "Payment";
  const refundedAwaitingCheck = isRefundedAwaitingCheck(item);
  // WP-2423: a resolved case is history; its actions are not offered again.
  const resolved = item.status === "Resolved";
  const header = (title: string) => (
    <header>
      <div>
        {refundedAwaitingCheck ? (
          <p className="bop-eyebrow order-exception__severity" data-severity="High">
            {overdue ? "Refunded · check overdue since " : "Refunded · check by "}
            <SourceTime instant={item.dueAt} />
          </p>
        ) : (
          <p className="bop-eyebrow order-exception__severity" data-severity={item.severity}>
            {item.severity} · {resolved ? "was due " : overdue ? "overdue since " : "due "}
            <SourceTime instant={item.dueAt} />
          </p>
        )}
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
              {formatCad(detail.captured.storeMinor)} /{" "}
              {detail.captured.providerMinor === null
                ? "could not be read"
                : formatCad(detail.captured.providerMinor)}
            </dd>
          </div>
          <div>
            <dt>Refunds (store / payment provider)</dt>
            <dd>
              {formatCad(detail.refunded.storeMinor)} /{" "}
              {detail.refunded.providerMinor === null
                ? "could not be read"
                : formatCad(detail.refunded.providerMinor)}
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
          <dd>
            {refundedAwaitingCheck
              ? overdue
                ? "Refunded — store check overdue"
                : "Refunded — check by end of day"
              : compensationLabel[item.compensationStatus]}
          </dd>
        </div>
        <div>
          <dt>Owner</dt>
          <dd>{item.ownerStatus}</dd>
        </div>
      </dl>
      {detail?.type === "Payment" && detail.resolvedAt !== null ? (
        // WP-2423 (2026-10-17): a later check of the same payment found it matching again.
        <p role="note">
          Resolved: this payment was checked again <SourceTime instant={detail.resolvedAt} /> and
          now matches the payment provider. Nothing more to do; both checks stay in the store&apos;s
          history.
        </p>
      ) : null}
      {csrf &&
      !resolved &&
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
      {resolved &&
      !(csrf && payment) &&
      !(detail?.type === "Payment" && detail.resolvedAt !== null) ? (
        <p role="note">Resolved: nothing more to do. It stays in the store&apos;s history.</p>
      ) : null}
      {item.orderReference === null && !resolved ? (
        <p>
          {detail?.type === "UnmatchedCharge"
            ? "The payment provider took this charge, but it matches no order or payment in this store. Review it below and refund it if no order was paid by it."
            : "No order is linked to this payment difference. Review it with the payment provider's records."}
        </p>
      ) : null}
      {csrf && unmatched ? (
        // A resolved charge keeps its read-only charge and refund review (v15 Oct 9), never a new
        // refund request or approval.
        <UnmatchedCaptureRefundAction
          key={item.exceptionReference + ":refund:" + csrf}
          exceptionReference={item.exceptionReference}
          csrf={csrf}
          readOnly={readOnly || resolved}
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
  // WP-2423: older resolved cases, a page at a time, kept until the next refresh.
  const [older, setOlder] = useState<{
    readonly view: OrderExceptionView;
    readonly items: readonly OrderExceptionItem[];
    readonly cursor: string | null;
    readonly status: "Idle" | "Loading" | "Failed";
  } | null>(null);
  const olderRequest = useRef<AbortController | null>(null);
  useEffect(() => () => olderRequest.current?.abort(), []);
  const currentView =
    state?.client === client && state.generation === generation ? state.view : null;
  const showOlder = () => {
    if (!currentView || olderRequest.current) return;
    const base = older?.view === currentView ? older : null;
    const cursor = base ? base.cursor : currentView.olderResolvedBefore;
    if (cursor === null) return;
    const controller = new AbortController();
    olderRequest.current = controller;
    setOlder({ view: currentView, items: base?.items ?? [], cursor, status: "Loading" });
    void client
      .load(controller.signal, cursor)
      .then(parseOrderExceptionView)
      .then((page) => {
        if (controller.signal.aborted) return;
        const shown = new Set([
          ...currentView.items.map((item) => item.exceptionReference),
          ...(base?.items ?? []).map((item) => item.exceptionReference),
        ]);
        const added = page.items.filter(
          (item) => item.status === "Resolved" && !shown.has(item.exceptionReference),
        );
        setOlder({
          view: currentView,
          items: [...(base?.items ?? []), ...added],
          cursor: page.olderResolvedBefore,
          status: "Idle",
        });
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setOlder({ view: currentView, items: base?.items ?? [], cursor, status: "Failed" });
      })
      .finally(() => {
        if (olderRequest.current === controller) olderRequest.current = null;
      });
  };
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
  const olderPage = older?.view === state.view ? older : null;
  return state.view ? (
    <OrderExceptionScreen
      view={
        olderPage
          ? {
              ...state.view,
              items: [...state.view.items, ...olderPage.items],
              olderResolvedBefore: olderPage.cursor,
            }
          : state.view
      }
      onRefresh={() => {
        olderRequest.current?.abort();
        olderRequest.current = null;
        setOlder(null);
        refresh();
      }}
      refreshButtonRef={recoveryButton}
      csrf={csrf}
      onShowOlder={showOlder}
      older={olderPage?.status ?? "Idle"}
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
