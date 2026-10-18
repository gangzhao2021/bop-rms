import { orderMoney } from "./order-money.js";
import { storeLocalInstant } from "./StoreTime.js";
import type { CounterOrderClientError } from "./staff-order-entry.js";

/**
 * WP-2423 C2: card-machine payment text and slip time shared by the counter order page and the
 * payment and refund actions on Orders, kept apart so Orders does not load the counter page.
 */
const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

export function payErrorText(error: CounterOrderClientError) {
  switch (error.code) {
    case "AmountChanged":
      return error.totalMinor === null
        ? "The amount changed. Charge the new total before recording it."
        : `The amount to charge is now ${cad(error.totalMinor)}. Charge the difference, then record it.`;
    case "PaymentWindowClosed":
      return "The time to pay this order has ended and it was released. Refund the card machine payment and take the order again.";
    case "AlreadyPaid":
      return "This order is already paid. Check Orders before charging again.";
    case "NotPayable":
      return "This order can no longer be paid (released or changed). Refund the card machine payment if you charged it.";
    case "Invalid":
      return "Check the slip reference and the paid-at time.";
    case "PermissionDenied":
      return "Your session can't record payments. Sign in again or ask a manager.";
    case "OutcomeUnknown":
      return "No answer from the system. Record again — the same payment is never counted twice.";
    default:
      return "The payment could not be recorded. Try again.";
  }
}

/**
 * A date-time input value ("2026-10-13T14:05") read as Store time (WP-2423 Q21: the slip's time
 * where the Store is, not the device's zone) as an instant, or null.
 */
export function paidAtInstant(
  value: string,
  now = Date.now(),
  timeZone?: string | undefined,
): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/u.test(value)) return null;
  const local = timeZone === undefined ? null : storeLocalInstant(value, timeZone);
  if (timeZone !== undefined && local === null) return null;
  const time = (local === null ? new Date(value) : new Date(local)).getTime();
  if (!Number.isFinite(time) || time > now || now - time > 72 * 60 * 60 * 1000) return null;
  return new Date(Math.floor(time / 1000) * 1000).toISOString();
}
