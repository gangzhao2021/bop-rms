import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import { PaymentReconciliationError } from "../../application/payment-reconciliation.js";

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

export const paymentReconciliationWindowRunLimit = 50;
export const paymentReconciliationWindowDifferenceLimit = 200;

export interface PaymentReconciliationWindowRun {
  readonly runReference: string;
  readonly mode: "Operational" | "DailySettlement";
  readonly scheduledAt: string;
  readonly cutoffAt: string;
  readonly completedAt: string;
  readonly counts: {
    readonly Matched: number;
    readonly Healed: number;
    readonly Unresolved: number;
    readonly Unavailable: number;
    readonly Difference: number;
  };
}
export interface PaymentReconciliationWindowDifference {
  readonly checkReference: string;
  readonly runReference: string;
  readonly checkedAt: string;
  readonly outcome: "Difference" | "Unresolved" | "Unavailable";
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
export interface PaymentReconciliationWindow {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly runs: readonly PaymentReconciliationWindowRun[];
  readonly differences: readonly PaymentReconciliationWindowDifference[];
}

/**
 * WP-2423 P1: the reconciliation runs whose cutoff falls inside a Store window (one business
 * day) and every check in them that did not match, for the day-end settlement page. Bounded,
 * read-only, scoped by Brand and Store under row-level security; never Provider secrets.
 */
export function createPostgresPaymentReconciliationWindowSource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly startsAt: string;
      readonly endsAt: string;
      readonly purpose: "ReadPaymentReconciliationWindow";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  return async (
    tx: ConsumerTransaction,
    input: { readonly startsAt: string; readonly endsAt: string },
  ): Promise<PaymentReconciliationWindow> => {
    const startsAt = instant(input.startsAt),
      endsAt = instant(input.endsAt);
    if (startsAt >= endsAt) return unavailable();
    const authorize = async () => {
      if (
        (await options.authorize(tx, {
          ...scope,
          startsAt,
          endsAt,
          purpose: "ReadPaymentReconciliationWindow",
        })) !== true
      )
        throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const runRows = await tx.query(
      `SELECT reconciliation_run_id::text AS run_reference,mode,scheduled_at,cutoff_at,completed_at,
matched_count,healed_count,unresolved_count,unavailable_count,difference_count
FROM rms_payment.payment_reconciliation_run
WHERE brand_id=$1 AND store_id=$2 AND cutoff_at>$3::timestamptz AND cutoff_at<=$4::timestamptz
ORDER BY completed_at DESC,reconciliation_run_id DESC LIMIT $5`,
      [
        scope.brandReference,
        scope.storeReference,
        startsAt,
        endsAt,
        paymentReconciliationWindowRunLimit + 1,
      ],
    );
    if (!Array.isArray(runRows.rows) || runRows.rows.length > paymentReconciliationWindowRunLimit)
      return unavailable();
    const runs = runRows.rows.map((row): PaymentReconciliationWindowRun => {
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
    });
    const runReferences = runs.map((run) => run.runReference);
    let differences: PaymentReconciliationWindowDifference[] = [];
    if (runReferences.length > 0) {
      const rows = await tx.query(
        `SELECT reconciliation_check_id::text AS check_reference,reconciliation_run_id::text AS run_reference,
checked_at,outcome,difference_reason,settlement_reference,internal_status,provider_status,currency_code,
internal_captured_minor::text AS internal_captured_minor,provider_captured_minor::text AS provider_captured_minor,
internal_refunded_minor::text AS internal_refunded_minor,provider_refunded_minor::text AS provider_refunded_minor,
reconciliation_exception_id::text AS exception_reference
FROM rms_payment.payment_reconciliation_record
WHERE brand_id=$1 AND store_id=$2 AND reconciliation_run_id::text=ANY($3::text[])
AND outcome IN ('Difference','Unresolved','Unavailable')
ORDER BY checked_at DESC,reconciliation_check_id DESC LIMIT $4`,
        [
          scope.brandReference,
          scope.storeReference,
          runReferences,
          paymentReconciliationWindowDifferenceLimit + 1,
        ],
      );
      if (
        !Array.isArray(rows.rows) ||
        rows.rows.length > paymentReconciliationWindowDifferenceLimit
      )
        return unavailable();
      const known = new Set(runReferences);
      differences = rows.rows.map((row): PaymentReconciliationWindowDifference => {
        const runReference = reference(row.run_reference);
        if (
          !known.has(runReference) ||
          (row.outcome !== "Difference" &&
            row.outcome !== "Unresolved" &&
            row.outcome !== "Unavailable") ||
          row.currency_code !== "CAD"
        )
          return unavailable();
        return Object.freeze({
          checkReference: reference(row.check_reference),
          runReference,
          checkedAt: instant(row.checked_at),
          outcome: row.outcome,
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
      });
    }
    await authorize();
    return Object.freeze({
      startsAt,
      endsAt,
      runs: Object.freeze(runs),
      differences: Object.freeze(differences),
    });
  };
}
