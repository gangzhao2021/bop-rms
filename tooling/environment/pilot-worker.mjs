import { createOptionalCompensationWorkloads } from "./pilot-compensation-workload.mjs";
import process from "node:process";
import { createOptionalBatchCancellationWorkloads } from "./pilot-batch-cancellation-workload.mjs";
import console from "node:console";
import { createPaymentAcceptanceWaitWorkload } from "../../apps/worker/dist/payment-acceptance-wait-workload.js";
import { createManualOutboxRecoveryRegistry } from "../../packages/bop/eventing/src/index.ts";
import { createConsumerOutboxTransport } from "../../apps/worker/dist/consumer-outbox-transport.js";
import { createHash } from "node:crypto";
import { createPersistentConsumerWorker } from "../../apps/worker/dist/persistent-consumer-worker.js";
export async function createInternalWorker(resources, observers = {}, options = {}, dependencies) {
  const {
    createInternalDiningCheckoutExpiryWorkload,
    createInternalCartExpiryWorkload,
    createInternalPaidOutcome,
    createInternalWorkerServices,
  } = dependencies;
  const services = await createInternalWorkerServices(resources, { persistentWaiting: true });
  const paid = await createInternalPaidOutcome(resources, { persistentWaiting: true });
  const waiting = createPaymentAcceptanceWaitWorkload({
    onSnapshot: observers.paymentWait,
    discover: (limit, after) =>
      resources.transactions.run((tx) => paid.listUnresolved(tx, limit, after)),
    resume: async (event) => {
      try {
        return await resources.transactions.run((tx) => paid.resume(tx, event));
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "INTERNAL_PAYMENT_WAIT_FAILED",
            code: /^[A-Z0-9_]{1,80}$/.test(String(error.code)) ? error.code : undefined,
            name: /^[A-Za-z]{1,64}$/.test(String(error.name)) ? error.name : undefined,
          }),
        );
        throw error;
      }
    },
    pageSize: 5,
    pollIntervalMs: 1000,
    drainDeadlineMs: 25000,
  });
  const derive = (key) => {
    const d = createHash("sha256").update(key).digest("hex");
    return (
      "0190fa46-" +
      d.slice(0, 4) +
      "-7" +
      d.slice(4, 7) +
      "-8" +
      d.slice(7, 10) +
      "-" +
      d.slice(10, 22)
    );
  };
  const identities = (key) =>
    Object.fromEntries(
      ["attemptId", "deadLetterId", "idempotencyKey", "scheduleId"].map((kind) => [
        kind,
        derive(kind + ":" + key),
      ]),
    );
  const scope = {
    brandId: resources.scope.brandReference,
    storeId: resources.scope.storeReference,
  };
  const runtime = createPersistentConsumerWorker({
    onSnapshot: observers.events,
    connections: resources.database,
    additionalWorkloads: [
      waiting,
      ...(await createOptionalCompensationWorkloads({
        enabled: options.compensation,
        resources,
        onSnapshot: observers.compensation,
        createService: dependencies.createInternalCompensation,
      })),
      ...(await createOptionalBatchCancellationWorkloads({
        enabled: options.batchCancellation,
        resources,
        onSnapshot: observers.batchCancellation,
        createDispatcher: dependencies.createInternalBatchCancellationDispatcher,
      })),
      ...(options.cartExpiry === true ? [createInternalCartExpiryWorkload(resources)] : []),
      ...(options.diningCheckoutExpiry === true
        ? [createInternalDiningCheckoutExpiryWorkload(resources, observers.diningCheckoutExpiry)]
        : []),
    ],
    eventing: {
      authorizeScope: async (value) =>
        process.env.NODE_ENV === "development" &&
        resources.now() < resources.publicProfile.binding.validUntil &&
        value.brandId === scope.brandId &&
        value.storeId === scope.storeId,
      now: resources.now,
      random: Math.random,
      outboxIdentities: (event, attempt) => identities("outbox:" + event + ":" + attempt),
      // The window start distinguishes an operator retry's attempt from the original attempt
      // with the same number (WP-2423); within one window it is stable, so replays still match.
      consumerIdentities: (input) =>
        identities(
          "consumer:" +
            input.eventId +
            ":" +
            input.consumerName +
            ":" +
            input.attemptNumber +
            ":" +
            input.firstAttemptAt,
        ),
    },
    services,
    scopes: [scope],
    leaseOwner: "internal-test-v4-business",
    newLeaseToken: resources.credentials.reference,
    config: {
      adapterConcurrency: 1,
      adapterTimeoutMs: 20000,
      batchMaximum: 5,
      perScopeMaximum: 5,
      leaseDurationSeconds: 30,
      drainDeadlineMs: 25000,
    },
    pollIntervalMs: 1000,
    drainDeadlineMs: 25000,
  });
  const recoveryRegistry = createManualOutboxRecoveryRegistry(
    services.map((service) => service.registration),
  );
  const routes = new Map();
  for (const service of services) {
    const eventType = service.registration.eventType;
    const names = routes.get(eventType) ?? [];
    names.push(service.registration.consumerName);
    routes.set(eventType, names);
  }
  const recoveryAdapter = createConsumerOutboxTransport({
    delivery: runtime.delivery,
    subscriptions: [...routes].map(([eventType, consumerNames]) => ({ eventType, consumerNames })),
  });
  return Object.freeze({ ...runtime, recoveryRegistry, recoveryAdapter });
}
