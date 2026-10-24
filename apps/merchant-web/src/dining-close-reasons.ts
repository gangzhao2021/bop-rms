import { t } from "./i18n/i18n.js";
/**
 * WP-2423 (B759): what still stops a table's Order from closing, in staff words with what to do.
 * The codes come from the server's close evaluation (the same one the close command applies:
 * settlement and closure eligibility); codes never reach the screen.
 */
const texts: Readonly<Record<string, string>> = {
  PAYMENT_RESULT_UNRESOLVED: t(
    "A guest's online payment has no result yet. Check again in a few minutes.",
  ),
  REFUND_PENDING: t(
    "A refund is still being made (online, or not yet recorded as refunded on the card machine). Record the card-machine refund on the Orders page, or check again in a few minutes.",
  ),
  REFUND_ALLOCATION_RECONCILIATION_REQUIRED: t(
    "A refund on this order needs to be reconciled first. Check it on the Exceptions page.",
  ),
  ORDER_BALANCE_UNPAID: t(
    "Part of the order hasn't been paid. Ask the guest to finish paying on their phone, or cancel the unpaid round on the Orders page.",
  ),
  ORDER_OVERPAYMENT_UNRESOLVED: t(
    "The guest paid more than the order now costs. Refund the difference on the Orders page.",
  ),
  ORDER_REPRICING_PENDING: t(
    "A change to the order is still waiting for approval or the kitchen. Resolve it on the Orders page.",
  ),
  AMENDMENT_PENDING: t(
    "A change to the order is still waiting for approval or the kitchen. Resolve it on the Orders page.",
  ),
  EXECUTION_NOT_FINAL: t(
    "Some items haven't been served or cancelled yet. Mark them served or cancel them on the Orders page.",
  ),
  FULFILLMENT_NOT_FINAL: t(
    "Some items haven't been served or cancelled yet. Mark them served or cancel them on the Orders page.",
  ),
  CANCELLATION_PENDING: t(
    "A cancellation is still waiting for a decision. Resolve it on the Orders page.",
  ),
  CRITICAL_TASK_BLOCKING: t(
    "An open issue on this order must be resolved first. Check the Exceptions page.",
  ),
  EVIDENCE_INCOMPLETE: t(
    "The kitchen hasn't finished recording this order yet. Check again in a minute.",
  ),
  FINANCIAL_FINALITY_REQUIRED: t(
    "The order's payments aren't settled yet. Check the order on the Orders page.",
  ),
  CLOSE_CHECK_UNAVAILABLE: t(
    "Couldn't check whether the order can be closed. Check the connection and try again.",
  ),
};
const fallback = t(
  "Something on this order still needs attention. Check the order on the Orders page.",
);

/** One line per distinct thing to do, in the order the server listed the reasons. */
export function closeReasonTexts(codes: readonly string[]): readonly string[] {
  return [...new Set(codes.map((code) => texts[code] ?? fallback))];
}
