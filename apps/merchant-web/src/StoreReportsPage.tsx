import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { formatCad } from "./order-money.js";
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
  Online: "Online (card)",
  CardMachine: "Store card machine",
};
export const orderTypeLabel: Record<StoreReportOrderType, string> = {
  DineIn: "Dine-in",
  Pickup: "Pickup",
  Counter: "Counter",
};
const plural = (n: number, one: string, many = one + "s") => `${n} ${n === 1 ? one : many}`;

/** "2026-10-14" → the date `days` earlier/later, by calendar arithmetic in UTC (no time zone). */
export function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date + "T00:00:00.000Z") + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}
function rangeLabel(view: StoreReportsView): string {
  return view.from === view.to
    ? `Business day ${businessDateText(view.from)}`
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
    ["Gross sales", money(summary.grossSalesMinor)],
    ["Discounts", "−" + money(summary.discountsMinor)],
    ["Net sales", money(summary.netSalesMinor), true],
  ];
  if (summary.serviceChargesMinor !== "0")
    lines.push(["Service charges", money(summary.serviceChargesMinor)]);
  for (const tax of summary.taxes) lines.push([`Tax · ${tax.label}`, money(tax.amountMinor)]);
  if (summary.taxes.length !== 1) lines.push(["Tax", money(summary.taxMinor)]);
  lines.push(["Tips", money(summary.tipsMinor)]);
  if (summary.unmatchedMinor !== "0")
    lines.push(["Paid but not matched to items", money(summary.unmatchedMinor)]);
  lines.push(["Total collected", money(summary.collectedMinor), true]);
  lines.push([
    `Refunds (${plural(summary.refundCount, "refund")})`,
    "−" + money(summary.refundsMinor),
  ]);
  if (summary.refundsMinor !== "0") {
    lines.push(["  of which sales", money(summary.refunds.salesMinor)]);
    lines.push(["  of which tax", money(summary.refunds.taxMinor)]);
    lines.push(["  of which tips", money(summary.refunds.tipsMinor)]);
    if (summary.refunds.serviceChargesMinor !== "0")
      lines.push(["  of which service charges", money(summary.refunds.serviceChargesMinor)]);
    if (summary.refunds.notItemizedMinor !== "0")
      lines.push(["  not split by item", money(summary.refunds.notItemizedMinor)]);
  }
  lines.push(["Net collected", money(summary.netCollectedMinor), true]);
  lines.push(["Net sales after refunds", money(summary.netSalesAfterRefundsMinor)]);
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
            aria-label={`Download ${title.toLowerCase()} as CSV`}
          >
            {downloading === report ? "Preparing…" : "Download CSV"}
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
              Today so far
            </span>
          ) : null}
        </header>
        <p className="bop-muted">
          {storeTime(view.startsAt, view.timeZone, true)} to{" "}
          {storeTime(view.endsAt, view.timeZone, true)} (store time). A sale counts on the business
          day it was paid and a refund on the day the money went back, the same as the day-end
          settlement. Orders cancelled before payment are not sales.
        </p>
        {r.matchesSettlement ? (
          <p role="status" className="store-reports__match">
            Matches the day-end settlement: {money(r.settlementCollectedMinor)} collected,{" "}
            {money(r.settlementRefundedMinor)} refunded.
          </p>
        ) : (
          <p role="alert" className="command-error">
            These totals differ from the day-end settlement ({money(r.reportCollectedMinor)} vs{" "}
            {money(r.settlementCollectedMinor)} collected, {money(r.reportRefundedMinor)} vs{" "}
            {money(r.settlementRefundedMinor)} refunded). Refresh; if it stays, use the{" "}
            <Link to="/app/operations/payment-reconciliation">Settlement</Link> figures and tell the
            Owner.
          </p>
        )}
        {r.pendingOnlineRefundCount > 0 ? (
          <p role="note">
            {plural(r.pendingOnlineRefundCount, "online refund")}{" "}
            {r.pendingOnlineRefundCount === 1 ? "is" : "are"} still waiting for the card company to
            confirm and {r.pendingOnlineRefundCount === 1 ? "is" : "are"} not counted yet.
          </p>
        ) : null}
      </section>
      <ul className="overview-counts store-reports__totals" aria-label="Totals">
        <li>
          <span className="overview-count__label">Net sales</span>
          <strong className="overview-count__value">{money(s.netSalesMinor)}</strong>
          <span className="overview-count__detail">
            {plural(s.orderCount, "order")} · {plural(s.paymentCount, "payment")}
          </span>
        </li>
        <li>
          <span className="overview-count__label">Tax</span>
          <strong className="overview-count__value">{money(s.taxMinor)}</strong>
          <span className="overview-count__detail">Collected on sales</span>
        </li>
        <li>
          <span className="overview-count__label">Tips</span>
          <strong className="overview-count__value">{money(s.tipsMinor)}</strong>
          <span className="overview-count__detail">Before refunds</span>
        </li>
        <li>
          <span className="overview-count__label">Net collected</span>
          <strong className="overview-count__value">{money(s.netCollectedMinor)}</strong>
          <span className="overview-count__detail">
            {money(s.collectedMinor)} collected − {money(s.refundsMinor)} refunded
          </span>
        </li>
      </ul>
      <ReportSection
        id="store-reports-summary"
        title="Sales summary"
        report="summary"
        onDownload={download}
        downloading={downloading}
      >
        <SummaryLines summary={s} />
        <h4>By payment</h4>
        <Table
          label="Sales by payment"
          columns={["Payment", "Payments", "Collected", "Tips", "Refunds", "Net"]}
          empty="No payments in this period."
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
        <h4>By order type</h4>
        <Table
          label="Sales by order type"
          columns={["Order type", "Orders", "Net sales", "Tax", "Tips", "Refunds", "Net collected"]}
          empty="No orders in this period."
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
            <h4>By day</h4>
            <Table
              label="Sales by day"
              columns={["Day", "Payments", "Net sales", "Tax", "Tips", "Refunds", "Net collected"]}
              empty="No days."
              rows={view.days.map((day) => [
                businessDateText(day.businessDate) + (day.status === "Open" ? " (so far)" : ""),
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
        title="Item sales"
        description="Each menu item and size, before tax. Options chosen with an item are included in its price. Refunds include dishes cancelled after payment."
        report="items"
        onDownload={download}
        downloading={downloading}
      >
        <Table
          label="Item sales"
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
          empty="No items sold or refunded in this period."
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
        title="Sales by hour"
        description={`By the store-time hour the payment was taken${view.days.length > 1 ? ", all days together" : ""}.`}
        report="hourly"
        onDownload={download}
        downloading={downloading}
      >
        <Table
          label="Sales by hour"
          columns={["Hour", "Payments", "Net sales", "Tax", "Tips", "Collected"]}
          empty="No payments in this period."
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
        title="Tips"
        description="Tips are recorded with each payment. The system does not record which staff member earned them; share them by your own tip-out rules."
        report="tips"
        onDownload={download}
        downloading={downloading}
      >
        <Table
          label="Tips by day and payment"
          columns={["Day", "Payment", "Tips", "Refunded", "Net tips"]}
          empty="No tips in this period."
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
        <p className="bop-muted">Downloading reports needs the export permission.</p>
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
            ? "Your permissions do not allow downloading reports."
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
      title="Reports"
      meta={storeLabel}
      status={view ? <Freshness status="Fresh" at={view.generatedAt} /> : null}
      actions={
        <button
          type="button"
          onClick={() => setRevision((value) => value + 1)}
          disabled={range === null}
        >
          Refresh
        </button>
      }
    >
      <form
        className="list-filters store-reports__picker"
        aria-label="Report period"
        onSubmit={(event) => {
          event.preventDefault();
          if (!invalid) show(draft.from, draft.to);
        }}
      >
        <label>
          From
          <input
            type="date"
            name="from"
            value={draft.from}
            max={today ?? undefined}
            onChange={(event) => setDraft({ ...draft, from: event.currentTarget.value })}
          />
        </label>
        <label>
          To
          <input
            type="date"
            name="to"
            value={draft.to}
            max={today ?? undefined}
            onChange={(event) => setDraft({ ...draft, to: event.currentTarget.value })}
          />
        </label>
        <button type="submit" disabled={invalid}>
          Show
        </button>
        {today === null ? null : (
          <div className="store-reports__presets" role="group" aria-label="Quick periods">
            <button type="button" onClick={() => show(today, today)}>
              Today
            </button>
            <button type="button" onClick={() => show(shiftDate(today, -1), shiftDate(today, -1))}>
              Yesterday
            </button>
            <button type="button" onClick={() => show(shiftDate(today, -6), today)}>
              Last 7 days
            </button>
          </div>
        )}
        {invalid && draft.from !== "" && draft.to !== "" ? (
          <p className="bop-muted store-reports__hint" role="status">
            Choose up to 31 days, ending no later than today&apos;s business day.
          </p>
        ) : null}
      </form>
      {downloadError === null ? null : (
        <p role="alert" className="command-error">
          {downloadError}
        </p>
      )}
      {state.kind === "Loading" ? (
        <StatePanel heading="Loading" tone="neutral" status>
          <p>Reading the store&apos;s sales…</p>
        </StatePanel>
      ) : state.kind === "PermissionDenied" ? (
        <StatePanel heading="Permission denied" tone="error" status>
          <p>Your permissions do not allow the sales reports for this Store.</p>
        </StatePanel>
      ) : state.kind === "Busy" ? (
        <StatePanel heading="Busy for a moment" tone="neutral" status>
          <p>
            {busyRetries >= 3
              ? "The store's records are still busy with orders and payments. Refresh in a minute."
              : "The store's records are busy with orders and payments. Trying again in a few seconds…"}
          </p>
        </StatePanel>
      ) : state.kind === "Unavailable" ? (
        <StatePanel heading="Reports unavailable" tone="error" status>
          <p>
            The reports could not be read. Check your connection and refresh. A period before the
            Store&apos;s setup took effect cannot be shown.
          </p>
        </StatePanel>
      ) : view ? (
        <StoreReports view={view} onDownload={download} downloading={downloading} />
      ) : null}
    </WorkspacePage>
  );
}
