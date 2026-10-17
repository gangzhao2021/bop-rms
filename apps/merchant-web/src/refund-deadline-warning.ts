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
  const when = leftMs <= 60_000 ? "in less than a minute" : `in ${Math.ceil(leftMs / 60_000)} min`;
  return `Order ${orderNumber} will be refunded automatically ${when} unless someone accepts it.`;
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
