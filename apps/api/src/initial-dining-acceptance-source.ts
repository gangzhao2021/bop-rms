import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderCreationQueryStore,
  createPostgresDiningOrderItemStateReader,
  parseOrderingReference,
  parseOrderingInstant,
} from "@rms/ordering";

const unavailable = (): never => {
  throw new Error("INITIAL_DINING_ACCEPTANCE_SOURCE_UNAVAILABLE");
};

/** Original initial submission and current aggregate are deliberately separate.
 * Both owner readers retain the caller's Order fence through the eventual command.
 */
export function createInitialDiningAcceptanceSource(options: {
  brandReference: string;
  storeReference: string;
  quoteVersion: 1 | 2;
  authorize(
    transaction: ConsumerTransaction,
    identity: {
      orderReference: string;
      orderBatchReference: string;
    },
  ): Promise<boolean>;
}) {
  const scope = {
    brandReference: String(parseOrderingReference(options.brandReference)),
    storeReference: String(parseOrderingReference(options.storeReference)),
  };
  return Object.freeze({
    async resolve(
      transaction: ConsumerTransaction,
      input: {
        orderReference: string;
        orderBatchReference: string;
        submissionReference: string;
        observedAt: string;
      },
    ) {
      const identity = {
        orderReference: String(parseOrderingReference(input.orderReference)),
        orderBatchReference: String(parseOrderingReference(input.orderBatchReference)),
      };
      const submission = String(parseOrderingReference(input.submissionReference));
      const observedAt = parseOrderingInstant(input.observedAt);
      const allowed = (tx: ConsumerTransaction) => options.authorize(tx, identity);
      if (!(await allowed(transaction))) return unavailable();
      const source = createPostgresOrderCreationQueryStore(
        { run: (work) => work(transaction) },
        scope,
        options.quoteVersion,
      );
      const result = await source.withCurrentSubmission(submission, async (_tx, order) => {
        const initial = order.order.batches.find(
          (b) => b.orderBatchReference === identity.orderBatchReference,
        );
        if (
          order.submissionReference !== submission ||
          order.order.orderReference !== identity.orderReference ||
          order.order.brandReference !== scope.brandReference ||
          order.order.storeReference !== scope.storeReference ||
          order.order.orderType !== "DineIn" ||
          order.order.diningSessionReference === null ||
          !initial ||
          initial.submissionReference !== submission ||
          initial.submittedAt > observedAt ||
          order.createdAt > observedAt
        )
          return unavailable();
        const current = await createPostgresDiningOrderItemStateReader({
          ...scope,
          authorize: allowed,
        }).load({
          transaction,
          ...scope,
          orderReference: identity.orderReference,
          diningSessionReference: order.order.diningSessionReference,
          guestSessionReference: order.guestSessionReference,
          observedAt,
        });
        if (
          !current ||
          current.orderReference !== identity.orderReference ||
          current.brandReference !== scope.brandReference ||
          current.storeReference !== scope.storeReference ||
          current.diningSessionReference !== order.order.diningSessionReference
        )
          return unavailable();
        const batch = current.batches.find(
          (b) => b.orderBatchReference === identity.orderBatchReference,
        );
        if (!batch || batch.sequence !== 1 || !(await allowed(transaction))) return unavailable();
        return Object.freeze({ order, current, batch, observedAt });
      });
      return result ?? unavailable();
    },
  });
}
