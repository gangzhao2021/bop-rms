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
import { elapsedWords } from "./operations-alert-words.js";
import { noAccessHeading, pageAccessDeniedText } from "./access-denied.js";
import { businessDateLabel, businessDateText, useStoreBusinessDay } from "./StoreBusinessDay.js";
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
        {t("and tell BOP support.")}
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
      {/* DEC-DINE-IN-PAY-LATER: cash the Store took for tables, to compare with the till. */}
      {view.cash === undefined ? null : view.cash === null ? (
        <p className="bop-muted" role="status">
          {t("Cash payments could not be read.")}
        </p>
      ) : view.cash.received.count === 0 && view.cash.refunded.count === 0 ? null : (
        <section className="store-card settlement__cash" aria-labelledby="settlement-cash">
          <header>
            <h3 id="settlement-cash">{t("Cash")}</h3>
          </header>
          <ul className="overview-counts settlement__totals" aria-label={t("Cash totals")}>
            <li>
              <span className="overview-count__label">{t("Cash received")}</span>
              <strong className="overview-count__value">{money(view.cash.received)}</strong>
              <span className="overview-count__detail">
                {t("{count} payment{value} · tips {tipMinor}", {
                  count: view.cash.received.count,
                  value: view.cash.received.count === 1 ? "" : "s",
                  tipMinor: formatSettlementMoney(view.cash.tipMinor),
                })}
              </span>
            </li>
            <li>
              <span className="overview-count__label">{t("Cash refunds")}</span>
              <strong className="overview-count__value">{money(view.cash.refunded)}</strong>
              <span className="overview-count__detail">
                {t("{count} refund{value}", {
                  count: view.cash.refunded.count,
                  value: view.cash.refunded.count === 1 ? "" : "s",
                })}
              </span>
            </li>
            <li>
              <span className="overview-count__label">{t("Net cash")}</span>
              <strong className="overview-count__value">
                {formatSettlementMoney(view.cash.netMinor)}
              </strong>
              <span className="overview-count__detail">
                {t("Cash rounding {roundingMinor}", {
                  roundingMinor: formatSettlementMoney(view.cash.roundingMinor),
                })}
              </span>
            </li>
          </ul>
          {view.cash.recordedAfterOutageCount > 0 ? (
            <p role="note">
              {t(
                "{recordedAfterOutageCount} cash payment(s) were recorded after an outage; they count on the day they were paid.",
                { recordedAfterOutageCount: view.cash.recordedAfterOutageCount },
              )}
            </p>
          ) : null}
          <p className="bop-muted">
            {t(
              "Cash our system recorded for tables. The till also holds cash from your own register, so compare this part only.",
            )}
          </p>
        </section>
      )}
      {/* WP-2423 item 8 ① segment 2: comps and discounts, their own line (never hidden). */}
      {view.comps === undefined ? null : view.comps === null ? (
        <p className="bop-muted" role="status">
          {t("Comps and discounts could not be read.")}
        </p>
      ) : view.comps.count === 0 ? null : (
        <section className="store-card settlement__comps" aria-labelledby="settlement-comps">
          <header>
            <h3 id="settlement-comps">{t("Comps and discounts by a manager")}</h3>
          </header>
          <ul className="overview-counts settlement__totals" aria-label={t("Comps and discounts")}>
            <li>
              <span className="overview-count__label">{t("Taken off bills")}</span>
              <strong className="overview-count__value">{money(view.comps)}</strong>
              <span className="overview-count__detail">{countOf(view.comps.count, "dish")}</span>
            </li>
          </ul>
          <p className="bop-muted">
            {t(
              "Decided today by a manager, with a reason, before the table paid. Not collected, so not in the takings above. This amount includes the tax taken off; Reports show comps before tax. Points guests used are not comps and are not included.",
            )}
          </p>
        </section>
      )}
      {/* DEC-DINE-IN-PAY-LATER (decision 4): never collected, kept in the day's summary. */}
      {view.unpaidWriteOffs === undefined ? null : view.unpaidWriteOffs === null ? (
        <p className="bop-muted" role="status">
          {t("Tables written off could not be read.")}
        </p>
      ) : view.unpaidWriteOffs.count === 0 ? null : (
        <section
          className="store-card settlement__write-offs"
          aria-labelledby="settlement-write-offs"
        >
          <header>
            <h3 id="settlement-write-offs">{t("Guests left without paying (written off)")}</h3>
          </header>
          <ul className="overview-counts settlement__totals" aria-label={t("Written off")}>
            <li>
              <span className="overview-count__label">{t("Written off")}</span>
              <strong className="overview-count__value">{money(view.unpaidWriteOffs)}</strong>
              <span className="overview-count__detail">
                {countOf(view.unpaidWriteOffs.count, "table")}
              </span>
            </li>
          </ul>
          {view.unpaidWriteOffs.recordedBy.map((person, index) => (
            <p key={index}>
              {person.name === null
                ? t("Recorded by someone no longer on staff: {tables}, {amount}", {
                    tables: countOf(person.count, "table"),
                    amount: formatSettlementMoney(person.amountMinor, "CAD"),
                  })
                : t("Recorded by {name}: {tables}, {amount}", {
                    name: person.name,
                    tables: countOf(person.count, "table"),
                    amount: formatSettlementMoney(person.amountMinor, "CAD"),
                  })}
            </p>
          ))}
          <p className="bop-muted">
            {t(
              "These guests were recorded as leaving without paying. Not collected, so not in the takings above.",
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
            ) : settlement === null && view.dayEndCheck?.state === "NotRun" ? (
              // WP-2423 (settlement-coverage): decided by the server; BOP is named as told only
              // when its channels were really sent the alert.
              <p role="status" data-reconciled="not-run">
                {view.dayEndCheck.supportAlerted
                  ? t(
                      "Not compared with the payment provider yet. This business day closed {duration} ago and its day-end check has not run. BOP support has been told; the figures above are not affected.",
                      { duration: elapsedWords(view.dayEndCheck.closedForMs) },
                    )
                  : t(
                      "Not compared with the payment provider yet. This business day closed {duration} ago and its day-end check has not run. It runs by itself once it is fixed; the figures above are not affected.",
                      { duration: elapsedWords(view.dayEndCheck.closedForMs) },
                    )}
              </p>
            ) : settlement === null && view.dayEndCheck?.state === "NotCovered" ? (
              // WP-2423 (settlement-coverage): before a real Pilot Store's issued record.
              <p role="status" data-reconciled="not-covered">
                {t(
                  "Not compared with the payment provider. Day-end checks for this Store started after this business day, so this day is not compared; the figures above are not affected.",
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

/** The business day before `businessDate` (a date label: no time zone is involved). */
export function previousBusinessDate(businessDate: string): string {
  return new Date(Date.parse(`${businessDate}T00:00:00.000Z`) - 86_400_000)
    .toISOString()
    .slice(0, 10);
}

/**
 * Owner 2026-11-03: the page opens on today, so what is left to finish on the last closed day is
 * said on today's page. The same reading as Home's opening checklist; nothing is calculated here.
 */
export function closedDayStillOpenText(view: SettlementView, today: string): string | null {
  const day = businessDateLabel(view.businessDate, today);
  const reconciliation = view.reconciliation;
  if (reconciliation === null)
    return t("{day} still needs closing: its checks could not be read.", { day: day });
  const attention = reconciliation.differences.filter((check) => !unfinishedGuestPayment(check));
  const settlement = reconciliation.settlement;
  if (settlement === null)
    return t("{day} still needs closing: not yet checked against the payment provider.", {
      day: day,
    });
  if (!settled(settlement))
    return t("{day} still needs closing: its totals differ from the provider statement.", {
      day: day,
    });
  if (attention.length > 0)
    return attention.length === 1
      ? t("{day} still needs closing: 1 payment to look at.", { day: day })
      : t("{day} still needs closing: {count} payments to look at.", {
          day: day,
          count: attention.length,
        });
  return null;
}

/** On today's page: is the last closed day finished? Silent when it is, or when there is none. */
type ClosedDay =
  | { readonly kind: "Quiet" }
  | { readonly kind: "Unread" }
  | { readonly kind: "Open"; readonly businessDate: string; readonly text: string };

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
  // Owner 2026-11-03: nothing asked for means today, the day a manager comes here to see; it follows
  // the Store's day as it turns over. Without a known Store day the server answers its last closed.
  const [requested, setRequested] = useState<string | null>(initialDay);
  const selected = requested ?? latestDay ?? null;
  const [draft, setDraft] = useState<string | null>(null);
  const showDay = (businessDate: string | null) => {
    setDraft(null);
    setRequested(businessDate);
  };
  const previousDay = latestDay ? previousBusinessDate(latestDay) : null;
  const [closedDay, setClosedDay] = useState<ClosedDay>({ kind: "Quiet" });
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
    load(selected);
    return () => active.current?.abort();
  }, [load, selected, revision]);
  // Viewing today: read the last closed day beside it, to say plainly if it is not finished.
  const today = selected !== null && selected === latestDay ? latestDay : null;
  useEffect(() => {
    if (today === null) {
      setClosedDay({ kind: "Quiet" });
      return;
    }
    const controller = new AbortController();
    void client
      .load(null, controller.signal)
      .then((closed) => {
        if (controller.signal.aborted) return;
        const text = closed.businessDate < today ? closedDayStillOpenText(closed, today) : null;
        setClosedDay(
          text === null
            ? { kind: "Quiet" }
            : { kind: "Open", businessDate: closed.businessDate, text },
        );
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // No earlier day to close, or no access (the page itself says so): nothing to add.
        const code = error instanceof SettlementClientError ? error.code : "Unavailable";
        setClosedDay(
          code === "NotCovered" || code === "PermissionDenied"
            ? { kind: "Quiet" }
            : { kind: "Unread" },
        );
      });
    return () => controller.abort();
  }, [client, today, revision]);
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
      className="settlement-page"
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
          showDay(draft === null ? requested : draft === "" ? null : draft);
        }}
      >
        {latestDay && previousDay ? (
          <div className="settlement__days">
            <button
              type="button"
              aria-pressed={selected === latestDay}
              onClick={() => showDay(null)}
            >
              {businessDateLabel(latestDay, latestDay)}
            </button>
            <button
              type="button"
              aria-pressed={selected === previousDay}
              onClick={() => showDay(previousDay)}
            >
              {businessDateLabel(previousDay, latestDay)}
            </button>
          </div>
        ) : null}
        <div className="settlement__other-day">
          <label>
            {t("Business day")}
            <input
              type="date"
              name="businessDate"
              value={draft ?? selected ?? ""}
              max={latestDay}
              onChange={(event) => setDraft(event.currentTarget.value)}
            />
          </label>
          <button type="submit">{t("Show")}</button>
        </div>
      </form>
      {closedDay.kind === "Open" ? (
        <p className="settlement__closed-day" role="status" data-tone="action">
          <span>{closedDay.text}</span>{" "}
          <button type="button" onClick={() => showDay(closedDay.businessDate)}>
            {t("Show {firstBusinessDate}", {
              firstBusinessDate: businessDateText(closedDay.businessDate),
            })}
          </button>
        </p>
      ) : closedDay.kind === "Unread" ? (
        <p className="settlement__closed-day" role="status">
          <span>
            {t("The last closed day could not be checked just now. Refresh to try again.")}
          </span>
        </p>
      ) : null}
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
          requestedDate={selected}
          firstBusinessDate={state.firstBusinessDate}
          onShowDay={showDay}
        />
      ) : state.kind === "Unavailable" ? (
        <StatePanel heading={t("Settlement unavailable")} tone="error" status>
          <p>
            {selected === null || selected === latestDay
              ? t("The day could not be read. Check your connection and refresh.")
              : t(
                  "That day could not be read. It may be in the future or before the Store's configuration took effect.",
                )}
          </p>
        </StatePanel>
      ) : view ? (
        <SettlementReport view={view} timeZone={timeZone} onShowDay={showDay} />
      ) : null}
    </WorkspacePage>
  );
}
