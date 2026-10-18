import type { ConsumerTransaction } from "@bop/eventing";
import { appendAuditRecordInTransaction } from "@bop/audit";
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
    /**
     * WP-2423: when given, a matching check resolves the same candidate's earlier open differences
     * (a business day's settlement check, or a single payment's Operational check), one
     * append-only resolution row and one audit record each, in the same transaction as the run.
     * Without it no resolution is recorded.
     */
    resolutions?: { nextReference(): string };
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
            // WP-2423: a resolved earlier difference of the same candidate and reason is history; only
            // an open one (or this exact identity) is the same difference.
            "SELECT x.reconciliation_exception_id::text AS identity,x.candidate_id::text AS candidate,x.reason,x.severity,x.status,x.opened_at FROM rms_payment.payment_reconciliation_exception x WHERE x.brand_id=$1 AND x.store_id=$2 AND (x.reconciliation_exception_id=$3 OR (x.candidate_id=$4 AND x.reason=$5 AND NOT EXISTS (SELECT 1 FROM rms_payment.payment_reconciliation_resolution s WHERE s.brand_id=x.brand_id AND s.store_id=x.store_id AND s.reconciliation_exception_id=x.reconciliation_exception_id))) LIMIT 2",
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
        if (options.resolutions)
          for (const c of result.checks) {
            // A matching check resolves the candidate's earlier open differences: a business day's
            // settlement check (DailySettlement) or, since 2026-10-17, a single payment's check
            // (Operational: Payment records and the Provider agree again). A check that still
            // differs, or is unresolved/unavailable, leaves them open.
            if (c.outcome !== "Matched") continue;
            const open = await tx.query(
              "SELECT e.reconciliation_exception_id::text AS exception_reference FROM rms_payment.payment_reconciliation_exception e WHERE e.brand_id=$1 AND e.store_id=$2 AND e.candidate_id=$3 AND e.opened_at<=$4::timestamptz AND NOT EXISTS (SELECT 1 FROM rms_payment.payment_reconciliation_resolution s WHERE s.brand_id=e.brand_id AND s.store_id=e.store_id AND s.reconciliation_exception_id=e.reconciliation_exception_id) ORDER BY e.reconciliation_exception_id LIMIT 5",
              [c.brandReference, c.storeReference, c.candidateReference, c.checkedAt],
            );
            if (!Array.isArray(open.rows) || open.rows.length > 4) return conflict();
            for (const row of open.rows) {
              const exception = String(parsePaymentReference(row.exception_reference));
              const auditReference = String(
                parsePaymentReference(options.resolutions.nextReference()),
              );
              const inserted = await tx.query(
                "INSERT INTO rms_payment.payment_reconciliation_resolution (reconciliation_exception_id,brand_id,store_id,candidate_id,resolution,reconciliation_run_id,reconciliation_check_id,resolved_at,audit_id) VALUES ($1,$2,$3,$4,'MatchedOnRecheck',$5,$6,$7,$8)",
                [
                  exception,
                  c.brandReference,
                  c.storeReference,
                  c.candidateReference,
                  c.runReference,
                  c.checkReference,
                  c.checkedAt,
                  auditReference,
                ],
              );
              if (inserted.rowCount !== 1) return conflict();
              await appendAuditRecordInTransaction(tx, {
                auditId: auditReference,
                brandId: c.brandReference,
                storeId: c.storeReference,
                actor: { type: "System" },
                actionCode: "PAYMENT_RECONCILIATION_DIFFERENCE_RESOLVED",
                targetType: "PaymentReconciliationException",
                targetId: exception,
                reasonCode: "MATCHED_ON_RECHECK",
                correlationId: c.checkReference,
                occurredAt: c.checkedAt,
                sourceChannel: "PAYMENT_RECONCILIATION",
                dataClassification: "Restricted",
                retentionPolicyCode: "FINANCIAL_COMPLIANCE",
                retentionPolicyVersion: 1,
              });
            }
          }
        const saved = await read(tx, { runReference: r.runReference });
        if (!saved || !equivalentPaymentReconciliationResult(result, saved)) return conflict();
        return { status: "Created" as const, result: saved };
      }),
  });
}

export interface PaymentReconciliationResolution {
  readonly exceptionReference: string;
  readonly resolution: "MatchedOnRecheck";
  readonly runReference: string;
  readonly checkReference: string;
  readonly resolvedAt: string;
}
/**
 * WP-2423: how an earlier reconciliation difference was resolved by a later matching check of the
 * same candidate (business day or payment), or null when it was not. Read-only, Store-scoped.
 */
export function createPostgresPaymentReconciliationResolutionReader(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  return async (
    tx: ConsumerTransaction,
    exceptionReference: string,
  ): Promise<PaymentReconciliationResolution | null> => {
    const exception = String(parsePaymentReference(exceptionReference));
    if ((await options.authorize(tx)) !== true)
      throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT reconciliation_exception_id::text AS exception_reference,resolution,reconciliation_run_id::text AS run_reference,reconciliation_check_id::text AS check_reference,resolved_at FROM rms_payment.payment_reconciliation_resolution WHERE brand_id=$1 AND store_id=$2 AND reconciliation_exception_id=$3 LIMIT 2",
      [scope.brandReference, scope.storeReference, exception],
    );
    if (!Array.isArray(result.rows) || result.rows.length > 1) return unavailable();
    const row = result.rows[0];
    if (!row) return null;
    const resolvedAt = instant(row.resolved_at);
    if (
      row.exception_reference !== exception ||
      row.resolution !== "MatchedOnRecheck" ||
      typeof resolvedAt !== "string"
    )
      return unavailable();
    if ((await options.authorize(tx)) !== true)
      throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    return Object.freeze({
      exceptionReference: exception,
      resolution: "MatchedOnRecheck",
      runReference: String(parsePaymentReference(row.run_reference)),
      checkReference: String(parsePaymentReference(row.check_reference)),
      resolvedAt: new Date(resolvedAt).toISOString(),
    });
  };
}

/**
 * WP-2423 (2026-10-17): how many earlier differences of this candidate and reason a later matching
 * check resolved. A new difference after a resolution is a new exception (its identity includes
 * this count, which the database assigns as the exception's generation); 0 keeps the identity a
 * difference has always had. Read-only, Store-scoped, inside the reconciliation lease.
 */
export function createPostgresPaymentReconciliationResolvedDifferenceCount(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}) {
  const scope = Object.freeze({
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
  });
  return async (
    tx: ConsumerTransaction,
    input: { readonly candidateReference: string; readonly reason: string },
  ): Promise<number> => {
    const candidate = String(parsePaymentReference(input.candidateReference));
    if (
      !["StateMismatch", "AmountMismatch", "RefundMismatch", "TerminalConflict"].includes(
        input.reason,
      )
    )
      return unavailable();
    if ((await options.authorize(tx)) !== true)
      throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT count(*)::int AS resolved FROM rms_payment.payment_reconciliation_exception e JOIN rms_payment.payment_reconciliation_resolution s ON s.brand_id=e.brand_id AND s.store_id=e.store_id AND s.reconciliation_exception_id=e.reconciliation_exception_id WHERE e.brand_id=$1 AND e.store_id=$2 AND e.candidate_id=$3 AND e.reason=$4",
      [scope.brandReference, scope.storeReference, candidate, input.reason],
    );
    const resolved =
      Array.isArray(result.rows) && result.rows.length === 1 ? result.rows[0]?.resolved : null;
    if (!Number.isSafeInteger(resolved) || (resolved as number) < 0) return unavailable();
    if ((await options.authorize(tx)) !== true)
      throw new PaymentReconciliationError("PAYMENT_RECONCILIATION_PERMISSION_DENIED");
    return resolved as number;
  };
}
