/**
 * Staff-facing words for values the sources carry as codes (WP-2423: staff text in their
 * language, never internal codes). Each helper falls back to a plain phrase, never the raw code.
 */

/** "fr-CA" as "French (Canada)"; an unrecognised tag stays as written by staff. */
export function languageName(locale: string): string {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
  } catch {
    return locale;
  }
}

/** Receipt fields a digital receipt layout prints, in the words a customer reads on it. */
export const receiptFieldLabels: Readonly<Record<string, string>> = Object.freeze({
  Issuer: "Business name",
  Store: "Store name and address",
  OrderNumber: "Order number",
  IssuedAt: "Date and time",
  Items: "Items",
  Subtotal: "Subtotal",
  Discount: "Discounts",
  Fee: "Fees",
  Tax: "Taxes",
  Tip: "Tip",
  Total: "Total",
  PaymentStatus: "Payment status",
  RefundedTotal: "Amount refunded",
});

/** Review steps of a receipt template. */
export function receiptTemplateStateLabel(state: string): string {
  switch (state) {
    case "InReview":
      return "Waiting for approval";
    case "Approved":
      return "Approved, not yet published";
    case "Published":
      return "Published";
    case "Draft":
      return "Draft";
    default:
      return "Status being updated";
  }
}
