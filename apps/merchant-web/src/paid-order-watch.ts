import { t } from "./i18n/i18n.js";
import type { RefundDeadline } from "./refund-deadline-warning.js";

/**
 * WP-2423 DEC-PAID-ORDER-AUTO-ACCEPT: what every screen knows about paid orders sent straight to the
 * kitchen. Only a Store that has it on (or still has orders from when it did) sends this at all.
 */
export interface PaidOrderWatchItem {
  readonly orderNumber: string;
  readonly orderType: "Pickup" | "DineIn";
  readonly acceptedAt: string;
  /** False: no ticket reached the kitchen. */
  readonly reachedKitchen: boolean;
  /** A pickup is refunded at this time unless the kitchen starts it; a table round never is. */
  readonly refundAt: string | null;
}
export interface PaidOrderWatch {
  readonly on: boolean;
  readonly settingVersion: number;
  readonly lastKitchenStepAt: string | null;
  readonly canTurnOff: boolean;
  /** Kitchen board only: whether this person can accept on Orders. */
  readonly canAcceptOrders: boolean;
  /** "Can't make it" refunds in the last 24 hours, for the manager's closing list. */
  readonly cantMakeRefunds: number;
  readonly waiting: readonly PaidOrderWatchItem[];
}

const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const invalid = (): never => {
  throw new Error("PAID_ORDER_WATCH_INVALID");
};
const instant = (value: unknown): string =>
  typeof value === "string" && INSTANT.test(value) ? value : invalid();

/** A wrong or partial answer is no watch at all: the screen keeps working without the warning. */
export function parsePaidOrderWatch(value: unknown): PaidOrderWatch | null {
  if (value === undefined || value === null) return null;
  try {
    const raw = value as Record<string, unknown>;
    if (
      typeof raw !== "object" ||
      typeof raw.on !== "boolean" ||
      !Number.isSafeInteger(raw.settingVersion) ||
      typeof raw.canTurnOff !== "boolean" ||
      !Array.isArray(raw.waiting) ||
      raw.waiting.length > 200
    )
      return null;
    return Object.freeze({
      on: raw.on,
      settingVersion: Number(raw.settingVersion),
      lastKitchenStepAt: raw.lastKitchenStepAt === null ? null : instant(raw.lastKitchenStepAt),
      canTurnOff: raw.canTurnOff,
      canAcceptOrders: raw.canAcceptOrders === true,
      cantMakeRefunds: Number.isSafeInteger(raw.cantMakeRefunds) ? Number(raw.cantMakeRefunds) : 0,
      waiting: Object.freeze(
        raw.waiting.map((entry: unknown) => {
          const item = entry as Record<string, unknown>;
          if (
            typeof item.orderNumber !== "string" ||
            (item.orderType !== "Pickup" && item.orderType !== "DineIn") ||
            typeof item.reachedKitchen !== "boolean"
          )
            return invalid();
          return Object.freeze({
            orderNumber: item.orderNumber,
            orderType: item.orderType,
            acceptedAt: instant(item.acceptedAt),
            reachedKitchen: item.reachedKitchen,
            refundAt: item.refundAt === null ? null : instant(item.refundAt),
          });
        }),
      ),
    });
  } catch {
    return null;
  }
}

/** Why a paid order is on Orders and not in the kitchen, one line in staff words. */
export function notSentReasonText(reason: string, itemCount: number | null): string {
  switch (reason) {
    case "HasAlcohol":
      return t("Has alcohol · check ID, then Accept");
    case "LargeOrder":
      return itemCount === null
        ? t("Large order · check it, then Accept")
        : t("Large order · {count} items · check it, then Accept", { count: itemCount });
    case "StockChanged":
      return t("Stock changed · check the items");
    case "StoreNotOpen":
      return t("Store was paused or closed · check, then Accept");
    case "KitchenScreenOff":
      return t("Kitchen screen was off · turn it on, then Accept");
    case "PaidBeforeSwitch":
      return t("Paid before automatic sending was turned on");
    case "PaidTooLongAgo":
      return t("Paid over 30 minutes ago · check with the guest");
    default:
      return t("Not sent automatically · check the order");
  }
}

/** When to speak up: nothing touched for this long, and again at twice this. */
export const paidOrderAlarmMinutes = 5;
export const paidOrderAlarmUrgentMinutes = 10;

export interface PaidOrderAlarm {
  /** Orders that never reached the kitchen (5 minutes after being sent). */
  readonly notReached: number;
  /** Orders waiting while the kitchen has touched nothing (0: a working kitchen raises nothing). */
  readonly silent: number;
  /** How long nothing has been touched. */
  readonly minutes: number;
  readonly tier: 0 | 1 | 2;
  /** Identifies this episode, so each tier chimes once. */
  readonly key: string;
}

/**
 * One Store-level alarm, no per-order chime: with 12 tickets in a Saturday queue a working kitchen
 * is not an alarm. It speaks when something sent 5 minutes ago is still untouched AND no kitchen step
 * happened anywhere for 5 minutes, or when an order never reached the kitchen at all.
 */
export function paidOrderAlarm(watch: PaidOrderWatch | null, now: number): PaidOrderAlarm | null {
  if (watch === null) return null;
  const minutesSince = (at: number) => Math.floor((now - at) / 60_000);
  const old = watch.waiting.filter(
    (item) => minutesSince(Date.parse(item.acceptedAt)) >= paidOrderAlarmMinutes,
  );
  if (old.length === 0) return null;
  const notReached = old.filter((item) => !item.reachedKitchen);
  const reached = old.filter((item) => item.reachedKitchen);
  const lastStep = watch.lastKitchenStepAt === null ? null : Date.parse(watch.lastKitchenStepAt);
  const oldest = Math.min(...old.map((item) => Date.parse(item.acceptedAt)));
  // Since whichever is later: an order sent 6 minutes ago after a quiet afternoon is 6 minutes.
  const quietFrom = lastStep === null ? oldest : Math.max(lastStep, oldest);
  const quiet = minutesSince(quietFrom);
  const silent = quiet >= paidOrderAlarmMinutes ? reached.length : 0;
  if (notReached.length === 0 && silent === 0) return null;
  return Object.freeze({
    notReached: notReached.length,
    silent,
    minutes: quiet,
    tier: quiet >= paidOrderAlarmUrgentMinutes ? 2 : 1,
    key: String(quietFrom),
  });
}

export function paidOrderAlarmLines(alarm: PaidOrderAlarm): readonly string[] {
  return [
    ...(alarm.silent === 0
      ? []
      : alarm.silent === 1
        ? [
            t(
              "The kitchen hasn't touched anything for {minutes} min and 1 paid order is waiting · check the kitchen screen",
              { minutes: alarm.minutes },
            ),
          ]
        : [
            t(
              "The kitchen hasn't touched anything for {minutes} min and {count} paid orders are waiting · check the kitchen screen",
              { minutes: alarm.minutes, count: alarm.silent },
            ),
          ]),
    ...(alarm.notReached === 0
      ? []
      : alarm.notReached === 1
        ? [
            t(
              "1 paid order did not reach the kitchen · make it from the order details, or tap Can't make it for a full refund",
            ),
          ]
        : [
            t(
              "{count} paid orders did not reach the kitchen · make them from the order details, or tap Can't make it for a full refund",
              { count: alarm.notReached },
            ),
          ]),
  ];
}

/** Pickups refunded unless the kitchen starts them: the same countdown as a pickup nobody accepts. */
export function paidOrderRefundDeadlines(watch: PaidOrderWatch | null): readonly RefundDeadline[] {
  return (watch?.waiting ?? []).flatMap((item) =>
    item.refundAt === null
      ? []
      : [{ orderNumber: item.orderNumber, acceptBy: item.refundAt, kitchenStart: true }],
  );
}
