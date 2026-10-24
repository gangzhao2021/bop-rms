import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import {
  createPostgresCardMachinePaymentStore,
  parsePaymentSucceededEnvelope,
} from "../../packages/rms/payment/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalReceiptConsumer(resources, { createReceipt }) {
  const authorize = (event) =>
    isPilotRuntime() &&
    resources.now() < resources.publicProfile.binding.validUntil &&
    event.tenantId === resources.scope.brandReference &&
    event.storeId === resources.scope.storeReference;
  const registration = Object.freeze({
    consumerName: "ordering.internal-original-receipt:v1",
    consumerVersion: 1,
    eventType: "PaymentSucceeded",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "issue_original_receipt",
    replaySafe: true,
    handler: async ({ transaction, envelope }) => {
      const event = parsePaymentSucceededEnvelope(envelope);
      if (!authorize(event)) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
      // WP-2423 Q7: a counter order paid on the Store's card machine has no customer device to
      // receive a digital receipt; the machine prints its own slip. Nothing to issue here.
      // WP-2423 D2: a table's first round staff entered and took on the card machine does start the
      // table's digital receipt (guests who join later see it, and later rounds — online or on the
      // machine — are added to it), as for a first round a guest paid online.
      const card = await createPostgresCardMachinePaymentStore({
        scope: resources.scope,
        authorize: async () => authorize(event),
      }).loadByIntent(transaction, event.payload.paymentIntentReference);
      if (card !== null) {
        const identity = await createPostgresOrderBatchIdentitySource({
          ...resources.scope,
          authorize: async () => authorize(event),
        }).load(transaction, {
          orderReference: String(card.orderReference),
          orderBatchReference: String(card.orderBatchReference),
          observedAt: resources.now(),
        });
        if (!identity) throw new Error("INTERNAL_RECEIPT_BATCH_UNAVAILABLE");
        if (identity.orderType !== "DineIn" || identity.kind !== "Initial")
          return { status: "completed" };
      }
      const issuer = await createReceipt(resources, { run: (work) => work(transaction) });
      await issuer.issueOriginal({
        orderReference: event.payload.orderReference,
        observedAt: resources.now(),
        freshAfter: event.occurredAt,
      });
      return { status: "completed" };
    },
  });
  return {
    registration,
    consume: async (transaction, envelope) => {
      const event = parsePaymentSucceededEnvelope(envelope);
      if (!authorize(event)) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
      return consumeEventInTransaction(transaction, registration, event);
    },
  };
}
