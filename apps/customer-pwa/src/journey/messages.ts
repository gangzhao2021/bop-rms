/** Customer sentences for server codes. Raw codes never reach the page; unknown codes get one safe sentence. */

const cartItemWarnings: Readonly<Record<string, string>> = Object.freeze({
  TRAINING_DATA_ONLY: "Training data only.",
  SOLD_OUT: "This item is sold out right now.",
  ITEM_UNAVAILABLE: "This item is no longer on the menu.",
  OPTION_UNAVAILABLE: "One of the choices for this item is no longer available.",
  PRICE_CHANGED: "The price of this item changed since you added it.",
  QUANTITY_LIMITED: "Fewer of this item are available than you chose.",
});

const quoteIssues: Readonly<Record<string, string>> = Object.freeze({
  TRAINING_DATA_ONLY: "Training data only.",
  PRICE_COVERAGE_MISSING: "An item in your order has no current price. Ask staff for help.",
  PRICE_BOOK_NOT_PUBLISHED: "Prices are being updated. Please try again in a moment.",
  OPTION_PRICE_MISSING: "One of your choices has no current price. Ask staff for help.",
  STOCK_RESERVATION_INSUFFICIENT: "An item is no longer available in the quantity you chose.",
  CATALOG_SELECTION_REJECTED: "An item or choice in your order is no longer available.",
  TAX_CONFIGURATION_NOT_EFFECTIVE: "Tax cannot be calculated right now. Ask staff for help.",
  PROMOTION_STACKING_CONFLICT: "Two discounts cannot be combined on this order.",
});

const lineEstimateReasons: Readonly<Record<string, string>> = Object.freeze({
  QUOTE_REQUIRED: "Priced at checkout",
  PRICE_UNAVAILABLE: "Price unavailable",
});

/** Sentence for a cart line warning, or null when the code carries nothing a customer can act on. */
export function cartItemWarningMessage(code: string): string | null {
  if (code === "OTHER_PARTICIPANT_ITEM") return null;
  return cartItemWarnings[code] ?? "Please check this item with staff before paying.";
}

/** Sentence for a quote warning or blocking reason. */
export function quoteIssueMessage(code: string, blocking: boolean): string {
  return (
    quoteIssues[code] ??
    (blocking
      ? "This order can’t be paid yet. Ask staff for help."
      : "Please review your order before paying.")
  );
}

/** Short label when a line has no estimate. */
export function lineEstimateLabel(reasonCode: string): string {
  return lineEstimateReasons[reasonCode] ?? "Priced at checkout";
}

/** Reasons the cart service gives for a rejected change, in customer words. */
export function cartIssueMessage(code: string): string | null {
  const known: Readonly<Record<string, string>> = {
    QUANTITY_OUT_OF_RANGE: "Choose between 1 and 100 of an item.",
    OPTION_REQUIRED: "A required choice is missing for this item.",
    OPTION_CONFLICT: "Two of the chosen options can’t be combined.",
    OPTION_UNAVAILABLE: "One of the chosen options is no longer available.",
    SELLABLE_UNAVAILABLE: "This item is no longer available.",
    SOLD_OUT: "This item is sold out right now.",
    NOTE_TOO_LONG: "Your note is too long.",
  };
  return known[code] ?? null;
}
