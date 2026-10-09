import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import {
  createSettlementClient,
  SettlementClientError,
  type SettlementDifference,
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
const outcomeLabel: Record<SettlementDifference["outcome"], string> = {
  Difference: "Difference",
  Unresolved: "Unresolved",
  Unavailable: "Provider unavailable",
};

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
  const runs = view.reconciliation?.runs ?? [];
  const latest = runs[0] ?? null;
  const differences = view.reconciliation?.differences ?? [];
  const totals = latest
    ? runs.reduce(
        (sum, run) => ({
          Matched: sum.Matched + run.counts.Matched,
          Healed: sum.Healed + run.counts.Healed,
          Unresolved: sum.Unresolved + run.counts.Unresolved,
          Unavailable: sum.Unavailable + run.counts.Unavailable,
          Difference: sum.Difference + run.counts.Difference,
        }),
        { Matched: 0, Healed: 0, Unresolved: 0, Unavailable: 0, Difference: 0 },
      )
    : null;
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
        {view.reconciliation === null ? (
          <p role="status">Reconciliation records could not be read.</p>
        ) : latest === null || totals === null ? (
          <p role="status">
            {open
              ? "The settlement run checks every payment against the provider after the business day closes."
              : "Not reconciled yet. The settlement run for this day has not completed."}
          </p>
        ) : (
          <>
            <p
              role="status"
              data-reconciled={totals.Difference + totals.Unresolved + totals.Unavailable === 0}
            >
              {totals.Difference + totals.Unresolved + totals.Unavailable === 0
                ? `Reconciled · ${totals.Matched} matched · ${totals.Healed} healed`
                : `${totals.Difference} difference${totals.Difference === 1 ? "" : "s"} · ${totals.Unresolved} unresolved · ${totals.Unavailable} unavailable · ${totals.Matched} matched`}
            </p>
            <p className="bop-muted">
              Last run {storeTime(latest.completedAt, zone, true)} ·{" "}
              {latest.mode === "DailySettlement" ? "daily settlement" : "operational check"}
              {runs.length > 1 ? ` · ${runs.length} runs` : ""}
            </p>
            {differences.length > 0 ? (
              <table className="settlement__differences">
                <thead>
                  <tr>
                    <th scope="col">Checked</th>
                    <th scope="col">Settlement ref</th>
                    <th scope="col">Result</th>
                    <th scope="col">Captured (ours / provider)</th>
                    <th scope="col">Refunded (ours / provider)</th>
                    <th scope="col">Exception</th>
                  </tr>
                </thead>
                <tbody>
                  {differences.map((d) => (
                    <tr key={d.checkReference}>
                      <td data-label="Checked">{storeTime(d.checkedAt, zone)}</td>
                      <td data-label="Settlement ref">{d.settlementReference ?? "—"}</td>
                      <td data-label="Result">
                        {outcomeLabel[d.outcome]}
                        {d.differenceReason
                          ? ` · ${differenceReasonLabel[d.differenceReason] ?? d.differenceReason}`
                          : ""}
                      </td>
                      <td data-label="Captured">
                        {formatSettlementMoney(d.internalCapturedMinor)} /{" "}
                        {d.providerCapturedMinor === null
                          ? "—"
                          : formatSettlementMoney(d.providerCapturedMinor)}
                      </td>
                      <td data-label="Refunded">
                        {formatSettlementMoney(d.internalRefundedMinor)} /{" "}
                        {d.providerRefundedMinor === null
                          ? "—"
                          : formatSettlementMoney(d.providerRefundedMinor)}
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
