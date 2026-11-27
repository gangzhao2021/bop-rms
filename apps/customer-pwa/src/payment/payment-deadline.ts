/**
 * WP-2423 M19: until when a guest can still pay, read on the server's clock.
 *
 * A phone's clock can be minutes off. The server sends its own time with every deadline, so the
 * page keeps the difference and runs its warning and end timers from that, never from the phone's
 * clock alone. The server's answer stays final: an ended deadline only stops offering the card and
 * reads the payment result, it never says the order was cancelled by itself.
 */
export interface PaymentDeadline {
  /** The moment the server stops accepting this payment (ISO instant). */
  readonly payBy: string;
  /** Server time minus phone time, in milliseconds, measured when the deadline arrived. */
  readonly serverOffsetMs: number;
}

/** Shown as "about 5 minutes left" from this much before the deadline. */
export const paymentDeadlineWarningMs = 5 * 60_000;

/** The deadline from a server answer: its pay-by instant and its time, measured on arrival. */
export function paymentDeadlineFrom(
  payBy: string,
  serverNow: string | undefined,
  receivedAtMs: number,
): PaymentDeadline | null {
  const end = Date.parse(payBy);
  if (!Number.isFinite(end)) return null;
  const server = serverNow === undefined ? Number.NaN : Date.parse(serverNow);
  return Object.freeze({
    payBy: new Date(end).toISOString(),
    serverOffsetMs: Number.isFinite(server) ? server - receivedAtMs : 0,
  });
}

/** The earlier of two deadlines (the one the server refuses at first). */
export function earlierPaymentDeadline(
  current: PaymentDeadline | null,
  next: PaymentDeadline | null,
): PaymentDeadline | null {
  if (current === null) return next;
  if (next === null) return current;
  return Date.parse(next.payBy) < Date.parse(current.payBy) ? next : current;
}

/** The server's time now, as this phone best knows it. */
export function serverTimeMs(deadline: PaymentDeadline, phoneNowMs: number): number {
  return phoneNowMs + deadline.serverOffsetMs;
}

export type PaymentDeadlinePhase = "open" | "warning" | "ended";

export function paymentDeadlinePhase(
  deadline: PaymentDeadline,
  phoneNowMs: number,
): PaymentDeadlinePhase {
  const left = Date.parse(deadline.payBy) - serverTimeMs(deadline, phoneNowMs);
  if (left <= 0) return "ended";
  return left <= paymentDeadlineWarningMs ? "warning" : "open";
}

/** Milliseconds until the phase next changes, or null once ended. One timer, never polling. */
export function nextPaymentDeadlineChangeMs(
  deadline: PaymentDeadline,
  phoneNowMs: number,
): number | null {
  const left = Date.parse(deadline.payBy) - serverTimeMs(deadline, phoneNowMs);
  if (left <= 0) return null;
  return left > paymentDeadlineWarningMs ? left - paymentDeadlineWarningMs : left;
}
