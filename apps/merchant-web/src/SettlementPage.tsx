import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  createSettlementClient,
  SettlementClientError,
  type SettlementCheck,
  type SettlementOutcome,
  type SettlementReconciliation,
  type SettlementView,
} from "./settlement-client.js";
import { Freshness, storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";

/** "$12.34" from a minor-unit string; never floating point. */
export function formatSettlementMoney(amountMinor: string, currencyCode = "CAD"): string {
  const negative = amountMinor.startsWith("-");
  const digits = negative ? amountMinor.slice(1) : amountMinor;
  const whole = digits.length > 2 ? digits.slice(0, -2) : "0";
  const cents = digits.padStart(2, "0").slice(-2);
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
  return `${negative ? "-" : ""}${currencyCode === "CAD" ? "$" : currencyCode + " "}${grouped}.${cents}`;
}
const netMinor = (captured: string, refunded: string) =>
  (BigInt(captured) - BigInt(refunded)).toString();

export const differenceReasonLabel: Record<string, string> = {
  StateMismatch: "State differs",
  AmountMismatch: "Amount differs",
  RefundMismatch: "Refund differs",
  TerminalConflict: "Terminal conflict",
};
const outcomeLabel: Record<SettlementOutcome, string> = {
  Matched: "Matched",
  Healed: "Healed",
  Difference: "Difference",
  Unresolved: "Unresolved",
  Unavailable: "Provider unavailable",
};
/** Payment states a Store Manager reads without the Provider's vocabulary. */
export const paymentStatusLabel: Record<string, string> = {
  RequiresCustomerAction: "Awaiting customer action",
  RequiresPaymentMethod: "Awaiting payment method",
  Processing: "Processing",
  Captured: "Captured",
  Canceled: "Cancelled",
};
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
/** "12 matched · 1 unresolved · 1 difference": matched first, then only what is not zero. */
export function summarizeOutcomes(outcomes: Readonly<Record<SettlementOutcome, number>>): string {
  const parts = [`${outcomes.Matched} matched`];
  if (outcomes.Healed > 0) parts.push(`${outcomes.Healed} healed`);
  if (outcomes.Unresolved > 0) parts.push(`${outcomes.Unresolved} unresolved`);
  if (outcomes.Difference > 0) parts.push(plural(outcomes.Difference, "difference"));
  if (outcomes.Unavailable > 0) parts.push(`${outcomes.Unavailable} provider unavailable`);
  return parts.join(" · ");
}
const settled = (settlement: NonNullable<SettlementReconciliation["settlement"]>) =>
  settlement.checks.every((check) => check.outcome === "Matched" || check.outcome === "Healed");

const moneyPair = (ours: string, provider: string | null) =>
  `${formatSettlementMoney(ours)} / ${provider === null ? "—" : formatSettlementMoney(provider)}`;
/** "Unresolved · Awaiting customer action" or "Difference · Refund differs". */
function resultLabel(check: SettlementCheck): string {
  const detail =
    check.differenceReason !== null
      ? (differenceReasonLabel[check.differenceReason] ?? check.differenceReason)
      : check.outcome === "Unresolved" && check.internalStatus !== null
        ? (paymentStatusLabel[check.internalStatus] ?? check.internalStatus)
        : null;
  return detail === null
    ? outcomeLabel[check.outcome]
    : `${outcomeLabel[check.outcome]} · ${detail}`;
}
/** The day-end report for one business day; pure so every state renders without a network. */
export function SettlementReport({
  view,
  timeZone,
}: {
  readonly view: SettlementView;
  readonly timeZone?: string | undefined;
}) {
  const zone = timeZone ?? view.window.timeZone;
  const open = view.window.status === "Open";
  const reconciliation = view.reconciliation;
  const settlement = reconciliation?.settlement ?? null;
  const operational = reconciliation?.operational ?? null;
  const money = (amount: SettlementView["captured"]) =>
    amount === null
      ? "Could not be read"
      : formatSettlementMoney(amount.amountMinor, amount.currencyCode);
  return (
    <div className="settlement">
      <section className="store-card settlement__day" aria-labelledby="settlement-day">
        <header>
          <h3 id="settlement-day">Business day {view.businessDate}</h3>
          <span className="status-chip" data-state={open ? "open" : "closed"}>
            {open ? "Still open" : "Closed"}
          </span>
        </header>
        <dl>
          <div>
            <dt>From</dt>
            <dd>{storeTime(view.window.startsAt, zone, true)}</dd>
          </div>
          <div>
            <dt>{open ? "Counted until" : "To"}</dt>
            <dd>{storeTime(view.window.endsAt, zone, true)}</dd>
          </div>
        </dl>
        {open ? (
          <p className="bop-muted">
            Totals grow until the business day closes; the settlement run happens after that.
          </p>
        ) : null}
      </section>
      <ul className="overview-counts settlement__totals" aria-label="Day totals">
        <li>
          <span className="overview-count__label">Captured</span>
          <strong className="overview-count__value">{money(view.captured)}</strong>
          <span className="overview-count__detail">
            {view.captured === null
              ? "Payment source unavailable"
              : `${view.captured.count} payment${view.captured.count === 1 ? "" : "s"}`}
          </span>
        </li>
        <li>
          <span className="overview-count__label">Refunded</span>
          <strong className="overview-count__value">{money(view.refunded)}</strong>
          <span className="overview-count__detail">
            {view.refunded === null
              ? "Refund source unavailable"
              : `${view.refunded.count} refund${view.refunded.count === 1 ? "" : "s"}`}
          </span>
        </li>
        <li>
          <span className="overview-count__label">Net</span>
          <strong className="overview-count__value">
            {view.captured && view.refunded
              ? formatSettlementMoney(
                  netMinor(view.captured.amountMinor, view.refunded.amountMinor),
                )
              : "—"}
          </strong>
          <span className="overview-count__detail">Captured minus refunded</span>
        </li>
      </ul>
      <section
        className="store-card settlement__reconciliation"
        aria-labelledby="settlement-reconciliation"
      >
        <header>
          <h3 id="settlement-reconciliation">Reconciliation with the payment provider</h3>
        </header>
        {reconciliation === null || operational === null ? (
          <p role="status">Reconciliation records could not be read.</p>
        ) : (
          <>
            {open ? (
              <p role="status">
                The settlement run compares the day&apos;s totals with the provider&apos;s statement
                after the business day closes.
              </p>
            ) : settlement === null ? (
              <p role="status" data-reconciled="pending">
                Not settled yet. The settlement run for this day has not completed.
              </p>
            ) : (
              <p role="status" data-reconciled={settled(settlement)}>
                {settled(settlement)
                  ? "Settled · the day's totals match the provider statement"
                  : "Settlement difference · the day's totals differ from the provider statement"}
              </p>
            )}
            {settlement ? (
              <>
                <p className="bop-muted">
                  Settlement run {storeTime(settlement.run.completedAt, zone, true)}
                </p>
                <table className="settlement__statement" aria-label="Provider statement">
                  <thead>
                    <tr>
                      <th scope="col">Statement</th>
                      <th scope="col">Result</th>
                      <th scope="col">Captured (ours / provider)</th>
                      <th scope="col">Refunded (ours / provider)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {settlement.checks.map((check) => (
                      <tr key={check.checkReference}>
                        <td data-label="Statement">{check.settlementReference ?? "—"}</td>
                        <td data-label="Result">{resultLabel(check)}</td>
                        <td data-label="Captured">
                          {moneyPair(check.internalCapturedMinor, check.providerCapturedMinor)}
                        </td>
                        <td data-label="Refunded">
                          {moneyPair(check.internalRefundedMinor, check.providerRefundedMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
            <p className="bop-muted">
              {operational.latestRun === null
                ? "No payment checks in this day yet."
                : `${plural(operational.paymentCount, "payment")} checked in ${plural(operational.runCount, "run")} · last ${storeTime(operational.latestRun.completedAt, zone, true)} · ${summarizeOutcomes(operational.outcomes)}`}
            </p>
            {reconciliation.differences.length > 0 ? (
              <>
                <h4 id="settlement-attention">Payments needing attention</h4>
                <table className="settlement__differences" aria-labelledby="settlement-attention">
                  <thead>
                    <tr>
                      <th scope="col">Checked</th>
                      <th scope="col">Result</th>
                      <th scope="col">Captured (ours / provider)</th>
                      <th scope="col">Refunded (ours / provider)</th>
                      <th scope="col">Exception</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reconciliation.differences.map((d) => (
                      <tr key={d.checkReference}>
                        <td data-label="Checked">{storeTime(d.checkedAt, zone)}</td>
                        <td data-label="Result">{resultLabel(d)}</td>
                        <td data-label="Captured">
                          {moneyPair(d.internalCapturedMinor, d.providerCapturedMinor)}
                        </td>
                        <td data-label="Refunded">
                          {moneyPair(d.internalRefundedMinor, d.providerRefundedMinor)}
                        </td>
                        <td data-label="Exception">
                          {d.exceptionReference === null ? (
                            "—"
                          ) : (
                            <Link to="/operations/order-exceptions">Exceptions</Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reconciliation.differenceCount > reconciliation.differences.length ? (
                  <p className="bop-muted">
                    Showing the latest {reconciliation.differences.length} of{" "}
                    {reconciliation.differenceCount} payments.
                  </p>
                ) : null}
              </>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

type State =
  | { readonly kind: "Loading" | "PermissionDenied" | "Unavailable" }
  | { readonly kind: "Ready"; readonly view: SettlementView };

/** WP-2423 P1 (PAY-RECONCILIATION): the Store's day-end page. */
export function SettlementPage({
  storeLabel,
  timeZone,
  fetcher,
}: {
  readonly storeLabel: string;
  readonly timeZone?: string | undefined;
  readonly fetcher?: typeof fetch | undefined;
}) {
  const client = useMemo(() => createSettlementClient(fetcher), [fetcher]);
  const [requested, setRequested] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [revision, setRevision] = useState(0);
  const active = useRef<AbortController | null>(null);
  const load = useCallback(
    (businessDate: string | null) => {
      active.current?.abort();
      const controller = new AbortController();
      active.current = controller;
      setState((s) => (s.kind === "Ready" ? s : { kind: "Loading" }));
      void client
        .load(businessDate, controller.signal)
        .then((view) => {
          if (!controller.signal.aborted) setState({ kind: "Ready", view });
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted)
            setState({
              kind: error instanceof SettlementClientError ? error.code : "Unavailable",
            });
        });
    },
    [client],
  );
  useEffect(() => {
    load(requested);
    return () => active.current?.abort();
  }, [load, requested, revision]);
  const refresh = () => setRevision((value) => value + 1);
  const view = state.kind === "Ready" ? state.view : null;
  return (
    <WorkspacePage
      title="Settlement"
      meta={storeLabel}
      status={view ? <Freshness status="Fresh" at={view.projectedAt} /> : null}
      actions={
        <button type="button" onClick={refresh}>
          Refresh
        </button>
      }
    >
      <form
        className="list-filters settlement__picker"
        onSubmit={(event) => {
          event.preventDefault();
          setRequested(draft === "" ? null : draft);
        }}
      >
        <label>
          Business day
          <input
            type="date"
            name="businessDate"
            value={draft}
            max={new Date().toISOString().slice(0, 10)}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <button type="submit">Show</button>
        <button
          type="button"
          onClick={() => {
            setDraft("");
            setRequested(null);
          }}
        >
          Latest closed day
        </button>
      </form>
      {state.kind === "Loading" ? (
        <StatePanel heading="Loading" tone="neutral" status>
          <p>Reading the day…</p>
        </StatePanel>
      ) : state.kind === "PermissionDenied" ? (
        <StatePanel heading="Permission denied" tone="error" status>
          <p>Your permissions do not allow the settlement view for this Store.</p>
        </StatePanel>
      ) : state.kind === "Unavailable" ? (
        <StatePanel heading="Settlement unavailable" tone="error" status>
          <p>
            {requested === null
              ? "The day could not be read. Check your connection and refresh."
              : "That day could not be read. It may be in the future or before the Store's configuration took effect."}
          </p>
        </StatePanel>
      ) : view ? (
        <SettlementReport view={view} timeZone={timeZone} />
      ) : null}
    </WorkspacePage>
  );
}
