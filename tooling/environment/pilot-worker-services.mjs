import { ConsumerRegistry } from "../../packages/bop/eventing/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export async function createInternalWorkerServices(
  resources,
  { persistentWaiting = false } = {},
  dependencies,
) {
  const {
    createInternalAdditionalReceiptConsumer,
    createInternalOrderSubmitted,
    createInternalPaymentStatus,
    createInternalPaidOutcome,
    createInternalOrderStatus,
    createInternalReceiptConsumer,
    createInternalPickupFulfillment,
    createInternalKitchen,
    createInternalKitchenConsumers,
    createInternalOrderProgressConsumers,
    createInternalInventoryConsumers,
    createInternalPickupReadiness,
    createInternalPickupProofConsumer,
    createInternalOrderCompletionConsumer,
    createInternalRefundConsumers,
  } = dependencies;
  if (!isPilotRuntime()) throw new Error("INTERNAL_WORKER_ONLY");
  const paid = await createInternalPaidOutcome(resources, { persistentWaiting }),
    status = await createInternalOrderStatus(resources);
  const paymentStatus = createInternalPaymentStatus(resources);
  const services = [
    status.created,
    createInternalOrderSubmitted(resources),
    ...paymentStatus.registrations.map((registration) => ({
      registration,
      consume: paymentStatus.consume,
    })),
    ...paid.registrations.map((registration) => ({
      registration,
      consume: async (tx, event) => (await paid.consume(tx, event)).consumerOutcome,
    })),
    createInternalReceiptConsumer(resources),
    createInternalAdditionalReceiptConsumer(resources),
    createInternalPickupFulfillment(resources).worker,
    createInternalKitchen(resources).worker,
    ...createInternalKitchenConsumers(resources),
    // WP-2423 / DEC-PILOT-BATCH-PHASE-01: Kitchen progress into the Ordering Order phase.
    ...(createInternalOrderProgressConsumers
      ? createInternalOrderProgressConsumers(resources)
      : []),
    ...createInternalInventoryConsumers(resources),
    createInternalPickupReadiness(resources).worker,
    createInternalPickupProofConsumer(resources),
    await createInternalOrderCompletionConsumer(resources),
    ...(createInternalRefundConsumers ? createInternalRefundConsumers(resources) : []),
    status.completed,
    // WP-2423: OrderCancelled (an unpaid dine-in round the System cancelled).
    ...(status.cancelled ? [status.cancelled] : []),
  ];
  new ConsumerRegistry(services.map((value) => value.registration));
  return services.map((service) => ({
    registration: service.registration,
    consume: (transaction, event) => {
      if (
        resources.now() >= resources.publicProfile.binding.validUntil ||
        event.tenantId !== resources.scope.brandReference ||
        event.storeId !== resources.scope.storeReference
      )
        throw new Error("INTERNAL_WORKER_SCOPE_DENIED");
      return service.consume(transaction, event);
    },
  }));
}
