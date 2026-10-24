import { t } from "./i18n/i18n.js";
/**
 * WP-2423 pilot rule "Warn before timeouts" (2026-10-17): a paid pickup order nobody accepts is
 * closed and refunded in full when its acceptance window ends (30 minutes after payment, or the
 * manager's decision time after an outage hold). Every merchant screen warns from 5 minutes before,
 * escalates at 2 minutes and 30 seconds, and chimes at those two points. A deferral that moves the
 * deadline starts the warnings again for the new time.
 */

/** A paid pickup order that is refunded automatically at `acceptBy` unless someone accepts it. */
export interface RefundDeadline {
  readonly orderNumber: string;
  readonly acceptBy: string;
}

export type RefundWarningTier = "warning" | "urgent" | "final";

export interface RefundWarning {
  readonly orderNumber: string;
  readonly acceptBy: string;
  readonly leftMs: number;
  readonly tier: RefundWarningTier;
  readonly text: string;
}

/** Warnings start this long before the refund (the Orders page's urgent tier starts here too). */
export const REFUND_WARNING_LEAD_MS = 5 * 60_000;
/** Escalation points; the screen chimes when an order reaches each. */
export const REFUND_URGENT_MS = 2 * 60_000;
export const REFUND_FINAL_MS = 30_000;

export function refundWarningTier(leftMs: number): RefundWarningTier | null {
  if (leftMs <= 0 || leftMs > REFUND_WARNING_LEAD_MS) return null;
  return leftMs <= REFUND_FINAL_MS ? "final" : leftMs <= REFUND_URGENT_MS ? "urgent" : "warning";
}

/** Plain staff wording, e.g. "Order 9 will be refunded automatically in 2 min unless someone accepts it." */
export function refundWarningText(orderNumber: string, leftMs: number): string {
  const when =
    leftMs <= 60_000
      ? t("in less than a minute")
      : t("in {value} min", { value: Math.ceil(leftMs / 60_000) });
  return t("Order {orderNumber} will be refunded automatically {when} unless someone accepts it.", {
    orderNumber: orderNumber,
    when: when,
  });
}

/**
 * v15 cbff9d6f: how long a signed-out screen trusts its last check. After this the countdown may
 * be out of date (someone may have accepted the order on another screen), so it says so and stops
 * sounding until a check succeeds again.
 */
export const REFUND_SIGNED_OUT_TRUST_MS = 30_000;

/** Whether a signed-out screen can no longer vouch for its countdown (see above). */
export function refundCountdownUnsure(
  signedOut: boolean,
  checkedAt: number | null,
  now: number,
): boolean {
  return signedOut && (checkedAt === null || now - checkedAt > REFUND_SIGNED_OUT_TRUST_MS);
}

/** Plain wording when the countdown may be out of date: it never tells staff an order still waits. */
export function refundWarningUnsureText(orderNumber: string, leftMs: number): string {
  const when =
    leftMs <= 60_000
      ? t("in less than a minute")
      : t("in {value} min", { value: Math.ceil(leftMs / 60_000) });
  return t(
    "Order {orderNumber} may already have been accepted. If not, it will be refunded automatically {when}.",
    { orderNumber: orderNumber, when: when },
  );
}

/** Orders inside their last five minutes, soonest first. */
export function refundWarnings(
  deadlines: readonly RefundDeadline[],
  now: number,
): readonly RefundWarning[] {
  return deadlines
    .flatMap((deadline) => {
      const leftMs = Date.parse(deadline.acceptBy) - now;
      const tier = Number.isFinite(leftMs) ? refundWarningTier(leftMs) : null;
      return tier === null
        ? []
        : [
            {
              orderNumber: deadline.orderNumber,
              acceptBy: deadline.acceptBy,
              leftMs,
              tier,
              text: refundWarningText(deadline.orderNumber, leftMs),
            },
          ];
    })
    .sort(
      (left, right) =>
        left.leftMs - right.leftMs || (left.orderNumber < right.orderNumber ? -1 : 1),
    );
}

/**
 * What to announce and whether to chime for warnings not yet alerted. Each order alerts once per
 * tier and deadline (`alerted` keeps the keys), so a moved deadline alerts again. The screen reader
 * hears every new tier; the chime sounds at 2 minutes and 30 seconds.
 */
export function refundAlertsDue(
  warnings: readonly RefundWarning[],
  alerted: ReadonlySet<string>,
): { readonly keys: readonly string[]; readonly chime: boolean; readonly announce: string | null } {
  const due = warnings.filter(
    (warning) => !alerted.has(`${warning.orderNumber}|${warning.acceptBy}|${warning.tier}`),
  );
  return {
    keys: due.map((warning) => `${warning.orderNumber}|${warning.acceptBy}|${warning.tier}`),
    chime: due.some((warning) => warning.tier !== "warning"),
    announce: due.length === 0 ? null : due.map((warning) => warning.text).join(" "),
  };
}

/** How often the screen clock ticks: every second near a refund, otherwise with each read. */
export function refundClockMs(deadlines: readonly RefundDeadline[], now: number): number | null {
  return deadlines.some((deadline) => {
    const left = Date.parse(deadline.acceptBy) - now;
    return left > 0 && left <= REFUND_WARNING_LEAD_MS + 20_000;
  })
    ? 1_000
    : null;
}

/**
 * v15 c9b377cb defect 2: what this screen last knew, kept for this browser tab only so a signed-out
 * or PIN screen can still show the countdown (with the time it was last checked) instead of losing
 * it. Order numbers and deadlines only — never customer details. A newer read replaces it; past
 * deadlines are ignored.
 */
export interface LastKnownRefundDeadlines {
  readonly deadlines: readonly RefundDeadline[];
  readonly checkedAt: number;
  /** Whether the person signed in here could accept orders (false on the kitchen display). */
  readonly canAccept: boolean;
  readonly timeZone: string | null;
}

const LAST_KNOWN_KEY = "bop-merchant-refund-deadlines";
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/u;
const ORDER_NUMBER = /^[A-Za-z0-9-]{1,20}$/u;
const TIME_ZONE = /^[A-Za-z_]+(\/[A-Za-z0-9_+-]+){0,2}$/u;

function tabStorage(): Storage | null {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}

export function saveLastKnownRefundDeadlines(value: LastKnownRefundDeadlines): void {
  try {
    tabStorage()?.setItem(
      LAST_KNOWN_KEY,
      JSON.stringify({
        deadlines: value.deadlines.map((deadline) => ({
          orderNumber: deadline.orderNumber,
          acceptBy: deadline.acceptBy,
        })),
        checkedAt: value.checkedAt,
        canAccept: value.canAccept,
        timeZone: value.timeZone,
      }),
    );
  } catch {
    // Storage full or blocked: the live screen still warns; only the signed-out copy is lost.
  }
}

/** The last known deadlines still ahead of `now`, or null when there are none. */
export function loadLastKnownRefundDeadlines(now: number): LastKnownRefundDeadlines | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tabStorage()?.getItem(LAST_KNOWN_KEY) ?? "null");
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const body = parsed as Record<string, unknown>;
  if (
    !Array.isArray(body.deadlines) ||
    !Number.isSafeInteger(body.checkedAt) ||
    typeof body.canAccept !== "boolean" ||
    (body.timeZone !== null &&
      (typeof body.timeZone !== "string" || !TIME_ZONE.test(body.timeZone)))
  )
    return null;
  const deadlines = body.deadlines.flatMap((item: unknown) => {
    if (item === null || typeof item !== "object") return [];
    const { orderNumber, acceptBy } = item as Record<string, unknown>;
    return typeof orderNumber === "string" &&
      ORDER_NUMBER.test(orderNumber) &&
      typeof acceptBy === "string" &&
      INSTANT.test(acceptBy) &&
      Date.parse(acceptBy) > now
      ? [{ orderNumber, acceptBy }]
      : [];
  });
  if (deadlines.length === 0) return null;
  return {
    deadlines,
    checkedAt: body.checkedAt as number,
    canAccept: body.canAccept,
    timeZone: body.timeZone as string | null,
  };
}
