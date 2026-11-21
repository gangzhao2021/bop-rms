import { createHash } from "node:crypto";
import { createPersistedOrderCreatedProjectionComposition } from "../../apps/api/dist/order-created-projection-composition.js";
import {
  createPostgresOrderStatusProjectionStore,
  createPostgresOrderExecutionReader,
  createFulfillmentCompletedEventConsumerService,
  createOrderCancelledEventConsumerService,
  loadOrderBatchCheckoutCancellation,
  orderBatchCheckoutCancellationDigest,
  orderCancelledEventMatchesRecord,
  parseOrderStatusProjection,
} from "../../packages/rms/ordering/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export async function createInternalOrderStatus(resources, { createCompletion }) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_STATUS_ONLY");
  const scope = resources.scope,
    hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const authorized = async (_tx, event) =>
    active() && event.tenantId === scope.brandReference && event.storeId === scope.storeReference;
  const references = { generateGeneration: resources.credentials.reference, now: resources.now };
  const created = createPersistedOrderCreatedProjectionComposition({
    scope,
    quoteVersion: 2,
    locale: "en-CA",
    sha256: hash,
    authorization: { authorize: authorized },
    references,
  });
  const completion = await createCompletion(resources);
  const reader = createPostgresOrderStatusProjectionStore({
    ...scope,
    authorize: async () => active(),
    validateCurrentSource: async () => false,
  });
  const equal = (value) =>
    JSON.stringify(value, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const projections = createPostgresOrderStatusProjectionStore({
    ...scope,
    authorize: async () => active(),
    validateCurrentSource: async (transaction, candidate) => {
      const baseline = await reader.load({
        transaction,
        orderReference: candidate.snapshot.orderReference,
      });
      if (!baseline || baseline.snapshot.batches.length !== 1) return false;
      const state = await createPostgresOrderExecutionReader({
        ...scope,
        sha256: hash,
        authorize: async () => active(),
      }).loadByBatch({
        transaction,
        orderReference: candidate.snapshot.orderReference,
        orderBatchReference: baseline.snapshot.batches[0].orderBatchReference,
      });
      if (!state.completion) return false;
      const r = state.completion,
        event = r.sourceEvent;
      const expected = parseOrderStatusProjection({
        ...candidate,
        snapshot: {
          ...baseline.snapshot,
          sourceVersion: r.fulfilledOrderVersion,
          sourceCheckpoint: r.completionReference,
          sourceDigest: r.sourceDigest,
          canonicalPhase: "Fulfilled",
          fulfillmentStatus: "Completed",
          fulfillmentReference: event.aggregateId,
          fulfillmentCompletionEventReference: event.eventId,
          fulfillmentCompletedAt: event.payload.completedAt,
        },
      });
      return (
        candidate.freshnessStatus === "Fresh" &&
        candidate.projectedAt >= r.recordedAt &&
        equal(candidate.snapshot) === equal(expected.snapshot)
      );
    },
  });
  const completed = createFulfillmentCompletedEventConsumerService({
    authorization: { authorize: authorized },
    completions: { commit: async (tx, event) => (await completion.consume(tx, event)).record },
    projections,
    references,
    digests: { sha256: hash },
  });
  // WP-2423: an unpaid dine-in round the System cancelled advances the projection to the
  // cancellation's Order version; phase and rounds stay as they were (shown from the record).
  const cancelledProjections = createPostgresOrderStatusProjectionStore({
    ...scope,
    authorize: async () => active(),
    validateCurrentSource: async (transaction, candidate) => {
      const baseline = await reader.load({
        transaction,
        orderReference: candidate.snapshot.orderReference,
      });
      if (!baseline || baseline.snapshot.sourceVersion >= candidate.snapshot.sourceVersion)
        return false;
      const record = await loadOrderBatchCheckoutCancellation(
        transaction,
        scope,
        candidate.snapshot.sourceCheckpoint,
      );
      if (
        record === null ||
        record.orderReference !== candidate.snapshot.orderReference ||
        record.cancelledOrderVersion !== candidate.snapshot.sourceVersion ||
        orderBatchCheckoutCancellationDigest(record) !== candidate.snapshot.sourceDigest
      )
        return false;
      return (
        candidate.freshnessStatus === "Fresh" &&
        equal(candidate.snapshot) ===
          equal({
            ...baseline.snapshot,
            sourceVersion: candidate.snapshot.sourceVersion,
            sourceCheckpoint: candidate.snapshot.sourceCheckpoint,
            sourceDigest: candidate.snapshot.sourceDigest,
          })
      );
    },
  });
  const cancelled = createOrderCancelledEventConsumerService({
    authorization: { authorize: authorized },
    cancellations: {
      matches: (transaction, event) => orderCancelledEventMatchesRecord(transaction, scope, event),
    },
    projections: cancelledProjections,
    references,
  });
  return { created, completed, cancelled, reader };
}
