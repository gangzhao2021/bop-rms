import { t } from "./i18n/i18n.js";
import type { EscalationReason } from "./ordinary-refund-client.js";

/** WP-2423 Q5: refund reasons staff choose from (codes stay server-owned). */
export const refundReasonCodes = [
  "CUSTOMER_REQUEST",
  "WRONG_ITEM",
  "MISSING_ITEM",
  "QUALITY_ISSUE",
  "LONG_WAIT",
  "DUPLICATE_CHARGE",
  "STORE_ERROR",
  "OTHER",
] as const;
export type RefundReasonCode = (typeof refundReasonCodes)[number];
export const refundReasonLabel: Readonly<Record<RefundReasonCode, string>> = {
  CUSTOMER_REQUEST: t("Customer asked for a refund"),
  WRONG_ITEM: t("Wrong item"),
  MISSING_ITEM: t("Item missing"),
  QUALITY_ISSUE: t("Quality problem"),
  LONG_WAIT: t("Waited too long"),
  DUPLICATE_CHARGE: t("Charged twice"),
  STORE_ERROR: t("Store mistake"),
  OTHER: t("Other (explain in a note)"),
};
/** A recorded reason in staff language; an unknown older code reads as a generic reason. */
export function describeRefundReason(code: string): string {
  if (code === "OTHER") return "Other";
  return (refundReasonLabel as Readonly<Record<string, string>>)[code] ?? t("Other reason");
}
/** Why an owner declined a refund. */
export const declineReasonLabel: Readonly<Record<string, string>> = {
  NOT_ELIGIBLE: t("Not eligible for a refund"),
  NEEDS_MORE_INFORMATION: t("More information needed"),
  ENTERED_IN_ERROR: t("Entered by mistake"),
  CUSTOMER_WITHDREW: t("Customer no longer wants it"),
};
/** Why an owner's approval is needed, in plain language. */
export const escalationReasonLabel: Readonly<Record<EscalationReason, string>> = {
  DifferentBusinessDate: t("The payment was made on an earlier business day"),
  MoreThan24Hours: t("The payment was made more than 24 hours ago"),
  OrderOrdinaryTotalAboveCad100: t("Refunds on this order would total more than $100"),
  ManualAllocationOverride: t("The tip or service charge was changed by hand"),
};
