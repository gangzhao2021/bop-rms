import type { createPostgresPaymentCompensationActionStore } from "./payment-compensation-action-store.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaymentProviderConfirmedRefundFact,
  parsePaymentCompensationActionReceipt,
  parsePaymentCompensationCase,
  type PaymentProviderConfirmedRefundFact,
} from "../../application/paid-without-fulfillable-order.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";
/** Verifies committed retrieval evidence. Case/lease binding remains the refund store's responsibility. */
export function createPostgresPaymentCompensationProviderEvidence(options: {
  scope: {
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  authorize(tx: ConsumerTransaction, fact: PaymentProviderConfirmedRefundFact): Promise<boolean>;
}) {
  const scope = Object.freeze({ ...options.scope });
  return async (tx: ConsumerTransaction, value: unknown): Promise<boolean> => {
    const fact = parsePaymentProviderConfirmedRefundFact(value);
    if (
      fact.source !== "ProviderRetrieval" ||
      fact.brandReference !== scope.brandReference ||
      fact.storeReference !== scope.storeReference ||
      (await options.authorize(tx, fact)) !== true
    )
      return false;
    const terminal = await createPostgresPaymentTerminalStore(
      { run: (work) => work(tx) },
      scope,
    ).read(fact.paymentIntentReference);
    if (
      !terminal ||
      terminal.outcome !== "Succeeded" ||
      terminal.orderReference !== fact.orderReference ||
      terminal.paymentTransactionReference !== fact.paymentTransactionReference ||
      terminal.paymentAttemptReference !== fact.paymentAttemptReference ||
      terminal.environment !== scope.environment ||
      terminal.providerAccountReference !== scope.providerAccountReference ||
      terminal.amount?.amountMinor !== fact.amount.amountMinor ||
      terminal.amount.currencyCode !== fact.amount.currencyCode ||
      terminal.occurredAt > fact.providerConfirmedAt
    )
      return false;
    const result = await tx.query(
      `SELECT EXISTS (
    SELECT 1 FROM rms_payment.payment_provider_observation o
    JOIN rms_payment.payment_attempt a ON a.brand_id=o.brand_id AND a.store_id=o.store_id AND a.payment_intent_id=o.payment_intent_id AND a.payment_attempt_id=o.payment_attempt_id
    JOIN rms_payment.payment_intent i ON i.brand_id=o.brand_id AND i.store_id=o.store_id AND i.payment_intent_id=o.payment_intent_id
    WHERE o.brand_id=$1 AND o.store_id=$2 AND o.payment_intent_id=$3 AND o.payment_attempt_id=$4
      AND o.observation_kind='Snapshot' AND o.normalized_status='Captured'
      AND o.provider_intent_reference=$5 AND o.evidence_digest=$6
      AND o.provider_observed_at=$7 AND o.recorded_at>=$7 AND o.recorded_at<=clock_timestamp()
      AND o.captured_minor=$8 AND o.refunded_minor=$8 AND o.currency_code='CAD'
      AND a.provider='Stripe' AND a.provider_environment=$9
      AND i.payment_method=$10 AND i.order_id=$11 AND i.total_minor=$8
  ) AS matched`,
      [
        scope.brandReference,
        scope.storeReference,
        fact.paymentIntentReference,
        fact.paymentAttemptReference,
        terminal.providerIntentReference,
        fact.evidenceDigest,
        fact.providerConfirmedAt,
        fact.amount.amountMinor.toString(),
        scope.environment,
        fact.originalPaymentMethod,
        fact.orderReference,
      ],
    );
    return (
      result.rows.length === 1 &&
      result.rows[0]?.matched === true &&
      (await options.authorize(tx, fact)) === true
    );
  };
}

/** Action phases describe dispatch recovery; only committed provider observations
 * can establish Pending/Confirmed. InvocationUnknown deliberately confirms no money. */
export function createPostgresPaymentCompensationActionOutcomeEvidence(options: {
  scope: {
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  now(): string;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
}): Parameters<typeof createPostgresPaymentCompensationActionStore>[0]["validateOutcome"] {
  const scope = Object.freeze({ ...options.scope });
  return async (tx, input) => {
    const receipt = parsePaymentCompensationActionReceipt(input.receipt);
    const current = parsePaymentCompensationCase(input.caseRecord);
    const observedAt = parsePaymentInstant(input.observedAt);
    if (
      current.brandReference !== scope.brandReference ||
      current.storeReference !== scope.storeReference ||
      current.environment !== scope.environment ||
      receipt.brandReference !== current.brandReference ||
      receipt.storeReference !== current.storeReference ||
      receipt.compensationCaseReference !== current.caseReference ||
      receipt.paymentTransactionReference !== current.paymentTransactionReference ||
      receipt.paymentAttemptReference !== current.paymentAttemptReference ||
      receipt.originalPaymentMethod !== "OnlineCard" ||
      current.originalPaymentMethod !== receipt.originalPaymentMethod ||
      receipt.dispositionDigest !== current.dispositionDigest ||
      receipt.terminalEvidenceDigest !== current.terminalEvidenceDigest ||
      observedAt < receipt.claimedAt ||
      observedAt > parsePaymentInstant(options.now()) ||
      !(await options.authorize(tx))
    )
      return false;
    const terminal = await createPostgresPaymentTerminalStore(
      { run: (work) => work(tx) },
      scope,
    ).read(current.paymentIntentReference);
    if (
      !terminal ||
      terminal.outcome !== "Succeeded" ||
      terminal.orderReference !== current.orderReference ||
      terminal.paymentTransactionReference !== current.paymentTransactionReference ||
      terminal.paymentAttemptReference !== current.paymentAttemptReference ||
      terminal.environment !== scope.environment ||
      terminal.providerAccountReference !== scope.providerAccountReference ||
      terminal.evidenceDigest !== current.terminalEvidenceDigest ||
      terminal.occurredAt > observedAt ||
      !terminal.amount ||
      terminal.amount.currencyCode !== receipt.amount.currencyCode ||
      receipt.amount.amountMinor <= 0n ||
      receipt.amount.amountMinor > terminal.amount.amountMinor
    )
      return false;
    if (input.nextPhase === "InvocationUnknown") return (await options.authorize(tx)) === true;
    if (input.nextPhase !== "ProviderPending" && input.nextPhase !== "ProviderConfirmed")
      return false;
    const found = await tx.query(
      `SELECT EXISTS (
      SELECT 1 FROM rms_payment.payment_provider_observation o
      WHERE o.brand_id=$1 AND o.store_id=$2 AND o.payment_intent_id=$3
        AND o.payment_attempt_id=$4 AND o.provider_intent_reference=$5
        AND o.observation_kind='Snapshot' AND o.normalized_status='Captured'
        AND o.provider_observed_at=$6 AND o.recorded_at>=$6 AND o.recorded_at<=clock_timestamp()
        AND o.captured_minor=$7 AND o.currency_code='CAD'
        AND (($9='ProviderConfirmed' AND o.refunded_minor=$7)
          OR ($9='ProviderPending' AND o.refunded_minor>$7-$8 AND o.refunded_minor<$7))
    ) AS matched`,
      [
        scope.brandReference,
        scope.storeReference,
        current.paymentIntentReference,
        current.paymentAttemptReference,
        terminal.providerIntentReference,
        observedAt,
        terminal.amount.amountMinor.toString(),
        receipt.amount.amountMinor.toString(),
        input.nextPhase,
      ],
    );
    return (
      found.rows.length === 1 &&
      found.rows[0]?.matched === true &&
      (await options.authorize(tx)) === true
    );
  };
}
