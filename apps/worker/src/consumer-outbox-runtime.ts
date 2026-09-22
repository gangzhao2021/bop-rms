import {
  ConsumerRegistry,
  type ConsumerRegistration,
  type ConsumerTransaction,
  type ConsumerOutcome,
  type DomainEventEnvelope,
} from "@bop/eventing";
import {
  ConsumerDeliveryWorker,
  type ConsumerDeliveryPort,
  type ConsumerFailureRecorder,
} from "./consumer-delivery.js";
import { createConsumerOutboxTransport } from "./consumer-outbox-transport.js";
import {
  OutboxDispatcher,
  type OutboxDispatcherConfig,
  type OutboxDispatchPort,
  type AuthorizedDispatchScope,
} from "./outbox-dispatcher.js";

/** Composition only; authority and persistence stay in the supplied owner services/ports. */
export function createConsumerOutboxRuntime(options: {
  readonly services: readonly {
    readonly registration: ConsumerRegistration;
    consume(
      transaction: ConsumerTransaction,
      envelope: DomainEventEnvelope,
    ): Promise<ConsumerOutcome>;
  }[];
  readonly database: ConsumerDeliveryPort;
  readonly dispatch: OutboxDispatchPort;
  readonly scopes: readonly AuthorizedDispatchScope[];
  readonly leaseOwner: string;
  readonly newLeaseToken: () => string;
  readonly failureRecorder?: ConsumerFailureRecorder;
  readonly config?: Partial<OutboxDispatcherConfig>;
}) {
  if (options.services.length === 0) throw new TypeError("OUTBOX_CONSUMERS_REQUIRED");
  const registry = new ConsumerRegistry(options.services.map((service) => service.registration));
  const services = new Map(
    options.services.map(
      (service) =>
        [
          service.registration.consumerName + ":" + service.registration.eventType,
          service,
        ] as const,
    ),
  );
  const routes = new Map<string, string[]>();
  for (const service of options.services) {
    const names = routes.get(service.registration.eventType) ?? [];
    names.push(service.registration.consumerName);
    routes.set(service.registration.eventType, names);
  }
  const delivery = new ConsumerDeliveryWorker({
    database: options.database,
    registry,
    ...(options.failureRecorder ? { failureRecorder: options.failureRecorder } : {}),
    consume: (transaction, registration, envelope) => {
      const service = services.get(registration.consumerName + ":" + registration.eventType);
      if (!service) throw new Error("OUTBOX_CONSUMER_SERVICE_MISSING");
      return service.consume(transaction, envelope);
    },
  });
  const dispatcher = new OutboxDispatcher(
    {
      adapter: createConsumerOutboxTransport({
        delivery,
        subscriptions: [...routes].map(([eventType, consumerNames]) => ({
          eventType,
          consumerNames,
        })),
      }),
      dispatch: options.dispatch,
      scopes: options.scopes,
      leaseOwner: options.leaseOwner,
      newLeaseToken: options.newLeaseToken,
    },
    options.config,
  );
  return Object.freeze({ delivery, dispatcher });
}
