import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import type { FulfillmentCompletedEnvelope } from "../contracts/fulfillment-completed-event.js";
import { parseOrderingHash, parseOrderingReference } from "../domain/cart.js";
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
function binding(event: FulfillmentCompletedEnvelope): string {
  return [
    "FulfillmentCompleted:v1",
    event.eventId,
    event.tenantId,
    event.storeId,
    event.aggregateId,
    event.aggregateVersion.toString(),
    event.payload.orderReference,
    event.payload.handoffRecordReference,
    event.payload.verificationMethod,
    event.payload.completedAt,
  ].join("|");
}

export function createFulfillmentCompletedEventConsumerService(
  ports: FulfillmentCompletedEventConsumerPorts,
) {
  const registration: ConsumerRegistration = {
    consumerName: "ordering.fulfillment-completed:v1",
    consumerVersion: 1,
    eventType: "FulfillmentCompleted",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "advance Ordering Order Status projection to Fulfilled",
    replaySafe: true,
    async handler({ envelope, transaction }) {
      const event = parseFulfillmentCompletedEnvelope(envelope);
      const orderReference = parseOrderingReference(event.payload.orderReference);
      const currentValue = await ports.projections
        .load(orderReference)
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
      if (snapshot.fulfillmentStatus === "Completed") {
        if (
          snapshot.canonicalPhase !== "Fulfilled" ||
          snapshot.fulfillmentReference !== event.aggregateId ||
          snapshot.fulfillmentCompletionEventReference !== event.eventId ||
          snapshot.fulfillmentCompletedAt !== event.payload.completedAt
        )
          return fail("ORDER_STATUS_VERSION_CONFLICT");
        return { status: "completed", resultHash: snapshot.sourceDigest.slice(7) };
      }
      if (
        snapshot.fulfillmentReference !== null ||
        snapshot.fulfillmentCompletionEventReference !== null ||
        snapshot.fulfillmentCompletedAt !== null
      )
        return fail("ORDER_STATUS_VERSION_CONFLICT");
      let sourceDigest: string;
      try {
        sourceDigest = parseOrderingHash(ports.digests.sha256(binding(event)));
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      let next;
      try {
        next = parseOrderStatusProjection({
          ...current,
          generationReference: ports.references.generateGeneration(),
          projectedAt: ports.references.now(),
          freshnessStatus: "Fresh",
          snapshot: {
            ...snapshot,
            sourceVersion: snapshot.sourceVersion + 1,
            sourceCheckpoint: event.eventId,
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
      const saved = parseProjection(
        await ports.projections
          .replace({ projection: next, envelope: event, transaction })
          .catch(() => fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE")),
      );
      if (
        saved.snapshot.sourceCheckpoint !== event.eventId ||
        saved.snapshot.fulfillmentReference !== event.aggregateId ||
        saved.snapshot.canonicalPhase !== "Fulfilled"
      )
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      return { status: "completed", resultHash: sourceDigest.slice(7) };
    },
  };
  return Object.freeze({
    registration: Object.freeze(registration),
    async consume(transaction: ConsumerTransaction, envelope: FulfillmentCompletedEnvelope) {
      return await consumeEventInTransaction(
        transaction,
        registration,
        parseFulfillmentCompletedEnvelope(envelope),
      );
    },
  });
}
