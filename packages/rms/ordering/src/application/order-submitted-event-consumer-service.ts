import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";

import type { OrderSubmittedEnvelope } from "./order-submitted-event.js";
import { parseOrderSubmittedEnvelope } from "./order-submitted-event.js";
import { parseOrderingReference } from "../domain/cart.js";
import {
  buildOrderStatusProjection,
  OrderStatusProjectionError,
  parseOrderStatusProjection,
  parseOrderStatusSourceSnapshot,
} from "../domain/order-status-projection.js";
import type { OrderSubmittedEventConsumerPorts } from "./ports/order-submitted-event-ports.js";

function dependency(): never {
  throw new OrderStatusProjectionError("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
}

function parseSource(value: unknown) {
  try {
    return parseOrderStatusSourceSnapshot(value);
  } catch {
    return dependency();
  }
}

function parseProjection(value: unknown) {
  try {
    return parseOrderStatusProjection(value);
  } catch {
    return dependency();
  }
}

function eventBindingMatches(
  projection: ReturnType<typeof parseOrderStatusProjection>,
  event: OrderSubmittedEnvelope,
): boolean {
  const snapshot = projection.snapshot;
  const firstBatch = snapshot.batches[event.payload.batchSequence - 1];
  const itemCount = firstBatch?.items.length;
  return (
    snapshot.orderReference === event.aggregateId &&
    snapshot.brandReference === event.tenantId &&
    snapshot.storeReference === event.storeId &&
    snapshot.sourceVersion === Number(event.aggregateVersion) &&
    snapshot.sourceCheckpoint === event.eventId &&
    snapshot.sourceDigest === event.payload.sourceSnapshotDigest &&
    snapshot.batches.length === event.payload.batchSequence &&
    firstBatch?.submittedAt === event.occurredAt &&
    firstBatch?.orderBatchReference === event.payload.orderBatchReference &&
    itemCount === event.payload.itemCount
  );
}

export function createOrderSubmittedEventConsumerService(ports: OrderSubmittedEventConsumerPorts) {
  const registration: ConsumerRegistration = {
    consumerName: "ordering.order-status-projection:v1",
    consumerVersion: 1,
    eventType: "OrderSubmitted",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "replace-order-status-projection",
    replaySafe: true,
    async handler({ envelope, transaction }) {
      const event = parseOrderSubmittedEnvelope(envelope);
      const orderReference = parseOrderingReference(event.aggregateId);
      const currentValue = await ports.projections
        .load({ orderReference, transaction })
        .catch(dependency);
      const current = currentValue === null ? null : parseProjection(currentValue);
      const eventVersion = Number(event.aggregateVersion);
      if (
        current &&
        (current.snapshot.orderReference !== orderReference ||
          current.snapshot.brandReference !== event.tenantId ||
          current.snapshot.storeReference !== event.storeId)
      )
        return dependency();
      if (current && current.snapshot.sourceVersion > eventVersion)
        return { status: "completed", resultHash: current.snapshot.sourceDigest.slice(7) };
      if (current && current.snapshot.sourceVersion === eventVersion) {
        if (!eventBindingMatches(current, event))
          throw new OrderStatusProjectionError("ORDER_STATUS_VERSION_CONFLICT");
        return { status: "completed", resultHash: current.snapshot.sourceDigest.slice(7) };
      }
      const sourceValue = await ports.source
        .loadExact({
          transaction,
          envelope: event,
          brandReference: parseOrderingReference(event.tenantId),
          storeReference: parseOrderingReference(event.storeId),
          orderReference,
          sourceVersion: eventVersion,
          sourceCheckpoint: parseOrderingReference(event.eventId),
          sourceDigest: event.payload.sourceSnapshotDigest,
        })
        .catch(dependency);
      if (sourceValue === null)
        return {
          status: "retry_required" as const,
          errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
        };
      const source = parseSource(sourceValue);
      const firstBatch = source.batches[event.payload.batchSequence - 1];
      const itemCount = firstBatch?.items.length;
      if (
        source.orderReference !== orderReference ||
        source.brandReference !== event.tenantId ||
        source.storeReference !== event.storeId ||
        source.sourceVersion !== eventVersion ||
        source.sourceCheckpoint !== event.eventId ||
        source.sourceDigest !== event.payload.sourceSnapshotDigest ||
        source.batches.length !== event.payload.batchSequence ||
        firstBatch?.submittedAt !== event.occurredAt ||
        firstBatch?.orderBatchReference !== event.payload.orderBatchReference ||
        itemCount !== event.payload.itemCount
      )
        return dependency();
      let projection;
      try {
        projection = parseOrderStatusProjection({
          ...buildOrderStatusProjection({
            source,
            generationReference: ports.references.generateGeneration(),
            projectedAt: ports.references.now(),
          }),
          freshnessStatus: await ports.source.freshness(transaction, source),
        });
      } catch {
        return dependency();
      }
      const savedValue = await ports.projections
        .replace({ projection, envelope: event, transaction })
        .catch(dependency);
      const saved = parseProjection(savedValue);
      if (
        saved.snapshot.orderReference !== orderReference ||
        saved.snapshot.sourceCheckpoint !== event.eventId ||
        saved.snapshot.sourceDigest !== event.payload.sourceSnapshotDigest
      )
        return dependency();
      return { status: "completed", resultHash: source.sourceDigest.slice(7) };
    },
  };
  return Object.freeze({
    registration: Object.freeze(registration),
    async consume(transaction: ConsumerTransaction, envelope: OrderSubmittedEnvelope) {
      const event = parseOrderSubmittedEnvelope(envelope);
      if ((await ports.authorization.authorize(transaction, event)) !== true)
        throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
      const currentValue = await ports.projections
        .load({ orderReference: parseOrderingReference(event.aggregateId), transaction })
        .catch(dependency);
      if (currentValue !== null) {
        const current = parseProjection(currentValue);
        if (
          current.snapshot.sourceCheckpoint === event.eventId &&
          !eventBindingMatches(current, event)
        )
          throw new OrderStatusProjectionError("ORDER_STATUS_VERSION_CONFLICT");
      }
      await transaction.query("SAVEPOINT ordering_submitted_projection_consumer", []);
      try {
        const result = await consumeEventInTransaction(transaction, registration, event);
        if ((await ports.authorization.authorize(transaction, event)) !== true)
          throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
        await transaction.query("RELEASE SAVEPOINT ordering_submitted_projection_consumer", []);
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT ordering_submitted_projection_consumer", []);
        await transaction.query("RELEASE SAVEPOINT ordering_submitted_projection_consumer", []);
        throw error;
      }
    },
  });
}
