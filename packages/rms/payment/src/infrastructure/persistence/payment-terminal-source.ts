import type { AuditTransaction } from "@bop/audit";
import {
  parsePaymentTerminalObservation,
  parsePaymentTerminalIntentSource,
  PaymentTerminalError,
  type PaymentTerminalObservation,
} from "../../application/payment-terminal-fact.js";
import { exactPaymentObject } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
import type { PaymentIntentTransactionRunner } from "./payment-intent-creation-store.js";

const sourceSql = `SELECT i.payment_operation_id AS "paymentOperationReference",
 i.order_id AS "orderReference", i.total_minor::text AS "amountMinor"
 FROM rms_payment.payment_intent i
 JOIN rms_payment.payment_attempt a
   ON a.payment_intent_id=i.payment_intent_id AND a.brand_id=i.brand_id AND a.store_id=i.store_id
 JOIN rms_payment.payment_provider_observation o
   ON o.payment_attempt_id=a.payment_attempt_id AND o.payment_intent_id=i.payment_intent_id
   AND o.brand_id=i.brand_id AND o.store_id=i.store_id
 WHERE i.brand_id=$1 AND i.store_id=$2 AND i.payment_intent_id=$3
   AND a.payment_attempt_id=$4 AND a.provider='Stripe' AND a.provider_environment=$5
   AND o.provider_observation_id=$6 AND o.observation_kind='Snapshot'
   AND o.provider_intent_reference=$7
   AND (o.provider_observed_at=$8 OR ($17::boolean AND o.provider_observed_at>$8 AND i.created_at<=$8))
   AND o.evidence_digest=$9 AND o.requested_minor=i.total_minor AND o.currency_code='CAD'
   AND (($10='Captured' AND o.normalized_status='Captured' AND o.captured_minor=i.total_minor
          AND o.captured_minor=$11::bigint)
     OR ($10='Failed' AND o.normalized_status IN ('Failed','Cancelled') AND o.captured_minor=0
          AND (($12='Cancelled' AND o.normalized_status='Cancelled')
            OR ($12<>'Cancelled' AND o.normalized_status='Failed'))))
   AND ($13='ProviderRetrieval' OR EXISTS (
     SELECT 1 FROM rms_payment.provider_webhook_record w
     WHERE w.brand_id=i.brand_id AND w.store_id=i.store_id
       AND w.webhook_receipt_id=$14 AND w.provider_event_id=$15
       AND w.provider_account_id=$16 AND w.provider_environment=a.provider_environment
       AND w.provider='Stripe'
       AND (($10='Captured' AND w.provider_event_type='payment_intent.succeeded')
         OR ($10='Failed' AND w.provider_event_type IN ('payment_intent.payment_failed','payment_intent.canceled')))
   ))`;

export interface PaymentTerminalOccurrenceVerification {
  /** Trusted adapter evidence of the original occurrence, not customer input.
   * Must verify this exact Provider account/intent/attempt/status/time; no synthetic time renewal. */
  verifyOccurrence(tx: AuditTransaction, observation: PaymentTerminalObservation): Promise<boolean>;
}
/** Default requires exact time. Later retrieval requires explicit original-occurrence evidence. */
export function createPostgresPaymentTerminalSource(
  runner: PaymentIntentTransactionRunner,
  scopeInput: unknown,
  occurrence?: PaymentTerminalOccurrenceVerification,
) {
  const raw = exactPaymentObject(scopeInput, [
    "brandReference",
    "storeReference",
    "providerAccountReference",
    "environment",
  ]);
  const brandReference = parsePaymentReference(raw.brandReference);
  const storeReference = parsePaymentReference(raw.storeReference);
  const providerAccountReference = parsePaymentReference(raw.providerAccountReference);
  if (raw.environment !== "Test" && raw.environment !== "Live")
    throw new PaymentTerminalError("PAYMENT_TERMINAL_INPUT_INVALID");
  const environment = raw.environment;
  const resolve = async (tx: AuditTransaction, value: unknown) => {
    const observation = parsePaymentTerminalObservation(value);
    if (
      observation.brandReference !== brandReference ||
      observation.storeReference !== storeReference ||
      observation.providerAccountReference !== providerAccountReference ||
      observation.environment !== environment
    )
      return null;
    const verify = async () =>
      observation.source === "ProviderRetrieval" && occurrence !== undefined
        ? (await occurrence.verifyOccurrence(tx, observation)) === true
        : false;
    const verifiedOccurrence = await verify();
    if (
      observation.source === "ProviderRetrieval" &&
      occurrence !== undefined &&
      !verifiedOccurrence
    )
      return null;
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
    const result = await tx.query(sourceSql, [
      brandReference,
      storeReference,
      observation.paymentIntentReference,
      observation.paymentAttemptReference,
      environment,
      observation.observationReference,
      observation.providerIntentReference,
      observation.occurredAt,
      observation.evidenceDigest,
      observation.status,
      observation.amount?.amountMinor.toString() ?? null,
      observation.failureReason,
      observation.source,
      observation.webhookReceiptReference,
      observation.providerEventReference,
      providerAccountReference,
      verifiedOccurrence,
    ]);
    const rows: unknown =
      result !== null && typeof result === "object"
        ? Object.getOwnPropertyDescriptor(result, "rows")?.value
        : undefined;
    if (!Array.isArray(rows) || rows.length > 1)
      throw new PaymentTerminalError("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
    if (rows.length === 0) return null;
    if (verifiedOccurrence && !(await verify())) return null;
    const row = exactPaymentObject(rows[0], [
      "paymentOperationReference",
      "orderReference",
      "amountMinor",
    ]);
    if (typeof row.amountMinor !== "string" || !/^[1-9][0-9]{0,18}$/u.test(row.amountMinor))
      throw new PaymentTerminalError("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
    return parsePaymentTerminalIntentSource({
      paymentIntentReference: observation.paymentIntentReference,
      paymentAttemptReference: observation.paymentAttemptReference,
      paymentOperationReference: row.paymentOperationReference,
      orderReference: row.orderReference,
      brandReference,
      storeReference,
      provider: "Stripe",
      environment,
      providerAccountReference,
      providerIntentReference: observation.providerIntentReference,
      expectedAmount: { amountMinor: BigInt(row.amountMinor), currencyCode: "CAD" },
    });
  };
  return Object.freeze({
    async resolve(value: unknown) {
      try {
        return await runner.run((tx) => resolve(tx, value));
      } catch (error) {
        if (error instanceof PaymentTerminalError) throw error;
        throw new PaymentTerminalError("PAYMENT_TERMINAL_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
