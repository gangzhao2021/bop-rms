import { createCompositeWorkerWorkload } from "./composite-workload.js";
import type { WorkerWorkload } from "./index.js";
import { createConsumerDeliveryDatabase } from "./consumer-transaction.js";
import { createPersistentEventingPorts } from "./persistent-eventing-ports.js";
import { createConsumerOutboxRuntime } from "./consumer-outbox-runtime.js";
import { ConsumerRetryScheduler } from "./retry-scheduler.js";
import { OutboxRetryScheduler } from "./outbox-retry-scheduler.js";
import { createOutboxWorkload } from "./outbox-workload.js";

/** Caller supplies real connections and trusted authority/configuration; no environment defaults. */
export function createPersistentConsumerWorker(options: {
  readonly additionalWorkloads?: readonly WorkerWorkload[];
  readonly connections: Parameters<typeof createConsumerDeliveryDatabase>[0];
  readonly eventing: Omit<Parameters<typeof createPersistentEventingPorts>[0], "database">;
  readonly services: Parameters<typeof createConsumerOutboxRuntime>[0]["services"];
  readonly scopes: Parameters<typeof createConsumerOutboxRuntime>[0]["scopes"];
  readonly leaseOwner: string;
  readonly newLeaseToken: () => string;
  readonly config?: Parameters<typeof createConsumerOutboxRuntime>[0]["config"];
  readonly pollIntervalMs: number;
  readonly drainDeadlineMs: number;
  readonly onSnapshot?: Parameters<typeof createOutboxWorkload>[0]["onSnapshot"];
}) {
  const eventing = createPersistentEventingPorts({
    ...options.eventing,
    database: createConsumerDeliveryDatabase(options.connections),
  });
  const runtime = createConsumerOutboxRuntime({
    services: options.services,
    scopes: options.scopes,
    database: eventing.database,
    dispatch: eventing.dispatch,
    failureRecorder: eventing.failureRecorder,
    leaseOwner: options.leaseOwner,
    newLeaseToken: options.newLeaseToken,
    ...(options.config ? { config: options.config } : {}),
  });
  const consumerRetries = new ConsumerRetryScheduler({
    delivery: runtime.delivery,
    retries: eventing.consumerRetries,
    scopes: options.scopes,
    leaseOwner: options.leaseOwner,
    newLeaseToken: options.newLeaseToken,
    now: () => options.eventing.now(),
  });
  const parkedRetries = new OutboxRetryScheduler({
    retries: eventing.parkedRetries,
    scopes: options.scopes,
  });
  const eventWorkload = createOutboxWorkload({
    ...(options.onSnapshot ? { onSnapshot: options.onSnapshot } : {}),
    pollIntervalMs: options.pollIntervalMs,
    drainDeadlineMs: options.drainDeadlineMs,
    dispatcher: {
      runOnce: async () => {
        const parked = await parkedRetries.runOnce();
        const retried = await consumerRetries.runOnce();
        return parked + retried + (await runtime.dispatcher.runOnce());
      },
      stop: () => runtime.dispatcher.stop(),
    },
  });
  const workload = options.additionalWorkloads?.length
    ? createCompositeWorkerWorkload([eventWorkload, ...options.additionalWorkloads])
    : eventWorkload;
  return Object.freeze({ ...runtime, eventing, consumerRetries, parkedRetries, workload });
}
