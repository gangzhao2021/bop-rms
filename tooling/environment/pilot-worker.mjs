import { createOptionalCompensationWorkloads } from "./pilot-compensation-workload.mjs";
import { supervisedCycleFailures } from "../../apps/worker/dist/outbox-workload.js";
import { isPilotRuntime } from "./pilot-environment.mjs";
import { createOptionalBatchCancellationWorkloads } from "./pilot-batch-cancellation-workload.mjs";
import console from "node:console";
import { reportUnexpected } from "./pilot-unexpected.mjs";
import { createPaymentAcceptanceWaitWorkload } from "../../apps/worker/dist/payment-acceptance-wait-workload.js";
import { createManualOutboxRecoveryRegistry } from "../../packages/bop/eventing/src/index.ts";
import { createConsumerOutboxTransport } from "../../apps/worker/dist/consumer-outbox-transport.js";
import { createHash } from "node:crypto";
import { createPersistentConsumerWorker } from "../../apps/worker/dist/persistent-consumer-worker.js";
import {
  isPilotDispatchScope,
  pilotDispatchScopes,
  pilotUnsubscribedEventTypes,
} from "./pilot-event-routing.mjs";

/**
 * v15 2026-11-01: the consumer deliveries that failed and have not been delivered since. The
 * events workload's health is `attention_required` while any remain (they retry, or wait for a
 * person once dead-lettered); a later successful delivery of the same consumer and event clears it.
 */
export function createPilotDeliveryFailures(limit = 10_000) {
  const open = new Set();
  return Object.freeze({
    failed(consumerName, eventId) {
      if (open.size < limit) open.add(consumerName + " " + eventId);
    },
    delivered(consumerName, eventId) {
      open.delete(consumerName + " " + eventId);
    },
    health(snapshot) {
      return open.size > 0 && (snapshot.state === "running" || snapshot.state === "idle")
        ? { ...snapshot, state: "attention_required" }
        : snapshot;
    },
  });
}
/**
 * WP-2423 M04: the payment-wait workload's health says attention while any paid wait keeps failing
 * (its siblings still run, so the cycle itself looks healthy). Never which wait.
 */
export function paymentWaitHealth(snapshot, stuckWaits) {
  return stuckWaits > 0 && (snapshot.state === "running" || snapshot.state === "idle")
    ? { ...snapshot, state: "attention_required" }
    : snapshot;
}
export async function createInternalWorker(resources, observers = {}, options = {}, dependencies) {
  const {
    createInternalDiningCheckoutExpiryWorkload,
    createInternalTableOnlineRefundWorkload,
    createInternalGuestTableCloseWorkload,
    createInternalCartExpiryWorkload,
    createInternalPaidOutcome,
    createInternalWorkerServices,
  } = dependencies;
  const services = await createInternalWorkerServices(resources, { persistentWaiting: true });
  const paid = await createInternalPaidOutcome(resources, { persistentWaiting: true });
  // WP-2423 M04: one paid wait that keeps failing is retried on its own; the Store's other paid
  // orders still reach the kitchen. While any fails, the health says attention (a count only).
  const stuck = { count: () => 0 };
  const waiting = createPaymentAcceptanceWaitWorkload({
    onSnapshot:
      observers.paymentWait === undefined
        ? undefined
        : (snapshot) => observers.paymentWait(paymentWaitHealth(snapshot, stuck.count())),
    discover: (limit, after) =>
      resources.transactions.run((tx) => paid.listUnresolved(tx, limit, after)),
    resume: (event) => resources.transactions.run((tx) => paid.resume(tx, event)),
    onWaitFailure: ({ failures, stuckWaits }, error) =>
      console.error(
        JSON.stringify({
          event: "INTERNAL_PAYMENT_WAIT_FAILED",
          code: /^[A-Z0-9_]{1,80}$/.test(String(error?.code)) ? error.code : undefined,
          name: /^[A-Za-z]{1,64}$/.test(String(error?.name)) ? error.name : undefined,
          failures,
          stuckWaits,
        }),
      ),
    pageSize: 5,
    pollIntervalMs: 1000,
    drainDeadlineMs: 25000,
    // WP-2423 pilot resilience: a failed cycle retries; it never stops the other workloads.
    supervision: supervisedCycleFailures,
  });
  stuck.count = waiting.stuckCount;
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
  // WP-2423 5e: the bound Store and the bound Brand; Brand-scoped events have no Store.
  const scopes = pilotDispatchScopes(resources.scope);
  const acknowledgedWithoutSubscribers = pilotUnsubscribedEventTypes(
    services.map((service) => service.registration),
  );
  // v15 2026-11-01: deliveries failing now (a consumer and event not delivered since it failed).
  // While any remain, the events health says attention, never "running, 0 failures".
  const failing = createPilotDeliveryFailures();
  const runtime = createPersistentConsumerWorker({
    onSnapshot: (snapshot) => observers.events(failing.health(snapshot)),
    // Every failed delivery is logged (consumer, event type, its code and the error's codes).
    onDeliveryFailure: ({ consumerName, eventType, eventId, errorCode, error }) => {
      failing.failed(consumerName, eventId);
      reportUnexpected("OUTBOX_CONSUMER_FAILED", error ?? new Error(errorCode), {
        step: eventType,
        consumer: consumerName,
      });
    },
    onDelivered: ({ consumerName, eventId }) => failing.delivered(consumerName, eventId),
    connections: resources.database,
    additionalWorkloads: [
      waiting,
      // WP-2423 Q12: always on; paid orders that cannot be fulfilled return their reserved stock.
      dependencies.createInternalPaidWithoutFulfillableInventoryWorkload(
        resources,
        observers.inventoryRelease,
      ),
      // WP-2423 Q12: always on; unpaid pickup orders close after the payment window and return stock.
      dependencies.createInternalPickupPaymentExpiryWorkload(
        resources,
        observers.pickupPaymentExpiry,
      ),
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
      // WP-2423 Q10 (Owner-approved 30 days): always on; daily removal of expired checkout contacts.
      dependencies.createInternalContactRetentionWorkload(resources, observers.contactRetention),
      // DEC-STRIPE-PILOT-WIRING: always on; daily deletion of raw webhook evidence after 30 days.
      dependencies.createInternalWebhookEvidenceRetentionWorkload(
        resources,
        observers.webhookEvidenceRetention,
      ),
      // DEC-PICKUP-CAPACITY-SCHEDULE: always on; without slots no pickup order can be taken.
      dependencies.createInternalPickupCapacityScheduleWorkload(
        resources,
        observers.pickupCapacitySchedule,
      ),
      createInternalTableOnlineRefundWorkload(resources, observers.tableOnlineRefund),
      // WP-2423 DEC-DINING-GUEST-TABLE-START: always on, so a started table is never orphaned.
      createInternalGuestTableCloseWorkload(resources, observers.guestTableClose),
      ...(options.cartExpiry === true ? [createInternalCartExpiryWorkload(resources)] : []),
      ...(options.diningCheckoutExpiry === true
        ? [createInternalDiningCheckoutExpiryWorkload(resources, observers.diningCheckoutExpiry)]
        : []),
    ],
    eventing: {
      // DEC-PILOT-RUNTIME-ENVIRONMENT: either pilot process (InternalTest or a Pilot Store).
      authorizeScope: async (value) =>
        isPilotRuntime() &&
        resources.now() < resources.publicProfile.binding.validUntil &&
        isPilotDispatchScope(value, resources.scope),
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
    scopes,
    acknowledgedWithoutSubscribers,
    leaseOwner: "internal-test-v4-business",
    newLeaseToken: resources.credentials.reference,
    config: {
      adapterConcurrency: 1,
      adapterTimeoutMs: 20000,
      // Five per scope each cycle, so a Brand authoring backlog never delays Store order events.
      batchMaximum: 10,
      perScopeMaximum: 5,
      leaseDurationSeconds: 30,
      drainDeadlineMs: 25000,
    },
    pollIntervalMs: 1000,
    drainDeadlineMs: 25000,
    supervision: supervisedCycleFailures,
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
    acknowledgedWithoutSubscribers,
  });
  return Object.freeze({ ...runtime, recoveryRegistry, recoveryAdapter });
}
