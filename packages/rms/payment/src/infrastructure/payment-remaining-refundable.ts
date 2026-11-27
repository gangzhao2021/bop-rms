import type { ConsumerTransaction } from "@bop/eventing";
import { parsePaymentInstant } from "../application/payment-intent-creation.js";
import { parsePaymentReference } from "../application/payment-provider-adapter.js";
import { createPostgresOrderPaymentRefundPosition } from "./order-payment-refund-position.js";
import { createPostgresPaymentIntentCreationStore } from "./persistence/payment-intent-creation-store.js";
import { createPostgresPaymentTerminalStore } from "./persistence/payment-terminal-store.js";
import { createPostgresPaymentCompensationRefundPositionSource } from "./persistence/payment-compensation-refund-position-source.js";
import type { CancellationRefundScope } from "./cancellation-refund-runtime.js";

const fail = (): never => {
  throw new Error("PAYMENT_REMAINING_REFUNDABLE_UNAVAILABLE");
};
const ref = (value: unknown) => String(parsePaymentReference(value));

export interface PaymentRemainingRefundableQuery {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly paymentTransactionReference: string;
  readonly paymentIntentReference: string;
  readonly paymentAttemptReference: string;
  readonly observedAt: string;
}

/** Read-only remaining refundable amount of one captured payment.
 * capturedMinor: the Provider-captured total (including tip).
 * claimedMinor: every occupying refund claim on this payment — ordinary claims
 * (including Cancellation) and compensation refunds, pending plus confirmed.
 * remainingMinor = capturedMinor - claimedMinor.
 * tipMinor: the tip captured with this payment (the original tip, not a remainder).
 * compensationMinor: compensation refunds (pending plus confirmed), included in claimedMinor.
 * Caller retains the transaction; no writes or Provider I/O. */
export async function readPaymentRemainingRefundable(
  tx: ConsumerTransaction,
  value: {
    readonly scope: CancellationRefundScope;
    readonly orderReference: string;
    readonly paymentTransactionReference: string;
    readonly paymentIntentReference: string;
    readonly paymentAttemptReference: string;
    readonly observedAt: string;
    authorize(tx: ConsumerTransaction, query: PaymentRemainingRefundableQuery): Promise<boolean>;
  },
): Promise<{
  readonly capturedMinor: bigint;
  readonly claimedMinor: bigint;
  readonly remainingMinor: bigint;
  readonly tipMinor: bigint;
  readonly compensationMinor: bigint;
}> {
  const environment = value.scope.environment;
  if (environment !== "Test" && environment !== "Live") return fail();
  const scope = {
    tenantReference: ref(value.scope.tenantReference),
    brandReference: ref(value.scope.brandReference),
    storeReference: ref(value.scope.storeReference),
  };
  const providerAccountReference = ref(value.scope.providerAccountReference);
  const query = Object.freeze({
    ...scope,
    orderReference: ref(value.orderReference),
    paymentTransactionReference: ref(value.paymentTransactionReference),
    paymentIntentReference: ref(value.paymentIntentReference),
    paymentAttemptReference: ref(value.paymentAttemptReference),
    observedAt: parsePaymentInstant(value.observedAt),
  });
  const allowed = async () => {
    if ((await value.authorize(tx, query)) !== true) return fail();
    return true;
  };
  await allowed();
  await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
    scope.brandReference,
    scope.storeReference,
  ]);
  const intents = await tx.query<{ operation: unknown }>(
    "SELECT payment_operation_id::text AS operation FROM rms_payment.payment_intent " +
      "WHERE brand_id=$1 AND store_id=$2 AND order_id=$3 AND payment_intent_id=$4",
    [
      scope.brandReference,
      scope.storeReference,
      query.orderReference,
      query.paymentIntentReference,
    ],
  );
  if (intents.rows.length !== 1) return fail();
  const runner = {
    run: <T>(work: (transaction: ConsumerTransaction) => Promise<T>) => work(tx),
  };
  const ownerScope = { brandReference: scope.brandReference, storeReference: scope.storeReference };
  const stored = await createPostgresPaymentIntentCreationStore(runner, ownerScope, {
    now: () => query.observedAt,
    generateObservationReference: fail,
  }).resolveOperation(ref(intents.rows[0]?.operation));
  const terminal = await createPostgresPaymentTerminalStore(runner, {
    ...ownerScope,
    providerAccountReference,
    environment,
  }).read(query.paymentIntentReference);
  if (
    !stored ||
    !terminal ||
    terminal.outcome !== "Succeeded" ||
    !terminal.amount ||
    terminal.amount.currencyCode !== "CAD" ||
    terminal.orderReference !== query.orderReference ||
    terminal.paymentIntentReference !== query.paymentIntentReference ||
    terminal.paymentTransactionReference !== query.paymentTransactionReference ||
    terminal.paymentAttemptReference !== query.paymentAttemptReference ||
    stored.intent.paymentIntentReference !== query.paymentIntentReference ||
    stored.attempt.paymentAttemptReference !== query.paymentAttemptReference ||
    stored.intent.preparation.orderReference !== query.orderReference ||
    stored.intent.preparation.total.amountMinor !== terminal.amount.amountMinor ||
    terminal.recordedAt > query.observedAt
  )
    return fail();
  const position = await createPostgresOrderPaymentRefundPosition({
    scope,
    providerAccountReference,
    environment,
    authorize: allowed,
  })(tx, {
    orderReference: query.orderReference,
    paymentTransactionReference: query.paymentTransactionReference,
    paymentIntentReference: query.paymentIntentReference,
    paymentAttemptReference: query.paymentAttemptReference,
    observedAt: query.observedAt,
  });
  const compensation = await createPostgresPaymentCompensationRefundPositionSource({
    scope: ownerScope,
    authorize: allowed,
  })(tx, {
    orderReference: query.orderReference,
    paymentTransactionReference: query.paymentTransactionReference,
    paymentAttemptReference: query.paymentAttemptReference,
  });
  const compensationMinor = compensation.confirmedMinor + compensation.pendingMinor;
  const capturedMinor = terminal.amount.amountMinor;
  const claimedMinor = position.confirmedMinor + position.pendingMinor;
  const tipMinor = stored.intent.preparation.tip.amountMinor;
  if (
    compensationMinor > claimedMinor ||
    claimedMinor > capturedMinor ||
    tipMinor < 0n ||
    tipMinor > capturedMinor
  )
    return fail();
  await allowed();
  return Object.freeze({
    capturedMinor,
    claimedMinor,
    remainingMinor: capturedMinor - claimedMinor,
    tipMinor,
    compensationMinor,
  });
}
