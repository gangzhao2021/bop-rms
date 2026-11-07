import type { ConsumerTransaction } from "@bop/eventing";
import {
  bindOrdinaryRefundProviderOutcome,
  createPostgresDiningTableSettlementStore,
  createRefundPaymentRequest,
  type DiningTableOnlineRefundRecord,
  type PaymentProviderAdapter,
  type RefundPaymentRequest,
} from "@rms/payment";

/**
 * WP-2423 DEC-TABLE-ONLINE-REFUND: sends an approved refund of a table's phone payment to the
 * Provider and records its answer. The approval fixed the key, so sending again (a lost answer, the
 * Provider down, this background retry) returns the same refund and can never pay twice. Provider
 * calls never run inside a database transaction.
 */
export const diningTableOnlineRefundRetryAfterMs = 60_000;

export function createDiningTableOnlineRefundSender(options: {
  readonly scope: {
    readonly tenantReference: string;
    readonly brandReference: string;
    readonly storeReference: string;
  };
  readonly provider: Pick<PaymentProviderAdapter, "refundPayment">;
  readonly transactions: { run<T>(work: (tx: ConsumerTransaction) => Promise<T>): Promise<T> };
  /** The caller's authority, rechecked each transaction: staff or the pilot's installed worker. */
  readonly authorize: (tx: ConsumerTransaction) => Promise<boolean>;
  readonly now: () => string;
  readonly nextReference: () => string;
}) {
  const store = createPostgresDiningTableSettlementStore({
    scope: options.scope,
    authorize: async (tx) => options.authorize(tx as unknown as ConsumerTransaction),
  });
  const instant = () => new Date(Date.parse(options.now())).toISOString();
  const requestFor = async (refund: DiningTableOnlineRefundRecord) =>
    options.transactions.run(async (tx): Promise<RefundPaymentRequest> => {
      const payment = (await store.listOnlinePaymentsByOrders(tx, [refund.orderReference])).find(
        (entry) => entry.onlinePaymentReference === refund.onlinePaymentReference,
      );
      if (payment === undefined) throw new Error("TABLE_ONLINE_REFUND_PAYMENT_UNAVAILABLE");
      return createRefundPaymentRequest({
        operation: "RefundPayment",
        purpose: "RefundPayment",
        idempotencyKey: refund.providerIdempotencyKey,
        context: {
          provider: "Stripe",
          environment: payment.environment,
          brandReference: options.scope.brandReference,
          storeReference: options.scope.storeReference,
          paymentAttemptReference: payment.onlinePaymentReference,
          operationReference: refund.operationReference,
        },
        providerIntentReference: payment.providerIntentReference,
        originalPaymentMethod: "OnlineCard",
        amount: { amountMinor: refund.amountMinor, currencyCode: "CAD" },
      } as never);
    });
  /** Sends it once; true when the Provider gave a final answer, now on record. */
  const send = async (refund: DiningTableOnlineRefundRecord): Promise<boolean> => {
    const request = await requestFor(refund);
    const outcome = bindOrdinaryRefundProviderOutcome(
      request,
      await options.provider.refundPayment(request),
    );
    const record = (
      input: Pick<
        Parameters<typeof store.recordOnlineRefundOutcome>[1],
        | "status"
        | "providerRefundReference"
        | "providerCreatedAt"
        | "providerObservedAt"
        | "evidenceDigest"
      >,
    ) =>
      options.transactions.run((tx) =>
        store.recordOnlineRefundOutcome(tx, {
          ...input,
          onlineRefundReference: refund.onlineRefundReference,
          recordedAt: instant(),
          auditReference: options.nextReference(),
        }),
      );
    if (outcome.kind === "RefundObservation") {
      if (
        outcome.amount.amountMinor !== refund.amountMinor ||
        String(outcome.providerIntentReference) !== String(request.providerIntentReference)
      )
        throw new Error("TABLE_ONLINE_REFUND_ANSWER_MISMATCH");
      if (outcome.status === "pending" || outcome.status === "requires_action") return false;
      await record({
        status: outcome.status === "succeeded" ? "Succeeded" : "Failed",
        providerRefundReference: String(outcome.providerRefundReference),
        providerCreatedAt: outcome.createdAt,
        providerObservedAt: outcome.observedAt,
        evidenceDigest: outcome.evidenceDigest,
      });
      return true;
    }
    // "Never" is the Provider refusing for good: nothing moved, so the amount is free again.
    if (outcome.kind === "Failure" && outcome.retryDisposition === "Never") {
      await record({
        status: "Failed",
        providerRefundReference: null,
        providerCreatedAt: null,
        providerObservedAt: instant(),
        evidenceDigest: null,
      });
      return true;
    }
    return false;
  };
  return Object.freeze({
    send,
    /** Background retry: refunds a staff request did not finish; one failing does not stop others. */
    async sendOpen(input: { readonly limit: number }): Promise<number> {
      const open = await options.transactions.run((tx) =>
        store.listOpenOnlineRefunds(tx, input.limit),
      );
      const before = Date.parse(options.now()) - diningTableOnlineRefundRetryAfterMs;
      let answered = 0;
      for (const refund of open) {
        if (Date.parse(refund.requestedAt) > before) continue;
        if (await send(refund).catch(() => false)) answered += 1;
      }
      return answered;
    },
  });
}
