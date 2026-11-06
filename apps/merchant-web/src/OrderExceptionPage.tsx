import { systemText, t } from "./i18n/i18n.js";
import { ReconciliationFollowUpAction } from "./ReconciliationFollowUpAction.js";
import { CompensationReconciliationAction } from "./CompensationReconciliationAction.js";
import { UnmatchedCaptureRefundAction } from "./UnmatchedCaptureRefundAction.js";
import {
  createOrderExceptionClient,
  OrderExceptionAccessDenied,
} from "./order-exception-client.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
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
import { useEffect, useId, useRef, useState, type Ref } from "react";

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
type ExceptionTab = "NotResolved" | "Overdue" | "Resolved" | "All";
/** The case in staff words: its order, its business day, or that it has no order. */
function exceptionLabel(item: OrderExceptionItem): string {
  const detail = item.reconciliation;
  if (detail?.type === "BusinessDayTotals" && detail.businessDate !== null)
    return businessDateText(detail.businessDate);
  if (item.orderReference === null) return t("No order");
  return item.orderNumber === null
    ? t("Order")
    : t("Order {orderNumber}", { orderNumber: item.orderNumber });
}
function exceptionTitle(item: OrderExceptionItem): string {
  const detail = item.reconciliation;
  if (item.kind === "PaymentReconciliationDifference" && item.sourceOwner === "Payment") {
    if (detail?.type === "BusinessDayTotals")
      return t("Business day totals differ from the payment provider");
    if (item.orderReference === null && detail?.type === "UnmatchedCharge")
      return t("Charge that matches no order");
  }
  return exceptionKindLabel[item.kind];
}
const exceptionTone = (item: OrderExceptionItem) =>
  item.status === "Resolved"
    ? "done"
    : item.status === "Open" || isRefundedAwaitingCheck(item)
      ? "danger"
      : "neutral";
export function OrderExceptionScreen({
  view,
  onRefresh,
  refreshButtonRef,
  csrf,
  onShowOlder,
  older = "Idle",
  onRecorded,
}: {
  readonly view: OrderExceptionView;
  readonly onRefresh?: () => void;
  readonly refreshButtonRef?: Ref<HTMLButtonElement>;
  readonly csrf?: string | undefined;
  /** WP-2423: reads the next older page of resolved cases (view.olderResolvedBefore). */
  readonly onShowOlder?: () => void;
  readonly older?: "Idle" | "Loading" | "Failed";
  /** A check was recorded: read the list again so the case's row follows it. */
  readonly onRecorded?: () => void;
}) {
  // Owner 2026-10-25: open work first; resolved exceptions are one choice away.
  const [tab, setTab] = useState<ExceptionTab>("NotResolved");
  const [kindFilter, setKindFilter] = useState("All");
  const [severityFilter, setSeverityFilter] = useState("All");
  const [progressFilter, setProgressFilter] = useState("All");
  const [ownerFilter, setOwnerFilter] = useState("All");
  const [providerFilter, setProviderFilter] = useState("All");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [opened, setOpened] = useState<string | null>(null);
  const panelId = useId();
  const filterButton = useRef<HTMLButtonElement>(null);
  const showButton = useRef<HTMLButtonElement>(null);
  const rowButtons = useRef(new Map<string, HTMLButtonElement>());
  const listScroll = useRef(0);
  const readOnly = view.freshnessStatus !== "Fresh";
  const matches = (item: OrderExceptionItem, shown: ExceptionTab) =>
    (kindFilter === "All" || item.kind === kindFilter) &&
    (severityFilter === "All" || item.severity === severityFilter) &&
    (progressFilter === "All" || item.status === progressFilter) &&
    (ownerFilter === "All" || item.ownerStatus === ownerFilter) &&
    (providerFilter === "All" || item.providerState === providerFilter) &&
    (shown === "All" ||
      (shown === "Resolved"
        ? item.status === "Resolved"
        : shown === "Overdue"
          ? isExceptionOverdue(item, view.projectedAt)
          : item.status !== "Resolved"));
  const items = view.items.filter((item) => matches(item, tab));
  const filtersApplied = [
    kindFilter,
    severityFilter,
    progressFilter,
    ownerFilter,
    providerFilter,
  ].filter((value) => value !== "All").length;
  const hasFilters = tab !== "NotResolved" || filtersApplied > 0;
  const visibleReferences = new Set(items.map((item) => item.exceptionReference));
  // A case the filters hide keeps its panel mounted, so a retry in progress is not lost.
  const selected = opened !== null && visibleReferences.has(opened) ? opened : null;
  const open = (reference: string) => {
    listScroll.current = typeof window === "undefined" ? 0 : window.scrollY;
    setOpened(reference);
  };
  const close = () => {
    if (selected === null) return;
    const reference = selected;
    setOpened(null);
    // On a phone the case replaced the list: back where staff left it, on the case's row.
    requestAnimationFrame(() => {
      if (window.matchMedia?.("(max-width: 48rem)").matches) window.scrollTo(0, listScroll.current);
      rowButtons.current.get(reference)?.focus({ preventScroll: true });
    });
  };
  const clearFilters = () => {
    setTab("NotResolved");
    setKindFilter("All");
    setSeverityFilter("All");
    setProgressFilter("All");
    setOwnerFilter("All");
    setProviderFilter("All");
  };
  const closeFilters = () => {
    setFiltersOpen(false);
    filterButton.current?.focus();
  };
  const chips = (
    legend: string,
    value: string,
    choose: (value: string) => void,
    options: readonly (readonly [string, string])[],
  ) => (
    <fieldset className="order-filter__group">
      <legend>{legend}</legend>
      <div className="order-filter__chips">
        {options.map(([option, label]) => (
          <button
            key={option}
            type="button"
            aria-pressed={value === option}
            onClick={() => choose(option)}
          >
            {label}
          </button>
        ))}
      </div>
    </fieldset>
  );
  const tabs: readonly (readonly [ExceptionTab, string])[] = [
    ["NotResolved", t("Not resolved yet")],
    ["Overdue", t("Overdue")],
    ["Resolved", t("Resolved")],
    ["All", t("All")],
  ];
  return (
    <WorkspacePage
      className="orders-page order-exception-page"
      title={t("Exceptions")}
      meta={t("{label} · Business date {businessDate}", {
        label: view.storeLabel,
        businessDate: businessDateText(view.businessDate),
      })}
      status={<Freshness status={view.freshnessStatus} at={view.projectedAt} />}
      actions={
        <button ref={refreshButtonRef} disabled={!onRefresh} onClick={onRefresh}>
          {t("Refresh")}
        </button>
      }
    >
      <div className="order-workbench" data-panel={selected === null ? undefined : "open"}>
        <div className="order-workbench-main">
          {readOnly ? (
            <StatePanel heading={t("Data may be out of date")} tone="offline" status>
              <p>{t("Refresh before taking an action.")}</p>
            </StatePanel>
          ) : null}
          <div className="order-toolbar">
            <div className="order-status-filters" role="group" aria-label={t("Show exceptions")}>
              {tabs.map(([value, label]) => (
                <button
                  key={value}
                  type="button"
                  aria-pressed={tab === value}
                  onClick={() => setTab(value)}
                >
                  {label}
                  <span className="order-status-filters__count">
                    {view.items.filter((item) => matches(item, value)).length}
                  </span>
                </button>
              ))}
            </div>
            <div className="order-toolbar__tools">
              <div className="order-filter">
                <button
                  ref={filterButton}
                  type="button"
                  className="order-filter__toggle"
                  aria-expanded={filtersOpen}
                  aria-controls={panelId + "-filters"}
                  onClick={() => setFiltersOpen((value) => !value)}
                >
                  {t("Filter")}
                  {filtersApplied === 0 ? null : (
                    <span className="order-filter__applied">{filtersApplied}</span>
                  )}
                </button>
                {filtersOpen ? (
                  <div
                    id={panelId + "-filters"}
                    className="order-filter__panel"
                    role="dialog"
                    aria-label={t("Filter exceptions on this page")}
                    onKeyDown={(event) => {
                      if (event.key !== "Escape") return;
                      event.stopPropagation();
                      closeFilters();
                    }}
                  >
                    <div className="order-filter__head">
                      <h2>{t("Filter")}</h2>
                      <button type="button" className="order-panel__close" onClick={closeFilters}>
                        <span aria-hidden="true">×</span>
                        <span className="visually-hidden">{t("Close filters")}</span>
                      </button>
                    </div>
                    {chips(t("Type"), kindFilter, setKindFilter, [
                      ["All", t("All")],
                      ...(Object.keys(exceptionKindLabel) as OrderExceptionItem["kind"][]).map(
                        (kind) => [kind, exceptionKindLabel[kind]] as const,
                      ),
                    ])}
                    {chips(t("Severity"), severityFilter, setSeverityFilter, [
                      ["All", t("All")],
                      ["High", t("High")],
                      ["Critical", t("Critical")],
                    ])}
                    {chips(t("Progress"), progressFilter, setProgressFilter, [
                      ["All", t("All")],
                      ["Open", t("Not acknowledged")],
                      ["Acknowledged", t("Acknowledged")],
                      ["Assigned", t("Assigned")],
                    ])}
                    {chips(t("Handled by"), ownerFilter, setOwnerFilter, [
                      ["All", t("All")],
                      ["Unassigned", t("Unassigned")],
                      ["Assigned", t("Assigned")],
                    ])}
                    {chips(t("Payment provider status"), providerFilter, setProviderFilter, [
                      ["All", t("All")],
                      ["NotApplicable", t("Not applicable")],
                      ["Pending", t("Pending")],
                      ["Unknown", t("Unknown")],
                      ["Confirmed", t("Confirmed")],
                    ])}
                    <div className="order-filter__actions">
                      <button
                        type="button"
                        disabled={!hasFilters}
                        onClick={() => {
                          clearFilters();
                          // This button is now disabled: keep the keyboard inside the sheet.
                          showButton.current?.focus();
                        }}
                      >
                        {t("Clear filters")}
                      </button>
                      <button
                        ref={showButton}
                        type="button"
                        className="order-filter__show"
                        onClick={closeFilters}
                      >
                        {items.length === 1
                          ? t("Show 1 exception")
                          : t("Show {count} exceptions", { count: items.length })}
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
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
              {view.items.length === 0 || !hasFilters ? null : (
                <button type="button" onClick={clearFilters}>
                  {t("Clear filters")}
                </button>
              )}
            </StatePanel>
          ) : null}
          <ol className="order-list" aria-label={t("Exceptions")}>
            {view.items.map((item) => {
              const reference = item.exceptionReference;
              const isOpen = reference === selected;
              const overdue = isExceptionOverdue(item, view.projectedAt);
              const openFor = exceptionOpenForText(item, view.projectedAt);
              const resolved = item.status === "Resolved";
              const refundCheck = isRefundedAwaitingCheck(item);
              return (
                <li
                  className="order-row"
                  data-status={item.status}
                  data-overdue={overdue ? "true" : undefined}
                  data-open={isOpen ? "true" : undefined}
                  hidden={!visibleReferences.has(reference)}
                  key={reference}
                >
                  <div className="order-row__summary">
                    <h3 className="order-row__number">
                      <button
                        type="button"
                        className="order-row__open"
                        aria-expanded={isOpen}
                        aria-controls={panelId + reference}
                        ref={(node) => {
                          if (node) rowButtons.current.set(reference, node);
                          else rowButtons.current.delete(reference);
                        }}
                        onClick={() => (isOpen ? close() : open(reference))}
                      >
                        {exceptionLabel(item)}
                      </button>
                    </h3>
                    <span className="order-row__what">
                      <span className="order-workbench-type">{exceptionTitle(item)}</span>
                      <span className="order-row__when">
                        <SourceTime instant={item.createdAt} />
                        {openFor === null ? null : (
                          <>
                            {" · "}
                            <span className="order-exception__open-for">{openFor}</span>
                          </>
                        )}
                      </span>
                    </span>
                    <span className="order-row__status">
                      <span className="order-workbench-phase" data-tone={exceptionTone(item)}>
                        {refundCheck ? t("Refunded, check needed") : systemText(item.status)}
                      </span>
                      {resolved ? null : (
                        <span
                          className="order-exception__due"
                          data-overdue={overdue ? "true" : undefined}
                        >
                          {item.severity === "Critical" && !refundCheck
                            ? systemText("Critical") + " · "
                            : ""}
                          {overdue ? t("overdue since ") : t("due ")}
                          <SourceTime instant={item.dueAt} />
                        </span>
                      )}
                    </span>
                  </div>
                  <div className="order-workbench-next">
                    <button
                      type="button"
                      className="order-exception__next"
                      onClick={() => open(reference)}
                    >
                      {resolved ? t("View") : refundCheck ? t("Check the refund") : t("Handle")}
                      <span className="visually-hidden"> {exceptionLabel(item)}</span>
                    </button>
                  </div>
                </li>
              );
            })}
          </ol>
          {view.olderResolvedBefore !== null && onShowOlder ? (
            <div className="order-exception__older">
              <button
                type="button"
                disabled={older === "Loading"}
                onClick={() => {
                  // The older cases are resolved ones: show them where they will appear.
                  if (tab !== "All") setTab("Resolved");
                  onShowOlder();
                }}
              >
                {older === "Loading"
                  ? t("Loading older resolved exceptions…")
                  : t("Show older resolved exceptions")}
              </button>
              {older === "Failed" ? (
                <p role="status">
                  {t("Older resolved exceptions could not be loaded. Try again.")}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
        {view.items.map((item) => (
          // Every case keeps its panel mounted: a "result unknown" retry survives opening another.
          <aside
            className="order-panel"
            id={panelId + item.exceptionReference}
            aria-label={exceptionTitle(item)}
            hidden={item.exceptionReference !== selected}
            key={item.exceptionReference}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return;
              event.stopPropagation();
              close();
            }}
          >
            <button type="button" className="order-panel__close" onClick={close}>
              <span aria-hidden="true">×</span>
              <span className="visually-hidden">{t("Close details")}</span>
            </button>
            <article
              className="order-workbench-detail order-exception__detail"
              data-status={item.status}
            >
              <OrderExceptionCard
                item={item}
                active={item.exceptionReference === selected}
                openFor={exceptionOpenForText(item, view.projectedAt)}
                overdue={isExceptionOverdue(item, view.projectedAt)}
                csrf={csrf}
                readOnly={readOnly}
                onRecorded={onRecorded}
              />
            </article>
          </aside>
        ))}
      </div>
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

/** WP-2423: one case's panel, worded for what the exception is about. */
function OrderExceptionCard({
  item,
  active,
  openFor,
  overdue,
  csrf,
  readOnly,
  onRecorded,
}: {
  readonly item: OrderExceptionItem;
  /** This case's panel is the one showing. */
  readonly active: boolean;
  /** WP-2423 UI refresh: how long an unresolved case has been open (null once resolved). */
  readonly openFor: string | null;
  /** WP-2423: past its due time and still open (same rule as the filter and Home). */
  readonly overdue: boolean;
  readonly csrf: string | undefined;
  readonly readOnly: boolean;
  readonly onRecorded: (() => void) | undefined;
}) {
  const detail = item.reconciliation;
  const payment = item.kind === "PaymentReconciliationDifference" && item.sourceOwner === "Payment";
  const refundedAwaitingCheck = isRefundedAwaitingCheck(item);
  // WP-2423: a resolved case is history; its actions are not offered again.
  const resolved = item.status === "Resolved";
  const header = (title: string) => (
    <header className="order-exception__head">
      <h2>{title}</h2>
      {refundedAwaitingCheck ? (
        <p className="order-panel__meta" data-overdue={overdue ? "true" : undefined}>
          {overdue ? t("Refunded · check overdue since ") : t("Refunded · check by ")}
          <SourceTime instant={item.dueAt} />
        </p>
      ) : (
        <p className="order-panel__meta" data-overdue={overdue ? "true" : undefined}>
          {systemText(item.severity)} ·{" "}
          {resolved ? t("was due ") : overdue ? t("overdue since ") : t("due ")}
          <SourceTime instant={item.dueAt} />
        </p>
      )}
      <div className="order-panel__status">
        <span className="order-panel__phase" data-tone={exceptionTone(item)}>
          {refundedAwaitingCheck ? t("Refunded, check needed") : systemText(item.status)}
        </span>
        {openFor === null ? null : <span className="order-exception__open-for">{openFor}</span>}
      </div>
    </header>
  );
  if (payment && detail?.type === "Unavailable") {
    // WP-2423 D3: never guess the kind of difference (and its actions) without its details.
    return (
      <>
        {header(exceptionKindLabel[item.kind])}
        <dl className="order-panel__facts">
          <div>
            <dt>{t("Created")}</dt>
            <dd>
              <SourceTime instant={item.createdAt} />
            </dd>
          </div>
          <div>
            <dt>{t("Handled by")}</dt>
            <dd>{systemText(item.ownerStatus)}</dd>
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
        <dl className="order-panel__facts">
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
            <dt>{t("Handled by")}</dt>
            <dd>{systemText(item.ownerStatus)}</dd>
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
      <dl className="order-panel__facts">
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
          <dt>{t("Refund")}</dt>
          <dd>
            {refundedAwaitingCheck
              ? overdue
                ? t("Refunded — store check overdue")
                : t("Refunded — check by end of day")
              : compensationLabel[item.compensationStatus]}
          </dd>
        </div>
        <div>
          <dt>{t("Handled by")}</dt>
          <dd>{systemText(item.ownerStatus)}</dd>
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
          active={active}
          onRecorded={onRecorded}
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
/**
 * WP-2423: a read that failed. A refusal of access (403) says so and offers no retry, because a
 * retry cannot help; any other failure keeps its retry.
 */
export function OrderExceptionLoadFailed({
  denied,
  onRetry,
  retryRef,
}: {
  readonly denied: boolean;
  readonly onRetry: () => void;
  readonly retryRef?: Ref<HTMLButtonElement>;
}) {
  return (
    <WorkspacePage className="orders-page order-exception-page" title={t("Exceptions")}>
      {denied ? (
        <StatePanel heading={noAccessHeading} tone="error" status>
          <p>{pageAccessDeniedText}</p>
        </StatePanel>
      ) : (
        <StatePanel heading={t("Exceptions unavailable")} tone="error" status>
          <p>{t("Exceptions could not be loaded. No action was sent.")}</p>
          <button ref={retryRef} onClick={onRetry}>
            {t("Retry loading exceptions")}
          </button>
        </StatePanel>
      )}
    </WorkspacePage>
  );
}
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
  // Keeps the page and open panels in place; a failed read leaves the list as it was.
  const reloadQuietly = () => {
    void client
      .load()
      .then(parseOrderExceptionView)
      .then((view) => setState({ client, generation, view, denied: false }))
      .catch((error: unknown) => {
        if (error instanceof OrderExceptionAccessDenied)
          setState({ client, generation, view: null, denied: true });
      });
  };
  const [state, setState] = useState<{
    client: OrderExceptionClient;
    generation: number;
    view: OrderExceptionView | null;
    denied: boolean;
  } | null>(null);
  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    void client
      .load(controller.signal)
      .then(parseOrderExceptionView)
      .then((view) => {
        if (active) setState({ client, generation, view, denied: false });
      })
      .catch((error: unknown) => {
        if (active)
          setState({
            client,
            generation,
            view: null,
            denied: error instanceof OrderExceptionAccessDenied,
          });
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
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // Access withdrawn since the page opened: the whole page says so, the rows go.
        if (error instanceof OrderExceptionAccessDenied) {
          setOlder(null);
          setState({ client, generation, view: null, denied: true });
        } else setOlder({ view: currentView, items: base?.items ?? [], cursor, status: "Failed" });
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
      <WorkspacePage className="orders-page order-exception-page" title={t("Exceptions")}>
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
      onRecorded={reloadQuietly}
    />
  ) : (
    <OrderExceptionLoadFailed denied={state.denied} onRetry={refresh} retryRef={recoveryButton} />
  );
}
