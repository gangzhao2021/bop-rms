import { useEffect, useRef } from "react";
import { t } from "./i18n/i18n.js";
import type { SlipConfirmation } from "./staff-order-entry.js";

/**
 * DEC-PAPER-SEND-IDEMPOTENT (b11 review): a paper slip whose reference is already recorded with
 * another order is never a dead end. After checking the slip, staff say it also paid this order
 * (one swipe for two orders) or it is another slip printed with the same reference (two card
 * machines); the server records the choice with their name. The same sale entered twice is not
 * recorded again.
 */
export function PaperSlipConfirm({
  orderNumber,
  disabled = false,
  onConfirm,
}: {
  /** The Store's number of the order the slip is recorded with, when known. */
  readonly orderNumber: string | null;
  readonly disabled?: boolean;
  readonly onConfirm: (confirmation: SlipConfirmation) => void;
}) {
  const question = useRef<HTMLFieldSetElement>(null);
  // b12: the question opens at the end of the order panel; it is brought into view with its
  // answers, so staff never hunt for it below the window.
  useEffect(() => {
    question.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return (
    <fieldset ref={question} className="paper-slip-confirm" disabled={disabled}>
      <legend>
        {orderNumber !== null
          ? t("Is this the slip already recorded with order {number}?", { number: orderNumber })
          : t("Is this the slip already recorded with another order?")}
      </legend>
      <p className="field-hint">
        {t(
          "Check the paper slip first. Your name is recorded with your answer. If this sale is already in that order, don't record it again.",
        )}
      </p>
      <div className="card-actions">
        <button type="button" onClick={() => onConfirm("SameSlipAlsoPaysThisOrder")}>
          {t("Same slip, it also paid for this order")}
        </button>
        <button type="button" onClick={() => onConfirm("DifferentSlipSameReference")}>
          {t("Another slip with the same reference")}
        </button>
      </div>
    </fieldset>
  );
}
