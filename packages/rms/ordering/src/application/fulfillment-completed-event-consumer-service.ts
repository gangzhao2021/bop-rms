import { validateOrderFulfillmentCompletionRecord } from "./order-fulfillment-completion-record.js";
import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import type { FulfillmentCompletedEnvelope } from "../contracts/fulfillment-completed-event.js";
import { parseOrderingReference } from "../domain/cart.js";
import {
  OrderStatusProjectionError,
  parseOrderStatusProjection,
} from "../domain/order-status-projection.js";
import { parseFulfillmentCompletedEnvelope } from "./fulfillment-completed-event.js";
import type { FulfillmentCompletedEventConsumerPorts } from "./ports/fulfillment-completed-event-ports.js";

function fail(
  code: "ORDER_STATUS_VERSION_CONFLICT" | "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
): never {
  throw new OrderStatusProjectionError(code);
}
function parseProjection(value: unknown) {
  try {
    return parseOrderStatusProjection(value);
  } catch {
    return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
  }
}

export function createFulfillmentCompletedEventConsumerService(
  ports: FulfillmentCompletedEventConsumerPorts,
) {
  const registration: ConsumerRegistration = {
    consumerName: "ordering.fulfillment-completed:v2",
    consumerVersion: 2,
    eventType: "FulfillmentCompleted",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "commit-fulfillment-and-status-projection",
    replaySafe: true,
    async handler({ envelope, transaction }) {
      const event = parseFulfillmentCompletedEnvelope(envelope);
      const orderReference = parseOrderingReference(event.payload.orderReference);
      const currentValue = await ports.projections
        .load({ orderReference, transaction })
        .catch(() => fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE"));
      if (currentValue === null)
        return {
          status: "retry_required" as const,
          errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
        };
      const current = parseProjection(currentValue);
      const snapshot = current.snapshot;
      if (
        snapshot.orderReference !== orderReference ||
        snapshot.brandReference !== event.tenantId ||
        snapshot.storeReference !== event.storeId ||
        snapshot.orderType !== "Pickup"
      )
        return fail("ORDER_STATUS_VERSION_CONFLICT");
      let completion;
      try {
        const committed = await ports.completions.commit(transaction, event);
        completion = validateOrderFulfillmentCompletionRecord(committed, ports.digests.sha256);
        // Replacing only the event must preserve its digest; no aliased or changed event is accepted.
        validateOrderFulfillmentCompletionRecord(
          { ...completion, sourceEvent: event },
          ports.digests.sha256,
        );
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      if (
        !snapshot.batches.some(
          (batch) => batch.orderBatchReference === completion.orderBatchReference,
        )
      )
        return fail("ORDER_STATUS_VERSION_CONFLICT");
      if (snapshot.fulfillmentStatus === "Completed") {
        if (
          snapshot.canonicalPhase !== "Fulfilled" ||
          snapshot.sourceVersion !== completion.fulfilledOrderVersion ||
          snapshot.sourceCheckpoint !== completion.completionReference ||
          snapshot.sourceDigest !== completion.sourceDigest ||
          snapshot.fulfillmentReference !== event.aggregateId ||
          snapshot.fulfillmentCompletionEventReference !== event.eventId ||
          snapshot.fulfillmentCompletedAt !== event.payload.completedAt
        )
          return fail("ORDER_STATUS_VERSION_CONFLICT");
        return { status: "completed", resultHash: snapshot.sourceDigest.slice(7) };
      }
      if (
        snapshot.sourceVersion > completion.expectedOrderVersion ||
        snapshot.fulfillmentReference !== null ||
        snapshot.fulfillmentCompletionEventReference !== null ||
        snapshot.fulfillmentCompletedAt !== null
      )
        return fail("ORDER_STATUS_VERSION_CONFLICT");
      const sourceDigest = completion.sourceDigest;
      let next;
      try {
        next = parseOrderStatusProjection({
          ...current,
          generationReference: ports.references.generateGeneration(),
          projectedAt: ports.references.now(),
          freshnessStatus: "Fresh",
          snapshot: {
            ...snapshot,
            sourceVersion: completion.fulfilledOrderVersion,
            sourceCheckpoint: completion.completionReference,
            sourceDigest,
            canonicalPhase: "Fulfilled",
            fulfillmentStatus: "Completed",
            fulfillmentReference: event.aggregateId,
            fulfillmentCompletionEventReference: event.eventId,
            fulfillmentCompletedAt: event.payload.completedAt,
          },
        });
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      if (next.projectedAt < completion.recordedAt)
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      const saved = parseProjection(
        await ports.projections
          .replace({ projection: next, envelope: event, transaction })
          .catch(() => fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE")),
      );
      const json = (value: unknown) =>
        JSON.stringify(value, (_key, entry) =>
          typeof entry === "bigint" ? entry.toString() : entry,
        );
      if (json(saved) !== json(next)) return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      return { status: "completed", resultHash: sourceDigest.slice(7) };
    },
  };
  return Object.freeze({
    registration: Object.freeze(registration),
    async consume(transaction: ConsumerTransaction, envelope: FulfillmentCompletedEnvelope) {
      const event = parseFulfillmentCompletedEnvelope(envelope);
      if ((await ports.authorization.authorize(transaction, event)) !== true)
        throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
      await transaction.query("SAVEPOINT ordering_fulfillment_consumer", []);
      try {
        const result = await consumeEventInTransaction(transaction, registration, event);
        await transaction.query("RELEASE SAVEPOINT ordering_fulfillment_consumer", []);
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT ordering_fulfillment_consumer", []);
        await transaction.query("RELEASE SAVEPOINT ordering_fulfillment_consumer", []);
        throw error;
      }
    },
  });
}
