import { countOf, t } from "./i18n/i18n.js";
/**
 * WP-2423 (v15 2026-10-16, decision DEC-DINE-IN-PAID-ROUND-WAIT): a paid dine-in round reaches the
 * kitchen only when staff accept it, and it is never cancelled or refunded automatically — the
 * guest has paid and is at the table, so only staff decide (accept it, or turn it down for a full
 * refund). Orders, Tables and Home therefore say how long a paid round has
 * waited: a warning from 3 minutes, urgent from 5 (Owner default 12, 2026-11-06: no automatic
 * refund for tables; alert staff at 5 minutes).
 */
export const paidRoundWarningMinutes = 3;
export const paidRoundUrgentMinutes = 5;

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

/**
 * v15 batch 8: how long ago, in words staff read at a glance: minutes for the first hour, then
 * hours and minutes, then days (a paid round from last week is "6 days ago", never "9823 min ago").
 */
export function waitedAgoText(minutes: number): string {
  if (minutes < 1) return t("just now");
  if (minutes < 60) return t("{minutes} min ago", { minutes: String(minutes) });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const rest = minutes % 60;
    return rest === 0
      ? t("{hours} h ago", { hours: String(hours) })
      : t("{hours} h {rest} min ago", { hours: String(hours), rest: String(rest) });
  }
  const days = Math.floor(hours / 24);
  return days === 1 ? t("1 day ago") : t("{days} days ago", { days: String(days) });
}

/**
 * The control the order panel offers this person to turn a paid round down (it refunds in full):
 * "Can't make it · refund" or "Refuse and refund"; null when they have neither.
 */
export type PaidRoundRefusal = "CantMake" | "RefuseAndRefund" | null;

/** The Orders page line next to Accept: it names only a button this person has. */
export function paidRoundWaitText(
  paidAt: string,
  now: number,
  refusal: PaidRoundRefusal = null,
): string {
  const { minutes, tier } = paidRoundWait(paidAt, now);
  if (tier === "ok") return t("Paid · the kitchen gets it once you accept it");
  const waited = waitedAgoText(minutes);
  if (tier === "warning")
    return t("Paid {waited} · the guest is waiting. Accept it to send it to the kitchen", {
      waited,
    });
  return refusal === "CantMake"
    ? t(
        "Accept now · paid {waited}. It is never refunded automatically. If it can't be made, use Can't make it · refund: the guest gets a full refund.",
        { waited },
      )
    : refusal === "RefuseAndRefund"
      ? t(
          "Accept now · paid {waited}. It is never refunded automatically. If it can't be made, use Refuse and refund: the guest gets a full refund.",
          { waited },
        )
      : t(
          "Accept now · paid {waited}. It is never refunded automatically. If it can't be made, ask a manager to refuse it: the guest gets a full refund.",
          { waited },
        );
}

/**
 * The Tables page line for a table with a paid round waiting. The order's own panel offers the
 * refusal this person has, so the line names no button (v15 batch 8: it named one staff lacked).
 */
export function tableRoundWaitText(roundNumber: number, paidAt: string, now: number): string {
  const { minutes, tier } = paidRoundWait(paidAt, now);
  // Its own words for under a minute: "paid just now" reads 刚付款 in Chinese, never 刚刚已付款.
  if (minutes < 1)
    return t(
      "Round {roundNumber} paid just now · accept it on the Orders page to send it to the kitchen",
      { roundNumber: roundNumber },
    );
  const waited = waitedAgoText(minutes);
  return tier === "urgent"
    ? t(
        "Round {roundNumber} paid {waited} and still not accepted · open the order now: accept it, or turn it down there for a full refund",
        { roundNumber: roundNumber, waited: waited },
      )
    : t(
        "Round {roundNumber} paid {waited} · accept it on the Orders page to send it to the kitchen",
        { roundNumber: roundNumber, waited: waited },
      );
}

/** "1 round" / "2 rounds". */

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
      ? t("{rounds} awaiting acceptance in {orders}", {
          rounds: countOf(input.rounds, "round"),
          orders: countOf(input.orders, "order"),
        })
      : t("{orders} awaiting acceptance", { orders: input.orders });
  return input.urgentRounds > 0
    ? t("{base} ({urgentRounds} paid {paidRoundUrgentMinutes}+ min ago)", {
        base: base,
        urgentRounds: input.urgentRounds,
        paidRoundUrgentMinutes: paidRoundUrgentMinutes,
      })
    : base;
}
