import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPaymentReconciliationExceptionSource,
  PaymentCompensationError,
  parsePaymentExceptionProjectionSource,
} from "../../application/paid-without-fulfillable-order.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
/** Read immutable owner exceptions without exposing amounts or Provider references. */
export function createPostgresPaymentReconciliationExceptionSource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  resolveIntent?(
    tx: ConsumerTransaction,
    paymentIntentReference: string,
  ): Promise<{
    readonly paymentIntentReference: string;
    readonly paymentAttemptReference: string;
    readonly orderReference: string;
  }>;
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly purpose: "ProjectOrderException";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  });
  return async (
    tx: ConsumerTransaction,
    input: { readonly afterExceptionReference: string | null; readonly limit: number },
  ) => {
    try {
      const unavailable = (): never => {
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
      };
      if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)
        return unavailable();
      const after =
        input.afterExceptionReference === null
          ? null
          : parsePaymentReference(input.afterExceptionReference);
      const authorize = async () => {
        if ((await options.authorize(tx, { ...scope, purpose: "ProjectOrderException" })) !== true)
          throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const result = await tx.query(
        // WP-2423 P6: the Provider-confirmed full refund of an unmatched capture closes it; a later
        // matching settlement check of the same business day resolves a day's difference.
        "SELECT e.reconciliation_exception_id::text AS exception_reference,e.brand_id::text AS brand_reference,e.store_id::text AS store_reference,e.candidate_id::text AS candidate_reference,e.reason,e.severity,e.status,e.opened_at,(SELECT o.recorded_at FROM rms_payment.unmatched_capture_refund_request r JOIN rms_payment.unmatched_capture_refund_outcome o ON o.brand_id=r.brand_id AND o.store_id=r.store_id AND o.refund_id=r.refund_id WHERE r.brand_id=e.brand_id AND r.store_id=e.store_id AND r.reconciliation_exception_id=e.reconciliation_exception_id) AS refunded_at,(SELECT s.resolved_at FROM rms_payment.payment_reconciliation_resolution s WHERE s.brand_id=e.brand_id AND s.store_id=e.store_id AND s.reconciliation_exception_id=e.reconciliation_exception_id) AS resolved_at FROM rms_payment.payment_reconciliation_exception e WHERE e.brand_id=$1 AND e.store_id=$2 AND ($3::uuid IS NULL OR e.reconciliation_exception_id>$3::uuid) ORDER BY e.reconciliation_exception_id LIMIT $4",
        [scope.brandReference, scope.storeReference, after, input.limit + 1],
      );
      if (!Array.isArray(result.rows) || result.rows.length > input.limit + 1) return unavailable();
      let previous = after;
      const sources = result.rows.map((row) => {
        const source = createPaymentReconciliationExceptionSource(
          {
            exceptionReference: row.exception_reference,
            brandReference: row.brand_reference,
            storeReference: row.store_reference,
            candidateReference: row.candidate_reference,
            reason: row.reason,
            severity: row.severity,
            status: row.status,
            openedAt: row.opened_at instanceof Date ? row.opened_at.toISOString() : row.opened_at,
            refundedAt:
              row.refunded_at instanceof Date
                ? row.refunded_at.toISOString()
                : (row.refunded_at ?? null),
            resolvedAt:
              row.resolved_at instanceof Date
                ? row.resolved_at.toISOString()
                : (row.resolved_at ?? null),
          },
          scope,
        );
        if (previous !== null && source.exceptionReference <= previous) return unavailable();
        previous = source.exceptionReference;
        return source;
      });
      const selected = sources.slice(0, input.limit);
      const items = [];
      for (const source of selected) {
        if (!options.resolveIntent) {
          items.push(source);
          continue;
        }
        const linked = await tx.query(
          "SELECT DISTINCT mode,payment_intent_id::text AS intent,difference_reason,outcome FROM rms_payment.payment_reconciliation_record WHERE brand_id=$1 AND store_id=$2 AND reconciliation_exception_id=$3 LIMIT 2",
          [scope.brandReference, scope.storeReference, source.exceptionReference],
        );
        if (!Array.isArray(linked.rows) || linked.rows.length > 1) return unavailable();
        const record = linked.rows[0];
        if (!record) {
          items.push(source);
          continue;
        }
        if (
          record.outcome !== "Difference" ||
          source.kind !== `Reconciliation${String(record.difference_reason)}`
        )
          return unavailable();
        if (record.mode === "DailySettlement" && record.intent === null) {
          items.push(source);
          continue;
        }
        if (record.mode !== "Operational") return unavailable();
        const intent = parsePaymentReference(record.intent);
        await authorize();
        const binding = await options.resolveIntent(tx, intent);
        if (binding.paymentIntentReference !== intent) return unavailable();
        items.push(
          parsePaymentExceptionProjectionSource({
            ...source,
            paymentIntentReference: intent,
            paymentAttemptReference: parsePaymentReference(binding.paymentAttemptReference),
            orderReference: parsePaymentReference(binding.orderReference),
          }),
        );
      }
      Object.freeze(items);
      await authorize();
      return Object.freeze({
        items,
        nextAfterExceptionReference:
          sources.length > input.limit ? (items.at(-1)?.exceptionReference ?? null) : null,
      });
    } catch (error) {
      if (error instanceof PaymentCompensationError) throw error;
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE");
    }
  };
}

/**
 * WP-2423: what a reconciliation exception is about, for the staff Exceptions card.
 * - BusinessDayTotals: a business day's settlement check found the day's totals differ from the
 *   payment provider's statement (no single payment); the check and, once a later check of the
 *   same day matched, that resolution.
 * - Payment: one payment's check differed.
 * - UnmatchedCharge: no check opened it — a charge the payment provider reported that matches no
 *   payment or order of the Store.
 */
export interface PaymentReconciliationExceptionDetail {
  readonly exceptionReference: string;
  readonly kind: "BusinessDayTotals" | "Payment" | "UnmatchedCharge";
  /** BusinessDayTotals only: the settlement check that found the difference. */
  readonly openingCheck: {
    readonly runReference: string;
    readonly checkedAt: string;
    readonly differenceReason: string | null;
    readonly internalCapturedMinor: string;
    readonly providerCapturedMinor: string | null;
    readonly internalRefundedMinor: string;
    readonly providerRefundedMinor: string | null;
  } | null;
  /** BusinessDayTotals only: the later matching check of the same day that resolved it. */
  readonly resolution: { readonly resolvedAt: string; readonly runReference: string } | null;
}
/** The most exceptions one detail read answers (the Exceptions page reads at most 500). */
export const paymentReconciliationExceptionDetailLimit = 500;
/**
 * WP-2423: read-only, Store-scoped detail of reconciliation exceptions (see the type). Amounts are
 * the day's totals the day-end settlement page already shows the same staff; never Provider
 * references or payment identifiers.
 */
export function createPostgresPaymentReconciliationExceptionDetailReader(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  const unavailable = (): never => {
    throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
  };
  const instant = (value: unknown): string => {
    const text = value instanceof Date ? value.toISOString() : value;
    if (typeof text !== "string" || !Number.isFinite(Date.parse(text))) return unavailable();
    return new Date(text).toISOString();
  };
  const minor = (value: unknown): string =>
    typeof value === "string" && /^(0|[1-9][0-9]*)$/u.test(value) ? value : unavailable();
  const optionalMinor = (value: unknown) => (value === null ? null : minor(value));
  return async (
    tx: ConsumerTransaction,
    exceptionReferences: readonly string[],
  ): Promise<ReadonlyMap<string, PaymentReconciliationExceptionDetail>> => {
    const references = [
      ...new Set(exceptionReferences.map((r) => String(parsePaymentReference(r)))),
    ];
    if (references.length > paymentReconciliationExceptionDetailLimit) return unavailable();
    if ((await options.authorize(tx)) !== true)
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    const details = new Map<string, PaymentReconciliationExceptionDetail>();
    if (references.length === 0) return details;
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      `SELECT e.reconciliation_exception_id::text AS exception_reference,o.mode,o.unlinked,
o.run_reference,o.checked_at,o.difference_reason,o.internal_captured_minor,o.provider_captured_minor,
o.internal_refunded_minor,o.provider_refunded_minor,s.resolved_at,
s.reconciliation_run_id::text AS resolution_run_reference
FROM rms_payment.payment_reconciliation_exception e
LEFT JOIN LATERAL (SELECT r.mode,r.payment_intent_id IS NULL AS unlinked,
  r.reconciliation_run_id::text AS run_reference,r.checked_at,r.difference_reason,
  r.internal_captured_minor::text AS internal_captured_minor,
  r.provider_captured_minor::text AS provider_captured_minor,
  r.internal_refunded_minor::text AS internal_refunded_minor,
  r.provider_refunded_minor::text AS provider_refunded_minor
  FROM rms_payment.payment_reconciliation_record r
  WHERE r.brand_id=e.brand_id AND r.store_id=e.store_id
    AND r.reconciliation_exception_id=e.reconciliation_exception_id
  ORDER BY r.checked_at,r.reconciliation_check_id LIMIT 1) o ON true
LEFT JOIN rms_payment.payment_reconciliation_resolution s
  ON s.brand_id=e.brand_id AND s.store_id=e.store_id
  AND s.reconciliation_exception_id=e.reconciliation_exception_id
WHERE e.brand_id=$1 AND e.store_id=$2 AND e.reconciliation_exception_id=ANY($3::uuid[])`,
      [scope.brandReference, scope.storeReference, references],
    );
    if (!Array.isArray(result.rows) || result.rows.length > references.length) return unavailable();
    for (const row of result.rows as Record<string, unknown>[]) {
      const exceptionReference = String(parsePaymentReference(row.exception_reference));
      if (!references.includes(exceptionReference) || details.has(exceptionReference))
        return unavailable();
      const day = row.mode === "DailySettlement" && row.unlinked === true;
      const kind =
        row.mode === null || row.mode === undefined
          ? ("UnmatchedCharge" as const)
          : day
            ? ("BusinessDayTotals" as const)
            : row.mode === "Operational"
              ? ("Payment" as const)
              : unavailable();
      if (kind !== "BusinessDayTotals" && row.resolved_at !== null) return unavailable();
      details.set(
        exceptionReference,
        Object.freeze({
          exceptionReference,
          kind,
          openingCheck: day
            ? Object.freeze({
                runReference: String(parsePaymentReference(row.run_reference)),
                checkedAt: instant(row.checked_at),
                differenceReason:
                  row.difference_reason === null
                    ? null
                    : typeof row.difference_reason === "string" &&
                        /^[A-Za-z]{1,64}$/u.test(row.difference_reason)
                      ? row.difference_reason
                      : unavailable(),
                internalCapturedMinor: minor(row.internal_captured_minor),
                providerCapturedMinor: optionalMinor(row.provider_captured_minor),
                internalRefundedMinor: minor(row.internal_refunded_minor),
                providerRefundedMinor: optionalMinor(row.provider_refunded_minor),
              })
            : null,
          resolution:
            row.resolved_at === null
              ? null
              : Object.freeze({
                  resolvedAt: instant(row.resolved_at),
                  runReference: String(parsePaymentReference(row.resolution_run_reference)),
                }),
        }),
      );
    }
    if ((await options.authorize(tx)) !== true)
      throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    return details;
  };
}
