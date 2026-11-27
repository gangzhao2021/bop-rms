import {
  consumeEventInTransaction,
  validateDomainEventEnvelope,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { parseOrderingInstant, parseOrderingReference } from "../domain/cart.js";

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: Ordering's reading of Fulfillment's published
 * PickupNotCollected event (no Fulfillment import). Only the Order, Fulfillment and closure
 * references and the closure time are kept; no actor.
 */
export const orderPickupNotCollectedConsumerName = "ordering.pickup-not-collected:v1";
export const orderPickupNotCollectedEventType = "PickupNotCollected" as const;

export interface OrderPickupNotCollectedEvent {
  readonly eventId: string;
  readonly brandReference: string;
  readonly storeReference: string;
  readonly orderReference: string;
  readonly fulfillmentReference: string;
  readonly notCollectedReference: string;
  readonly closedAt: string;
}

export class OrderPickupNotCollectedEventError extends Error {
  readonly code = "ORDERING_PICKUP_NOT_COLLECTED_EVENT_INVALID" as const;
  constructor() {
    super("pickup not collected event is invalid");
    this.name = "OrderPickupNotCollectedEventError";
  }
}
function invalid(): never {
  throw new OrderPickupNotCollectedEventError();
}

const payloadFields = [
  "fulfillmentReference",
  "orderReference",
  "notCollectedReference",
  "storeReference",
  "readyAt",
  "closedAt",
] as const;

export function parseOrderPickupNotCollectedEnvelope(value: unknown): OrderPickupNotCollectedEvent {
  try {
    const envelope = validateDomainEventEnvelope(value as DomainEventEnvelope);
    const payload = envelope.payload as unknown;
    if (
      envelope.eventType !== orderPickupNotCollectedEventType ||
      envelope.schemaVersion !== 1 ||
      envelope.producerModule !== "@rms/fulfillment" ||
      envelope.aggregateType !== "Fulfillment" ||
      envelope.storeId === undefined ||
      payload === null ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.getPrototypeOf(payload) !== Object.prototype
    )
      return invalid();
    const raw = payload as Readonly<Record<string, unknown>>;
    const keys = Reflect.ownKeys(raw);
    if (
      keys.length !== payloadFields.length ||
      keys.some(
        (key) => typeof key !== "string" || !(payloadFields as readonly string[]).includes(key),
      )
    )
      return invalid();
    const fulfillmentReference = parseOrderingReference(raw.fulfillmentReference);
    const storeReference = parseOrderingReference(raw.storeReference);
    const readyAt = parseOrderingInstant(raw.readyAt);
    const closedAt = parseOrderingInstant(raw.closedAt);
    if (
      storeReference !== envelope.storeId ||
      fulfillmentReference !== envelope.aggregateId ||
      readyAt > closedAt
    )
      return invalid();
    return Object.freeze({
      eventId: parseOrderingReference(envelope.eventId),
      brandReference: parseOrderingReference(envelope.tenantId),
      storeReference,
      orderReference: parseOrderingReference(raw.orderReference),
      fulfillmentReference,
      notCollectedReference: parseOrderingReference(raw.notCollectedReference),
      closedAt,
    });
  } catch (error) {
    if (error instanceof OrderPickupNotCollectedEventError) throw error;
    return invalid();
  }
}

export interface OrderPickupNotCollectedConsumerPorts {
  readonly authorization: {
    authorize(
      transaction: ConsumerTransaction,
      event: OrderPickupNotCollectedEvent,
    ): Promise<boolean>;
  };
  readonly facts: {
    /**
     * Append the closure to Ordering's own record (idempotent per event and per Order). Returns
     * false when the pickup Order is not (yet) visible in this Store, so the delivery is retried.
     */
    record(transaction: ConsumerTransaction, event: OrderPickupNotCollectedEvent): Promise<boolean>;
  };
}

/**
 * WP-2423 / DEC-PILOT-BATCH-PHASE-01: Ordering's inbox for a pickup closed as not collected. The
 * inbox applies each event once; the phase merge treats the closure as a terminal outcome.
 */
export function createOrderPickupNotCollectedConsumerService(
  ports: OrderPickupNotCollectedConsumerPorts,
) {
  const registration = Object.freeze<ConsumerRegistration>({
    consumerName: orderPickupNotCollectedConsumerName,
    consumerVersion: 1,
    eventType: orderPickupNotCollectedEventType,
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "none",
    sideEffect: "record-order-pickup-not-collected-fact",
    replaySafe: true,
    async handler({ envelope, transaction }) {
      const event = parseOrderPickupNotCollectedEnvelope(envelope);
      if (!(await ports.facts.record(transaction, event)))
        return {
          status: "retry_required" as const,
          errorCode: "CONSUMER_TEMPORARY_FAILURE" as const,
        };
      return { status: "completed" as const };
    },
  });
  return Object.freeze({
    registration,
    async consume(transaction: ConsumerTransaction, envelope: DomainEventEnvelope) {
      const event = parseOrderPickupNotCollectedEnvelope(envelope);
      if ((await ports.authorization.authorize(transaction, event)) !== true)
        throw new Error("ORDERING_PICKUP_NOT_COLLECTED_DENIED");
      await transaction.query("SAVEPOINT ordering_pickup_not_collected_consumer", []);
      try {
        const result = await consumeEventInTransaction(transaction, registration, envelope);
        await transaction.query("RELEASE SAVEPOINT ordering_pickup_not_collected_consumer", []);
        return result;
      } catch (error) {
        await transaction.query("ROLLBACK TO SAVEPOINT ordering_pickup_not_collected_consumer", []);
        await transaction.query("RELEASE SAVEPOINT ordering_pickup_not_collected_consumer", []);
        throw error;
      }
    },
  });
}
