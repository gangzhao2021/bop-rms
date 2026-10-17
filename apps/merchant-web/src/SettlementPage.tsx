import { StatePanel } from "@bop-rms/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router";
import {
  createSettlementClient,
  SettlementClientError,
  type SettlementCheck,
  type SettlementOutcome,
  type SettlementReconciliation,
  type SettlementView,
  unfinishedGuestPayment,
} from "./settlement-client.js";
export { unfinishedGuestPayment };
import { orderMoney } from "./order-money.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";
import { Freshness, storeTime } from "./StoreTime.js";
import { WorkspacePage } from "./WorkspacePage.js";

/** "$12.34" from a minor-unit string; the app's one money format (`orderMoney`). */
export function formatSettlementMoney(amountMinor: string, currencyCode = "CAD"): string {
  return orderMoney({ amountMinor, currencyCode });
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
  Captured: "Paid",
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
type DaySettlement = NonNullable<SettlementReconciliation["settlement"]>;
/** WP-2423: the day's current statement checks — its latest re-check when it was checked again. */
const currentChecks = (settlement: DaySettlement): readonly SettlementCheck[] =>
  settlement.recheck === null ? settlement.checks : [settlement.recheck.check];
const settled = (settlement: DaySettlement) =>
  currentChecks(settlement).every(
    (check) => check.outcome === "Matched" || check.outcome === "Healed",
  );
const ordinal = (n: number) =>
  n % 10 === 1 && n % 100 !== 11
    ? `${n}st`
    : n % 10 === 2 && n % 100 !== 12
      ? `${n}nd`
      : n % 10 === 3 && n % 100 !== 13
        ? `${n}rd`
        : `${n}th`;
/** "$22.60 more at the payment provider" / "$22.60 less at the payment provider". */
function providerGap(ours: string, provider: string | null): string {
  if (provider === null) return "the payment provider's figure could not be read";
  const gap = BigInt(provider) - BigInt(ours);
  return gap === 0n
    ? "the same"
    : `${formatSettlementMoney((gap < 0n ? -gap : gap).toString())} ${gap > 0n ? "more" : "less"} at the payment provider`;
}

/**
 * WP-2423: what an open difference of the day's totals means and what staff can do, in their
 * words. A day is checked again automatically when new records arrive.
 */
function DayDifferenceHelp({ check }: { readonly check: SettlementCheck }) {
  const refunds = check.differenceReason === "RefundMismatch";
  const ours = refunds ? check.internalRefundedMinor : check.internalCapturedMinor;
  const provider = refunds ? check.providerRefundedMinor : check.providerCapturedMinor;
  return (
    <div
      className="settlement__difference-help"
      role="note"
      aria-labelledby="settlement-day-difference"
    >
      <h4 id="settlement-day-difference">
        {refunds ? "Refunds for this day differ" : "Payments for this day differ"}
      </h4>
      <p>
        The store&apos;s records show {formatSettlementMoney(ours)} in{" "}
        {refunds ? "refunds" : "payments"}; the payment provider&apos;s statement shows{" "}
        {provider === null ? "an amount that could not be read" : formatSettlementMoney(provider)} (
        {providerGap(ours, provider)}).
      </p>
      <p>
        <span className="system-alert__label">What to do: </span>
        {refunds
          ? "Check whether a refund for this day was made directly with the payment provider, or is still waiting for the provider to confirm it (open the order from Orders). "
          : "A charge the payment provider took that matches no order is listed in Exceptions as an unmatched charge: review it there and refund it if the guest should not have paid. Otherwise check the day's orders and payments. "}
        This day is checked again automatically when new records arrive. If it still differs, note
        what you found on the difference in{" "}
        <Link to="/operations/order-exceptions">Exceptions</Link> and tell the pilot operator.
      </p>
    </div>
  );
}

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
  onShowDay,
}: {
  readonly view: SettlementView;
  readonly timeZone?: string | undefined;
  /** WP-2423 Q19: open another business day (the current day's self-approved refunds). */
  readonly onShowDay?: (businessDate: string) => void;
}) {
  const zone = timeZone ?? view.window.timeZone;
  const open = view.window.status === "Open";
  const reconciliation = view.reconciliation;
  const settlement = reconciliation?.settlement ?? null;
  const operational = reconciliation?.operational ?? null;
  const differences = reconciliation?.differences ?? [];
  const unfinished = differences.filter(unfinishedGuestPayment);
  const attention = differences.filter((check) => !unfinishedGuestPayment(check));
  const money = (amount: SettlementView["captured"]) =>
    amount === null
      ? "Could not be read"
      : formatSettlementMoney(amount.amountMinor, amount.currencyCode);
  return (
    <div className="settlement">
      <section className="store-card settlement__day" aria-labelledby="settlement-day">
        <header>
          <h3 id="settlement-day">Business day: {businessDateText(view.businessDate)}</h3>
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
          <span className="overview-count__label">Paid online</span>
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
          <span className="overview-count__detail">Paid online minus refunded</span>
        </li>
      </ul>
      {/* WP-2423 Q7: the Store's own card machine, kept apart to match its batch total. */}
      {view.cardMachine === undefined ? null : view.cardMachine === null ? (
        <p className="bop-muted" role="status">
          Card-machine payments could not be read.
        </p>
      ) : (
        <section
          className="store-card settlement__card-machine"
          aria-labelledby="settlement-card-machine"
        >
          <header>
            <h3 id="settlement-card-machine">Store card machine</h3>
          </header>
          <ul className="overview-counts settlement__totals" aria-label="Card machine totals">
            <li>
              <span className="overview-count__label">Taken on card machine</span>
              <strong className="overview-count__value">{money(view.cardMachine.taken)}</strong>
              <span className="overview-count__detail">
                {view.cardMachine.taken.count} payment
                {view.cardMachine.taken.count === 1 ? "" : "s"} · tips{" "}
                {formatSettlementMoney(view.cardMachine.tipMinor)}
              </span>
            </li>
            <li>
              <span className="overview-count__label">Refunded on card machine</span>
              <strong className="overview-count__value">{money(view.cardMachine.refunded)}</strong>
              <span className="overview-count__detail">
                {view.cardMachine.refunded.count} refund
                {view.cardMachine.refunded.count === 1 ? "" : "s"}
              </span>
            </li>
            <li>
              <span className="overview-count__label">Card machine net</span>
              <strong className="overview-count__value">
                {formatSettlementMoney(
                  netMinor(
                    view.cardMachine.taken.amountMinor,
                    view.cardMachine.refunded.amountMinor,
                  ),
                )}
              </strong>
              <span className="overview-count__detail">
                Compare with the machine&apos;s batch total
              </span>
            </li>
          </ul>
          {view.cardMachine.recordedAfterOutageCount > 0 ? (
            <p role="note">
              {view.cardMachine.recordedAfterOutageCount} payment
              {view.cardMachine.recordedAfterOutageCount === 1 ? " was" : "s were"} recorded after
              an outage from paper orders; they count on the day they were paid.
            </p>
          ) : null}
          <p className="bop-muted">
            Not included in the online totals above or in the payment provider reconciliation.
          </p>
        </section>
      )}
      {view.currentDaySelfApprovedRefunds !== null &&
      view.currentDaySelfApprovedRefunds.count > 0 ? (
        <p role="status" className="settlement__self-approved-today">
          Today so far ({businessDateText(view.currentDaySelfApprovedRefunds.businessDate)}):{" "}
          {view.currentDaySelfApprovedRefunds.count} refund
          {view.currentDaySelfApprovedRefunds.count === 1 ? "" : "s"} ·{" "}
          {formatSettlementMoney(view.currentDaySelfApprovedRefunds.amountMinor)} approved by the
          owner alone.{" "}
          {onShowDay ? (
            <button
              type="button"
              onClick={() => onShowDay(view.currentDaySelfApprovedRefunds?.businessDate ?? "")}
            >
              View today
            </button>
          ) : null}
        </p>
      ) : null}
      {view.selfApprovedRefunds === null ? (
        <p className="bop-muted" role="status">
          Refunds approved by the owner alone could not be read.
        </p>
      ) : view.selfApprovedRefunds.count > 0 ? (
        <section
          className="store-card settlement__self-approved"
          aria-labelledby="settlement-self-approved"
        >
          <header>
            <h3 id="settlement-self-approved">Refunds the owner approved alone</h3>
          </header>
          <p role="status">
            {view.selfApprovedRefunds.count} refund
            {view.selfApprovedRefunds.count === 1 ? "" : "s"} ·{" "}
            {formatSettlementMoney(view.selfApprovedRefunds.amountMinor)} approved by the owner
            without a second person (sole operator) this business day. Review them against the
            orders.
          </p>
        </section>
      ) : null}
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
                  {settlement.recheck === null
                    ? ""
                    : ` · checked again ${storeTime(settlement.recheck.run.completedAt, zone, true)}`}
                </p>
                <table
                  className="settlement__statement"
                  aria-label={`Provider statement for ${businessDateText(view.businessDate)}`}
                >
                  <thead>
                    <tr>
                      <th scope="col">Statement</th>
                      <th scope="col">Result</th>
                      <th scope="col">Paid (ours / provider)</th>
                      <th scope="col">Refunded (ours / provider)</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      ...settlement.additionalChecks
                        .filter(
                          (check) => check.checkedAt < (settlement.checks[0]?.checkedAt ?? ""),
                        )
                        .map((check) => ({
                          check,
                          label: `Earlier check of ${businessDateText(view.businessDate)}`,
                        })),
                      ...settlement.checks.map((check) => ({
                        check,
                        label:
                          settlement.recheck === null
                            ? `Provider statement for ${businessDateText(view.businessDate)}`
                            : `First check of ${businessDateText(view.businessDate)}`,
                      })),
                      ...(settlement.recheck === null
                        ? []
                        : [
                            {
                              check: settlement.recheck.check,
                              label:
                                settlement.recheck.count === 1
                                  ? "Checked again"
                                  : `Checked again (${ordinal(settlement.recheck.count)} time)`,
                            },
                          ]),
                      ...settlement.additionalChecks
                        .filter(
                          (check) => check.checkedAt >= (settlement.checks[0]?.checkedAt ?? ""),
                        )
                        .map((check) => ({
                          check,
                          label: `Additional check of ${businessDateText(view.businessDate)}`,
                        })),
                    ].map(({ check, label }) => (
                      <tr key={check.checkReference}>
                        <td data-label="Statement">{label}</td>
                        <td data-label="Result">{resultLabel(check)}</td>
                        <td data-label="Paid">
                          {moneyPair(check.internalCapturedMinor, check.providerCapturedMinor)}
                        </td>
                        <td data-label="Refunded">
                          {moneyPair(check.internalRefundedMinor, check.providerRefundedMinor)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {settlement.recheck !== null &&
                settled(settlement) &&
                settlement.checks.some((check) => check.outcome === "Difference") ? (
                  <p role="note" className="settlement__resolved">
                    The first check found a difference. The day was checked again after new records
                    arrived and now matches the provider statement, so that difference is resolved.
                    Both checks stay in the history.
                  </p>
                ) : null}
                {settlement.additionalChecks.length > 0 ? (
                  <p role="note" className="settlement__resolved">
                    This day was checked more than once when it closed. The day&apos;s result is its
                    scheduled check
                    {settlement.recheck === null ? "" : " and the checks made again after it"}; the
                    other {settlement.additionalChecks.length === 1 ? "check stays" : "checks stay"}{" "}
                    in the history.
                  </p>
                ) : null}
                {currentChecks(settlement)
                  .filter((check) => check.outcome === "Difference")
                  .map((check) => (
                    <DayDifferenceHelp key={check.checkReference} check={check} />
                  ))}
              </>
            ) : null}
            {view.unmatchedProviderCharges &&
            (view.unmatchedProviderCharges.captured.count > 0 ||
              view.unmatchedProviderCharges.refunded.count > 0) ? (
              <div className="settlement__unmatched" aria-labelledby="settlement-unmatched">
                <h4 id="settlement-unmatched">Charges that match no order</h4>
                <ul>
                  {view.unmatchedProviderCharges.captured.count > 0 ? (
                    <li>
                      Charge the payment provider took that matches no order:{" "}
                      {plural(view.unmatchedProviderCharges.captured.count, "charge")} ·{" "}
                      {formatSettlementMoney(view.unmatchedProviderCharges.captured.amountMinor)}.
                      Review it in <Link to="/operations/order-exceptions">Exceptions</Link>.
                    </li>
                  ) : null}
                  {view.unmatchedProviderCharges.refunded.count > 0 ? (
                    <li>
                      Refund of an unmatched provider charge:{" "}
                      {plural(view.unmatchedProviderCharges.refunded.count, "refund")} ·{" "}
                      {formatSettlementMoney(view.unmatchedProviderCharges.refunded.amountMinor)}
                    </li>
                  ) : null}
                </ul>
                <p className="bop-muted">
                  Not in the Paid online and Refunded totals above, which are the store&apos;s own
                  orders. The provider statement check counts them on the store&apos;s side.
                </p>
              </div>
            ) : null}
            <p className="bop-muted">
              {operational.latestRun === null
                ? "No payment checks in this day yet."
                : `${plural(operational.paymentCount, "payment")} checked in ${plural(operational.runCount, "run")} · last ${storeTime(operational.latestRun.completedAt, zone, true)} · ${summarizeOutcomes(operational.outcomes)}`}
            </p>
            {unfinished.length > 0 ? (
              <p role="note" className="bop-muted settlement__unfinished">
                {unfinished.length === 1
                  ? "1 online payment was started by a guest but not finished"
                  : `${unfinished.length} online payments were started by guests but not finished`}{" "}
                (the guest left or is still paying). Nothing was charged, so there is nothing to do.
              </p>
            ) : null}
            {attention.length > 0 ? (
              <>
                <h4 id="settlement-attention">Payments needing attention</h4>
                <table className="settlement__differences" aria-labelledby="settlement-attention">
                  <thead>
                    <tr>
                      <th scope="col">Checked</th>
                      <th scope="col">Result</th>
                      <th scope="col">Paid (ours / provider)</th>
                      <th scope="col">Refunded (ours / provider)</th>
                      <th scope="col">Exception</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((d) => (
                      <tr key={d.checkReference}>
                        <td data-label="Checked">{storeTime(d.checkedAt, zone)}</td>
                        <td data-label="Result">{resultLabel(d)}</td>
                        <td data-label="Paid">
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

/** WP-2423: a business day before the Store's records begin — an answer, not a refusal. */
export function SettlementNotCovered({
  requestedDate,
  firstBusinessDate,
  onShowDay,
}: {
  readonly requestedDate: string | null;
  readonly firstBusinessDate: string;
  readonly onShowDay?: (businessDate: string) => void;
}) {
  return (
    <StatePanel heading="No settlement records for this day" tone="neutral" status>
      <p>
        {requestedDate === null ? "This day" : businessDateText(requestedDate)} is before the store
        started using this system, so there is nothing to settle. The store&apos;s records begin on{" "}
        {businessDateText(firstBusinessDate)}.
      </p>
      <button type="button" onClick={() => onShowDay?.(firstBusinessDate)}>
        Show {businessDateText(firstBusinessDate)}
      </button>
    </StatePanel>
  );
}

type State =
  | { readonly kind: "Loading" | "PermissionDenied" | "Busy" | "Unavailable" }
  | { readonly kind: "NotCovered"; readonly firstBusinessDate: string }
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
  // WP-2423 Q21: the latest day staff can ask for is the Store's current business day (after
  // midnight, before the business-day start, that is still the previous calendar date).
  const latestDay = useStoreBusinessDay()?.businessDate;
  // WP-2423: other screens (Exceptions) open a given day with ?businessDate=YYYY-MM-DD.
  const [search] = useSearchParams();
  const linkedDay = search.get("businessDate");
  const initialDay =
    linkedDay !== null && /^\d{4}-\d{2}-\d{2}$/u.test(linkedDay) ? linkedDay : null;
  const [requested, setRequested] = useState<string | null>(initialDay);
  const [draft, setDraft] = useState(initialDay ?? "");
  const [state, setState] = useState<State>({ kind: "Loading" });
  const [revision, setRevision] = useState(0);
  const [busyRetries, setBusyRetries] = useState(0);
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
            setState(
              error instanceof SettlementClientError &&
                error.code === "NotCovered" &&
                error.firstBusinessDate !== null
                ? { kind: "NotCovered", firstBusinessDate: error.firstBusinessDate }
                : {
                    kind:
                      error instanceof SettlementClientError && error.code !== "NotCovered"
                        ? error.code
                        : "Unavailable",
                  },
            );
        });
    },
    [client],
  );
  useEffect(() => {
    load(requested);
    return () => active.current?.abort();
  }, [load, requested, revision]);
  // Records busy with live ordering and payment work: try again on our own a few times.
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
            max={latestDay}
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
        <StatePanel heading={noAccessHeading} tone="error" status>
          <p>{pageAccessDeniedText}</p>
        </StatePanel>
      ) : state.kind === "Busy" ? (
        <StatePanel heading="Busy for a moment" tone="neutral" status>
          <p>
            {busyRetries >= 3
              ? "The store's records are still busy with orders and payments. Refresh in a minute."
              : "The store's records are busy with orders and payments. Trying again in a few seconds…"}
          </p>
        </StatePanel>
      ) : state.kind === "NotCovered" ? (
        <SettlementNotCovered
          requestedDate={requested}
          firstBusinessDate={state.firstBusinessDate}
          onShowDay={(businessDate) => {
            setDraft(businessDate);
            setRequested(businessDate);
          }}
        />
      ) : state.kind === "Unavailable" ? (
        <StatePanel heading="Settlement unavailable" tone="error" status>
          <p>
            {requested === null
              ? "The day could not be read. Check your connection and refresh."
              : "That day could not be read. It may be in the future or before the Store's configuration took effect."}
          </p>
        </StatePanel>
      ) : view ? (
        <SettlementReport
          view={view}
          timeZone={timeZone}
          onShowDay={(businessDate) => {
            setDraft(businessDate);
            setRequested(businessDate);
          }}
        />
      ) : null}
    </WorkspacePage>
  );
}
