import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  PaymentReconciliationError,
  paymentReconciliationOutcomes,
  type PaymentReconciliationOutcome,
} from "../../application/payment-reconciliation.js";

const unavailable = (): never => {
  throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
};
const instant = (value: unknown): string => {
  const text = value instanceof Date ? value.toISOString() : value;
  if (typeof text !== "string" || !Number.isFinite(Date.parse(text))) return unavailable();
  const canonical = new Date(text).toISOString();
  return canonical === text ? canonical : unavailable();
};
const count = (value: unknown): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : unavailable();
const minor = (value: unknown): string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? value : unavailable();
const optionalMinor = (value: unknown): string | null => (value === null ? null : minor(value));
const optionalText = (value: unknown, pattern: RegExp): string | null =>
  value === null ? null : typeof value === "string" && pattern.test(value) ? value : unavailable();
const reference = (value: unknown): string =>
  typeof value === "string" ? String(parsePaymentReference(value)) : unavailable();
const outcome = (value: unknown): PaymentReconciliationOutcome =>
  typeof value === "string" && (paymentReconciliationOutcomes as readonly string[]).includes(value)
    ? (value as PaymentReconciliationOutcome)
    : unavailable();

/** Payments listed on the day-end page; the count is still exact beyond this. */
export const paymentReconciliationDayDifferenceLimit = 200;
/** Checks one settlement run may carry (its `maxCandidates` ceiling). */
export const paymentReconciliationDaySettlementCheckLimit = 100;
const unmatchedOutcomes: readonly PaymentReconciliationOutcome[] = [
  "Difference",
  "Unresolved",
  "Unavailable",
];

export interface PaymentReconciliationDayRun {
  readonly runReference: string;
  readonly mode: "Operational" | "DailySettlement";
  readonly scheduledAt: string;
  readonly cutoffAt: string;
  readonly completedAt: string;
  readonly counts: Readonly<Record<PaymentReconciliationOutcome, number>>;
}
export interface PaymentReconciliationDayCheck {
  readonly checkReference: string;
  readonly runReference: string;
  readonly checkedAt: string;
  readonly outcome: PaymentReconciliationOutcome;
  readonly differenceReason: string | null;
  readonly settlementReference: string | null;
  readonly internalStatus: string | null;
  readonly providerStatus: string | null;
  readonly currencyCode: "CAD";
  readonly internalCapturedMinor: string;
  readonly providerCapturedMinor: string | null;
  readonly internalRefundedMinor: string;
  readonly providerRefundedMinor: string | null;
  readonly exceptionReference: string | null;
}
/**
 * One Store business day as the day-end page reads it. A real Store produces hundreds of
 * operational runs a day (the pilot worker checks every ~100 s), so runs are summarised and
 * each payment counts once by its latest check; the settlement run that closes the day is
 * addressed by the reference its scheduler derives, never guessed from timestamps.
 */
export interface PaymentReconciliationDay {
  readonly startsAt: string;
  readonly endsAt: string;
  /** The settlement run for this day and its statement checks, once it has completed. */
  readonly settlement: {
    readonly run: PaymentReconciliationDayRun;
    readonly checks: readonly PaymentReconciliationDayCheck[];
  } | null;
  /** Runs whose cutoff fell inside the day, and every payment they checked, counted once. */
  readonly operational: {
    readonly runCount: number;
    readonly latestRun: PaymentReconciliationDayRun | null;
    readonly paymentCount: number;
    readonly outcomes: Readonly<Record<PaymentReconciliationOutcome, number>>;
  };
  /** Payments whose latest check in the day did not match, newest first, up to the limit. */
  readonly differences: readonly PaymentReconciliationDayCheck[];
  readonly differenceCount: number;
}

const runColumns = `reconciliation_run_id::text AS run_reference,mode,scheduled_at,cutoff_at,completed_at,
matched_count,healed_count,unresolved_count,unavailable_count,difference_count`;
const checkColumns = `reconciliation_check_id::text AS check_reference,reconciliation_run_id::text AS run_reference,
checked_at,outcome,difference_reason,settlement_reference,internal_status,provider_status,currency_code,
internal_captured_minor::text AS internal_captured_minor,provider_captured_minor::text AS provider_captured_minor,
internal_refunded_minor::text AS internal_refunded_minor,provider_refunded_minor::text AS provider_refunded_minor,
reconciliation_exception_id::text AS exception_reference`;
/** Each payment's latest check among the runs whose cutoff fell inside the day. */
const latestPerPayment = `SELECT DISTINCT ON (r.payment_intent_id) r.reconciliation_check_id,r.outcome
FROM rms_payment.payment_reconciliation_record r
JOIN rms_payment.payment_reconciliation_run u
  ON u.reconciliation_run_id=r.reconciliation_run_id AND u.brand_id=r.brand_id AND u.store_id=r.store_id
WHERE r.brand_id=$1 AND r.store_id=$2 AND r.payment_intent_id IS NOT NULL
  AND u.cutoff_at>$3::timestamptz AND u.cutoff_at<=$4::timestamptz
ORDER BY r.payment_intent_id,r.checked_at DESC,r.reconciliation_check_id DESC`;

const rows = (result: unknown): Record<string, unknown>[] => {
  const value = (result as { rows?: unknown } | null)?.rows;
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : unavailable();
};
const toRun = (row: Record<string, unknown>): PaymentReconciliationDayRun => {
  if (row.mode !== "Operational" && row.mode !== "DailySettlement") return unavailable();
  return Object.freeze({
    runReference: reference(row.run_reference),
    mode: row.mode,
    scheduledAt: instant(row.scheduled_at),
    cutoffAt: instant(row.cutoff_at),
    completedAt: instant(row.completed_at),
    counts: Object.freeze({
      Matched: count(row.matched_count),
      Healed: count(row.healed_count),
      Unresolved: count(row.unresolved_count),
      Unavailable: count(row.unavailable_count),
      Difference: count(row.difference_count),
    }),
  });
};
const toCheck = (row: Record<string, unknown>): PaymentReconciliationDayCheck => {
  if (row.currency_code !== "CAD") return unavailable();
  return Object.freeze({
    checkReference: reference(row.check_reference),
    runReference: reference(row.run_reference),
    checkedAt: instant(row.checked_at),
    outcome: outcome(row.outcome),
    differenceReason: optionalText(row.difference_reason, /^[A-Za-z]{1,64}$/u),
    settlementReference: optionalText(
      row.settlement_reference,
      /^[A-Za-z0-9][A-Za-z0-9_-]{6,126}[A-Za-z0-9]$/u,
    ),
    internalStatus: optionalText(row.internal_status, /^[A-Za-z]{1,64}$/u),
    providerStatus: optionalText(row.provider_status, /^[A-Za-z]{1,64}$/u),
    currencyCode: "CAD",
    internalCapturedMinor: minor(row.internal_captured_minor),
    providerCapturedMinor: optionalMinor(row.provider_captured_minor),
    internalRefundedMinor: minor(row.internal_refunded_minor),
    providerRefundedMinor: optionalMinor(row.provider_refunded_minor),
    exceptionReference:
      row.exception_reference === null ? null : reference(row.exception_reference),
  });
};

/**
 * WP-2423 P1: the reconciliation facts of one Store business day for the day-end settlement
 * page. Bounded, read-only, scoped by Brand and Store under row-level security; never Provider
 * secrets. `settlementRunReference` names the settlement run the Store's scheduler derives for
 * this day; null (an open day, or no scheduler) reads no settlement.
 */
export function createPostgresPaymentReconciliationDaySource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly purpose: "ReadPaymentReconciliationDay";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  return async (
    tx: ConsumerTransaction,
    input: {
      readonly startsAt: string;
      readonly endsAt: string;
      readonly settlementRunReference: string | null;
    },
  ): Promise<PaymentReconciliationDay> => {
    const startsAt = instant(input.startsAt),
      endsAt = instant(input.endsAt),
      settlementRunReference =
        input.settlementRunReference === null ? null : reference(input.settlementRunReference);
    if (startsAt >= endsAt) return unavailable();
    const authorize = async () => {
      if (
        (await options.authorize(tx, {
          ...scope,
          startsAt,
          endsAt,
          purpose: "ReadPaymentReconciliationDay",
        })) !== true
      )
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    };
    await authorize();
    const window = [scope.brandReference, scope.storeReference, startsAt, endsAt];
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);

    const runCountRows = rows(
      await tx.query(
        `SELECT count(*)::int AS run_count FROM rms_payment.payment_reconciliation_run
WHERE brand_id=$1 AND store_id=$2 AND cutoff_at>$3::timestamptz AND cutoff_at<=$4::timestamptz`,
        window,
      ),
    );
    if (runCountRows.length !== 1) return unavailable();
    const runCount = count(runCountRows[0]?.run_count);
    const latestRows = rows(
      await tx.query(
        `SELECT ${runColumns} FROM rms_payment.payment_reconciliation_run
WHERE brand_id=$1 AND store_id=$2 AND cutoff_at>$3::timestamptz AND cutoff_at<=$4::timestamptz
ORDER BY completed_at DESC,reconciliation_run_id DESC LIMIT 1`,
        window,
      ),
    );
    if (latestRows.length > 1 || (runCount === 0) !== (latestRows.length === 0))
      return unavailable();
    const latestRun = latestRows[0] === undefined ? null : toRun(latestRows[0]);

    const outcomes: Record<PaymentReconciliationOutcome, number> = {
      Matched: 0,
      Healed: 0,
      Unresolved: 0,
      Unavailable: 0,
      Difference: 0,
    };
    for (const row of rows(
      await tx.query(
        `WITH latest AS (${latestPerPayment})
SELECT outcome,count(*)::int AS payments FROM latest GROUP BY outcome`,
        window,
      ),
    ))
      outcomes[outcome(row.outcome)] = count(row.payments);
    const paymentCount = Object.values(outcomes).reduce((sum, value) => sum + value, 0);
    const differenceCount = unmatchedOutcomes.reduce((sum, key) => sum + outcomes[key], 0);
    let differences: PaymentReconciliationDayCheck[] = [];
    if (differenceCount > 0) {
      differences = rows(
        await tx.query(
          `WITH latest AS (${latestPerPayment})
SELECT ${checkColumns} FROM rms_payment.payment_reconciliation_record r
WHERE r.brand_id=$1 AND r.store_id=$2 AND r.reconciliation_check_id IN
  (SELECT reconciliation_check_id FROM latest WHERE outcome=ANY($5::text[]))
ORDER BY r.checked_at DESC,r.reconciliation_check_id DESC LIMIT $6`,
          [...window, unmatchedOutcomes, paymentReconciliationDayDifferenceLimit],
        ),
      ).map(toCheck);
      if (
        differences.length === 0 ||
        differences.length > Math.min(differenceCount, paymentReconciliationDayDifferenceLimit) ||
        differences.some((check) => !unmatchedOutcomes.includes(check.outcome))
      )
        return unavailable();
    }

    let settlement: PaymentReconciliationDay["settlement"] = null;
    if (settlementRunReference !== null) {
      const runRows = rows(
        await tx.query(
          `SELECT ${runColumns} FROM rms_payment.payment_reconciliation_run
WHERE brand_id=$1 AND store_id=$2 AND reconciliation_run_id=$3
  AND mode='DailySettlement' AND scheduled_at>=$4::timestamptz`,
          [scope.brandReference, scope.storeReference, settlementRunReference, endsAt],
        ),
      );
      if (runRows.length > 1) return unavailable();
      if (runRows[0] !== undefined) {
        const run = toRun(runRows[0]);
        const checks = rows(
          await tx.query(
            `SELECT ${checkColumns} FROM rms_payment.payment_reconciliation_record r
WHERE r.brand_id=$1 AND r.store_id=$2 AND r.reconciliation_run_id=$3
ORDER BY r.checked_at,r.reconciliation_check_id LIMIT $4`,
            [
              scope.brandReference,
              scope.storeReference,
              settlementRunReference,
              paymentReconciliationDaySettlementCheckLimit + 1,
            ],
          ),
        ).map(toCheck);
        if (
          checks.length === 0 ||
          checks.length > paymentReconciliationDaySettlementCheckLimit ||
          checks.some((check) => check.runReference !== run.runReference)
        )
          return unavailable();
        settlement = Object.freeze({ run, checks: Object.freeze(checks) });
      }
    }
    await authorize();
    return Object.freeze({
      startsAt,
      endsAt,
      settlement,
      operational: Object.freeze({
        runCount,
        latestRun,
        paymentCount,
        outcomes: Object.freeze(outcomes),
      }),
      differences: Object.freeze(differences),
      differenceCount,
    });
  };
}
