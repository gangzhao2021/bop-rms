import { createInitialDiningAcceptanceSource } from "./initial-dining-acceptance-source.js";
import { readOrderPaidCapacity } from "./order-paid-capacity-source.js";
import { createPostgresSubmissionFinalValidationStore } from "@rms/inventory";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createPostgresOrderAcceptanceReader,
  createPostgresOrderInitialExecutionReader,
  createPostgresOrderCreationQueryStore,
  parseOrderingReference,
  parseOrderingInstant,
  OrderPaymentOutcomeError,
} from "@rms/ordering";
import { createOrderCapturedPaymentSource } from "./order-captured-payment-source.js";

const unavailable = (): never => {
  throw new OrderPaymentOutcomeError("ORDER_PAYMENT_OUTCOME_SOURCE_UNAVAILABLE");
};

/** Internal original Order/Payment/acceptance history; current fulfillment must still be established. */
export function createOrderPaidContextSource(
  options: Parameters<typeof createOrderCapturedPaymentSource>[0] & {
    /** Initial Dining acceptance/release callers opt into current batch execution. */
    currentDiningAcceptance?: boolean;
    quoteVersion: 1 | 2;
    tenantReference: string;
    authorizeInventory: Parameters<
      typeof createPostgresSubmissionFinalValidationStore
    >[2]["authorize"];
    authorizeOrder: Parameters<typeof createPostgresOrderAcceptanceReader>[0]["authorize"];
  },
) {
  const scope = Object.freeze({
    brandReference: String(parseOrderingReference(options.scope.brandReference)),
    storeReference: String(parseOrderingReference(options.scope.storeReference)),
  });
  const tenantReference = String(parseOrderingReference(options.tenantReference));
  const captured = createOrderCapturedPaymentSource(options);
  const acceptanceReader = createPostgresOrderAcceptanceReader({
    ...scope,
    authorize: options.authorizeOrder,
  });
  const executionReader = createPostgresOrderInitialExecutionReader({
    ...scope,
    authorize: options.authorizeOrder,
  });
  const quoteVersion = options.quoteVersion;
  return Object.freeze({
    async resolve(transaction: ConsumerTransaction, event: unknown) {
      try {
        const startedAt = parseOrderingInstant(options.now());
        const paymentFacts = await captured.resolve(transaction, event);
        const preparation = paymentFacts.payment.intent.preparation;
        const acceptance = await acceptanceReader.loadByBatch({
          transaction,
          orderReference: preparation.orderReference,
          orderBatchReference: preparation.orderBatchReference,
        });
        const reader = createPostgresOrderCreationQueryStore(
          { run: async (work) => work(transaction) },
          scope,
          quoteVersion,
        );
        const result = await reader.withCurrentSubmission(
          preparation.submissionReference,
          async (_, order) => {
            const batch = order.order.batches.find(
              (candidate) => candidate.orderBatchReference === preparation.orderBatchReference,
            );
            if (
              !batch ||
              order.order.orderReference !== preparation.orderReference ||
              order.guestSessionReference !== preparation.guestSessionReference ||
              batch.submissionReference !== preparation.submissionReference ||
              batch.sourceCartReference !== preparation.sourceCartReference ||
              batch.sourceCartVersion !== preparation.sourceCartVersion ||
              batch.quoteReference !== preparation.quoteReference
            )
              return unavailable();
            const currentDining =
              options.currentDiningAcceptance === true && order.order.orderType === "DineIn"
                ? await createInitialDiningAcceptanceSource({
                    ...scope,
                    quoteVersion,
                    authorize: (tx, identity) =>
                      options.authorizeOrder(tx, { ...scope, ...identity }),
                  }).resolve(transaction, {
                    orderReference: preparation.orderReference,
                    orderBatchReference: preparation.orderBatchReference,
                    submissionReference: preparation.submissionReference,
                    observedAt: options.now(),
                  })
                : null;
            const cancellation = currentDining?.batch.cancellation;
            const initialExecution = currentDining
              ? Object.freeze({
                  brandReference: parseOrderingReference(scope.brandReference),
                  storeReference: parseOrderingReference(scope.storeReference),
                  orderReference: preparation.orderReference,
                  orderBatchReference: preparation.orderBatchReference,
                  phase: cancellation
                    ? ("Cancelled" as const)
                    : acceptance
                      ? ("Accepted" as const)
                      : ("Submitted" as const),
                  version:
                    cancellation?.cancelledOrderVersion ?? acceptance?.acceptedOrderVersion ?? 1,
                  checkpoint:
                    cancellation?.cancellationReference ??
                    acceptance?.acceptanceReference ??
                    order.submissionReference,
                  occurredAt:
                    cancellation?.cancelledAt ?? acceptance?.acceptedAt ?? batch.submittedAt,
                })
              : await executionReader.loadByBatch({
                  transaction,
                  orderReference: preparation.orderReference,
                  orderBatchReference: preparation.orderBatchReference,
                });
            const observedAt = parseOrderingInstant(options.now());
            if (
              observedAt < startedAt ||
              initialExecution.occurredAt > observedAt ||
              (acceptance !== null && acceptance.acceptedAt > observedAt)
            )
              return unavailable();
            if (initialExecution.phase === "Cancelled" || initialExecution.phase === "Rejected")
              return Object.freeze({
                ...paymentFacts,
                order,
                acceptance,
                initialExecution,
                currentDining,
                observedAt,
                capacity: null,
                inventory: null,
              });
            const capacity = await readOrderPaidCapacity(
              transaction,
              { ...scope, tenantReference },
              paymentFacts.payment,
              order.order.orderType,
              observedAt,
            );
            const inventoryStore = createPostgresSubmissionFinalValidationStore(
              { run: async (work) => work(transaction) },
              { ...scope, tenantReference },
              {
                authorize: options.authorizeInventory,
                resolveCurrent: async () => unavailable(),
              },
            );
            const inventory = await inventoryStore.withCurrent(
              {
                submissionReference: preparation.submissionReference,
                actorReference: preparation.guestSessionReference,
                observedAt,
              },
              async (_, facts) => {
                const original = facts.record;
                if (
                  String(original.orderReference) !== String(preparation.orderReference) ||
                  String(original.cartReference) !== String(preparation.sourceCartReference) ||
                  original.cartVersion !== preparation.sourceCartVersion ||
                  String(original.quoteReference) !== String(preparation.quoteReference)
                )
                  return unavailable();
                return facts;
              },
            );
            if (inventory === null || parseOrderingInstant(options.now()) < observedAt)
              return unavailable();
            return Object.freeze({
              ...paymentFacts,
              order,
              acceptance,
              initialExecution,
              currentDining,
              capacity,
              inventory,
              observedAt,
            });
          },
        );
        return result ?? unavailable();
      } catch {
        return unavailable();
      }
    },
  });
}
