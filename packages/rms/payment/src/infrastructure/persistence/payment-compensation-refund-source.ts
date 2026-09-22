import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaymentReference,
  createRefundPaymentRequest,
} from "../../application/payment-provider-adapter.js";
import { parsePaymentInstant } from "../../application/payment-intent-creation.js";
import { decodePaymentCompensationRefund } from "../../application/payment-compensation-refund-codec.js";
import { decodePaymentCompensationAction } from "../../application/payment-compensation-action-codec.js";
import { createPostgresPaymentTerminalStore } from "./payment-terminal-store.js";

/** Recover original request bindings for confirmed refunds; no Provider dispatch authority. */
export function createPostgresConfirmedCompensationRefundSource(options: {
  scope: {
    brandReference: string;
    storeReference: string;
    providerAccountReference: string;
    environment: "Test" | "Live";
  };
  authorize(
    tx: ConsumerTransaction,
    input: { observedAt: string; purpose: "ReconcilePayments" },
  ): Promise<boolean>;
}) {
  const scope = {
    brandReference: String(parsePaymentReference(options.scope.brandReference)),
    storeReference: String(parsePaymentReference(options.scope.storeReference)),
    providerAccountReference: String(parsePaymentReference(options.scope.providerAccountReference)),
    environment: options.scope.environment,
  };
  const fail = (): never => {
    throw Error("COMPENSATION_REFUND_SOURCE_UNAVAILABLE");
  };
  if (!["Test", "Live"].includes(scope.environment)) return fail();
  return async (
    tx: ConsumerTransaction,
    input: { observedAt: string; afterRefundReference: string | null; limit: number },
  ) => {
    const observedAt = parsePaymentInstant(input.observedAt),
      after =
        input.afterRefundReference === null
          ? null
          : String(parsePaymentReference(input.afterRefundReference));
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100) return fail();
    const authorize = async () => {
      if ((await options.authorize(tx, { observedAt, purpose: "ReconcilePayments" })) !== true)
        return fail();
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    const result = await tx.query(
      "SELECT r.refund_id::text AS reference,r.record_json::text AS record FROM rms_payment.payment_compensation_refund r JOIN rms_payment.payment_terminal_fact t ON t.brand_id=r.brand_id AND t.store_id=r.store_id AND t.payment_attempt_id=r.payment_attempt_id WHERE r.brand_id=$1 AND r.store_id=$2 AND t.provider_account_id=$3 AND t.provider_environment=$4 AND r.recorded_at <= $5 AND ($6::uuid IS NULL OR r.refund_id>$6::uuid) ORDER BY r.refund_id LIMIT $7",
      [
        scope.brandReference,
        scope.storeReference,
        scope.providerAccountReference,
        scope.environment,
        observedAt,
        after,
        input.limit + 1,
      ],
    );
    if (result.rows.length > input.limit + 1) return fail();
    let previous = after;
    const parsed = result.rows.map((row) => {
      const receipt = decodePaymentCompensationRefund(row.record),
        fact = receipt.fact;
      if (
        row.reference !== fact.refundReference ||
        fact.brandReference !== scope.brandReference ||
        fact.storeReference !== scope.storeReference ||
        fact.recordedAt > observedAt ||
        (previous !== null && fact.refundReference <= previous)
      )
        return fail();
      previous = fact.refundReference;
      return receipt;
    });
    const records = [];
    for (const receipt of parsed.slice(0, input.limit)) {
      const fact = receipt.fact;
      const rows = await tx.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_action_history WHERE brand_id=$1 AND store_id=$2 AND case_id=$3 AND observed_at <= $4 ORDER BY history_version DESC LIMIT 1",
        [scope.brandReference, scope.storeReference, fact.compensationCaseReference, observedAt],
      );
      if (rows.rows.length !== 1) return fail();
      const action = decodePaymentCompensationAction(rows.rows[0]?.record);
      for (const key of [
        "brandReference",
        "storeReference",
        "compensationCaseReference",
        "paymentTransactionReference",
        "paymentAttemptReference",
        "originalPaymentMethod",
      ] as const)
        if (action[key] !== fact[key]) return fail();
      if (
        action.phase !== "ProviderConfirmed" ||
        action.originalPaymentMethod !== "OnlineCard" ||
        action.amount.amountMinor !== fact.amount.amountMinor ||
        action.amount.currencyCode !== fact.amount.currencyCode ||
        action.claimedAt > fact.providerConfirmedAt
      )
        return fail();
      const terminal = await createPostgresPaymentTerminalStore(
        { run: (work) => work(tx) },
        scope,
      ).read(fact.paymentIntentReference);
      if (
        !terminal ||
        terminal.outcome !== "Succeeded" ||
        !terminal.amount ||
        terminal.amount.amountMinor !== fact.amount.amountMinor ||
        terminal.amount.currencyCode !== fact.amount.currencyCode ||
        terminal.evidenceDigest !== action.terminalEvidenceDigest ||
        terminal.recordedAt > action.claimedAt
      )
        return fail();
      for (const key of [
        "paymentTransactionReference",
        "paymentAttemptReference",
        "orderReference",
      ] as const)
        if (terminal[key] !== fact[key]) return fail();
      const request = createRefundPaymentRequest({
        operation: "RefundPayment",
        purpose: "RefundPayment",
        context: {
          provider: "Stripe",
          environment: scope.environment,
          brandReference: fact.brandReference,
          storeReference: fact.storeReference,
          paymentAttemptReference: fact.paymentAttemptReference,
          operationReference: action.actionReference,
        },
        idempotencyKey: action.providerIdempotencyKey,
        providerIntentReference: terminal.providerIntentReference,
        originalPaymentMethod: fact.originalPaymentMethod,
        amount: action.amount,
      });
      records.push(Object.freeze({ receipt, action, request }));
    }
    await authorize();
    return Object.freeze({
      records: Object.freeze(records),
      nextAfterRefundReference:
        parsed.length > input.limit ? (records.at(-1)?.receipt.fact.refundReference ?? null) : null,
    });
  };
}
