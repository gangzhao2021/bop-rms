/**
 * WP-2423 (v15 2026-10-16, decision DEC-DINE-IN-PAID-ROUND-WAIT): a paid dine-in round reaches the
 * kitchen only when staff accept it, and it is never cancelled or refunded automatically — the
 * guest has paid and is at the table, so only staff decide (accept it, or accept it and have a
 * manager cancel it for a full refund). Orders, Tables and Home therefore say how long a paid
 * round has waited: a warning from 5 minutes, urgent from 10.
 */
export const paidRoundWarningMinutes = 5;
export const paidRoundUrgentMinutes = 10;

export type PaidRoundWaitTier = "ok" | "warning" | "urgent";

export function paidRoundWait(paidAt: string, now: number) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(paidAt)) / 60_000));
  const tier: PaidRoundWaitTier =
    minutes >= paidRoundUrgentMinutes
      ? "urgent"
      : minutes >= paidRoundWarningMinutes
        ? "warning"
        : "ok";
  return { minutes, tier };
}

/** The Orders page line next to Accept. */
export function paidRoundWaitText(paidAt: string, now: number): string {
  const { minutes, tier } = paidRoundWait(paidAt, now);
  if (tier === "ok") return "Paid · the kitchen gets it once you accept it";
  if (tier === "warning")
    return `Paid ${minutes} min ago · the guest is waiting. Accept it to send it to the kitchen`;
  return `Paid ${minutes} min ago and still not accepted · accept it now. It is never cancelled or refunded automatically; if it can't be made, accept it and a manager can cancel it for a full refund`;
}

/** The Tables page line for a table with a paid round waiting. */
export function tableRoundWaitText(roundNumber: number, paidAt: string, now: number): string {
  const { minutes, tier } = paidRoundWait(paidAt, now);
  const waited = minutes < 1 ? "just now" : `${minutes} min ago`;
  return tier === "urgent"
    ? `Round ${roundNumber} paid ${waited} and still not accepted · accept it on the Orders page now`
    : `Round ${roundNumber} paid ${waited} · accept it on the Orders page to send it to the kitchen`;
}

/** "1 round" / "2 rounds". */
const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * Home's acceptance count: orders, or rounds when an order has more than one round to accept
 * ("2 rounds awaiting acceptance in 1 order"), and how many waited too long.
 */
export function awaitingAcceptanceText(input: {
  readonly orders: number;
  readonly rounds: number;
  readonly urgentRounds: number;
}): string {
  const base =
    input.rounds > input.orders
      ? `${plural(input.rounds, "round")} awaiting acceptance in ${plural(input.orders, "order")}`
      : `${input.orders} awaiting acceptance`;
  return input.urgentRounds > 0
    ? `${base} (${input.urgentRounds} paid ${paidRoundUrgentMinutes}+ min ago)`
    : base;
}
