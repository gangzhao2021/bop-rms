import { createInternalBatchCancellationDispatcher } from "./pilot-batch-cancellation-dispatcher.mjs";
import { createInternalCompensationService } from "./pilot-compensation-service.mjs";
import { join } from "node:path";
import { createInternalAdditionalReceiptConsumer } from "./pilot-additional-receipt-consumer.mjs";
import { createInternalOrderSubmitted } from "./pilot-order-submitted.mjs";
import { createInternalPaymentStatus } from "./pilot-payment-status.mjs";
import { createInternalPaidOutcome } from "./pilot-paid-outcome.mjs";
import { createInternalOrderStatus } from "./pilot-order-status.mjs";
import { createInternalReceiptConsumer } from "./pilot-receipt-consumer.mjs";
import { createInternalPickupFulfillment } from "./pilot-pickup-fulfillment.mjs";
import { createInternalKitchen } from "./pilot-kitchen.mjs";
import { createInternalKitchenConsumers } from "./pilot-kitchen-consumers.mjs";
import { createInternalInventoryConsumers } from "./pilot-inventory-consumers.mjs";
import { createInternalPickupReadiness } from "./pilot-pickup-readiness.mjs";
import { createInternalPickupProofConsumer } from "./pilot-pickup-proof-consumer.mjs";
import { createInternalOrderCompletionConsumer } from "./pilot-order-completion-consumer.mjs";
import { createInternalOrderCompletion } from "./pilot-order-completion.mjs";
import { createInternalOrderConfirmation } from "./pilot-order-confirmation.mjs";
import { createInternalPickupProof } from "./pilot-pickup-proof.mjs";
import { createInternalReceipt } from "./pilot-receipt.mjs";
import { refreshInternalReceiptObservations } from "./pilot-receipt-observations.mjs";
import { createInternalSimulatedProvider } from "./pilot-payment-provider.mjs";
import { createInternalKitchenQueue } from "./pilot-kitchen-queue.mjs";
import { createInternalDiningCheckoutExpiryWorkload } from "./pilot-dining-checkout-expiry.mjs";
import { createInternalCartExpiryWorkload } from "./pilot-cart-expiry.mjs";
import { createInternalWorkerServices } from "./pilot-worker-services.mjs";
import { createInternalWorker } from "./pilot-worker.mjs";

const factories = {
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
        }),
      createInternalPaidOutcome: paid,
      createInternalWorkerServices: (r, opts) =>
        f.createInternalWorkerServices(r, opts, dependencies),
      createInternalCartExpiryWorkload: f.createInternalCartExpiryWorkload,
      createInternalDiningCheckoutExpiryWorkload: (r, observer) =>
        f.createInternalDiningCheckoutExpiryWorkload(r, observer, account),
    });
  };
}
