import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { storeLocalInstant, storeTime } from "./StoreTime.js";
import type { CounterOrderClientError } from "./staff-order-entry.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";

/**
 * WP-2423 C2: card-machine payment text and slip time shared by the counter order page and the
 * payment and refund actions on Orders, kept apart so Orders does not load the counter page.
 */
const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

export function payErrorText(error: CounterOrderClientError) {
  switch (error.code) {
    case "AmountChanged":
      return error.totalMinor === null
        ? t("The amount changed. Charge the new total before recording it.")
        : t("The amount to charge is now {totalMinor}. Charge the difference, then record it.", {
            totalMinor: cad(error.totalMinor),
          });
    case "PaymentWindowClosed":
      return t(
        "The time to pay this order has ended and it was released. Refund the card machine payment and take the order again.",
      );
    case "AlreadyPaid":
      return t("This order is already paid. Check Orders before charging again.");
    case "NotPayable":
      return t(
        "This order can no longer be paid (released or changed). Refund the card machine payment if you charged it.",
      );
    case "Invalid":
      return t("Check the slip reference and the paid-at time.");
    case "PermissionDenied":
      return t("Your session can't record payments. Sign in again or ask a manager.");
    case "OutcomeUnknown":
      return t(
        "No answer from the system. Record again — the same payment is never counted twice.",
      );
    default:
      return t("The payment could not be recorded. Try again.");
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

/** WP-2423 item 5: minutes before the payment time ends when staff are warned urgently. */
export const paymentUrgentMinutes = 10;

/**
 * WP-2423 item 5 ("warn before timeouts"): what staff are told about the time left to record a
 * card-machine payment. A table round not recorded by then is cancelled automatically and never
 * reaches the kitchen; a counter order is released. Nothing is charged in the system either way.
 */
export function paymentWindowNotice(input: {
  readonly payBy: string;
  readonly now: number;
  readonly tableMode: boolean;
  readonly timeZone?: string | undefined;
}): { readonly tier: "warning" | "urgent"; readonly ended: boolean; readonly text: string } {
  const at = storeTime(input.payBy, input.timeZone);
  const remainingMs = Date.parse(input.payBy) - input.now;
  if (remainingMs <= 0)
    return {
      tier: "urgent",
      ended: true,
      text: input.tableMode
        ? t(
            "The time to pay this round ended at {at}. It was not sent to the kitchen and is cancelled automatically; nothing was charged in the system. If you charged the card machine, refund it on the machine.",
            { at: at },
          )
        : t(
            "The time to pay this order ended at {at}. It is released and its items go back to stock. If you charged the card machine, refund it on the machine.",
            { at: at },
          ),
    };
  const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
  if (minutes <= paymentUrgentMinutes)
    return {
      tier: "urgent",
      ended: false,
      text: input.tableMode
        ? t(
            "{minutes} min left: record the payment by {at} or this round is cancelled and its items go back to stock.",
            { minutes: minutes, at: at },
          )
        : t(
            "{minutes} min left: record the payment by {at} or the order is released and its items go back to stock.",
            { minutes: minutes, at: at },
          ),
    };
  return {
    tier: "warning",
    ended: false,
    text: input.tableMode
      ? t(
          "Record the payment by {at}. The kitchen starts this order once it is recorded here; if it isn't recorded by then, the round is cancelled.",
          { at: at },
        )
      : t(
          "Record the payment by {at}. If it isn't paid by then the order is released and its items go back to stock.",
          { at: at },
        ),
  };
}

/**
 * WP-2423 (v15 751dd768): a counter order sent and not paid on the card machine yet, still payable
 * (its pickup time not released): staff charge it from Orders or the Counter order page.
 */
export function counterAwaitingCardMachine(
  order: CurrentOrderQueue["items"][number],
  now = Date.now(),
): boolean {
  return (
    order.counter !== null &&
    order.counter.paidOnCardMachine === null &&
    order.counter.payBy !== null &&
    Date.parse(order.counter.payBy) > now &&
    order.awaitingPayment &&
    order.unfulfillable === null &&
    order.batches[0]?.acceptanceStatus === "NotAccepted"
  );
}
/** The tier of a counter order's pay-by warning: urgent in its last minutes. */
export function counterPayByTier(payBy: string, now: number | undefined) {
  return paymentWindowNotice({ payBy, now: now ?? Date.now(), tableMode: false }).tier;
}
/** The short row text of a counter order's pay-by time (the form says what to do). */
export function counterPayByText(payBy: string, timeZone: string | undefined, now?: number) {
  const left = Date.parse(payBy) - (now ?? Date.now());
  const at = storeTime(payBy, timeZone);
  if (left <= 0) return t("Payment time ended at {at} · being released", { at: at });
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return minutes <= paymentUrgentMinutes
    ? t("{minutes} min left to charge · released at {at} if unpaid", { minutes: minutes, at: at })
    : t("Charge on card machine by {at} · released if unpaid", { at: at });
}

/**
 * WP-2423 D1: what staff are told once a card-machine payment is recorded. The server accepts the
 * paid order or round with the record (it then goes to the kitchen) or leaves it for acceptance.
 * Shared by the counter's own charge step and its "Sent, not paid yet" list (v15 f971cecb).
 */
export function paidNoteText(input: {
  readonly tableMode: boolean;
  readonly recordedAfterOutage: boolean;
  readonly acceptance: "Accepted" | "NotAccepted";
}): string {
  if (input.acceptance === "NotAccepted")
    return t(
      "Paid, but not sent to the kitchen yet. Accept it in Orders now (or ask a manager to): an order that isn't accepted in time expires and must be refunded on the card machine.",
    );
  // A paper order was usually made and handed over already; it still goes through the list so its
  // records close, and nothing expires or is refunded by mistake.
  if (input.tableMode)
    return input.recordedAfterOutage
      ? t(
          "Recorded after the outage and added to the table's order. If it was already made and served, mark it ready in Kitchen and served on the order.",
        )
      : t("Paid and sent to the kitchen. It shows on the table's order as entered by staff.");
  return input.recordedAfterOutage
    ? t(
        "Recorded after the outage and accepted. If it was already made and handed over, mark it ready in Kitchen and handed over in Pickup.",
      )
    : t("Paid and sent to the kitchen.");
}
