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
export function cashTender(dueMinor: bigint, received: string) {
  const cashDueMinor = cashTotalMinor(dueMinor);
  const receivedMinor = dollarsToMinor(received);
  const changeMinor = receivedMinor === null ? null : receivedMinor - cashDueMinor;
  return {
    cashDueMinor,
    receivedMinor,
    changeMinor,
    /** Enough cash was received to record it. */
    ready:
      changeMinor !== null && changeMinor >= 0n && receivedMinor !== null && receivedMinor > 0n,
  };
}

export function CashTenderFields({
  idPrefix,
  dueMinor,
  received,
  onReceived,
  disabled,
  showDue = true,
}: {
  readonly idPrefix: string;
  /** Whether to say the cash total here (false when the page already shows it). */
  readonly showDue?: boolean;
  /** What the order comes to (tax and tip included), before the cash rounding. */
  readonly dueMinor: bigint;
  readonly received: string;
  readonly onReceived: (value: string) => void;
  readonly disabled: boolean;
}) {
  const tender = cashTender(dueMinor, received);
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
          disabled={disabled}
          aria-invalid={received !== "" && tender.receivedMinor === null}
          aria-describedby={idPrefix + "-change"}
          onChange={(event) => onReceived(event.currentTarget.value)}
        />
      </label>
      <div className="cash-tender__quick" role="group" aria-label={t("Cash received")}>
        {cashQuickAmounts(tender.cashDueMinor).map((amount, index) => (
          <button
            key={amount.toString()}
            type="button"
            disabled={disabled}
            onClick={() => onReceived((Number(amount) / 100).toFixed(2))}
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
    </div>
  );
}
