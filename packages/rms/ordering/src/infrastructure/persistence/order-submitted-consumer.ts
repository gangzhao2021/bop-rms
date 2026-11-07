import {
  loadOutboxEnvelope,
  type ConsumerTransaction,
  type DomainEventEnvelope,
} from "@bop/eventing";
import { parseOrderSubmittedEnvelope } from "../../application/order-submitted-event.js";
import {
  createPostgresOrderSubmittedHistorySource,
  isCurrentSubmittedOrderRevision,
} from "./order-submitted-history-source.js";
import { createOrderSubmittedEventConsumerService } from "../../application/order-submitted-event-consumer-service.js";
import type { OrderSubmittedEventConsumerPorts } from "../../application/ports/order-submitted-event-ports.js";
import { createPostgresOrderStatusProjectionStore } from "./order-status-projection-store.js";

type ProjectionOptions = Parameters<typeof createPostgresOrderStatusProjectionStore>[0];
/** One borrowed transaction owns Inbox and projection updates. Exact history,
 * freshness and current owner authority remain mandatory transaction-bound ports.
 */
export function createPostgresOrderSubmittedConsumer(options: {
  projection: ProjectionOptions;
  authorization: OrderSubmittedEventConsumerPorts["authorization"];
  history: { quoteVersion: 1 | 2; locale: string };
  freshness: OrderSubmittedEventConsumerPorts["source"]["freshness"];
  references: OrderSubmittedEventConsumerPorts["references"];
}) {
  const loadExact = createPostgresOrderSubmittedHistorySource({
    brandReference: options.projection.brandReference,
    storeReference: options.projection.storeReference,
    quoteVersion: options.history.quoteVersion,
    locale: options.history.locale,
    authorize: options.authorization.authorize,
  });
  const projections = createPostgresOrderStatusProjectionStore({
    ...options.projection,
    validateCurrentSource: async (transaction, projection) => {
      const source = projection.snapshot;
      if (
        !(await isCurrentSubmittedOrderRevision(
          transaction,
          source,
          projection.freshnessStatus === "Stale",
        ))
      )
        return false;
      const envelope = await loadOutboxEnvelope(transaction, source.sourceCheckpoint);
      if (!envelope || envelope.eventType !== "OrderSubmitted") return false;
      const exact = await loadExact({
        transaction,
        envelope: parseOrderSubmittedEnvelope(envelope),
        brandReference: source.brandReference,
        storeReference: source.storeReference,
        orderReference: source.orderReference,
        sourceVersion: source.sourceVersion,
        sourceCheckpoint: source.sourceCheckpoint,
        sourceDigest: source.sourceDigest,
      });
      const encode = (value: unknown) =>
        JSON.stringify(value, (_key, entry) =>
          typeof entry === "bigint" ? entry.toString() : entry,
        );
      return (
        exact !== null &&
        encode(exact) === encode(source) &&
        projection.freshnessStatus === (await options.freshness(transaction, source)) &&
        (await options.projection.validateCurrentSource(transaction, projection))
      );
    },
  });
  const service = createOrderSubmittedEventConsumerService({
    authorization: options.authorization,
    source: {
      loadExact,
      freshness: options.freshness,
    },
    references: options.references,
    projections,
  });
  return Object.freeze({
    registration: service.registration,
    consume(transaction: ConsumerTransaction, envelope: DomainEventEnvelope) {
      return service.consume(transaction, parseOrderSubmittedEnvelope(envelope));
    },
  });
}
