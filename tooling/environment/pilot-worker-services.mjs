import process from "node:process";
import { ConsumerRegistry } from "../../packages/bop/eventing/src/index.ts";
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
    createInternalInventoryConsumers,
    createInternalPickupReadiness,
    createInternalPickupProofConsumer,
    createInternalOrderCompletionConsumer,
  } = dependencies;
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_WORKER_ONLY");
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
    ...createInternalInventoryConsumers(resources),
    createInternalPickupReadiness(resources).worker,
    createInternalPickupProofConsumer(resources),
    await createInternalOrderCompletionConsumer(resources),
    status.completed,
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
