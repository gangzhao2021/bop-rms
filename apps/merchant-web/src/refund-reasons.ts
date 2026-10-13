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
] as const;
export type RefundReasonCode = (typeof refundReasonCodes)[number];
export const refundReasonLabel: Readonly<Record<RefundReasonCode, string>> = {
  CUSTOMER_REQUEST: "Customer asked for a refund",
  WRONG_ITEM: "Wrong item",
  MISSING_ITEM: "Item missing",
  QUALITY_ISSUE: "Quality problem",
  LONG_WAIT: "Waited too long",
  DUPLICATE_CHARGE: "Charged twice",
  STORE_ERROR: "Store mistake",
};
/** A recorded reason in staff language; an unknown older code reads as a generic reason. */
export function describeRefundReason(code: string): string {
  return (refundReasonLabel as Readonly<Record<string, string>>)[code] ?? "Other reason";
}
/** Why an owner's approval is needed, in plain language. */
export const escalationReasonLabel: Readonly<Record<EscalationReason, string>> = {
  DifferentBusinessDate: "The payment was made on an earlier business day",
  MoreThan24Hours: "The payment was made more than 24 hours ago",
  OrderOrdinaryTotalAboveCad100: "Refunds on this order would total more than CAD 100",
  ManualAllocationOverride: "The tip or service charge was changed by hand",
};
export const formatCad = (minor: string) =>
  "CAD " +
  (BigInt(minor) / 100n).toString() +
  "." +
  (BigInt(minor) % 100n).toString().padStart(2, "0");
