import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import {
  equivalentPaymentReconciliationResult,
  PaymentReconciliationError,
  parsePaymentReconciliationRunResult,
} from "../../application/payment-reconciliation.js";

const unavailable = (): never => {
  throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_DEPENDENCY_UNAVAILABLE");
};
const instant = (value: unknown) => (value instanceof Date ? value.toISOString() : value);
function money(value: unknown, currencyCode: unknown) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) return unavailable();
  return { currencyCode, amountMinor: BigInt(value) };
}
/** Complete immutable run readback in the caller's retained transaction. */
export function createPostgresPaymentReconciliationRunSource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(
    tx: ConsumerTransaction,
    input: {
      readonly brandReference: string;
      readonly storeReference: string;
      readonly runReference: string;
      readonly purpose: "ReconcilePayments";
    },
  ): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: parsePaymentReference(options.scope.brandReference),
    storeReference: parsePaymentReference(options.scope.storeReference),
  });
  return async (tx: ConsumerTransaction, input: { readonly runReference: string }) => {
    try {
      const runReference = parsePaymentReference(input.runReference);
      const authorize = async () => {
        if (
          (await options.authorize(tx, {
            ...scope,
            runReference,
            purpose: "ReconcilePayments",
          })) !== true
        )
          throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
      };
      await authorize();
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, scope.storeReference],
      );
      const params = [scope.brandReference, scope.storeReference, runReference];
      const runs = await tx.query(
        "SELECT * FROM rms_payment.payment_reconciliation_run WHERE brand_id=$1 AND store_id=$2 AND reconciliation_run_id=$3 LIMIT 2",
        params,
      );
      if (!Array.isArray(runs.rows) || runs.rows.length > 1) return unavailable();
      const row = runs.rows[0];
      if (!row) {
        await authorize();
        return null;
      }
      if (
        row.reconciliation_run_id !== runReference ||
        row.brand_id !== scope.brandReference ||
        row.store_id !== scope.storeReference
      )
        return unavailable();
      const records = await tx.query(
        "SELECT * FROM rms_payment.payment_reconciliation_record WHERE brand_id=$1 AND store_id=$2 AND reconciliation_run_id=$3 ORDER BY checked_at,reconciliation_check_id LIMIT 101",
        params,
      );
      if (!Array.isArray(records.rows) || records.rows.length > 100) return unavailable();
      const exceptions = await tx.query(
        "SELECT e.* FROM rms_payment.payment_reconciliation_exception e WHERE e.brand_id=$1 AND e.store_id=$2 AND EXISTS (SELECT 1 FROM rms_payment.payment_reconciliation_record r WHERE r.brand_id=$1 AND r.store_id=$2 AND r.reconciliation_run_id=$3 AND r.reconciliation_exception_id=e.reconciliation_exception_id) ORDER BY e.reconciliation_exception_id LIMIT 101",
        params,
      );
      if (!Array.isArray(exceptions.rows) || exceptions.rows.length > 100) return unavailable();
      const result = parsePaymentReconciliationRunResult({
        run: {
          runReference: row.reconciliation_run_id,
          mode: row.mode,
          brandReference: row.brand_id,
          storeReference: row.store_id,
          actorReference: row.actor_id,
          purpose: row.purpose,
          scheduledAt: instant(row.scheduled_at),
          cutoffAt: instant(row.cutoff_at),
          maxCandidates: row.max_candidates,
        },
        status: "Completed",
        completedAt: instant(row.completed_at),
        counts: {
          Matched: row.matched_count,
          Healed: row.healed_count,
          Unresolved: row.unresolved_count,
          Unavailable: row.unavailable_count,
          Difference: row.difference_count,
        },
        checks: records.rows.map((c) => ({
          checkReference: c.reconciliation_check_id,
          runReference: c.reconciliation_run_id,
          candidateReference: c.candidate_id,
          mode: c.mode,
          brandReference: c.brand_id,
          storeReference: c.store_id,
          paymentIntentReference: c.payment_intent_id,
          settlementReference: c.settlement_reference,
          outcome: c.outcome,
          differenceReason: c.difference_reason,
          internalStatus: c.internal_status,
          providerStatus: c.provider_status,
          internalCapturedAmount: money(c.internal_captured_minor, c.currency_code),
          providerCapturedAmount:
            c.provider_captured_minor === null
              ? null
              : money(c.provider_captured_minor, c.currency_code),
          internalRefundedAmount: money(c.internal_refunded_minor, c.currency_code),
          providerRefundedAmount:
            c.provider_refunded_minor === null
              ? null
              : money(c.provider_refunded_minor, c.currency_code),
          exceptionReference: c.reconciliation_exception_id,
          safeCode: c.safe_code,
          checkedAt: instant(c.checked_at),
        })),
        exceptions: exceptions.rows.map((e) => ({
          exceptionReference: e.reconciliation_exception_id,
          brandReference: e.brand_id,
          storeReference: e.store_id,
          candidateReference: e.candidate_id,
          reason: e.reason,
          severity: e.severity,
          status: e.status,
          openedAt: instant(e.opened_at),
        })),
      });
      await authorize();
      return result;
    } catch (error) {
      if (
        error instanceof PaymentReconciliationError &&
        error.code === "PAYMENT_RECONCILIATION_PERMISSION_DENIED"
      )
        throw error;
      return unavailable();
    }
  };
}

/** Owns the transaction boundary so failed append/readback cannot commit partial history. */
export function createPostgresPaymentReconciliationRepository(
  options: Parameters<typeof createPostgresPaymentReconciliationRunSource>[0] & {
    transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  },
) {
  const read = createPostgresPaymentReconciliationRunSource(options);
  const conflict = (): never => {
    throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_RUN_CONFLICT");
  };
  return Object.freeze({
    loadRun: (input: { readonly runReference: string }) =>
      options.transactions.run((tx) => read(tx, input)),
    commit: (value: unknown) =>
      options.transactions.run(async (tx) => {
        const result = parsePaymentReconciliationRunResult(value),
          r = result.run;
        if (
          r.brandReference !== options.scope.brandReference ||
          r.storeReference !== options.scope.storeReference
        )
          return conflict();
        const request = {
          brandReference: r.brandReference,
          storeReference: r.storeReference,
          runReference: r.runReference,
          purpose: "ReconcilePayments" as const,
        };
        if ((await options.authorize(tx, request)) !== true)
          throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
        await tx.query(
          "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
          [r.brandReference, r.storeReference],
        );
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "PaymentReconciliation:" + r.brandReference + ":" + r.storeReference,
        ]);
        const previous = await read(tx, { runReference: r.runReference });
        if (previous)
          return {
            status: equivalentPaymentReconciliationResult(result, previous)
              ? ("Duplicate" as const)
              : ("Conflict" as const),
            result: previous,
          };
        await tx.query(
          "INSERT INTO rms_payment.payment_reconciliation_run (reconciliation_run_id,brand_id,store_id,mode,actor_id,purpose,scheduled_at,cutoff_at,max_candidates,completed_at,matched_count,healed_count,unresolved_count,unavailable_count,difference_count) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
          [
            r.runReference,
            r.brandReference,
            r.storeReference,
            r.mode,
            r.actorReference,
            r.purpose,
            r.scheduledAt,
            r.cutoffAt,
            r.maxCandidates,
            result.completedAt,
            result.counts.Matched,
            result.counts.Healed,
            result.counts.Unresolved,
            result.counts.Unavailable,
            result.counts.Difference,
          ],
        );
        for (const e of result.exceptions) {
          const existing = await tx.query(
            "SELECT reconciliation_exception_id::text AS identity,candidate_id::text AS candidate,reason,severity,status,opened_at FROM rms_payment.payment_reconciliation_exception WHERE brand_id=$1 AND store_id=$2 AND (reconciliation_exception_id=$3 OR (candidate_id=$4 AND reason=$5)) LIMIT 2",
            [
              e.brandReference,
              e.storeReference,
              e.exceptionReference,
              e.candidateReference,
              e.reason,
            ],
          );
          if (!Array.isArray(existing.rows) || existing.rows.length > 1) return conflict();
          const prior = existing.rows[0];
          if (prior) {
            const openedAt = instant(prior.opened_at);
            if (
              prior.identity !== e.exceptionReference ||
              prior.candidate !== e.candidateReference ||
              prior.reason !== e.reason ||
              prior.severity !== e.severity ||
              prior.status !== e.status ||
              typeof openedAt !== "string" ||
              openedAt > e.openedAt
            )
              return conflict();
          } else {
            await tx.query(
              "INSERT INTO rms_payment.payment_reconciliation_exception (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
              [
                e.exceptionReference,
                e.brandReference,
                e.storeReference,
                e.candidateReference,
                e.reason,
                e.severity,
                e.status,
                e.openedAt,
              ],
            );
          }
        }
        for (const c of result.checks)
          await tx.query(
            "INSERT INTO rms_payment.payment_reconciliation_record (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,payment_intent_id,settlement_reference,outcome,difference_reason,internal_status,provider_status,internal_captured_minor,provider_captured_minor,internal_refunded_minor,provider_refunded_minor,currency_code,reconciliation_exception_id,safe_code,checked_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)",
            [
              c.checkReference,
              c.runReference,
              c.candidateReference,
              c.brandReference,
              c.storeReference,
              c.mode,
              c.paymentIntentReference,
              c.settlementReference,
              c.outcome,
              c.differenceReason,
              c.internalStatus,
              c.providerStatus,
              c.internalCapturedAmount.amountMinor.toString(),
              c.providerCapturedAmount?.amountMinor.toString() ?? null,
              c.internalRefundedAmount.amountMinor.toString(),
              c.providerRefundedAmount?.amountMinor.toString() ?? null,
              c.internalCapturedAmount.currencyCode,
              c.exceptionReference,
              c.safeCode,
              c.checkedAt,
            ],
          );
        const saved = await read(tx, { runReference: r.runReference });
        if (!saved || !equivalentPaymentReconciliationResult(result, saved)) return conflict();
        return { status: "Created" as const, result: saved };
      }),
  });
}
