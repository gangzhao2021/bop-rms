import { isTableMoved } from "./customer-dining-table-moved.js";

/**
 * WP-2423 staff-wording-and-expected-refusals (v15 2026-11-11): the business refusals a guest's
 * round or payment meets in ordinary service, each answered on the phone in plain words (the
 * payment handler's explicit answers, customer-payment-intent.ts). Staff moved the table, a dish
 * ran out, the menu changed, the Store stopped taking orders, tips were turned off, the round is
 * already ordered or paid, another card is not allowed yet. Nothing was placed or charged for any
 * of them. They are expected, so the server logs them as information with their own code, never
 * as an error an operator must chase (a table move logged "INTERNAL_ADDITIONAL_PAYMENT_UNAVAILABLE"
 * at error level). Anything not listed here stays an unexpected failure.
 *
 * Also expected: another guest at the table is paying (shared tables, routine), a dish came off
 * the menu, and the checkout window lapsed while the guest decided (the cart prices again). Staff
 * moving the table is recognized however it arrives: Ordering's refusal, or Dining's own refusal
 * reaching the catch without `refuseRoundOfMovedTable` or the latch (customer-dining-table-moved).
 *
 * Deliberately not listed: PaymentIntentCreationError PAYMENT_INTENT_ORDER_NOT_READY. Its causes are
 * an unparseable or mismatched preparation record, a request time ahead of the server clock, a
 * preparation window that is not the fixed 30 minutes, or a missing prior operation: integrity or
 * clock failures nothing in ordinary service produces, so an operator must see them.
 *
 * Recognized by the error's name and code, not by class identity: the pilot composes some owner
 * stores from sources, so a second copy of an owner module can raise the same refusal.
 */
export type CustomerRoundRefusal =
  | "TABLE_MOVED"
  | "ITEMS_SHORT"
  | "REQUOTE_REQUIRED"
  | "STORE_CLOSED"
  | "ALREADY_ORDERED"
  | "TIPS_TURNED_OFF"
  | "PAY_LATER_TABLE"
  | "PAY_FIRST_TABLE"
  | "RETRY_LIMIT"
  | "RETRY_PENDING"
  | "ALREADY_PAID"
  | "WINDOW_ENDED"
  | "CHECKOUT_IN_PROGRESS"
  | "ITEM_UNAVAILABLE"
  | "CHECKOUT_EXPIRED";

const refusals: Readonly<Record<string, Readonly<Record<string, CustomerRoundRefusal>>>> = {
  OrderCreationError: {
    ORDER_CREATE_TABLE_MOVED: "TABLE_MOVED",
    ORDER_CREATE_STOCK_SHORT: "ITEMS_SHORT",
    ORDER_CREATE_ALREADY_ORDERED: "ALREADY_ORDERED",
    ORDER_CREATE_VALIDATION_EXPIRED: "CHECKOUT_EXPIRED",
  },
  CheckoutValidationError: {
    CHECKOUT_STOCK_SHORT: "ITEMS_SHORT",
    CHECKOUT_REQUOTE_REQUIRED: "REQUOTE_REQUIRED",
    CHECKOUT_ITEM_UNAVAILABLE: "ITEM_UNAVAILABLE",
    CHECKOUT_QUOTE_EXPIRED: "CHECKOUT_EXPIRED",
  },
  CheckoutSessionServiceError: {
    STORE_CLOSED: "STORE_CLOSED",
    CHECKOUT_IN_PROGRESS: "CHECKOUT_IN_PROGRESS",
    ITEM_UNAVAILABLE: "ITEM_UNAVAILABLE",
    ITEM_SHORT: "ITEMS_SHORT",
    REQUOTE_REQUIRED: "REQUOTE_REQUIRED",
    ALREADY_ORDERED: "ALREADY_ORDERED",
  },
  PaymentTipSelectionError: { PAYMENT_TIP_TURNED_OFF: "TIPS_TURNED_OFF" },
  PaymentIntentCreationError: {
    PAYMENT_INTENT_RETRY_LIMIT_REACHED: "RETRY_LIMIT",
    PAYMENT_INTENT_RETRY_NOT_ALLOWED: "RETRY_PENDING",
    PAYMENT_INTENT_ALREADY_PAID: "ALREADY_PAID",
    PAYMENT_INTENT_PREPARATION_EXPIRED: "WINDOW_ENDED",
  },
  CustomerDiningPayLaterError: { PayLater: "PAY_LATER_TABLE", PayFirst: "PAY_FIRST_TABLE" },
};

/** The refusal this error is, or null when it is not an expected business refusal. */
export function customerRoundRefusal(error: unknown): CustomerRoundRefusal | null {
  if (error === null || typeof error !== "object") return null;
  const { name, code } = error as { name?: unknown; code?: unknown };
  if (name === "CustomerStoreClosedError") return "STORE_CLOSED";
  if (isTableMoved(error)) return "TABLE_MOVED";
  if (typeof name !== "string" || typeof code !== "string" || !Object.hasOwn(refusals, name))
    return null;
  const byCode = refusals[name] as Readonly<Record<string, CustomerRoundRefusal>>;
  return Object.hasOwn(byCode, code) ? (byCode[code] as CustomerRoundRefusal) : null;
}

/**
 * The information line for an expected refusal (level 30, its event and refusal code only; never
 * the request, credentials, references or cart content), or null when `error` is not one.
 */
export function customerRoundRefusalLine(event: string, error: unknown): string | null {
  const refusal = customerRoundRefusal(error);
  if (refusal === null || !/^[A-Z][A-Z0-9_]{2,79}$/u.test(event)) return null;
  return JSON.stringify({ level: 30, time: new Date().toISOString(), event, code: refusal });
}
