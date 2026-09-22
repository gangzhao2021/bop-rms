import process from "node:process";
import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseKitchenOrderReadyEnvelope } from "../../packages/rms/kitchen/src/index.ts";
export function createInternalPickupProofConsumer(
  resources,
  { createConfirmation, createReadiness, createProof },
) {
  if (process.env.NODE_ENV !== "development") throw new Error("INTERNAL_PICKUP_PROOF_ONLY");
  const confirmation = createConfirmation(resources),
    ready = createReadiness(resources),
    proof = createProof(resources);
  const authorized = (value) => {
    const event = parseKitchenOrderReadyEnvelope(value);
    if (
      resources.now() >= resources.publicProfile.binding.validUntil ||
      event.tenantId !== resources.scope.brandReference ||
      event.storeId !== resources.scope.storeReference
    )
      throw new Error("INTERNAL_PICKUP_PROOF_SCOPE_DENIED");
    return event;
  };
  const registration = Object.freeze({
    consumerName: "fulfillment.internal-pickup-proof:v1",
    consumerVersion: 1,
    eventType: "KitchenOrderReady",
    schemaVersions: [1],
    ownerModule: "@rms/fulfillment",
    tenantScope: "store",
    ordering: "aggregate",
    sideEffect: "ensure_pickup_proof_issued",
    replaySafe: true,
    handler: async ({ transaction, envelope }) => {
      const event = authorized(envelope),
        orderReference = event.payload.orderReference;
      const identity = await createPostgresOrderBatchIdentitySource({
        ...resources.scope,
        authorize: async () => resources.now() < resources.publicProfile.binding.validUntil,
      }).load(transaction, {
        orderReference,
        orderBatchReference: event.payload.orderBatchReference,
        observedAt: resources.now(),
      });
      if (!identity) throw new Error("INTERNAL_PICKUP_PROOF_IDENTITY_UNAVAILABLE");
      if (identity.orderType === "DineIn") return { status: "completed" };
      const confirmed = await confirmation(transaction, orderReference);
      if (confirmed.payload.orderBatchReference !== event.payload.orderBatchReference)
        throw new Error("INTERNAL_PICKUP_PROOF_SCOPE_DENIED");
      const issued = await ready.repository.lockPickupHandoffByOrder({
        ...resources.scope,
        transaction,
        orderReference,
      });
      if (issued !== null) {
        if (
          issued.source.brandReference !== resources.scope.brandReference ||
          issued.source.storeReference !== resources.scope.storeReference ||
          !issued.capability ||
          issued.capability.fulfillmentReference !== issued.source.fulfillmentReference
        )
          throw new Error("INTERNAL_PICKUP_PROOF_SOURCE_CONFLICT");
        // Owner folds and verifies immutable issuance/handoff history. Replays must not regenerate expired or used proofs.
        return { status: "completed" };
      }
      await proof.issuer.ensureIssued({
        transaction,
        orderReference,
        idempotencyReference: event.eventId,
        correlationReference: event.correlationId,
      });
      return { status: "completed" };
    },
  });
  return {
    registration,
    consume: (transaction, value) =>
      consumeEventInTransaction(transaction, registration, authorized(value)),
  };
}
