import { countOf, t } from "./i18n/i18n.js";
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
  StateMismatch: t("State differs"),
  AmountMismatch: t("Amount differs"),
  RefundMismatch: t("Refund differs"),
  TerminalConflict: t("Terminal conflict"),
};
const outcomeLabel: Record<SettlementOutcome, string> = {
  Matched: t("Matched"),
  Healed: t("Healed"),
  Difference: t("Difference"),
  Unresolved: t("Unresolved"),
  Unavailable: t("Provider unavailable"),
};
/** Payment states a Store Manager reads without the Provider's vocabulary. */
export const paymentStatusLabel: Record<string, string> = {
  RequiresCustomerAction: t("Awaiting customer action"),
  RequiresPaymentMethod: t("Awaiting payment method"),
  Processing: t("Processing"),
  Captured: t("Paid"),
  Canceled: t("Cancelled"),
};

/** "12 matched · 1 unresolved · 1 difference": matched first, then only what is not zero. */
export function summarizeOutcomes(outcomes: Readonly<Record<SettlementOutcome, number>>): string {
  const parts = [t("{Matched} matched", { Matched: outcomes.Matched })];
  if (outcomes.Healed > 0) parts.push(t("{Healed} healed", { Healed: outcomes.Healed }));
  if (outcomes.Unresolved > 0)
    parts.push(t("{Unresolved} unresolved", { Unresolved: outcomes.Unresolved }));
  if (outcomes.Difference > 0) parts.push(countOf(outcomes.Difference, "difference"));
  if (outcomes.Unavailable > 0)
    parts.push(t("{Unavailable} provider unavailable", { Unavailable: outcomes.Unavailable }));
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
    ? t("{n}st", { n: n })
    : n % 10 === 2 && n % 100 !== 12
      ? t("{n}nd", { n: n })
      : n % 10 === 3 && n % 100 !== 13
        ? t("{n}rd", { n: n })
        : t("{n}th", { n: n });
/** "$22.60 more at the payment provider" / "$22.60 less at the payment provider". */
function providerGap(ours: string, provider: string | null): string {
  if (provider === null) return t("the payment provider's figure could not be read");
  const gap = BigInt(provider) - BigInt(ours);
  return gap === 0n
    ? t("the same")
    : t("{value} {value2} at the payment provider", {
        value: formatSettlementMoney((gap < 0n ? -gap : gap).toString()),
        value2: gap > 0n ? "more" : "less",
      });
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
        {refunds ? t("Refunds for this day differ") : t("Payments for this day differ")}
      </h4>
      <p>
        {t(
          "The store's records show {ours} in {value}; the payment provider's statement shows {value2} ({ours2}).",
          {
            ours: formatSettlementMoney(ours),
            value: refunds ? t("refunds") : t("payments"),
            value2:
              provider === null
                ? t("an amount that could not be read")
                : formatSettlementMoney(provider),
            ours2: providerGap(ours, provider),
          },
        )}
      </p>
      <p>
        <span className="system-alert__label">{t("What to do:")} </span>
        {t(
          "{value}This day is checked again automatically when new records arrive. If it still differs, note what you found on the difference in",
          {
            value: refunds
              ? t(
                  "Check whether a refund for this day was made directly with the payment provider, or is still waiting for the provider to confirm it (open the order from Orders). ",
                )
              : t(
                  "A charge the payment provider took that matches no order is listed in Exceptions as an unmatched charge: review it there and refund it if the guest should not have paid. Otherwise check the day's orders and payments. ",
                ),
          },
        )}{" "}
        <Link to="/operations/order-exceptions">{t("Exceptions")}</Link>{" "}
        {t("and tell the pilot operator.")}
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
      ? t("Could not be read")
      : formatSettlementMoney(amount.amountMinor, amount.currencyCode);
  return (
    <div className="settlement">
      <section className="store-card settlement__day" aria-labelledby="settlement-day">
        <header>
          <h3 id="settlement-day">
            {t("Business day: {businessDate}", {
              businessDate: businessDateText(view.businessDate),
            })}
          </h3>
          <span className="status-chip" data-state={open ? "open" : "closed"}>
            {open ? t("Still open") : t("Closed")}
          </span>
        </header>
        <dl>
          <div>
            <dt>{t("From")}</dt>
            <dd>{storeTime(view.window.startsAt, zone, true)}</dd>
          </div>
          <div>
            <dt>{open ? t("Counted until") : t("To")}</dt>
            <dd>{storeTime(view.window.endsAt, zone, true)}</dd>
          </div>
        </dl>
        {open ? (
          <p className="bop-muted">
            {t("Totals grow until the business day closes; the settlement run happens after that.")}
          </p>
        ) : null}
      </section>
      <ul className="overview-counts settlement__totals" aria-label={t("Day totals")}>
        <li>
          <span className="overview-count__label">{t("Paid online")}</span>
          <strong className="overview-count__value">{money(view.captured)}</strong>
          <span className="overview-count__detail">
            {view.captured === null
              ? t("Payment source unavailable")
              : t("{count} payment{value}", {
                  count: view.captured.count,
                  value: view.captured.count === 1 ? "" : "s",
                })}
          </span>
        </li>
        <li>
          <span className="overview-count__label">{t("Refunded")}</span>
          <strong className="overview-count__value">{money(view.refunded)}</strong>
          <span className="overview-count__detail">
            {view.refunded === null
              ? t("Refund source unavailable")
              : t("{count} refund{value}", {
                  count: view.refunded.count,
                  value: view.refunded.count === 1 ? "" : "s",
                })}
          </span>
        </li>
        <li>
          <span className="overview-count__label">{t("Net")}</span>
          <strong className="overview-count__value">
            {view.captured && view.refunded
              ? formatSettlementMoney(
                  netMinor(view.captured.amountMinor, view.refunded.amountMinor),
                )
              : "—"}
          </strong>
          <span className="overview-count__detail">{t("Paid online minus refunded")}</span>
        </li>
      </ul>
      {/* WP-2423 Q7: the Store's own card machine, kept apart to match its batch total. */}
      {view.cardMachine === undefined ? null : view.cardMachine === null ? (
        <p className="bop-muted" role="status">
          {t("Card-machine payments could not be read.")}
        </p>
      ) : (
        <section
          className="store-card settlement__card-machine"
          aria-labelledby="settlement-card-machine"
        >
          <header>
            <h3 id="settlement-card-machine">{t("Store card machine")}</h3>
          </header>
          <ul className="overview-counts settlement__totals" aria-label={t("Card machine totals")}>
            <li>
              <span className="overview-count__label">{t("Taken on card machine")}</span>
              <strong className="overview-count__value">{money(view.cardMachine.taken)}</strong>
              <span className="overview-count__detail">
                {t("{count} payment{value} · tips {tipMinor}", {
                  count: view.cardMachine.taken.count,
                  value: view.cardMachine.taken.count === 1 ? "" : "s",
                  tipMinor: formatSettlementMoney(view.cardMachine.tipMinor),
                })}
              </span>
            </li>
            <li>
              <span className="overview-count__label">{t("Refunded on card machine")}</span>
              <strong className="overview-count__value">{money(view.cardMachine.refunded)}</strong>
              <span className="overview-count__detail">
                {t("{count} refund{value}", {
                  count: view.cardMachine.refunded.count,
                  value: view.cardMachine.refunded.count === 1 ? "" : "s",
                })}
              </span>
            </li>
            <li>
              <span className="overview-count__label">{t("Card machine net")}</span>
              <strong className="overview-count__value">
                {formatSettlementMoney(
                  netMinor(
                    view.cardMachine.taken.amountMinor,
                    view.cardMachine.refunded.amountMinor,
                  ),
                )}
              </strong>
              <span className="overview-count__detail">
                {t("Compare with the machine's batch total")}
              </span>
            </li>
          </ul>
          {view.cardMachine.recordedAfterOutageCount > 0 ? (
            <p role="note">
              {view.cardMachine.recordedAfterOutageCount === 1
                ? t(
                    "1 payment was recorded after an outage from a paper order; it counts on the day it was paid.",
                  )
                : t(
                    "{recordedAfterOutageCount} payments were recorded after an outage from paper orders; they count on the day they were paid.",
                    { recordedAfterOutageCount: view.cardMachine.recordedAfterOutageCount },
                  )}
            </p>
          ) : null}
          <p className="bop-muted">
            {t(
              "Not included in the online totals above or in the payment provider reconciliation.",
            )}
          </p>
        </section>
      )}
      {view.currentDaySelfApprovedRefunds !== null &&
      view.currentDaySelfApprovedRefunds.count > 0 ? (
        <p role="status" className="settlement__self-approved-today">
          {t("Today so far (")}
          {businessDateText(view.currentDaySelfApprovedRefunds.businessDate)}):{" "}
          {view.currentDaySelfApprovedRefunds.count} {t("refund")}
          {view.currentDaySelfApprovedRefunds.count === 1 ? "" : "s"} ·{" "}
          {formatSettlementMoney(view.currentDaySelfApprovedRefunds.amountMinor)}{" "}
          {t("approved by the owner alone.")}{" "}
          {onShowDay ? (
            <button
              type="button"
              onClick={() => onShowDay(view.currentDaySelfApprovedRefunds?.businessDate ?? "")}
            >
              {t("View today")}
            </button>
          ) : null}
        </p>
      ) : null}
      {view.selfApprovedRefunds === null ? (
        <p className="bop-muted" role="status">
          {t("Refunds approved by the owner alone could not be read.")}
        </p>
      ) : view.selfApprovedRefunds.count > 0 ? (
        <section
          className="store-card settlement__self-approved"
          aria-labelledby="settlement-self-approved"
        >
          <header>
            <h3 id="settlement-self-approved">{t("Refunds the owner approved alone")}</h3>
          </header>
          <p role="status">
            {t(
              "{count} refund{value} · {amountMinor} approved by the owner without a second person (sole operator) this business day. Review them against the orders.",
              {
                count: view.selfApprovedRefunds.count,
                value: view.selfApprovedRefunds.count === 1 ? "" : "s",
                amountMinor: formatSettlementMoney(view.selfApprovedRefunds.amountMinor),
              },
            )}
          </p>
        </section>
      ) : null}
      <section
        className="store-card settlement__reconciliation"
        aria-labelledby="settlement-reconciliation"
      >
        <header>
          <h3 id="settlement-reconciliation">{t("Reconciliation with the payment provider")}</h3>
        </header>
        {reconciliation === null || operational === null ? (
          <p role="status">{t("Reconciliation records could not be read.")}</p>
        ) : (
          <>
            {open ? (
              <p role="status">
                {t(
                  "The settlement run compares the day's totals with the provider's statement after the business day closes.",
                )}
              </p>
            ) : settlement === null ? (
              <p role="status" data-reconciled="pending">
                {t("Not settled yet. The settlement run for this day has not completed.")}
              </p>
            ) : (
              <p role="status" data-reconciled={settled(settlement)}>
                {settled(settlement)
                  ? t("Settled · the day's totals match the provider statement")
                  : t(
                      "Settlement difference · the day's totals differ from the provider statement",
                    )}
              </p>
            )}
            {settlement ? (
              <>
                <p className="bop-muted">
                  {t("Settlement run {completedAt}{value}", {
                    completedAt: storeTime(settlement.run.completedAt, zone, true),
                    value:
                      settlement.recheck === null
                        ? ""
                        : t(" · checked again {completedAt}", {
                            completedAt: storeTime(settlement.recheck.run.completedAt, zone, true),
                          }),
                  })}
                </p>
                <table
                  className="settlement__statement"
                  aria-label={t("Provider statement for {businessDate}", {
                    businessDate: businessDateText(view.businessDate),
                  })}
                >
                  <thead>
                    <tr>
                      <th scope="col">{t("Statement")}</th>
                      <th scope="col">{t("Result")}</th>
                      <th scope="col">{t("Paid (ours / provider)")}</th>
                      <th scope="col">{t("Refunded (ours / provider)")}</th>
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
                          label: t("Earlier check of {businessDate}", {
                            businessDate: businessDateText(view.businessDate),
                          }),
                        })),
                      ...settlement.checks.map((check) => ({
                        check,
                        label:
                          settlement.recheck === null
                            ? t("Provider statement for {businessDate}", {
                                businessDate: businessDateText(view.businessDate),
                              })
                            : t("First check of {businessDate}", {
                                businessDate: businessDateText(view.businessDate),
                              }),
                      })),
                      ...(settlement.recheck === null
                        ? []
                        : [
                            {
                              check: settlement.recheck.check,
                              label:
                                settlement.recheck.count === 1
                                  ? t("Checked again")
                                  : t("Checked again ({count} time)", {
                                      count: ordinal(settlement.recheck.count),
                                    }),
                            },
                          ]),
                      ...settlement.additionalChecks
                        .filter(
                          (check) => check.checkedAt >= (settlement.checks[0]?.checkedAt ?? ""),
                        )
                        .map((check) => ({
                          check,
                          label: t("Additional check of {businessDate}", {
                            businessDate: businessDateText(view.businessDate),
                          }),
                        })),
                    ].map(({ check, label }) => (
                      <tr key={check.checkReference}>
                        <td data-label={t("Statement")}>{label}</td>
                        <td data-label={t("Result")}>{resultLabel(check)}</td>
                        <td data-label={t("Paid")}>
                          {moneyPair(check.internalCapturedMinor, check.providerCapturedMinor)}
                        </td>
                        <td data-label={t("Refunded")}>
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
                    {t(
                      "The first check found a difference. The day was checked again after new records arrived and now matches the provider statement, so that difference is resolved. Both checks stay in the history.",
                    )}
                  </p>
                ) : null}
                {settlement.additionalChecks.length > 0 ? (
                  <p role="note" className="settlement__resolved">
                    {settlement.additionalChecks.length === 1
                      ? t(
                          "This day was checked more than once when it closed. The day's result is its scheduled check{value}; the other check stays in the history.",
                          {
                            value:
                              settlement.recheck === null
                                ? ""
                                : t(" and the checks made again after it"),
                          },
                        )
                      : t(
                          "This day was checked more than once when it closed. The day's result is its scheduled check{value}; the other checks stay in the history.",
                          {
                            value:
                              settlement.recheck === null
                                ? ""
                                : t(" and the checks made again after it"),
                          },
                        )}
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
                <h4 id="settlement-unmatched">{t("Charges that match no order")}</h4>
                <ul>
                  {view.unmatchedProviderCharges.captured.count > 0 ? (
                    <li>
                      {t(
                        "Charge the payment provider took that matches no order: {count} · {amountMinor}. Review it in",
                        {
                          count: countOf(view.unmatchedProviderCharges.captured.count, "charge"),
                          amountMinor: formatSettlementMoney(
                            view.unmatchedProviderCharges.captured.amountMinor,
                          ),
                        },
                      )}{" "}
                      <Link to="/operations/order-exceptions">{t("Exceptions")}</Link>.
                    </li>
                  ) : null}
                  {view.unmatchedProviderCharges.refunded.count > 0 ? (
                    <li>
                      {t("Refund of an unmatched provider charge: {count} · {amountMinor}", {
                        count: countOf(view.unmatchedProviderCharges.refunded.count, "refund"),
                        amountMinor: formatSettlementMoney(
                          view.unmatchedProviderCharges.refunded.amountMinor,
                        ),
                      })}
                    </li>
                  ) : null}
                </ul>
                <p className="bop-muted">
                  {t(
                    "Not in the Paid online and Refunded totals above, which are the store's own orders. The provider statement check counts them on the store's side.",
                  )}
                </p>
              </div>
            ) : null}
            <p className="bop-muted">
              {operational.latestRun === null
                ? t("No payment checks in this day yet.")
                : t("{paymentCount} checked in {runCount} · last {completedAt} · {outcomes}", {
                    paymentCount: countOf(operational.paymentCount, "payment"),
                    runCount: countOf(operational.runCount, "run"),
                    completedAt: storeTime(operational.latestRun.completedAt, zone, true),
                    outcomes: summarizeOutcomes(operational.outcomes),
                  })}
            </p>
            {unfinished.length > 0 ? (
              <p role="note" className="bop-muted settlement__unfinished">
                {t(
                  "{value} (the guest left or is still paying). Nothing was charged, so there is nothing to do.",
                  {
                    value:
                      unfinished.length === 1
                        ? t("1 online payment was started by a guest but not finished")
                        : t("{length} online payments were started by guests but not finished", {
                            length: unfinished.length,
                          }),
                  },
                )}
              </p>
            ) : null}
            {attention.length > 0 ? (
              <>
                <h4 id="settlement-attention">{t("Payments needing attention")}</h4>
                <table className="settlement__differences" aria-labelledby="settlement-attention">
                  <thead>
                    <tr>
                      <th scope="col">{t("Checked")}</th>
                      <th scope="col">{t("Result")}</th>
                      <th scope="col">{t("Paid (ours / provider)")}</th>
                      <th scope="col">{t("Refunded (ours / provider)")}</th>
                      <th scope="col">{t("Exception")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {attention.map((d) => (
                      <tr key={d.checkReference}>
                        <td data-label={t("Checked")}>{storeTime(d.checkedAt, zone)}</td>
                        <td data-label={t("Result")}>{resultLabel(d)}</td>
                        <td data-label={t("Paid")}>
                          {moneyPair(d.internalCapturedMinor, d.providerCapturedMinor)}
                        </td>
                        <td data-label={t("Refunded")}>
                          {moneyPair(d.internalRefundedMinor, d.providerRefundedMinor)}
                        </td>
                        <td data-label={t("Exception")}>
                          {d.exceptionReference === null ? (
                            "—"
                          ) : (
                            <Link to="/operations/order-exceptions">{t("Exceptions")}</Link>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {reconciliation.differenceCount > reconciliation.differences.length ? (
                  <p className="bop-muted">
                    {t("Showing the latest {length} of {differenceCount} payments.", {
                      length: reconciliation.differences.length,
                      differenceCount: reconciliation.differenceCount,
                    })}
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
    <StatePanel heading={t("No settlement records for this day")} tone="neutral" status>
      <p>
        {t(
          "{value} is before the store started using this system, so there is nothing to settle. The store's records begin on {firstBusinessDate}.",
          {
            value: requestedDate === null ? t("This day") : businessDateText(requestedDate),
            firstBusinessDate: businessDateText(firstBusinessDate),
          },
        )}
      </p>
      <button type="button" onClick={() => onShowDay?.(firstBusinessDate)}>
        {t("Show {firstBusinessDate}", { firstBusinessDate: businessDateText(firstBusinessDate) })}
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
      title={t("Settlement")}
      meta={storeLabel}
      status={view ? <Freshness status="Fresh" at={view.projectedAt} /> : null}
      actions={
        <button type="button" onClick={refresh}>
          {t("Refresh")}
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
          {t("Business day")}
          <input
            type="date"
            name="businessDate"
            value={draft}
            max={latestDay}
            onChange={(event) => setDraft(event.currentTarget.value)}
          />
        </label>
        <button type="submit">{t("Show")}</button>
        <button
          type="button"
          onClick={() => {
            setDraft("");
            setRequested(null);
          }}
        >
          {t("Latest closed day")}
        </button>
      </form>
      {state.kind === "Loading" ? (
        <StatePanel heading={t("Loading")} tone="neutral" status>
          <p>{t("Reading the day…")}</p>
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
        <StatePanel heading={t("Settlement unavailable")} tone="error" status>
          <p>
            {requested === null
              ? t("The day could not be read. Check your connection and refresh.")
              : t(
                  "That day could not be read. It may be in the future or before the Store's configuration took effect.",
                )}
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
