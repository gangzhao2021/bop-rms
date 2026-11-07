import { loadOutboxEnvelope } from "@bop/eventing";
import {
  createOrderCreatedEventConsumerService,
  parseOrderCreatedEnvelope,
  createPostgresOrderCreationQueryStore,
  createPostgresOrderStatusProjectionStore,
  createPostgresOrderExecutionReader,
  createOrderStatusCreationSource,
  OrderStatusProjectionError,
  type OrderCreatedEventConsumerPorts,
} from "@rms/ordering";

/** Original event source and current freshness through public owner contracts in one transaction. */
export function createOrderCreatedProjectionComposition(options: {
  scope: Readonly<{ brandReference: string; storeReference: string }>;
  quoteVersion: 1 | 2;
  locale: string;
  sha256(value: string): string;
  authorization: OrderCreatedEventConsumerPorts["authorization"];
  projections: OrderCreatedEventConsumerPorts["projections"];
  references: OrderCreatedEventConsumerPorts["references"];
}) {
  const scope = Object.freeze({ ...options.scope });
  return createOrderCreatedEventConsumerService({
    authorization: {
      authorize: async (transaction, event) =>
        event.tenantId === scope.brandReference &&
        event.storeId === scope.storeReference &&
        (await options.authorization.authorize(transaction, event)) === true,
    },
    projections: options.projections,
    references: options.references,
    source: {
      loadExact: async (input) => {
        const source = createPostgresOrderCreationQueryStore(
          { run: async (work) => work(input.transaction) },
          scope,
          options.quoteVersion,
        );
        return source.withCurrentSubmission(
          input.envelope.payload.submissionReference,
          async (_, record) =>
            createOrderStatusCreationSource({
              record,
              quoteVersion: options.quoteVersion,
              envelope: input.envelope,
              locale: options.locale,
              sha256: options.sha256,
            }),
        );
      },
      freshness: async (transaction, snapshot) => {
        const batch = snapshot.batches[0];
        if (!batch) throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
        const state = await createPostgresOrderExecutionReader({
          ...scope,
          sha256: options.sha256,
          // Internal call follows current event authorization and projection's owner fence.
          authorize: async () => true,
        }).loadByBatch({
          transaction,
          orderReference: snapshot.orderReference,
          orderBatchReference: batch.orderBatchReference,
        });
        return state.version === snapshot.sourceVersion && state.phase === snapshot.canonicalPhase
          ? "Fresh"
          : "Stale";
      },
    },
  });
}

/** Durable composition for either order type; verifies generation content against owner history. */
export function createPersistedOrderCreatedProjectionComposition(
  options: Omit<Parameters<typeof createOrderCreatedProjectionComposition>[0], "projections">,
) {
  const equal = (value: unknown) =>
    JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));
  const projections = createPostgresOrderStatusProjectionStore({
    ...options.scope,
    // This store is private to the consumer, whose entry authorizes before every load.
    authorize: async (_transaction, scope) =>
      scope.brandReference === options.scope.brandReference &&
      scope.storeReference === options.scope.storeReference,
    validateCurrentSource: async (transaction, candidate) => {
      const envelope = await loadOutboxEnvelope(transaction, candidate.snapshot.sourceCheckpoint);
      if (!envelope || envelope.eventType !== "OrderCreated") return false;
      const event = parseOrderCreatedEnvelope(envelope);
      if (!(await options.authorization.authorize(transaction, event))) return false;
      const source = createPostgresOrderCreationQueryStore(
        { run: async (work) => work(transaction) },
        options.scope,
        options.quoteVersion,
      );
      const snapshot = await source.withCurrentSubmission(
        event.payload.submissionReference,
        async (_tx, record) =>
          createOrderStatusCreationSource({
            record,
            quoteVersion: options.quoteVersion,
            envelope: event,
            locale: options.locale,
            sha256: options.sha256,
          }),
      );
      if (snapshot === null) return false;
      const batch = snapshot.batches[0];
      if (!batch) return false;
      const state = await createPostgresOrderExecutionReader({
        ...options.scope,
        sha256: options.sha256,
        authorize: async () => true,
      }).loadByBatch({
        transaction,
        orderReference: snapshot.orderReference,
        orderBatchReference: batch.orderBatchReference,
      });
      const freshness =
        state.version === snapshot.sourceVersion && state.phase === snapshot.canonicalPhase
          ? "Fresh"
          : "Stale";
      return (
        equal(candidate.snapshot) === equal(snapshot) && candidate.freshnessStatus === freshness
      );
    },
  });
  return createOrderCreatedProjectionComposition({ ...options, projections });
}
