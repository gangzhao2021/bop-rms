import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresSubmissionFinalValidationStore } from "@rms/inventory";
import {
  createPostgresAdditionalDiningExecutionReader,
  parseOrderingReference,
  parseOrderingInstant,
  OrderPaymentOutcomeError,
} from "@rms/ordering";
import { createOrderCapturedPaymentSource } from "./order-captured-payment-source.js";
import { readOrderPaidCapacity } from "./order-paid-capacity-source.js";

const unavailable = (): never => {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
};

/** Exact Additional payment facts under caller-owned transaction fences.
 * Does not reinterpret the snapshot as an Initial Order or infer full Order payment.
 */
export function createAdditionalOrderPaidContextSource(
  options: Parameters<typeof createOrderCapturedPaymentSource>[0] & {
    tenantReference: string;
    quoteVersion: 1 | 2;
    authorizeOrder: Parameters<
      typeof createPostgresAdditionalDiningExecutionReader
    >[0]["authorize"];
    authorizeInventory: Parameters<
      typeof createPostgresSubmissionFinalValidationStore
    >[2]["authorize"];
  },
) {
  const scope = {
    tenantReference: String(parseOrderingReference(options.tenantReference)),
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  };
  const captured = createOrderCapturedPaymentSource(options);
  const executionReader = createPostgresAdditionalDiningExecutionReader({
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    authorize: options.authorizeOrder,
  });
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, event: unknown) {
      try {
        const startedAt = parseOrderingInstant(options.now());
        const paymentFacts = await captured.resolve(transaction, event);
        const p = paymentFacts.payment.intent.preparation;
        const execution = await executionReader.loadBySubmission({
          transaction,
          submissionReference: p.submissionReference,
          observedAt: parseOrderingInstant(options.now()),
        });
        if (!execution) return unavailable();
        const s = execution.snapshot,
          b = s.batch;
        if (
          s.snapshotVersion !== options.quoteVersion ||
          s.orderReference !== p.orderReference ||
          s.brandReference !== p.brandReference ||
          s.storeReference !== p.storeReference ||
          s.guestSessionReference !== p.guestSessionReference ||
          b.orderBatchReference !== p.orderBatchReference ||
          b.submissionReference !== p.submissionReference ||
          b.sourceCartReference !== p.sourceCartReference ||
          b.sourceCartVersion !== p.sourceCartVersion ||
          b.quoteReference !== p.quoteReference ||
          s.items.reduce((sum, item) => sum + item.pricing.total.amountMinor, 0n) !==
            p.orderAllocation.amountMinor
        )
          return unavailable();
        const observedAt = parseOrderingInstant(options.now());
        if (observedAt < startedAt || observedAt < execution.observedAt) return unavailable();
        const capacity = await readOrderPaidCapacity(
          transaction,
          scope,
          paymentFacts.payment,
          "DineIn",
          observedAt,
        );
        const inventory = await createPostgresSubmissionFinalValidationStore(
          { run: (work) => work(transaction) },
          scope,
          { authorize: options.authorizeInventory, resolveCurrent: async () => unavailable() },
        ).withCurrent(
          {
            submissionReference: p.submissionReference,
            actorReference: p.guestSessionReference,
            observedAt,
          },
          async (_tx, facts) => {
            const r = facts.record;
            if (
              String(r.orderReference) !== String(p.orderReference) ||
              String(r.cartReference) !== String(p.sourceCartReference) ||
              r.cartVersion !== p.sourceCartVersion ||
              String(r.quoteReference) !== String(p.quoteReference)
            )
              return unavailable();
            return facts;
          },
        );
        if (!inventory || parseOrderingInstant(options.now()) < observedAt) return unavailable();
        return Object.freeze({ ...paymentFacts, execution, capacity, inventory, observedAt });
      } catch {
        return unavailable();
      }
    },
  });
}
