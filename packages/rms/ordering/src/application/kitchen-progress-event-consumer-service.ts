import {
  consumeEventInTransaction,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";
import {
  orderKitchenProgressEventTypes,
  parseOrderKitchenProgressEnvelope,
  type OrderKitchenProgressEvent,
} from "./kitchen-progress-event.js";

export const orderKitchenProgressConsumerName = "ordering.kitchen-progress:v1";

export interface OrderKitchenProgressConsumerPorts {
  readonly authorization: {
    authorize(transaction: ConsumerTransaction, event: OrderKitchenProgressEvent): Promise<boolean>;
  };
  readonly facts: {
    /**
     * Append the event's facts to Ordering's own record (idempotent per event). Returns false when
     * the Order or item is not (yet) visible in this Store, so the delivery is retried.
     */
    record(transaction: ConsumerTransaction, event: OrderKitchenProgressEvent): Promise<boolean>;
  };
}

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: Ordering's inbox for Kitchen preparation facts. One consumer
 * name with one registration per Kitchen event type; the inbox makes each event apply once and the
 * phase merge is order-independent, so replays and late events never move the phase backwards.
 */
export function createOrderKitchenProgressConsumerService(
  ports: OrderKitchenProgressConsumerPorts,
) {
  const registrations = orderKitchenProgressEventTypes.map((eventType) =>
    Object.freeze<ConsumerRegistration>({
      consumerName: orderKitchenProgressConsumerName,
      consumerVersion: 1,
      eventType,
      schemaVersions: [1],
      ownerModule: "@rms/ordering",
      tenantScope: "store",
      ordering: "none",
      sideEffect: "record-order-kitchen-progress-fact",
      replaySafe: true,
      async handler({ envelope, transaction }) {
        const event = parseOrderKitchenProgressEnvelope(envelope);
        if (event.eventType !== eventType)
          return { status: "rejected" as const, errorCode: "EVENT_TYPE_UNSUPPORTED" as const };
        if (!(await ports.facts.record(transaction, event)))
          return {
            status: "retry_required" as const,
            errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
          };
        return { status: "completed" as const };
      },
    }),
  );
  const byType = new Map(
    registrations.map((registration) => [registration.eventType, registration]),
  );
  return Object.freeze({
    registrations: Object.freeze(registrations),
    async consume(transaction: ConsumerTransaction, envelope: DomainEventEnvelope) {
      const event = parseOrderKitchenProgressEnvelope(envelope);
      const registration = byType.get(event.eventType);
      if (!registration || (await ports.authorization.authorize(transaction, event)) !== true)
        throw new Error("ORDERING_KITCHEN_PROGRESS_DENIED");
      await transaction.query("SAVEPOINT ordering_kitchen_progress_consumer", []);
      try {
        const result = await consumeEventInTransaction(transaction, registration, envelope);
        await transaction.query("RELEASE SAVEPOINT ordering_kitchen_progress_consumer", []);
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT ordering_kitchen_progress_consumer", []);
        await transaction.query("RELEASE SAVEPOINT ordering_kitchen_progress_consumer", []);
        throw error;
      }
    },
  });
}
