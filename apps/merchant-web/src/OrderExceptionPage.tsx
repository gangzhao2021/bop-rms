import { t } from "./i18n/i18n.js";
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
  DiningUnpaidBatch: t("Unpaid dine-in round"),
  PaymentReconciliationDifference: t("Payment reconciliation difference"),
  CaptureDeadlineExceeded: t("Capture deadline exceeded"),
  PaidWithoutFulfillableOrder: t("Paid without a fulfillable order"),
};
const providerStateLabel: Record<OrderExceptionItem["providerState"], string> = {
  // Shown as "Payment provider status".
  NotApplicable: t("Not applicable"),
  Pending: t("Pending"),
  Unknown: t("Unknown"),
  Confirmed: t("Confirmed"),
};
const compensationLabel: Record<OrderExceptionItem["compensationStatus"], string> = {
  NotRequested: t("Not requested"),
  Pending: t("Pending"),
  Completed: t("Completed"),
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
  exceptionOpenForText,
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
      title={t("Exceptions")}
      meta={`${view.storeLabel} · Business date ${businessDateText(view.businessDate)}`}
      status={<Freshness status={view.freshnessStatus} at={view.projectedAt} />}
      actions={
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          {t("Refresh")}
        </button>
      }
    >
      <>
        {readOnly ? (
          <StatePanel heading={t("Data may be out of date")} tone="offline" status>
            <p>{t("Refresh before taking an action.")}</p>
          </StatePanel>
        ) : null}
        <div className="list-filters order-exception-filters">
          <label>
            {t("Type")}
            <select
              value={kindFilter}
              onChange={(event) => setKindFilter(event.currentTarget.value)}
            >
              <option value="All">{t("All")}</option>
              {(Object.keys(exceptionKindLabel) as OrderExceptionItem["kind"][]).map((kind) => (
                <option key={kind} value={kind}>
                  {exceptionKindLabel[kind]}
                </option>
              ))}
            </select>
          </label>
          <label>
            {t("Severity")}
            <select
              value={severityFilter}
              onChange={(event) => setSeverityFilter(event.currentTarget.value)}
            >
              <option>{t("All")}</option>
              <option>{t("High")}</option>
              <option>{t("Critical")}</option>
            </select>
          </label>
          <label>
            {t("Status")}
            <select
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.currentTarget.value)}
            >
              <option>{t("All")}</option>
              <option>{t("Open")}</option>
              <option>{t("Acknowledged")}</option>
              <option>{t("Assigned")}</option>
              <option>{t("Resolved")}</option>
            </select>
          </label>
          <label>
            {t("Owner")}
            <select
              value={ownerFilter}
              onChange={(event) => setOwnerFilter(event.currentTarget.value)}
            >
              <option>{t("All")}</option>
              <option>{t("Unassigned")}</option>
              <option>{t("Assigned")}</option>
            </select>
          </label>
          <label>
            {t("Payment provider status")}
            <select
              value={providerFilter}
              onChange={(event) => setProviderFilter(event.currentTarget.value)}
            >
              <option value="All">{t("All")}</option>
              <option value="NotApplicable">{t("Not applicable")}</option>
              <option value="Pending">{t("Pending")}</option>
              <option value="Unknown">{t("Unknown")}</option>
              <option value="Confirmed">{t("Confirmed")}</option>
            </select>
          </label>
          <label className="order-exception-overdue-filter">
            <input
              type="checkbox"
              checked={overdueOnly}
              onChange={(event) => setOverdueOnly(event.currentTarget.checked)}
            />
            {t("Overdue only")}
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
            {t("Clear filters")}
          </button>
        </div>
        {items.length === 0 ? (
          <StatePanel
            heading={
              view.items.length === 0
                ? t("No exceptions in this view")
                : t("No exceptions match these filters")
            }
            tone="neutral"
            status
          >
            <p>
              {view.items.length === 0
                ? t("There are no open exceptions for this Store.")
                : t("No exception on this page matches the filters.")}
            </p>
          </StatePanel>
        ) : null}
        <div className="store-card-grid">
          {view.items.map((item) => (
            <article
              className="store-card order-exception__card"
              data-status={item.status}
              data-overdue={isExceptionOverdue(item, view.projectedAt) ? "true" : undefined}
              hidden={!visibleReferences.has(item.exceptionReference)}
              key={item.exceptionReference}
            >
              <OrderExceptionCard
                item={item}
                openFor={exceptionOpenForText(item, view.projectedAt)}
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
                ? t("Loading older resolved exceptions…")
                : t("Show older resolved exceptions")}
            </button>
            {older === "Failed" ? (
              <p role="status">{t("Older resolved exceptions could not be loaded. Try again.")}</p>
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
    return t("{label}: the payment provider's figure could not be read", { label: label });
  const gap = BigInt(pair.providerMinor) - BigInt(pair.storeMinor);
  if (gap === 0n) return null;
  return t("{label}: the payment provider has {value} {value2} than the store", {
    label: label,
    value: formatCad((gap < 0n ? -gap : gap).toString()),
    value2: gap > 0n ? "more" : "less",
  });
}
const settlementLink = (businessDate: string | null) =>
  businessDate === null
    ? "/app/operations/payment-reconciliation"
    : `/app/operations/payment-reconciliation?businessDate=${businessDate}`;

/** WP-2423: one exception card, worded for what the exception is about. */
function OrderExceptionCard({
  item,
  openFor,
  overdue,
  csrf,
  readOnly,
}: {
  readonly item: OrderExceptionItem;
  /** WP-2423 UI refresh: how long an unresolved case has been open (null once resolved). */
  readonly openFor: string | null;
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
            {overdue ? t("Refunded · check overdue since ") : t("Refunded · check by ")}
            <SourceTime instant={item.dueAt} />
          </p>
        ) : (
          <p className="bop-eyebrow order-exception__severity" data-severity={item.severity}>
            {item.severity} · {resolved ? t("was due ") : overdue ? t("overdue since ") : t("due ")}
            <SourceTime instant={item.dueAt} />
          </p>
        )}
        <h3>{title}</h3>
      </div>
      <div className="order-exception__state">
        <strong className="order-exception__status" data-status={item.status}>
          {item.status}
        </strong>
        {openFor === null ? null : <span className="order-exception__open-for">{openFor}</span>}
      </div>
    </header>
  );
  if (payment && detail?.type === "Unavailable") {
    // WP-2423 D3: never guess the kind of difference (and its actions) without its details.
    return (
      <>
        {header(exceptionKindLabel[item.kind])}
        <dl>
          <div>
            <dt>{t("Created")}</dt>
            <dd>
              <SourceTime instant={item.createdAt} />
            </dd>
          </div>
          <div>
            <dt>{t("Owner")}</dt>
            <dd>{item.ownerStatus}</dd>
          </div>
        </dl>
        <p role="note">
          {t(
            "The details of this payment difference could not be loaded, so what to do next is not shown. Refresh the page to try again.",
          )}
        </p>
      </>
    );
  }
  if (payment && detail?.type === "BusinessDayTotals") {
    const day = detail.businessDate === null ? null : businessDateText(detail.businessDate);
    const differences = [
      totalsDifference(t("Payments taken"), detail.captured),
      totalsDifference("Refunds", detail.refunded),
    ].filter((text): text is string => text !== null);
    return (
      <>
        {header(t("Business day totals differ from the payment provider"))}
        <dl>
          <div>
            <dt>{t("Business day")}</dt>
            <dd>{day ?? t("Shown in Settlement")}</dd>
          </div>
          <div>
            <dt>{t("Found")}</dt>
            <dd>
              <SourceTime instant={detail.checkedAt} />
            </dd>
          </div>
          <div>
            <dt>{t("Payments taken (store / payment provider)")}</dt>
            <dd>
              {formatCad(detail.captured.storeMinor)} /{" "}
              {detail.captured.providerMinor === null
                ? t("could not be read")
                : formatCad(detail.captured.providerMinor)}
            </dd>
          </div>
          <div>
            <dt>{t("Refunds (store / payment provider)")}</dt>
            <dd>
              {formatCad(detail.refunded.storeMinor)} /{" "}
              {detail.refunded.providerMinor === null
                ? t("could not be read")
                : formatCad(detail.refunded.providerMinor)}
            </dd>
          </div>
          <div>
            <dt>{t("Owner")}</dt>
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
            {t("Resolved: the day was checked again")} <SourceTime instant={detail.resolvedAt} />{" "}
            {t(
              "and now matches the payment provider's statement. Nothing more to do; both checks stay in the day's history.",
            )}
          </p>
        ) : (
          <p>
            {t(
              "The store's totals for {value} do not match the payment provider's statement. Settlement explains the difference and what to do.",
              { value: day ?? t("this business day") },
            )}
          </p>
        )}
        <p>
          <Link to={settlementLink(detail.businessDate)}>
            {day === null ? t("Open Settlement") : t("Open Settlement for {day}", { day: day })}
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
          ? t("Charge that matches no order")
          : exceptionKindLabel[item.kind],
      )}
      <dl>
        <div>
          <dt>{t("Created")}</dt>
          <dd>
            <SourceTime instant={item.createdAt} />
          </dd>
        </div>
        <div>
          <dt>{t("Order")}</dt>
          <dd>
            {item.orderReference === null
              ? t("No matching order")
              : item.orderNumber !== null
                ? t("Order {orderNumber}", { orderNumber: item.orderNumber })
                : t("Linked order · order number not shown")}
          </dd>
        </div>
        <div>
          <dt>{t("Payment provider status")}</dt>
          <dd>{providerStateLabel[item.providerState]}</dd>
        </div>
        <div>
          <dt>{t("Compensation")}</dt>
          <dd>
            {refundedAwaitingCheck
              ? overdue
                ? t("Refunded — store check overdue")
                : t("Refunded — check by end of day")
              : compensationLabel[item.compensationStatus]}
          </dd>
        </div>
        <div>
          <dt>{t("Owner")}</dt>
          <dd>{item.ownerStatus}</dd>
        </div>
      </dl>
      {detail?.type === "Payment" && detail.resolvedAt !== null ? (
        // WP-2423 (2026-10-17): a later check of the same payment found it matching again.
        <p role="note">
          {t("Resolved: this payment was checked again")} <SourceTime instant={detail.resolvedAt} />{" "}
          {t(
            "and now matches the payment provider. Nothing more to do; both checks stay in the store's history.",
          )}
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
        <p role="note">{t("Resolved: nothing more to do. It stays in the store's history.")}</p>
      ) : null}
      {item.orderReference === null && !resolved ? (
        <p>
          {detail?.type === "UnmatchedCharge"
            ? t(
                "The payment provider took this charge, but it matches no order or payment in this store. Review it below and refund it if no order was paid by it.",
              )
            : t(
                "No order is linked to this payment difference. Review it with the payment provider's records.",
              )}
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
      <WorkspacePage className="order-exception-page" title={t("Exceptions")}>
        <StatePanel heading={t("Loading exceptions")} tone="neutral" status>
          <p>{t("Reading the Store's exceptions…")}</p>
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
    <WorkspacePage className="order-exception-page" title={t("Exceptions")}>
      <StatePanel heading={t("Exceptions unavailable")} tone="error" status>
        <p>{t("Exceptions could not be loaded. No action was sent.")}</p>
        <button ref={recoveryButton} onClick={refresh}>
          {t("Retry loading exceptions")}
        </button>
      </StatePanel>
    </WorkspacePage>
  );
}
