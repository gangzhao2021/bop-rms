import { createHash } from "node:crypto";
import type { ConsumerTransaction } from "@bop/eventing";
import { PaymentCompensationError } from "../../application/paid-without-fulfillable-order.js";
import { decodePaymentCompensationAction } from "../../application/payment-compensation-action-codec.js";
import { decodePaymentCompensationRefund } from "../../application/payment-compensation-refund-codec.js";
import { exactPaymentObject } from "../../application/payment-intent-creation.js";
import { parsePaymentReference } from "../../application/payment-provider-adapter.js";
export interface PaymentCompensationRefundPositionInput {
  readonly orderReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentAttemptReference: string;
}
const fail = (): never => {
  throw new PaymentCompensationError("PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE");
};
/** Compensation-owned amounts only. Other refund owners must be composed separately.
 * Caller retains the shared Order fence through its complete source read/transaction.
 */
export function createPostgresPaymentCompensationRefundPositionSource(options: {
  readonly scope: { readonly brandReference: string; readonly storeReference: string };
  readonly authorize: (
    tx: ConsumerTransaction,
    input: PaymentCompensationRefundPositionInput & {
      readonly brandReference: string;
      readonly storeReference: string;
    },
  ) => Promise<boolean>;
}) {
  const brandReference = String(parsePaymentReference(options.scope.brandReference));
  const storeReference = String(parsePaymentReference(options.scope.storeReference));
  return async (tx: ConsumerTransaction, value: PaymentCompensationRefundPositionInput) => {
    const raw = exactPaymentObject(value, [
      "orderReference",
      "paymentTransactionReference",
      "paymentAttemptReference",
    ]);
    const input = {
      brandReference,
      storeReference,
      orderReference: String(parsePaymentReference(raw.orderReference)),
      paymentTransactionReference: String(parsePaymentReference(raw.paymentTransactionReference)),
      paymentAttemptReference: String(parsePaymentReference(raw.paymentAttemptReference)),
    };
    const authorize = async () => {
      if ((await options.authorize(tx, input)) !== true)
        throw new PaymentCompensationError("PAYMENT_COMPENSATION_PERMISSION_DENIED");
    };
    await authorize();
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brandReference,
      storeReference,
    ]);
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      "PaymentReceiptOrder:" + brandReference + ":" + storeReference + ":" + input.orderReference,
    ]);
    const parameters = [brandReference, storeReference, input.paymentAttemptReference];
    const actions = await tx.query(
      "SELECT DISTINCT ON (action_id) history_version::text AS version,order_id::text AS order_id,record_json::text AS record " +
        "FROM rms_payment.payment_compensation_action_history WHERE brand_id=$1 AND store_id=$2 AND payment_attempt_id=$3 " +
        "ORDER BY action_id,history_version DESC LIMIT 101",
      parameters,
    );
    const refunds = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund " +
        "WHERE brand_id=$1 AND store_id=$2 AND payment_attempt_id=$3 ORDER BY refund_id LIMIT 101",
      parameters,
    );
    if (actions.rows.length > 100 || refunds.rows.length > 100) return fail();
    const confirmed = new Map<string, bigint>();
    const receipts = [];
    let confirmedMinor = 0n,
      pendingMinor = 0n,
      version = 1;
    for (const row of refunds.rows) {
      const receipt = decodePaymentCompensationRefund(row.record);
      const fact = receipt.fact;
      if (
        fact.brandReference !== brandReference ||
        fact.storeReference !== storeReference ||
        fact.paymentAttemptReference !== input.paymentAttemptReference ||
        fact.paymentTransactionReference !== input.paymentTransactionReference ||
        fact.orderReference !== input.orderReference ||
        confirmed.has(fact.compensationCaseReference)
      )
        return fail();
      confirmed.set(fact.compensationCaseReference, fact.amount.amountMinor);
      confirmedMinor += fact.amount.amountMinor;
      version++;
      receipts.push(receipt);
    }
    const seen = new Set<string>(),
      claims = [];
    for (const row of actions.rows) {
      if (typeof row.version !== "string" || !/^[1-9][0-9]*$/u.test(row.version)) return fail();
      const sequence = Number(row.version);
      if (!Number.isSafeInteger(sequence)) return fail();
      const action = decodePaymentCompensationAction(row.record);
      if (
        row.order_id !== input.orderReference ||
        action.brandReference !== brandReference ||
        action.storeReference !== storeReference ||
        action.paymentAttemptReference !== input.paymentAttemptReference ||
        action.paymentTransactionReference !== input.paymentTransactionReference ||
        seen.has(action.compensationCaseReference)
      )
        return fail();
      seen.add(action.compensationCaseReference);
      const refunded = confirmed.get(action.compensationCaseReference) ?? 0n;
      if (refunded > action.amount.amountMinor) return fail();
      // Even ProviderConfirmed remains occupied until its durable refund fact exists.
      pendingMinor += action.amount.amountMinor - refunded;
      version += sequence;
      claims.push(action);
    }
    if (!Number.isSafeInteger(version) || confirmedMinor + pendingMinor > 9223372036854775807n)
      return fail();
    await authorize();
    const snapshotDigest =
      "sha256:" +
      createHash("sha256")
        .update(
          JSON.stringify({ input, claims, receipts }, (_key, item: unknown) =>
            typeof item === "bigint" ? item.toString() : item,
          ),
        )
        .digest("hex");
    return Object.freeze({ confirmedMinor, pendingMinor, version, snapshotDigest });
  };
}
