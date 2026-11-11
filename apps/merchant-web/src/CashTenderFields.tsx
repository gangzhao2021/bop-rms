import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { cashQuickAmounts, dollarsToMinor } from "./TableCheckout.js";
import { cashTotalMinor } from "./table-checkout-client.js";

const cad = (minor: bigint) => orderMoney({ amountMinor: minor.toString(), currencyCode: "CAD" });

/**
 * WP-2423 M52 (DEC-COUNTER-CASH): what the cashier sees for a cash payment, by the table's cash
 * rules — the cash total rounded to 5 cents, the cash received (typed, or the exact amount and the
 * bills a guest usually hands over in one tap) and the change to give back. The server applies the
 * same rounding and refuses a short amount; this only shows it before anything is recorded.
 */
/**
 * WP-2423 M52: change above this ($100) is checked before it is recorded: a mistyped amount
 * ("5000" for $50.00) would otherwise be recorded, on an append-only row, as cash in the drawer.
 */
export const cashLargeChangeMinor = 10_000n;

export function cashTender(dueMinor: bigint, received: string, largeChangeConfirmed = false) {
  const cashDueMinor = cashTotalMinor(dueMinor);
  const receivedMinor = dollarsToMinor(received);
  const changeMinor = receivedMinor === null ? null : receivedMinor - cashDueMinor;
  const largeChange = changeMinor !== null && changeMinor > cashLargeChangeMinor;
  return {
    cashDueMinor,
    receivedMinor,
    changeMinor,
    /** The change is large enough that the cashier confirms the cash received first. */
    largeChange,
    /** Enough cash was received to record it (and a large change was confirmed). */
    ready:
      changeMinor !== null &&
      changeMinor >= 0n &&
      receivedMinor !== null &&
      receivedMinor > 0n &&
      (!largeChange || largeChangeConfirmed),
  };
}

export function CashTenderFields({
  idPrefix,
  dueMinor,
  received,
  onReceived,
  disabled,
  showDue = true,
  largeChangeConfirmed,
  onLargeChangeConfirmed,
  unanswered = false,
}: {
  readonly idPrefix: string;
  /** Whether to say the cash total here (false when the page already shows it). */
  readonly showDue?: boolean;
  /** What the order comes to (tax and tip included), before the cash rounding. */
  readonly dueMinor: bigint;
  readonly received: string;
  readonly onReceived: (value: string) => void;
  readonly disabled: boolean;
  /** The cashier confirmed the cash received for a large change. */
  readonly largeChangeConfirmed: boolean;
  readonly onLargeChangeConfirmed: (value: boolean) => void;
  /**
   * WP-2423 M52: a Record that got no answer. The cash received is kept as sent, so recording
   * again is the same payment and shows the tender and change that were really recorded.
   */
  readonly unanswered?: boolean;
}) {
  const tender = cashTender(dueMinor, received, largeChangeConfirmed);
  const locked = disabled || unanswered;
  const receive = (value: string) => {
    onLargeChangeConfirmed(false);
    onReceived(value);
  };
  return (
    <div className="cash-tender">
      {showDue ? (
        <p className="cash-tender__due">
          {t("Cash total {amount} (rounded to 5 cents)", { amount: cad(tender.cashDueMinor) })}
        </p>
      ) : null}
      <label>
        {t("Cash received")}
        <input
          id={idPrefix + "-received"}
          inputMode="decimal"
          autoComplete="off"
          value={received}
          disabled={locked}
          aria-invalid={received !== "" && tender.receivedMinor === null}
          aria-describedby={idPrefix + "-change"}
          onChange={(event) => receive(event.currentTarget.value)}
        />
      </label>
      {/* v15 batch 8: its own name, so a screen reader tells the quick amounts from the field. */}
      <div className="cash-tender__quick" role="group" aria-label={t("Quick cash amounts")}>
        {cashQuickAmounts(tender.cashDueMinor).map((amount, index) => (
          <button
            key={amount.toString()}
            type="button"
            disabled={locked}
            onClick={() => receive((Number(amount) / 100).toFixed(2))}
          >
            {index === 0 ? t("Exact {amount}", { amount: cad(amount) }) : cad(amount)}
          </button>
        ))}
      </div>
      <p
        id={idPrefix + "-change"}
        className="cash-tender__change"
        data-short={tender.changeMinor !== null && tender.changeMinor < 0n ? "true" : undefined}
        aria-live="polite"
      >
        {tender.changeMinor === null
          ? null
          : tender.changeMinor >= 0n
            ? t("Change {amount}", { amount: cad(tender.changeMinor) })
            : t("{amount} short", { amount: cad(-tender.changeMinor) })}
      </p>
      {tender.largeChange && tender.receivedMinor !== null && tender.changeMinor !== null ? (
        <div className="cash-tender__check" role="group">
          <p>
            {t("That is {change} in change. Check the cash received before you record it.", {
              change: cad(tender.changeMinor),
            })}
          </p>
          <label>
            <input
              type="checkbox"
              checked={largeChangeConfirmed}
              disabled={locked}
              onChange={(event) => onLargeChangeConfirmed(event.currentTarget.checked)}
            />
            {t("I counted {amount} received", { amount: cad(tender.receivedMinor) })}
          </label>
        </div>
      ) : null}
      {unanswered && tender.receivedMinor !== null ? (
        <p className="field-hint" role="status">
          {t(
            "No answer from the system. Record again: it sends the same {amount} received, so it is never counted twice.",
            { amount: cad(tender.receivedMinor) },
          )}
        </p>
      ) : null}
    </div>
  );
}
