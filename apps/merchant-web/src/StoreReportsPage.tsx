import { countOf, t } from "./i18n/i18n.js";
import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { formatCad } from "./order-money.js";
import { actionAccessDeniedText, noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import {
  createStoreReportsClient,
  StoreReportsClientError,
  type StoreReportChannel,
  type StoreReportExportKind,
  type StoreReportOrderType,
  type StoreReportSummary,
  type StoreReportsView,
} from "./store-reports-client.js";
import { businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { Freshness, storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";

const money = formatCad;
export const channelLabel: Record<StoreReportChannel, string> = {
  Online: t("Online (card)"),
  CardMachine: t("Store card machine"),
};
export const orderTypeLabel: Record<StoreReportOrderType, string> = {
  DineIn: t("Dine-in"),
  Pickup: t("Pickup"),
  Counter: t("Counter"),
};

/** "2026-10-14" → the date `days` earlier/later, by calendar arithmetic in UTC (no time zone). */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00.000Z") + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function rangeLabel(view: StoreReportsView): string {
  return view.from === view.to
    ? t("Business day {from}", { from: businessDateText(view.from) })
    : `${businessDateText(view.from)} – ${businessDateText(view.to)}`;
}

function Table({
  label,
  columns,
  rows,
  empty,
}: {
  readonly label: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly ReactNode[])[];
  readonly empty: string;
}) {
  if (rows.length === 0) return <p className="bop-muted">{empty}</p>;
  return (
    <div className="store-reports__scroll">
      <table className="store-reports__table" aria-label={label}>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column} scope="col">
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => (
            <tr key={index}>
              {row.map((cell, column) =>
                column === 0 ? (
                  <th key={column} scope="row" data-label={columns[column]}>
                    {cell}
                  </th>
                ) : (
                  <td key={column} data-label={columns[column]}>
                    {cell}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SummaryLines({ summary }: { readonly summary: StoreReportSummary }) {
  const lines: [string, string, boolean?][] = [
    [t("Gross sales"), money(summary.grossSalesMinor)],
    ["Discounts", "−" + money(summary.discountsMinor)],
    [t("Net sales"), money(summary.netSalesMinor), true],
  ];
  if (summary.serviceChargesMinor !== "0")
    lines.push([t("Service charges"), money(summary.serviceChargesMinor)]);
  for (const tax of summary.taxes)
    lines.push([t("Tax · {label}", { label: tax.label }), money(tax.amountMinor)]);
  if (summary.taxes.length !== 1) lines.push(["Tax", money(summary.taxMinor)]);
  lines.push(["Tips", money(summary.tipsMinor)]);
  if (summary.unmatchedMinor !== "0")
    lines.push([t("Paid but not matched to items"), money(summary.unmatchedMinor)]);
  lines.push([t("Total collected"), money(summary.collectedMinor), true]);
  lines.push([
    t("Refunds ({refundCount})", { refundCount: countOf(summary.refundCount, "refund") }),
    "−" + money(summary.refundsMinor),
  ]);
  if (summary.refundsMinor !== "0") {
    lines.push([t("  of which sales"), money(summary.refunds.salesMinor)]);
    lines.push([t("  of which tax"), money(summary.refunds.taxMinor)]);
    lines.push([t("  of which tips"), money(summary.refunds.tipsMinor)]);
    if (summary.refunds.serviceChargesMinor !== "0")
      lines.push([t("  of which service charges"), money(summary.refunds.serviceChargesMinor)]);
    if (summary.refunds.notItemizedMinor !== "0")
      lines.push([t("  not split by item"), money(summary.refunds.notItemizedMinor)]);
  }
  lines.push([t("Net collected"), money(summary.netCollectedMinor), true]);
  lines.push([t("Net sales after refunds"), money(summary.netSalesAfterRefundsMinor)]);
  return (
    <dl className="store-reports__lines">
      {lines.map(([term, value, strong]) => (
        <div
          key={term}
          data-strong={strong ? "true" : undefined}
          data-part={term.startsWith("  ") ? "true" : undefined}
        >
          <dt>{term.trim()}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  );
}

function ReportSection({
  id,
  title,
  description,
  report,
  onDownload,
  downloading,
  children,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: ReactNode;
  readonly report: StoreReportExportKind;
  readonly onDownload: ((report: StoreReportExportKind) => void) | null;
  readonly downloading: StoreReportExportKind | null;
  readonly children: ReactNode;
}) {
  return (
    <section className="store-card store-reports__section" aria-labelledby={id}>
      <header>
        <h3 id={id}>{title}</h3>
        {onDownload === null ? null : (
          <button
            type="button"
            onClick={() => onDownload(report)}
            disabled={downloading !== null}
            aria-label={t("Download {value} as CSV", { value: title.toLowerCase() })}
          >
            {downloading === report ? t("Preparing…") : t("Download CSV")}
          </button>
        )}
      </header>
      {description === undefined ? null : <p className="bop-muted">{description}</p>}
      {children}
    </section>
  );
}

/** The reports for one range; pure so every state renders without a network. */
export function StoreReports({
  view,
  onDownload,
  downloading = null,
}: {
  readonly view: StoreReportsView;
  readonly onDownload?: ((report: StoreReportExportKind) => void) | null;
  readonly downloading?: StoreReportExportKind | null;
}) {
  const download = view.mayExport ? (onDownload ?? null) : null;
  const s = view.summary;
  const r = view.reconciliation;
  return (
    <div className="store-reports">
      <section className="store-card store-reports__range" aria-labelledby="store-reports-range">
        <header>
          <h3 id="store-reports-range">{rangeLabel(view)}</h3>
          {view.includesOpenDay ? (
            <span className="status-chip" data-state="open">
              {t("Today so far")}
            </span>
          ) : null}
        </header>
        <p className="bop-muted">
          {t(
            "{startsAt} to {endsAt} (store time). A sale counts on the business day it was paid and a refund on the day the money went back, the same as the day-end settlement. Orders cancelled before payment are not sales.",
            {
              startsAt: storeTime(view.startsAt, view.timeZone, true),
              endsAt: storeTime(view.endsAt, view.timeZone, true),
            },
          )}
        </p>
        {r.matchesSettlement && view.includesOpenDay ? (
          // v15 store-day L6: an open business day has no day-end settlement yet.
          <p role="status" className="store-reports__match">
            {view.days.some((day) => day.status === "Closed")
              ? t(
                  "Closed days match the day-end settlement. Today is checked against it when the day closes.",
                )
              : t("Checked against the day-end settlement when the day closes.")}
          </p>
        ) : r.matchesSettlement ? (
          <p role="status" className="store-reports__match">
            {t(
              "Matches the day-end settlement: {settlementCollectedMinor} collected, {settlementRefundedMinor} refunded.",
              {
                settlementCollectedMinor: money(r.settlementCollectedMinor),
                settlementRefundedMinor: money(r.settlementRefundedMinor),
              },
            )}
          </p>
        ) : (
          <p role="alert" className="command-error">
            {t(
              "These totals differ from the day-end settlement ({reportCollectedMinor} vs {settlementCollectedMinor} collected, {reportRefundedMinor} vs {settlementRefundedMinor} refunded). Refresh; if it stays, use the",
              {
                reportCollectedMinor: money(r.reportCollectedMinor),
                settlementCollectedMinor: money(r.settlementCollectedMinor),
                reportRefundedMinor: money(r.reportRefundedMinor),
                settlementRefundedMinor: money(r.settlementRefundedMinor),
              },
            )}{" "}
            <Link to="/app/operations/payment-reconciliation">{t("Settlement")}</Link>{" "}
            {t("figures and tell the Owner.")}
          </p>
        )}
        {r.pendingOnlineRefundCount > 0 ? (
          <p role="note">
            {r.pendingOnlineRefundCount === 1
              ? t(
                  "1 online refund is still waiting for the card company to confirm and is not counted yet.",
                )
              : t(
                  "{count} online refunds are still waiting for the card company to confirm and are not counted yet.",
                  { count: r.pendingOnlineRefundCount },
                )}
          </p>
        ) : null}
      </section>
      <ul className="overview-counts store-reports__totals" aria-label={t("Totals")}>
        <li>
          <span className="overview-count__label">{t("Net sales")}</span>
          <strong className="overview-count__value">{money(s.netSalesMinor)}</strong>
          <span className="overview-count__detail">
            {countOf(s.orderCount, "order")} · {countOf(s.paymentCount, "payment")}
          </span>
        </li>
        <li>
          <span className="overview-count__label">{t("Tax")}</span>
          <strong className="overview-count__value">{money(s.taxMinor)}</strong>
          <span className="overview-count__detail">{t("Collected on sales")}</span>
        </li>
        <li>
          <span className="overview-count__label">{t("Tips")}</span>
          <strong className="overview-count__value">{money(s.tipsMinor)}</strong>
          <span className="overview-count__detail">{t("Before refunds")}</span>
        </li>
        <li>
          <span className="overview-count__label">{t("Net collected")}</span>
          <strong className="overview-count__value">{money(s.netCollectedMinor)}</strong>
          <span className="overview-count__detail">
            {t("{collectedMinor} collected − {refundsMinor} refunded", {
              collectedMinor: money(s.collectedMinor),
              refundsMinor: money(s.refundsMinor),
            })}
          </span>
        </li>
      </ul>
      <ReportSection
        id="store-reports-summary"
        title={t("Sales summary")}
        report="summary"
        onDownload={download}
        downloading={downloading}
      >
        <SummaryLines summary={s} />
        <h4>{t("By payment")}</h4>
        <Table
          label={t("Sales by payment")}
          columns={["Payment", "Payments", "Collected", "Tips", "Refunds", "Net"]}
          empty={t("No payments in this period.")}
          rows={view.byChannel
            .filter((entry) => entry.paymentCount > 0 || entry.refundCount > 0)
            .map((entry) => [
              channelLabel[entry.channel],
              entry.paymentCount,
              money(entry.collectedMinor),
              money(entry.tipsMinor),
              money(entry.refundsMinor),
              money(entry.netCollectedMinor),
            ])}
        />
        <h4>{t("By order type")}</h4>
        <Table
          label={t("Sales by order type")}
          columns={["Order type", "Orders", "Net sales", "Tax", "Tips", "Refunds", "Net collected"]}
          empty={t("No orders in this period.")}
          rows={view.byOrderType
            .filter((entry) => entry.paymentCount > 0 || entry.refundCount > 0)
            .map((entry) => [
              orderTypeLabel[entry.orderType],
              entry.orderCount,
              money(entry.netSalesMinor),
              money(entry.taxMinor),
              money(entry.tipsMinor),
              money(entry.refundsMinor),
              money(entry.netCollectedMinor),
            ])}
        />
        {view.days.length > 1 ? (
          <>
            <h4>{t("By day")}</h4>
            <Table
              label={t("Sales by day")}
              columns={["Day", "Payments", "Net sales", "Tax", "Tips", "Refunds", "Net collected"]}
              empty={t("No days.")}
              rows={view.days.map((day) => [
                businessDateText(day.businessDate) + (day.status === "Open" ? t(" (so far)") : ""),
                day.summary.paymentCount,
                money(day.summary.netSalesMinor),
                money(day.summary.taxMinor),
                money(day.summary.tipsMinor),
                money(day.summary.refundsMinor),
                money(day.summary.netCollectedMinor),
              ])}
            />
          </>
        ) : null}
      </ReportSection>
      <ReportSection
        id="store-reports-items"
        title={t("Item sales")}
        description={t(
          "Each menu item and size, before tax. Options chosen with an item are included in its price. Refunds include dishes cancelled after payment.",
        )}
        report="items"
        onDownload={download}
        downloading={downloading}
      >
        <Table
          label={t("Item sales")}
          columns={[
            "Item",
            "Sold",
            "Gross sales",
            "Discounts",
            "Net sales",
            "Refunded",
            "Refunds",
            "Net after refunds",
          ]}
          empty={t("No items sold or refunded in this period.")}
          rows={view.items.map((row) => [
            row.name,
            row.quantitySold,
            money(row.grossSalesMinor),
            money(row.discountsMinor),
            money(row.netSalesMinor),
            row.refundedQuantity,
            money(row.refundsMinor),
            money(row.netAfterRefundsMinor),
          ])}
        />
      </ReportSection>
      <ReportSection
        id="store-reports-hours"
        title={t("Sales by hour")}
        description={t("By the store-time hour the payment was taken{value}.", {
          value: view.days.length > 1 ? ", all days together" : "",
        })}
        report="hourly"
        onDownload={download}
        downloading={downloading}
      >
        <Table
          label={t("Sales by hour")}
          columns={["Hour", "Payments", "Net sales", "Tax", "Tips", "Collected"]}
          empty={t("No payments in this period.")}
          rows={view.hours.map((row) => [
            row.hour,
            row.paymentCount,
            money(row.netSalesMinor),
            money(row.taxMinor),
            money(row.tipsMinor),
            money(row.collectedMinor),
          ])}
        />
      </ReportSection>
      <ReportSection
        id="store-reports-tips"
        title={t("Tips")}
        description={t(
          "Tips are recorded with each payment. The system does not record which staff member earned them; share them by your own tip-out rules.",
        )}
        report="tips"
        onDownload={download}
        downloading={downloading}
      >
        <Table
          label={t("Tips by day and payment")}
          columns={["Day", "Payment", "Tips", "Refunded", "Net tips"]}
          empty={t("No tips in this period.")}
          rows={view.tips.flatMap((day) =>
            day.channels
              .filter((entry) => entry.tipsMinor !== "0" || entry.refundedMinor !== "0")
              .map((entry) => [
                businessDateText(day.businessDate),
                channelLabel[entry.channel],
                money(entry.tipsMinor),
                money(entry.refundedMinor),
                money(entry.netMinor),
              ]),
          )}
        />
      </ReportSection>
      {view.mayExport ? null : (
        <p className="bop-muted">{t("Downloading reports needs the export permission.")}</p>
      )}
    </div>
  );
}

type State =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly view: StoreReportsView }
  | { readonly kind: "PermissionDenied" | "Busy" | "Unavailable" };

/** RPT-OPS-DASHBOARD: Store sales reports for the Owner and Store Manager. */
export function StoreReportsPage({
  storeLabel,
  fetcher,
}: {
  readonly storeLabel: string;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createStoreReportsClient(fetcher), [fetcher]);
  // WP-2423 Q21: "today" is the Store's current business day.
  const today = useStoreBusinessDay()?.businessDate ?? null;
  const [range, setRange] = useState<{ from: string; to: string } | null>(null);
  const [draft, setDraft] = useState<{ from: string; to: string }>({ from: "", to: "" });
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [revision, setRevision] = useState(0);
  const [busyRetries, setBusyRetries] = useState(0);
  const [downloading, setDownloading] = useState<StoreReportExportKind | null>(null);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const active = useRef<AbortController | null>(null);
  useEffect(() => {
    if (range === null && today !== null) {
      setRange({ from: today, to: today });
      setDraft({ from: today, to: today });
    }
  }, [range, today]);
  const load = useCallback(
    (current: { from: string; to: string }) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setState((s) => (s.kind === "Ready" ? s : { kind: "Loading" }));
      void client
        .load(current.from, current.to, controller.signal)
        .then((view) => {
          if (!controller.signal.aborted) setState({ kind: "Ready", view });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              kind: error instanceof StoreReportsClientError ? error.code : "Unavailable",
            });
        });
    },
    [client],
  );
  useEffect(() => {
    if (range === null) return;
    load(range);
    return () => active.current?.abort();
  }, [load, range, revision]);
  useEffect(() => {
    if (state.kind !== "Busy") {
      if (state.kind === "Ready") setBusyRetries(0);
      return;
    }
    if (busyRetries >= 3) return;
    const timer = setTimeout(() => {
      setBusyRetries((value) => value + 1);
      setRevision((value) => value + 1);
    }, 5000);
    return () => clearTimeout(timer);
  }, [state.kind, busyRetries]);
  const show = (from: string, to: string) => {
    setDraft({ from, to });
    setDownloadError(null);
    setRange({ from, to });
  };
  const download = (report: StoreReportExportKind) => {
    if (range === null) return;
    setDownloading(report);
    setDownloadError(null);
    const controller = new AbortController();
    void client
      .download(report, range.from, range.to, controller.signal)
      .then((file) => {
        const url = URL.createObjectURL(file.blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = file.fileName;
        document.body.append(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      })
      .catch((error: unknown) => {
        setDownloadError(
          error instanceof StoreReportsClientError && error.code === "PermissionDenied"
            ? actionAccessDeniedText
            : error instanceof StoreReportsClientError && error.code === "Busy"
              ? "The store's records are busy with orders and payments. Try the download again in a minute."
              : "The download failed. Check your connection and try again.",
        );
      })
      .finally(() => setDownloading(null));
  };
  const view = state.kind === "Ready" ? state.view : null;
  const invalid =
    draft.from === "" ||
    draft.to === "" ||
    draft.from > draft.to ||
    (today !== null && draft.to > today) ||
    draft.to > shiftDate(draft.from, 30);
  return (
    <WorkspacePage
      title={t("Reports")}
      meta={storeLabel}
      status={view ? <Freshness status="Fresh" at={view.generatedAt} /> : null}
      actions={
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          disabled={range === null}
        >
          {t("Refresh")}
        </button>
      }
    >
      <form
        className="list-filters store-reports__picker"
        aria-label={t("Report period")}
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) show(draft.from, draft.to);
        }}
      >
        <label>
          {t("From")}
          <input
            type="date"
            name="from"
            value={draft.from}
            max={today ?? undefined}
            onChange={(event) => setDraft({ ...draft, from: event.currentTarget.value })}
          />
        </label>
        <label>
          {t("To")}
          <input
            type="date"
            name="to"
            value={draft.to}
            max={today ?? undefined}
            onChange={(event) => setDraft({ ...draft, to: event.currentTarget.value })}
          />
        </label>
        <button type="submit" disabled={invalid}>
          {t("Show")}
        </button>
        {today === null ? null : (
          <div className="store-reports__presets" role="group" aria-label={t("Quick periods")}>
            <button type="button" onClick={() => show(today, today)}>
              {t("Today")}
            </button>
            <button type="button" onClick={() => show(shiftDate(today, -1), shiftDate(today, -1))}>
              {t("Yesterday")}
            </button>
            <button type="button" onClick={() => show(shiftDate(today, -6), today)}>
              {t("Last 7 days")}
            </button>
          </div>
        )}
        {invalid && draft.from !== "" && draft.to !== "" ? (
          <p className="bop-muted store-reports__hint" role="status">
            {t("Choose up to 31 days, ending no later than today's business day.")}
          </p>
        ) : null}
      </form>
      {downloadError === null ? null : (
        <p role="alert" className="command-error">
          {downloadError}
        </p>
      )}
      {state.kind === "Loading" ? (
        <StatePanel heading={t("Loading")} tone="neutral" status>
          <p>{t("Reading the store's sales…")}</p>
        </StatePanel>
      ) : state.kind === "PermissionDenied" ? (
        <StatePanel heading={noAccessHeading} tone="error" status>
          <p>{pageAccessDeniedText}</p>
        </StatePanel>
      ) : state.kind === "Busy" ? (
        <StatePanel heading={t("Busy for a moment")} tone="neutral" status>
          <p>
            {busyRetries >= 3
              ? t(
                  "The store's records are still busy with orders and payments. Refresh in a minute.",
                )
              : t(
                  "The store's records are busy with orders and payments. Trying again in a few seconds…",
                )}
          </p>
        </StatePanel>
      ) : state.kind === "Unavailable" ? (
        <StatePanel heading={t("Reports unavailable")} tone="error" status>
          <p>
            {t(
              "The reports could not be read. Check your connection and refresh. A period before the Store's setup took effect cannot be shown.",
            )}
          </p>
        </StatePanel>
      ) : view ? (
        <StoreReports view={view} onDownload={download} downloading={downloading} />
      ) : null}
    </WorkspacePage>
  );
}
