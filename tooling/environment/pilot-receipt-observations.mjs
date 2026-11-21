import {
  createPostgresReceiptOrderSource,
  listStoreUnpaidBatchCancellations,
} from "../../packages/rms/ordering/src/index.ts";
import {
  createPostgresCapturedBatchPaymentSource,
  createPostgresPaymentProviderObservationStore,
  parsePaymentSucceededEnvelope,
} from "../../packages/rms/payment/src/index.ts";
import { createOrderCapturedPaymentSource } from "../../apps/api/dist/order-captured-payment-source.js";
import { isPilotRuntime, pilotProviderEnvironment } from "./pilot-environment.mjs";
/** DEMO observation refresh only. No receipt/capture mutation; Order locks end before retrieval. */
export async function refreshInternalReceiptObservations(
  resources,
  value,
  authorize,
  dependencies,
) {
  const event = parsePaymentSucceededEnvelope(value);
  if (
    event.tenantId !== resources.scope.brandReference ||
    event.storeId !== resources.scope.storeReference
  )
    throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
  return refreshInternalOrderReceiptObservations(
    resources,
    event.payload.orderReference,
    authorize,
    dependencies,
  );
}
export async function refreshInternalOrderReceiptObservations(
  resources,
  orderReference,
  authorize,
  { providerAccountReference, createSimulatedProvider },
) {
  const allowed = async () =>
    isPilotRuntime() &&
    resources.now() < resources.publicProfile.binding.validUntil &&
    (await authorize());
  if (!(await allowed())) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
  const scope = {
    ...resources.scope,
    providerAccountReference: providerAccountReference,
    environment: pilotProviderEnvironment(),
  };
  const plans = await resources.transactions.run(async (transaction) => {
    const order = await createPostgresReceiptOrderSource({
      ...resources.scope,
      authorize: allowed,
    })(transaction, { orderReference, observedAt: resources.now() });
    const batchSource = createPostgresCapturedBatchPaymentSource({ scope, authorize: allowed });
    const captured = createOrderCapturedPaymentSource({
      scope,
      now: resources.now,
      authorize: allowed,
    });
    const plans = [];
    // WP-2423 Q5: a round cancelled because its payment failed was never charged; skip it.
    const uncharged = new Set(
      (await listStoreUnpaidBatchCancellations(transaction, resources.scope, [orderReference])).map(
        (entry) => entry.orderBatchReference,
      ),
    );
    for (const batch of order.batches) {
      if (uncharged.has(batch.orderBatchReference)) continue;
      const paid = await batchSource.load(transaction, {
        orderReference: order.orderReference,
        orderBatchReference: batch.orderBatchReference,
        observedAt: resources.now(),
      });
      // WP-2423 Q5: a round not paid yet (e.g. a staff round still to be paid on the card
      // machine) is not on the receipt; its own payment refreshes and issues the next version.
      if (!paid) continue;
      const current = await captured.resolve(transaction, paid.paymentEvent),
        prior = current.payment.providerOutcome;
      // WP-2423 item 4: a round paid on the Store's card machine has no Provider to ask; its
      // record is the evidence the receipt reads.
      if (current.payment.intent.paymentMethod === "StoreCardMachine") continue;
      if (prior?.kind !== "Snapshot") throw new Error("INTERNAL_RECEIPT_PROVIDER_UNAVAILABLE");
      plans.push({
        paymentIntentReference: paid.paymentIntentReference,
        context: prior.context,
        providerIntentReference: prior.providerIntentReference,
      });
    }
    if (!(await allowed())) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
    return plans;
  });
  const simulator = await createSimulatedProvider();
  try {
    const observations = createPostgresPaymentProviderObservationStore(
      resources.transactions,
      resources.scope,
      { now: resources.now },
    );
    for (const plan of plans) {
      if (!(await allowed())) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
      const snapshot = await simulator.adapter.retrieveIntent({
        operation: "RetrieveIntent",
        purpose: "RetrievePaymentIntent",
        context: { ...plan.context, operationReference: resources.credentials.reference() },
        providerIntentReference: plan.providerIntentReference,
      });
      if (!(await allowed())) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
      await observations.record({
        observationReference: resources.credentials.reference(),
        paymentIntentReference: plan.paymentIntentReference,
        snapshot,
      });
    }
  } finally {
    simulator.close();
  }
  return plans.length;
}
