import { t } from "./i18n/i18n.js";
import { orderMoney } from "./order-money.js";
import { storeDate, storeLocalInputValue, storeLocalInstant, storeTime } from "./StoreTime.js";
import type { CounterOrderClientError } from "./staff-order-entry.js";
import type { CurrentOrderQueue } from "./current-order-queue-client.js";

/**
 * WP-2423 C2: card-machine payment text and slip time shared by the counter order page and the
 * payment and refund actions on Orders, kept apart so Orders does not load the counter page.
 */
const cad = (amountMinor: string) => orderMoney({ amountMinor, currencyCode: "CAD" });

export function payErrorText(
  error: CounterOrderClientError,
  /** WP-2423 M52: the payment was cash (no slip to check). */
  inCash = false,
) {
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
      return inCash
        ? t("Check the cash received and the paid-at time.")
        : t("Check the slip reference and the paid-at time.");
    case "CashShort":
      return t("The cash received is less than the cash total.");
    case "TakenBeforeRecords":
      return t(
        "That paid-at time is before this store started recording sales in the system. Check when it was paid and enter it again.",
      );
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
 * One card-machine (or cash) payment as staff entered it: the same key is the same payment command
 * (a retry reuses its operation), a corrected slip, time or cash is a new one.
 */
export function payIntentKey(
  orderBatchReference: string,
  expectedTotalMinor: string,
  inCash: boolean,
  slip: string,
  takenAt: string | null,
  tenderedMinor: string | null,
): string {
  return JSON.stringify([
    orderBatchReference,
    expectedTotalMinor,
    inCash ? "" : slip.trim(),
    takenAt,
    tenderedMinor,
  ]);
}

/**
 * DEC-PAPER-ORDER-PAID-AT-SEND: why a paper order's payment (taken during the outage) was not
 * recorded with it, in words that never ask staff to charge the guest again.
 */
export function paperPaymentProblem(error: CounterOrderClientError, inCash = false): string {
  switch (error.code) {
    case "AmountChanged":
      return error.totalMinor === null
        ? t("The total changed. Check it against the paper slip, then record the payment.")
        : t("The total is now {totalMinor}. Check it against the paper slip, then record it.", {
            totalMinor: cad(error.totalMinor),
          });
    case "PaymentWindowClosed":
    case "NotPayable":
      return t(
        "This paper order was taken off because its payment wasn't recorded in time. Enter the paper order again from the slip; don't charge the guest again.",
      );
    case "Unavailable":
    case "OutcomeUnknown":
      return t(
        "The order is in, but its payment from the paper slip isn't recorded yet. Record it again below: the same payment is never counted twice.",
      );
    default:
      return payErrorText(error, inCash);
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

/**
 * WP-2423 (v15 fabf0261): a refusal about the paid-at time itself (staff correct the time where they
 * typed it, then record again).
 */
export function paidAtRefusal(error: CounterOrderClientError): boolean {
  return error.code === "TakenBeforeRecords";
}

/**
 * WP-2423 (v15 fabf0261, Hotpot PC 9): a paper paid-at on another day than today where the Store
 * is: staff are asked to check the slip's date, since the payment counts on the day it was paid (a
 * typed date is the easiest mistake to miss). Null when it is today, or the time is not complete.
 */
export function paidAtDayNote(
  instant: string | null,
  now = Date.now(),
  timeZone?: string | undefined,
): string | null {
  if (instant === null) return null;
  const zone = timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  const day = (at: string) => storeLocalInputValue(at, zone).slice(0, 10);
  if (day(instant) === day(new Date(now).toISOString())) return null;
  return t(
    "{date} is not today. Check the date on the paper slip: the payment counts on the day it was paid.",
    { date: storeDate(instant, zone) },
  );
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
  /**
   * DEC-PAPER-ORDER-PAID-AT-SEND: a paper order whose payment (taken during the outage) did not
   * record with it. Staff are told it is not in the day's takings until recorded and what the
   * system does at the time, never to charge or take payment.
   */
  readonly paper?: boolean;
}): { readonly tier: "warning" | "urgent"; readonly ended: boolean; readonly text: string } {
  const at = storeTime(input.payBy, input.timeZone);
  const remainingMs = Date.parse(input.payBy) - input.now;
  if (input.paper === true) {
    if (remainingMs <= 0)
      return {
        tier: "urgent",
        ended: true,
        text: t(
          "Its payment wasn't recorded by {at}, so the system took this paper order off. Enter it again from the paper slip; don't charge the guest again.",
          { at },
        ),
      };
    const minutes = Math.max(1, Math.ceil(remainingMs / 60_000));
    return {
      tier: minutes <= paymentUrgentMinutes ? "urgent" : "warning",
      ended: false,
      text:
        minutes <= paymentUrgentMinutes
          ? t(
              "{minutes} min left: record this paper order's payment by {at}. Until it is recorded the sale isn't in the day's takings; after {at} the system takes the order off and you enter it again.",
              { minutes, at },
            )
          : t(
              "Record this paper order's payment now. Until it is recorded the sale isn't in the day's takings; if it still isn't by {at}, the system takes the order off and you enter it again.",
              { at },
            ),
    };
  }
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
export function counterPayByText(
  payBy: string,
  timeZone: string | undefined,
  now?: number,
  /** DEC-PAPER-ORDER-PAID-AT-SEND: a paper order, already paid during the outage. */
  paper = false,
) {
  const left = Date.parse(payBy) - (now ?? Date.now());
  const at = storeTime(payBy, timeZone);
  if (paper)
    return left <= 0
      ? t("Not recorded by {at} · enter the paper order again", { at })
      : t("Paid during the outage · record it by {at}, or it is taken off", { at });
  if (left <= 0) return t("Payment time ended at {at} · being released", { at: at });
  const minutes = Math.max(1, Math.ceil(left / 60_000));
  return minutes <= paymentUrgentMinutes
    ? t("{minutes} min left to charge · released at {at} if unpaid", { minutes: minutes, at: at })
    : t("Take payment by {at} · released if unpaid", { at: at });
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
  /** WP-2423 M52: paid in cash at the counter (the change to give back). */
  readonly cash?: { readonly changeMinor: string } | null | undefined;
}): string {
  if (input.cash != null) {
    const change = orderMoney({ amountMinor: input.cash.changeMinor, currencyCode: "CAD" });
    if (input.acceptance === "NotAccepted")
      return t(
        "Cash recorded. Give {change} change. It is not in the kitchen yet: accept it in Orders now (or ask a manager to); an order that isn't accepted in time expires and the cash must be given back.",
        { change },
      );
    return input.recordedAfterOutage
      ? t(
          "Cash recorded after the outage and accepted. If it was already made and handed over, mark it ready in Kitchen and handed over in Pickup.",
        )
      : t("Cash recorded. Give {change} change. Sent to the kitchen.", { change });
  }
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
