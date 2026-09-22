import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresAdditionalDiningBatchHistoryReader } from "./additional-dining-batch-store.js";
import { createPostgresDiningOrderItemStateReader } from "./dining-order-item-state-reader.js";
import { parseOrderingReference, parseOrderingInstant } from "../../domain/cart.js";
import { AdditionalDiningBatchStoreError } from "./additional-dining-batch-store.js";

type HistoryOptions = Parameters<typeof createPostgresAdditionalDiningBatchHistoryReader>[0];

/** Current pre-kitchen Additional execution. Order version and this Batch's
 * acceptance are separate facts; another Batch's acceptance never accepts this one.
 * Caller retains the transaction/disposition fence through outcome commit.
 */
export function createPostgresAdditionalDiningExecutionReader(
  options: Omit<HistoryOptions, "transactions">,
) {
  const brandReference = parseOrderingReference(options.brandReference);
  const storeReference = parseOrderingReference(options.storeReference);
  return Object.freeze({
    async loadBySubmission(input: {
      transaction: ConsumerTransaction;
      submissionReference: string;
      observedAt: string;
    }) {
      const submissionReference = parseOrderingReference(input.submissionReference);
      const observedAt = parseOrderingInstant(input.observedAt);
      const scope = { brandReference, storeReference, submissionReference };
      const authorize = (tx: ConsumerTransaction) => options.authorize(tx, scope);
      const history = createPostgresAdditionalDiningBatchHistoryReader({
        ...scope,
        authorize,
        transactions: { run: (work) => work(input.transaction) },
      });
      return history.withCurrentSubmission(
        submissionReference,
        observedAt,
        async (transaction, snapshot, link) => {
          const current = await createPostgresDiningOrderItemStateReader({
            brandReference,
            storeReference,
            authorize,
          }).load({
            transaction,
            brandReference,
            storeReference,
            orderReference: snapshot.orderReference,
            diningSessionReference: snapshot.diningSessionReference,
            guestSessionReference: snapshot.guestSessionReference,
            observedAt,
          });
          if (!current) return null;
          const batch = current.batches.find(
            (value) => value.orderBatchReference === snapshot.batch.orderBatchReference,
          );
          if (!batch) throw new AdditionalDiningBatchStoreError();
          const { acceptance, cancellation } = batch;
          const appendedVersion = snapshot.expectedOrderVersion + 1;
          if (
            acceptance &&
            (acceptance.expectedOrderVersion < appendedVersion ||
              acceptance.acceptedOrderVersion > current.orderVersion ||
              acceptance.acceptedAt < snapshot.batch.submittedAt ||
              acceptance.acceptedAt > observedAt)
          )
            throw new AdditionalDiningBatchStoreError();
          if (
            cancellation &&
            (acceptance !== null ||
              cancellation.submissionReference !== snapshot.batch.submissionReference ||
              cancellation.expectedOrderVersion < appendedVersion ||
              cancellation.cancelledOrderVersion > current.orderVersion ||
              cancellation.cancelledAt < snapshot.batch.submittedAt ||
              cancellation.cancelledAt > observedAt)
          )
            throw new AdditionalDiningBatchStoreError();
          if ((await authorize(transaction)) !== true) throw new AdditionalDiningBatchStoreError();
          return Object.freeze({
            snapshot,
            link,
            acceptance,
            cancellation,
            orderVersion: current.orderVersion,
            canonicalPhase: current.canonicalPhase,
            batchPhase: cancellation
              ? ("Cancelled" as const)
              : acceptance
                ? ("Accepted" as const)
                : ("Submitted" as const),
            batchVersion:
              cancellation?.cancelledOrderVersion ??
              acceptance?.acceptedOrderVersion ??
              appendedVersion,
            batchCheckpoint:
              cancellation?.cancellationReference ??
              acceptance?.acceptanceReference ??
              snapshot.batch.submissionReference,
            batchOccurredAt:
              cancellation?.cancelledAt ?? acceptance?.acceptedAt ?? snapshot.batch.submittedAt,
            observedAt,
          });
        },
      );
    },
  });
}
