import { useEffect, useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useBrowserOffline } from "./stale-read.js";
import { countOf, t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { storeTime } from "./StoreTime.js";
import { businessDateText } from "./StoreBusinessDay.js";
import {
  StoreReportsClientError,
  type StoreReportChannel,
  type StoreReportsClient,
  type StoreReportSummary,
  type TonightSummary,
} from "./store-reports-client.js";

const money = (minor: string | bigint) =>
  orderMoney({ amountMinor: String(minor), currencyCode: "CAD" });
const minus = (minor: string | bigint) => "−" + money(minor);
const channelText: Record<StoreReportChannel, string> = {
  Online: t("Online (guest's phone)"),
  CardMachine: t("Card machine"),
  Cash: t("Cash"),
};

/** One payment method's evening, from today's report (its own figures, never recomputed). */
export function tonightChannel(summary: TonightSummary, channel: StoreReportChannel) {
  return summary.report.byChannel.find((entry) => entry.channel === channel) ?? null;
}

/**
 * The checks the closing summary's figures always satisfy (the report's own rule): net sales are
 * gross less discounts and comps; what was taken is net sales, service charges, tax, tips and
 * cash rounding; the payment methods add up to the totals; and the open tables add up to their
 * total. Owner addition (a), 2026-10-28: a sample or a screen whose numbers don't add up is wrong.
 */
export function tonightProblems(summary: TonightSummary): readonly string[] {
  const s = summary.report.summary;
  const n = (value: string) => BigInt(value);
  const problems: string[] = [];
  const check = (ok: boolean, what: string) => {
    if (!ok) problems.push(what);
  };
  const rows: readonly StoreReportSummary[] = [s, ...summary.report.byChannel];
  for (const row of rows) {
    check(
      n(row.grossSalesMinor) - n(row.discountsMinor) - n(row.compsMinor) === n(row.netSalesMinor),
      "net sales",
    );
    check(
      n(row.netSalesMinor) +
        n(row.serviceChargesMinor) +
        n(row.taxMinor) +
        n(row.tipsMinor) +
        n(row.cashRoundingMinor) +
        n(row.unmatchedMinor) ===
        n(row.collectedMinor),
      "collected",
    );
    check(
      n(row.collectedMinor) - n(row.refundsMinor) === n(row.netCollectedMinor),
      "net collected",
    );
  }
  const sum = (key: keyof StoreReportSummary) =>
    summary.report.byChannel.reduce((total, row) => total + n(String(row[key])), 0n);
  for (const key of [
    "grossSalesMinor",
    "compsMinor",
    "netSalesMinor",
    "taxMinor",
    "tipsMinor",
    "cashRoundingMinor",
    "collectedMinor",
    "refundsMinor",
  ] as const)
    check(sum(key) === n(String(s[key])), "payment methods · " + key);
  check(
    summary.openTables.reduce((total, table) => total + n(table.owedMinor), 0n) ===
      n(summary.openTablesOwedMinor),
    "open tables",
  );
  return problems;
}

function Row({
  label,
  detail,
  value,
  strong = false,
  muted = false,
  tone,
}: {
  readonly label: string;
  readonly detail?: string | null;
  readonly value: string;
  readonly strong?: boolean;
  readonly muted?: boolean;
  readonly tone?: "action" | undefined;
}) {
  return (
    <div className="tonight__row" data-strong={strong} data-muted={muted} data-tone={tone}>
      <dt>
        {label}
        {detail ? <span className="tonight__detail">{detail}</span> : null}
      </dt>
      <dd>{value}</dd>
    </div>
  );
}

/**
 * WP-2423 item 8 ② (Figma 47-2): tonight's closing summary — today's report so far (the same
 * figures as the reports page and, once the day closes, the day-end settlement), what each
 * payment method took with a card-machine batch check and the drawer's table cash, the tables
 * still open, and tonight's refunds and cancellations (listed, not sales).
 */
export function TonightSummaryView({ summary }: { readonly summary: TonightSummary }) {
  const report = summary.report;
  const s = report.summary;
  const day = report.days[0];
  const online = tonightChannel(summary, "Online"),
    machine = tonightChannel(summary, "CardMachine"),
    cash = tonightChannel(summary, "Cash");
  const machineNet = machine === null ? 0n : BigInt(machine.netCollectedMinor);
  const drawer = cash === null ? 0n : BigInt(cash.netCollectedMinor);
  const open = summary.openTables;
  const c = summary.cancelled;
  return (
    <div className="tonight">
      <header className="tonight__head">
        <h2>{t("Tonight · {date}", { date: businessDateText(report.from) })}</h2>
        <p>
          <span className="tonight__status" data-open={day?.status === "Open"}>
            {day?.status === "Open"
              ? t("Open · as of {time}", { time: storeTime(report.generatedAt, report.timeZone) })
              : t("Day closed")}
          </span>{" "}
          <span className="tonight__detail">
            {t("Business day from {startsAt}", {
              startsAt: storeTime(report.startsAt, report.timeZone, true),
            })}
          </span>
        </p>
      </header>

      <section aria-labelledby="tonight-sales" className="tonight__section">
        <h3 id="tonight-sales">
          {t("Sales")}{" "}
          <span className="tonight__detail">{t("Since opening, paid and comped in full")}</span>
        </h3>
        <dl>
          <Row label={t("Gross sales")} value={money(s.grossSalesMinor)} />
          <Row
            label={t("Comps and discounts by a manager")}
            detail={countOf(s.compCount, "dish")}
            value={minus(s.compsMinor)}
          />
          {s.discountsMinor !== "0" ? (
            <Row label={t("Discounts")} value={minus(s.discountsMinor)} />
          ) : null}
          <Row label={t("Net sales")} value={money(s.netSalesMinor)} strong />
          {s.taxes.map((tax) => (
            <Row
              key={tax.label}
              label={t("Tax · {label}", { label: tax.label })}
              value={money(tax.amountMinor)}
            />
          ))}
          {s.serviceChargesMinor !== "0" ? (
            <Row label={t("Service charges")} value={money(s.serviceChargesMinor)} />
          ) : null}
        </dl>
      </section>

      <section aria-labelledby="tonight-takings" className="tonight__section">
        <h3 id="tonight-takings">
          {t("Taken, by payment method")}{" "}
          <span className="tonight__detail">{t("Tips shown apart")}</span>
        </h3>
        <table className="tonight__methods">
          <thead>
            <tr>
              <th scope="col">{t("Method")}</th>
              <th scope="col">{t("Payments")}</th>
              <th scope="col">{t("Tips")}</th>
              <th scope="col">{t("Taken")}</th>
            </tr>
          </thead>
          <tbody>
            {[online, machine, cash].map((row, index) =>
              row === null ? null : (
                <tr key={index}>
                  <th scope="row">{channelText[row.channel]}</th>
                  <td>{row.paymentCount}</td>
                  <td>{money(row.tipsMinor)}</td>
                  <td>{money(row.collectedMinor)}</td>
                </tr>
              ),
            )}
          </tbody>
        </table>
        {cash !== null && (cash.paymentCount > 0 || cash.refundCount > 0) ? (
          <dl className="tonight__cash">
            <Row label={t("Cash rounding")} value={money(cash.cashRoundingMinor)} muted />
            <Row
              label={t("Cash given back")}
              detail={countOf(cash.refundCount, "refund")}
              value={minus(cash.refundsMinor)}
              muted
            />
            <Row label={t("Table cash that should be in the drawer")} value={money(drawer)} />
          </dl>
        ) : null}
        <dl>
          <Row label={t("Total taken")} value={money(s.collectedMinor)} strong />
          <Row
            label={t("Refunds")}
            detail={countOf(s.refundCount, "refund")}
            value={minus(s.refundsMinor)}
          />
          <Row label={t("Net taken")} value={money(s.netCollectedMinor)} strong />
        </dl>
        <ul className="tonight__checks">
          {machine !== null ? (
            // Owner addition (b): reconcile with the card machine's own batch.
            <li>
              {t(
                "Card machine: when you close, run its batch (settlement). The batch total should be {amount} (tips included, refunds taken off). If it differs, check each table's card payment.",
                { amount: money(machineNet) },
              )}
            </li>
          ) : null}
          {/* Owner addition (c): the drawer also holds the merchant's own register cash. */}
          <li>
            {t(
              "The cash drawer also holds cash taken on your own register. This figure is only the table cash this system recorded: count the two apart.",
            )}
          </li>
        </ul>
      </section>

      <section aria-labelledby="tonight-open" className="tonight__section">
        <h3 id="tonight-open">
          {t("Tables not paid yet")}{" "}
          <span className="tonight__detail">
            {open.length === 0
              ? t("Every table is paid")
              : t("{tables} · {amount} to take before closing", {
                  tables: countOf(open.length, "table"),
                  amount: money(summary.openTablesOwedMinor),
                })}
          </span>
        </h3>
        {open.length > 0 ? (
          <>
            <dl>
              {open.map((table) => (
                <Row
                  key={table.tableLabel}
                  tone={table.owedMinor !== "0" ? "action" : undefined}
                  label={t("Table {table}", { table: table.tableLabel })}
                  detail={
                    (table.phase === "Closing" ? t("Checking out") : t("Seated")) +
                    " · " +
                    t("open {minutes} min", { minutes: String(table.openedMinutes) })
                  }
                  value={table.owedMinor === "0" ? t("Paid") : money(table.owedMinor)}
                />
              ))}
            </dl>
            <p className="tonight__links">
              <Link to="/operations/dining">{t("Go to Tables")}</Link>
            </p>
            <p className="tonight__detail">
              {t(
                "Take each table's payment before closing. If guests left without paying, a manager records it on the table.",
              )}
            </p>
          </>
        ) : null}
        {s.unpaidWriteOffCount > 0 ? (
          <dl>
            <Row
              label={t("Guests left without paying (written off)")}
              detail={countOf(s.unpaidWriteOffCount, "table") + " · " + t("not taken")}
              value={money(s.unpaidWriteOffMinor)}
            />
          </dl>
        ) : null}
      </section>

      <section aria-labelledby="tonight-cancelled" className="tonight__section">
        <h3 id="tonight-cancelled">
          {t("Refunds and cancellations")}{" "}
          <span className="tonight__detail">{t("Listed only, not sales")}</span>
        </h3>
        <dl>
          <Row
            label={t("Refunds")}
            detail={countOf(s.refundCount, "refund")}
            value={money(s.refundsMinor)}
          />
          <Row
            label={t("Dishes taken off a bill before payment")}
            detail={countOf(c.removedBeforePayment.dishCount, "dish")}
            value={money(c.removedBeforePayment.amountMinor)}
          />
          {c.cancelledAfterPayment.dishCount > 0 ? (
            <Row
              label={t("Dishes cancelled after payment (refunded)")}
              detail={countOf(c.cancelledAfterPayment.dishCount, "dish")}
              value={money(c.cancelledAfterPayment.amountMinor)}
            />
          ) : null}
          <Row
            label={t("Rounds and orders cancelled unpaid")}
            detail={
              countOf(c.cancelledUnpaid.roundCount, "round") +
              " · " +
              countOf(c.cancelledUnpaid.dishCount, "dish")
            }
            value={money(c.cancelledUnpaid.amountMinor)}
          />
        </dl>
      </section>

      <section aria-labelledby="tonight-match" className="tonight__section">
        <h3 id="tonight-match">{t("Matches the day-end settlement")}</h3>
        <p className="tonight__detail">
          {t(
            "These are the reports' figures for today so far, from the same records as tomorrow's day-end settlement. Payments taken after the business day ends count on the next day.",
          )}
        </p>
        <p className="tonight__links">
          <Link to="/app/operations/payment-reconciliation">{t("Settlement")}</Link>
          <button type="button" onClick={() => window.print()}>
            {t("Print")}
          </button>
        </p>
      </section>
    </div>
  );
}

type TonightState =
  | { readonly kind: "Loading" }
  | { readonly kind: "Ready"; readonly summary: TonightSummary; readonly stale: boolean }
  | { readonly kind: "PermissionDenied" | "Busy" | "Unavailable" };

/**
 * The "Tonight" tab: reads the closing summary when shown and on Refresh (`revision`). If the
 * store system can't be reached, the last figures stay with their time and what staff do
 * instead (operating continuity; nothing is kept in the browser beyond this page).
 */
export function TonightReport({
  client,
  revision,
}: {
  readonly client: Pick<StoreReportsClient, "tonight">;
  readonly revision: number;
}) {
  const [state, setState] = useState<TonightState>({ kind: "Loading" });
  useEffect(() => {
    const controller = new AbortController();
    client
      .tonight(controller.signal)
      .then((summary) => {
        if (!controller.signal.aborted) setState({ kind: "Ready", summary, stale: false });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const code = error instanceof StoreReportsClientError ? error.code : "Unavailable";
        setState((prior) =>
          prior.kind === "Ready" && code !== "PermissionDenied"
            ? { ...prior, stale: true }
            : { kind: code },
        );
      });
    return () => controller.abort();
  }, [client, revision]);
  useBrowserOffline(() =>
    setState((prior) => (prior.kind === "Ready" ? { ...prior, stale: true } : prior)),
  );
  if (state.kind === "Loading")
    return (
      <p role="status" className="bop-muted">
        {t("Reading tonight's figures…")}
      </p>
    );
  if (state.kind === "PermissionDenied")
    return <p role="status">{t("Your access doesn't include the store's sales.")}</p>;
  if (state.kind !== "Ready")
    return (
      <TonightOffline at={null} timeZone={undefined}>
        {state.kind === "Busy"
          ? t("The store's records are busy with orders and payments. Refresh in a minute.")
          : null}
      </TonightOffline>
    );
  return (
    <>
      {state.stale ? (
        <TonightOffline
          at={state.summary.report.generatedAt}
          timeZone={state.summary.report.timeZone}
        />
      ) : null}
      <TonightSummaryView summary={state.summary} />
    </>
  );
}

/** What to do while tonight's figures can't be read (Figma 47-2, 390 offline). */
function TonightOffline({
  at,
  timeZone,
  children,
}: {
  readonly at: string | null;
  readonly timeZone: string | undefined;
  readonly children?: ReactNode;
}) {
  return (
    <section
      className="tonight__offline"
      role="status"
      aria-label={t("Can't reach the store system")}
    >
      <p className="tonight__offline-title">
        {at === null
          ? t("Can't reach the store system")
          : t("Can't reach the store system · showing the figures from {time}", {
              time: storeTime(at, timeZone),
            })}
      </p>
      {children ? <p>{children}</p> : null}
      <p>
        {t(
          "Card and cash taken since then are not counted yet. At closing, check the card machine's batch and the drawer's table cash against your paper slips; once the slips are entered, this page and tomorrow's day-end settlement include them.",
        )}
      </p>
    </section>
  );
}
