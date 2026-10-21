import { createInternalBatchCancellationDispatcher } from "./pilot-batch-cancellation-dispatcher.mjs";
import { createInternalCompensationService } from "./pilot-compensation-service.mjs";
import { join } from "node:path";
import { createInternalAdditionalReceiptConsumer } from "./pilot-additional-receipt-consumer.mjs";
import { createInternalOrderSubmitted } from "./pilot-order-submitted.mjs";
import { createInternalPaymentStatus } from "./pilot-payment-status.mjs";
import { createInternalRefundConsumers } from "./pilot-refund-consumers.mjs";
import { createInternalPaidOutcome } from "./pilot-paid-outcome.mjs";
import { createInternalOrderStatus } from "./pilot-order-status.mjs";
import { createInternalReceiptConsumer } from "./pilot-receipt-consumer.mjs";
import { createInternalPickupFulfillment } from "./pilot-pickup-fulfillment.mjs";
import { createInternalKitchen } from "./pilot-kitchen.mjs";
import { createInternalKitchenConsumers } from "./pilot-kitchen-consumers.mjs";
import { createInternalOrderProgressConsumers } from "./pilot-order-progress-consumers.mjs";
import { createInternalInventoryConsumers } from "./pilot-inventory-consumers.mjs";
import { createInternalPickupReadiness } from "./pilot-pickup-readiness.mjs";
import { createInternalPickupProofConsumer } from "./pilot-pickup-proof-consumer.mjs";
import { createInternalOrderCompletionConsumer } from "./pilot-order-completion-consumer.mjs";
import { createInternalOrderCompletion } from "./pilot-order-completion.mjs";
import { createInternalOrderConfirmation } from "./pilot-order-confirmation.mjs";
import { createInternalPickupProof } from "./pilot-pickup-proof.mjs";
import { createInternalReceipt } from "./pilot-receipt.mjs";
import { refreshInternalReceiptObservations } from "./pilot-receipt-observations.mjs";
// DEC-STRIPE-PILOT-WIRING: the configured Provider (Stripe test mode or the TEST-ONLY simulator).
import { createPilotPaymentProvider as createInternalSimulatedProvider } from "./pilot-stripe-provider.mjs";
import { createInternalKitchenQueue } from "./pilot-kitchen-queue.mjs";
import { createInternalDiningCheckoutExpiryWorkload } from "./pilot-dining-checkout-expiry.mjs";
import { createInternalCartExpiryWorkload } from "./pilot-cart-expiry.mjs";
import { createInternalPaidWithoutFulfillableInventoryWorkload } from "./pilot-paid-without-fulfillable-inventory.mjs";
import { createInternalPickupPaymentExpiryWorkload } from "./pilot-pickup-payment-expiry.mjs";
import { createInternalContactRetentionWorkload } from "./pilot-contact-retention.mjs";
import { createInternalPickupCapacityScheduleWorkload } from "./pilot-pickup-capacity-schedule.mjs";
import { createInternalWorkerServices } from "./pilot-worker-services.mjs";
import { createInternalWorker } from "./pilot-worker.mjs";

const factories = {
  createInternalRefundConsumers,
  createInternalBatchCancellationDispatcher,
  createInternalCompensationService,
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
  createInternalOrderCompletion,
  createInternalOrderConfirmation,
  createInternalPickupProof,
  createInternalReceipt,
  refreshInternalReceiptObservations,
  createInternalSimulatedProvider,
  createInternalKitchenQueue,
  createInternalDiningCheckoutExpiryWorkload,
  createInternalCartExpiryWorkload,
  createInternalPaidWithoutFulfillableInventoryWorkload,
  createInternalPickupPaymentExpiryWorkload,
  createInternalContactRetentionWorkload,
  createInternalPickupCapacityScheduleWorkload,
  createInternalWorkerServices,
  createInternalWorker,
};
export function composeConfiguredBusinessWorker({
  directory,
  installation,
  config,
  implementations = factories,
}) {
  const f = implementations;
  const account = { providerAccountReference: config.providerAccountReference };
  const provider = (options = {}) =>
    f.createInternalSimulatedProvider(options, {
      directory,
      path: join(directory, "simulated-provider.sqlite"),
      loadProfile: installation.loadProfile,
      expectedDatabaseName: installation.database,
    });
  const receipt = async (r, transactions = r.transactions) =>
    f.createInternalReceipt(r, transactions, {
      config: await installation.loadReceiptTemplate(),
      ...account,
    });
  const completion = async (r) =>
    f.createInternalOrderCompletion(r, {
      saved: await installation.loadWorkflow("Pickup"),
      actor: config.actors.orderCompletion,
    });
  const confirmation = (r) => f.createInternalOrderConfirmation(r, account);
  const readiness = (r, current = null) =>
    f.createInternalPickupReadiness(r, current, { createConfirmation: confirmation });
  const proof = (r, current = null) =>
    f.createInternalPickupProof(r, current, { createReadiness: readiness });
  const queue = (r) =>
    f.createInternalKitchenQueue(r, { actorReference: config.actors.kitchenQueue });
  const paid = (r, options = {}) =>
    f.createInternalPaidOutcome(r, options, {
      loadPickupWorkflow: () => installation.loadWorkflow("Pickup"),
      loadDiningWorkflow: () => installation.loadWorkflow("DineIn"),
      loadAdditionalWorkflow: () => installation.loadWorkflow("AdditionalRelease"),
      ...account,
      actorReference: config.actors.paidOutcome,
    });
  const dependencies = {
    createInternalOrderSubmitted: f.createInternalOrderSubmitted,
    createInternalPaymentStatus: (r) => f.createInternalPaymentStatus(r, account),
    createInternalRefundConsumers: f.createInternalRefundConsumers,
    createInternalPaidOutcome: paid,
    createInternalOrderStatus: (r) =>
      f.createInternalOrderStatus(r, { createCompletion: completion }),
    createInternalReceiptConsumer: (r) =>
      f.createInternalReceiptConsumer(r, { createReceipt: receipt }),
    createInternalAdditionalReceiptConsumer: (r) =>
      f.createInternalAdditionalReceiptConsumer(r, {
        createReceipt: receipt,
        ...account,
        refreshObservations: (resources, value, authorize) =>
          f.refreshInternalReceiptObservations(resources, value, authorize, {
            ...account,
            createSimulatedProvider: provider,
          }),
      }),
    createInternalPickupFulfillment: f.createInternalPickupFulfillment,
    createInternalKitchen: f.createInternalKitchen,
    createInternalKitchenConsumers: (r) =>
      f.createInternalKitchenConsumers(r, { createQueue: queue }),
    createInternalOrderProgressConsumers: f.createInternalOrderProgressConsumers,
    createInternalInventoryConsumers: f.createInternalInventoryConsumers,
    createInternalPickupReadiness: readiness,
    createInternalPickupProofConsumer: (r) =>
      f.createInternalPickupProofConsumer(r, {
        createConfirmation: confirmation,
        createReadiness: readiness,
        createProof: proof,
      }),
    createInternalOrderCompletionConsumer: (r) =>
      f.createInternalOrderCompletionConsumer(r, { createCompletion: completion }),
  };
  return (resources, observers, options) => {
    if (
      (options.batchCancellation === true && config.workloads?.batchCancellation !== true) ||
      (options.compensation === true && config.workloads?.compensation !== true)
    )
      throw Error("BUSINESS_WORKER_OPTION_UNCONFIGURED");
    return f.createInternalWorker(resources, observers, options, {
      createInternalCompensation: (r) =>
        f.createInternalCompensationService({
          resources: r,
          ...account,
          createSimulatedProvider: provider,
          additionalRefundOwners: [],
        }),
      createInternalBatchCancellationDispatcher: (r) =>
        f.createInternalBatchCancellationDispatcher(r, {
          loadWorkflow: installation.loadCancellationWorkflow,
          expectedDatabaseName: installation.database,
          systemActorReference: config.actors.paidOutcome,
          // WP-2423 abandoned payment: a started payment still open at the deadline is resolved
          // with the (TEST-ONLY simulated) Provider; its failure reason names the cancellation.
          ...account,
          createSimulatedProvider: provider,
        }),
      createInternalPaidOutcome: paid,
      createInternalWorkerServices: (r, opts) =>
        f.createInternalWorkerServices(r, opts, dependencies),
      createInternalCartExpiryWorkload: f.createInternalCartExpiryWorkload,
      createInternalPaidWithoutFulfillableInventoryWorkload: (r, observer) =>
        f.createInternalPaidWithoutFulfillableInventoryWorkload(r, observer, {
          systemActorReference: config.actors.paidOutcome,
        }),
      createInternalPickupPaymentExpiryWorkload: (r, observer) =>
        f.createInternalPickupPaymentExpiryWorkload(r, observer, {
          systemActorReference: config.actors.paidOutcome,
          // WP-2423 abandoned pickup payment: a closed Order's open card payment is settled with
          // the (TEST-ONLY simulated) Provider, like an unpaid dine-in round's.
          ...account,
          createSimulatedProvider: provider,
        }),
      createInternalDiningCheckoutExpiryWorkload: (r, observer) =>
        f.createInternalDiningCheckoutExpiryWorkload(r, observer, account),
      // WP-2423 Q10: always on; daily removal of checkout contacts past the 30-day retention.
      createInternalContactRetentionWorkload: (r, observer) =>
        f.createInternalContactRetentionWorkload(r, observer),
      // DEC-PICKUP-CAPACITY-SCHEDULE: always on; pickup slots 14 days ahead from published hours.
      createInternalPickupCapacityScheduleWorkload: (r, observer) =>
        f.createInternalPickupCapacityScheduleWorkload(r, observer),
    });
  };
}
/** The default implementations, for operator tooling that composes the worker without starting it. */
export { factories as pilotBusinessFactories };
