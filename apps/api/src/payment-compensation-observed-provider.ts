import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPaymentProviderContext,
  createRetrieveIntentRequest,
  createRefundPaymentRequest,
  parsePaymentProviderOutcome,
  createPostgresPaymentProviderObservationStore,
  type PaymentProviderAdapter,
  type PaymentProviderContext,
} from "@rms/payment";
/** Never report a Snapshot to compensation before its owner observation commits. */
export function createPaymentCompensationObservedProvider(options: {
  transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  context: PaymentProviderContext;
  paymentIntentReference: string;
  providerIntentReference: string;
  provider: Pick<PaymentProviderAdapter, "retrieveIntent" | "refundPayment">;
  authorize(tx: ConsumerTransaction): Promise<boolean>;
  now(): string;
  newObservationReference(): string;
}): PaymentProviderAdapter {
  const context = createPaymentProviderContext(options.context);
  const deny = (): never => {
    throw new Error("PAYMENT_COMPENSATION_PROVIDER_UNAVAILABLE");
  };
  const authorize = async (tx: ConsumerTransaction) => {
    if ((await options.authorize(tx)) !== true) deny();
  };
  const bound = (value: { context: PaymentProviderContext; providerIntentReference: string }) => {
    if (
      value.providerIntentReference !== options.providerIntentReference ||
      JSON.stringify(createPaymentProviderContext(value.context)) !== JSON.stringify(context)
    )
      deny();
  };
  async function observe(value: unknown) {
    const outcome = parsePaymentProviderOutcome(value);
    if (JSON.stringify(createPaymentProviderContext(outcome.context)) !== JSON.stringify(context))
      return deny();
    if (outcome.kind !== "Snapshot") return outcome;
    bound(outcome);
    await options.transactions.run(async (tx) => {
      await authorize(tx);
      const store = createPostgresPaymentProviderObservationStore(
        { run: (work) => work(tx) },
        { brandReference: context.brandReference, storeReference: context.storeReference },
        { now: options.now },
      );
      await store.record({
        observationReference: options.newObservationReference(),
        paymentIntentReference: options.paymentIntentReference,
        snapshot: outcome,
      });
      await authorize(tx);
    });
    return outcome;
  }
  const unsupported = async () => deny();
  return Object.freeze({
    createIntent: unsupported,
    cancelIntent: unsupported,
    captureIntent: unsupported,
    async retrieveIntent(value: Parameters<PaymentProviderAdapter["retrieveIntent"]>[0]) {
      const request = createRetrieveIntentRequest(value);
      bound(request);
      await options.transactions.run(authorize);
      return observe(await options.provider.retrieveIntent(request));
    },
    async refundPayment(value: Parameters<PaymentProviderAdapter["refundPayment"]>[0]) {
      const request = createRefundPaymentRequest(value);
      bound(request);
      await options.transactions.run(authorize);
      return observe(await options.provider.refundPayment(request));
    },
  });
}
