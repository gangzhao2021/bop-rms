import { displayLocale, t } from "./i18n/i18n.js";
/**
 * Staff-facing words for values the sources carry as codes (WP-2423: staff text in their
 * language, never internal codes). Each helper falls back to a plain phrase, never the raw code.
 */

/** "fr-CA" as "French (Canada)"; an unrecognised tag stays as written by staff. */
export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames([displayLocale()], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** Receipt fields a digital receipt layout prints, in the words a customer reads on it. */
export const receiptFieldLabels: Readonly<Record<string, string>> = Object.freeze({
  Issuer: t("Business name"),
  Store: t("Store name and address"),
  OrderNumber: t("Order number"),
  IssuedAt: t("Date and time"),
  Items: t("Items"),
  Subtotal: t("Subtotal"),
  Discount: t("Discounts"),
  Fee: t("Fees"),
  Tax: t("Taxes"),
  Tip: t("Tip"),
  Total: t("Total"),
  PaymentStatus: t("Payment status"),
  RefundedTotal: t("Amount refunded"),
});

/** Review steps of a receipt template. */
export function receiptTemplateStateLabel(state: string): string {
  switch (state) {
    case "InReview":
      return t("Waiting for approval");
    case "Approved":
      return t("Approved, not yet published");
    case "Published":
      return t("Published");
    case "Draft":
      return t("Draft");
    default:
      return t("Status being updated");
  }
}
