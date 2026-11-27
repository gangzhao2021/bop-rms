import { t } from "./i18n/i18n.js";
import { paidNoteText, paperAlreadyRecordedText } from "./counter-payment.js";
import type { PlacedCounterOrder, RecordedCardPayment } from "./staff-order-entry.js";

/*
 * Batch 67 (v15 b66 live, TM2 orders 20-22): switching the staff language right after a round was
 * sent ("20 号单" sent to the kitchen) or a counter order was paid ("21 号单已付款") reloaded the page
 * to an empty order, and the confirmation of what was just sent or paid was gone (the sale and the
 * round were recorded; only the screen lost them). The page keeps that confirmation through the
 * switch's reload with the same short-lived, this-tab-only keep entry the order being taken uses.
 * Only what the confirmation shows is kept, never sent again: each text is said again in the new
 * language from the facts it was made of, not kept as text in the old one.
 */

/** Where the "paid" line under the confirmation came from (said again after the switch). */
export type PaidNoteSource =
  | {
      readonly kind: "Recorded";
      readonly recordedAfterOutage: boolean;
      readonly acceptance: "Accepted" | "NotAccepted";
      readonly cash: { readonly changeMinor: string } | null;
    }
  | { readonly kind: "PaperAlreadyRecorded" }
  | { readonly kind: "AlreadyPaid"; readonly orderNumber: string; readonly paper: boolean };

export function paidNoteFrom(source: PaidNoteSource, tableMode: boolean): string {
  if (source.kind === "PaperAlreadyRecorded") return paperAlreadyRecordedText();
  if (source.kind === "AlreadyPaid")
    return source.paper
      ? paperAlreadyRecordedText()
      : t(
          "Order {number} is already paid; its payment is recorded. Don't charge the guest again; Orders shows it.",
          { number: source.orderNumber },
        );
  return paidNoteText({
    tableMode,
    recordedAfterOutage: source.recordedAfterOutage,
    acceptance: source.acceptance,
    cash: source.cash,
  });
}

/** The guests' dishes a sent round took in, as its confirmation lists them. */
export interface KeptGuestLine {
  readonly name: string;
  readonly options: string;
  readonly quantity: number;
  readonly estimateMinor: string | null;
  readonly unsellable: boolean;
  readonly phoneNumber: number | null;
  readonly phoneLeft: boolean;
}
/** The guests' dishes taken out with the round sent (what staff tell the guests). */
export type RemovedSource =
  | {
      readonly kind: "Guest";
      readonly lines: readonly { readonly name: string; readonly unsellable: boolean }[];
    }
  | { readonly kind: "TableCart"; readonly names: readonly string[] };

export interface KeptConfirmation<L> {
  readonly phase: "Sent" | "Paid" | "Accepted";
  readonly placed: PlacedCounterOrder;
  readonly lines: readonly L[];
  readonly tip: string;
  readonly customTip: string;
  readonly tender: "CardMachine" | "Cash";
  readonly paper: boolean;
  readonly changeDue: string | null;
  readonly paid: PaidNoteSource | null;
  readonly removed: RemovedSource | null;
  readonly sentGuest: readonly KeptGuestLine[];
}

const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
const minor = (value: unknown): value is string =>
  typeof value === "string" && /^-?\d{1,12}$/u.test(value);
const text = (value: unknown, most = 400): value is string =>
  typeof value === "string" && value.length <= most;
const nullable = <T>(value: unknown, is: (value: unknown) => value is T): value is T | null =>
  value === null || is(value);
const flag = (value: unknown): value is boolean => typeof value === "boolean";

function placedOf(value: unknown): PlacedCounterOrder | null {
  const raw = record(value);
  if (
    raw === null ||
    (raw.status !== "Placed" && raw.status !== "AlreadyPlaced") ||
    !text(raw.orderReference, 64) ||
    !text(raw.orderBatchReference, 64) ||
    !text(raw.orderNumber, 32) ||
    !Number.isSafeInteger(raw.orderVersion) ||
    !minor(raw.orderMinor) ||
    !minor(raw.tipMinor) ||
    !minor(raw.totalMinor) ||
    !nullable(raw.payBy, (v): v is string => text(v, 64)) ||
    !flag(raw.payLater) ||
    !flag(raw.recordedAfterOutage) ||
    !nullable(raw.tableLabel, (v): v is string => text(v, 120)) ||
    !(raw.paid === undefined || raw.paid === true)
  )
    return null;
  return {
    status: raw.status,
    orderReference: raw.orderReference,
    orderBatchReference: raw.orderBatchReference,
    orderNumber: raw.orderNumber,
    orderVersion: raw.orderVersion as number,
    orderMinor: raw.orderMinor,
    tipMinor: raw.tipMinor,
    totalMinor: raw.totalMinor,
    payBy: raw.payBy,
    payLater: raw.payLater,
    recordedAfterOutage: raw.recordedAfterOutage,
    tableLabel: raw.tableLabel,
    ...(raw.paid === true ? { paid: true as const } : {}),
  };
}

function paidOf(value: unknown): PaidNoteSource | null | undefined {
  if (value === null) return null;
  const raw = record(value);
  if (raw === null) return undefined;
  if (raw.kind === "PaperAlreadyRecorded") return { kind: "PaperAlreadyRecorded" };
  if (raw.kind === "AlreadyPaid" && text(raw.orderNumber, 32) && flag(raw.paper))
    return { kind: "AlreadyPaid", orderNumber: raw.orderNumber, paper: raw.paper };
  const cash = raw.cash === null ? null : record(raw.cash);
  if (
    raw.kind === "Recorded" &&
    flag(raw.recordedAfterOutage) &&
    (raw.acceptance === "Accepted" || raw.acceptance === "NotAccepted") &&
    (cash === null || minor(cash.changeMinor))
  )
    return {
      kind: "Recorded",
      recordedAfterOutage: raw.recordedAfterOutage,
      acceptance: raw.acceptance,
      cash: cash === null ? null : { changeMinor: cash.changeMinor as string },
    };
  return undefined;
}

function removedOf(value: unknown): RemovedSource | null | undefined {
  if (value === null) return null;
  const raw = record(value);
  if (raw === null || !Array.isArray(raw.lines ?? raw.names)) return undefined;
  if (raw.kind === "TableCart" && Array.isArray(raw.names) && raw.names.every((n) => text(n)))
    return { kind: "TableCart", names: raw.names as string[] };
  if (
    raw.kind === "Guest" &&
    Array.isArray(raw.lines) &&
    raw.lines.every((line: unknown) => {
      const entry = record(line);
      return entry !== null && text(entry.name) && flag(entry.unsellable);
    })
  )
    return {
      kind: "Guest",
      lines: (raw.lines as Record<string, unknown>[]).map((line) => ({
        name: line.name as string,
        unsellable: line.unsellable as boolean,
      })),
    };
  return undefined;
}

function guestLineOf(value: unknown): KeptGuestLine | null {
  const raw = record(value);
  if (
    raw === null ||
    !text(raw.name) ||
    !text(raw.options) ||
    !Number.isSafeInteger(raw.quantity) ||
    (raw.quantity as number) < 1 ||
    !nullable(raw.estimateMinor, minor) ||
    !flag(raw.unsellable) ||
    !nullable(raw.phoneNumber, (v): v is number => Number.isSafeInteger(v)) ||
    !flag(raw.phoneLeft)
  )
    return null;
  return {
    name: raw.name,
    options: raw.options,
    quantity: raw.quantity as number,
    estimateMinor: raw.estimateMinor,
    unsellable: raw.unsellable,
    phoneNumber: raw.phoneNumber,
    phoneLeft: raw.phoneLeft,
  };
}

/**
 * What the language switch kept of a sent round's or a paid order's confirmation, or null when
 * nothing usable was kept. `lineOf` checks one of the order's own lines.
 */
export function keptConfirmationOf<L>(
  value: unknown,
  lineOf: (line: unknown) => line is L,
): KeptConfirmation<L> | null {
  const raw = record(value);
  if (raw === null || (raw.phase !== "Sent" && raw.phase !== "Paid" && raw.phase !== "Accepted"))
    return null;
  const placed = placedOf(raw.placed);
  const paid = paidOf(raw.paid);
  const removed = removedOf(raw.removed);
  const guest = Array.isArray(raw.sentGuest) ? raw.sentGuest.map(guestLineOf) : null;
  if (
    placed === null ||
    // A round sent to the table's bill is "Sent"; a paid order is "Paid" or "Accepted".
    (raw.phase === "Sent") !== placed.payLater ||
    paid === undefined ||
    removed === undefined ||
    guest === null ||
    guest.length > 200 ||
    !guest.every((line) => line !== null) ||
    !Array.isArray(raw.lines) ||
    raw.lines.length > 200 ||
    !raw.lines.every(lineOf) ||
    !text(raw.tip, 16) ||
    !text(raw.customTip, 16) ||
    (raw.tender !== "CardMachine" && raw.tender !== "Cash") ||
    !flag(raw.paper) ||
    !nullable(raw.changeDue, minor)
  )
    return null;
  return {
    phase: raw.phase,
    placed,
    lines: raw.lines,
    tip: raw.tip,
    customTip: raw.customTip,
    tender: raw.tender,
    paper: raw.paper,
    changeDue: raw.changeDue,
    paid,
    removed,
    sentGuest: guest as KeptGuestLine[],
  };
}

/** The "Order N paid" panel of a sent, unpaid counter order recorded from its list. */
export interface KeptRecordedPayment {
  readonly orderReference: string;
  readonly orderNumber: string;
  readonly payment: RecordedCardPayment;
}
export function keptRecordedPaymentOf(value: unknown): KeptRecordedPayment | null {
  const raw = record(value);
  const payment = record(raw?.payment);
  if (raw === null || payment === null) return null;
  const cash = payment.cash === null ? null : record(payment.cash);
  if (
    !text(raw.orderReference, 64) ||
    !text(raw.orderNumber, 32) ||
    (payment.status !== "Recorded" && payment.status !== "AlreadyRecorded") ||
    !minor(payment.amountMinor) ||
    (payment.recordingReason !== "AtCounter" &&
      payment.recordingReason !== "RecordedAfterOutage") ||
    !text(payment.takenAt, 64) ||
    (payment.acceptance !== "Accepted" && payment.acceptance !== "NotAccepted") ||
    !(
      cash === null ||
      (minor(cash.cashTotalMinor) && minor(cash.tenderedMinor) && minor(cash.changeMinor))
    )
  )
    return null;
  return {
    orderReference: raw.orderReference,
    orderNumber: raw.orderNumber,
    payment: {
      status: payment.status,
      amountMinor: payment.amountMinor,
      recordingReason: payment.recordingReason,
      takenAt: payment.takenAt,
      acceptance: payment.acceptance,
      cash:
        cash === null
          ? null
          : {
              cashTotalMinor: cash.cashTotalMinor as string,
              tenderedMinor: cash.tenderedMinor as string,
              changeMinor: cash.changeMinor as string,
            },
    },
  };
}
