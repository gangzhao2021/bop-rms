import { createOrderCapturedPaymentSource } from "../../apps/api/dist/order-captured-payment-source.js";
import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parsePaymentSucceededEnvelope } from "../../packages/rms/payment/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
export function createInternalAdditionalReceiptConsumer(
  resources,
  { refreshObservations, createReceipt, providerAccountReference },
) {
  const authorize = (event) =>
    isPilotRuntime() &&
    resources.now() < resources.publicProfile.binding.validUntil &&
    event.tenantId === resources.scope.brandReference &&
    event.storeId === resources.scope.storeReference;
  const registration = Object.freeze({
    consumerName: "ordering.internal-additional-receipt:v1",
    consumerVersion: 1,
    eventType: "PaymentSucceeded",
    schemaVersions: [1],
    ownerModule: "@rms/ordering",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "append_additional_receipt",
    replaySafe: true,
    handler: async ({ transaction, envelope }) => {
      const event = parsePaymentSucceededEnvelope(envelope);
      if (!authorize(event)) throw new Error("INTERNAL_RECEIPT_SCOPE_DENIED");
      const captured = createOrderCapturedPaymentSource({
        scope: {
          ...resources.scope,
          providerAccountReference: providerAccountReference,
          environment: "Test",
        },
        now: resources.now,
        authorize: async (_tx, value) => authorize(value),
      });
      const facts = await captured.resolve(transaction, event),
        p = facts.payment.intent.preparation;
      const identity = await createPostgresOrderBatchIdentitySource({
        ...resources.scope,
        authorize: async () => authorize(event),
      }).load(transaction, {
        orderReference: p.orderReference,
        orderBatchReference: p.orderBatchReference,
        observedAt: resources.now(),
      });
      if (!identity || identity.submissionReference !== p.submissionReference)
        throw new Error("INTERNAL_RECEIPT_BATCH_UNAVAILABLE");
      if (identity.kind === "Initial") return { status: "completed" };
      if (identity.kind !== "Additional" || identity.orderType !== "DineIn")
        throw new Error("INTERNAL_RECEIPT_BATCH_UNAVAILABLE");
      await refreshObservations(resources, event, () => authorize(event));
      const issuer = await createReceipt(resources, { run: (work) => work(transaction) });
      await issuer.issueOriginal({
        orderReference: event.payload.orderReference,
        observedAt: resources.now(),
        freshAfter: event.occurredAt,
      });
      await issuer.issueAdditional({
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
