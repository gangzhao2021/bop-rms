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
        "SELECT reconciliation_exception_id::text AS exception_reference,brand_id::text AS brand_reference,store_id::text AS store_reference,candidate_id::text AS candidate_reference,reason,severity,status,opened_at FROM rms_payment.payment_reconciliation_exception WHERE brand_id=$1 AND store_id=$2 AND ($3::uuid IS NULL OR reconciliation_exception_id>$3::uuid) ORDER BY reconciliation_exception_id LIMIT $4",
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
