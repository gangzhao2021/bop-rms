import process from "node:process";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parsePaymentSucceededEnvelope } from "../../packages/rms/payment/src/index.ts";
export function createInternalReceiptConsumer(resources, { createReceipt }) {
  const authorize = (event) =>
    process.env.NODE_ENV === "development" &&
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
