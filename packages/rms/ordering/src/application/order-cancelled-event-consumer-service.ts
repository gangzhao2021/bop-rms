import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
} from "@bop/eventing";
import {
  parseOrderingReference,
  type OrderingInstant,
  type OrderingReference,
} from "../domain/cart.js";
import {
  OrderStatusProjectionError,
  parseOrderStatusProjection,
  type OrderStatusProjection,
} from "../domain/order-status-projection.js";
import {
  parseOrderCancelledEnvelope,
  type OrderCancelledEnvelope,
} from "./order-cancelled-event.js";

export interface OrderCancelledEventConsumerPorts {
  readonly authorization: {
    authorize(transaction: ConsumerTransaction, envelope: OrderCancelledEnvelope): Promise<boolean>;
  };
  /** The append-only cancellation behind the event, re-read in this transaction. */
  readonly cancellations: {
    matches(transaction: ConsumerTransaction, envelope: OrderCancelledEnvelope): Promise<boolean>;
  };
  readonly projections: {
    load(input: {
      readonly orderReference: OrderingReference;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection | null>;
    replace(input: {
      readonly projection: OrderStatusProjection;
      readonly envelope: OrderCancelledEnvelope;
      readonly transaction: ConsumerTransaction;
    }): Promise<OrderStatusProjection>;
  };
  readonly references: { generateGeneration(): OrderingReference; now(): OrderingInstant };
}

function fail(
  code: "ORDER_STATUS_VERSION_CONFLICT" | "ORDER_STATUS_DEPENDENCY_UNAVAILABLE",
): never {
  throw new OrderStatusProjectionError(code);
}
const json = (value: unknown) =>
  JSON.stringify(value, (_key, entry) => (typeof entry === "bigint" ? entry.toString() : entry));

/**
 * WP-2423: the customer order status projection records the Order version and checkpoint of an
 * unpaid round's System cancellation. Phase and rounds are unchanged by design
 * (DEC-PILOT-BATCH-PHASE-01: cancellation authority stays in owner history; the cancelled round is
 * shown from Ordering's cancellation record). A later round's `OrderSubmitted` rebuilds from the
 * full history as before.
 */
export function createOrderCancelledEventConsumerService(ports: OrderCancelledEventConsumerPorts) {
  const registration: ConsumerRegistration = {
    consumerName: "ordering.order-status-projection:v1",
    consumerVersion: 1,
    eventType: "OrderCancelled",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "advance-order-status-projection",
    replaySafe: true,
    async handler({ envelope, transaction }) {
      const event = parseOrderCancelledEnvelope(envelope);
      const orderReference = parseOrderingReference(event.aggregateId);
      const version = Number(event.aggregateVersion);
      let currentValue;
      try {
        currentValue = await ports.projections.load({ orderReference, transaction });
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      if (currentValue === null)
        return {
          status: "retry_required" as const,
          errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
        };
      let current;
      try {
        current = parseOrderStatusProjection(currentValue);
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      const snapshot = current.snapshot;
      if (
        snapshot.orderReference !== orderReference ||
        snapshot.brandReference !== event.tenantId ||
        snapshot.storeReference !== event.storeId ||
        snapshot.orderType !== "DineIn"
      )
        return fail("ORDER_STATUS_VERSION_CONFLICT");
      if ((await ports.cancellations.matches(transaction, event)) !== true)
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      if (snapshot.sourceVersion === version) {
        if (
          snapshot.sourceCheckpoint !== event.payload.cancellationReference ||
          snapshot.sourceDigest !== event.payload.sourceDigest
        )
          return fail("ORDER_STATUS_VERSION_CONFLICT");
        return { status: "completed", resultHash: snapshot.sourceDigest.slice(7) };
      }
      // A later round already rebuilt the projection from history that includes this cancellation.
      if (snapshot.sourceVersion > version)
        return { status: "completed", resultHash: snapshot.sourceDigest.slice(7) };
      let next;
      try {
        next = parseOrderStatusProjection({
          ...current,
          generationReference: ports.references.generateGeneration(),
          projectedAt: ports.references.now(),
          freshnessStatus: "Fresh",
          snapshot: {
            ...snapshot,
            sourceVersion: version,
            sourceCheckpoint: event.payload.cancellationReference,
            sourceDigest: event.payload.sourceDigest,
          },
        });
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      if (next.projectedAt < current.projectedAt)
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      let saved;
      try {
        saved = parseOrderStatusProjection(
          await ports.projections.replace({ projection: next, envelope: event, transaction }),
        );
      } catch {
        return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      }
      if (json(saved) !== json(next)) return fail("ORDER_STATUS_DEPENDENCY_UNAVAILABLE");
      return { status: "completed", resultHash: event.payload.sourceDigest.slice(7) };
    },
  };
  return Object.freeze({
    registration: Object.freeze(registration),
    async consume(transaction: ConsumerTransaction, envelope: unknown) {
      const event = parseOrderCancelledEnvelope(envelope);
      if ((await ports.authorization.authorize(transaction, event)) !== true)
        throw new OrderStatusProjectionError("ORDER_STATUS_PERMISSION_DENIED");
      await transaction.query("SAVEPOINT ordering_cancelled_projection_consumer", []);
      try {
        const result = await consumeEventInTransaction(transaction, registration, event);
        await transaction.query("RELEASE SAVEPOINT ordering_cancelled_projection_consumer", []);
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT ordering_cancelled_projection_consumer", []);
        await transaction.query("RELEASE SAVEPOINT ordering_cancelled_projection_consumer", []);
        throw error;
      }
    },
  });
}
