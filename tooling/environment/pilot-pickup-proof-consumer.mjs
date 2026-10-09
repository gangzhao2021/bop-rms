import { createPostgresOrderBatchIdentitySource } from "../../packages/rms/ordering/src/index.ts";
import { consumeEventInTransaction } from "../../packages/bop/eventing/src/index.ts";
import { parseKitchenOrderReadyEnvelope } from "../../packages/rms/kitchen/src/index.ts";
import { isPilotRuntime } from "./pilot-environment.mjs";
/** The longest a pickup proof may stay valid after the order is ready (pickup-proof domain rule). */
const pickupWindowMs = 60 * 60 * 1000;
export function createInternalPickupProofConsumer(
  resources,
  { createConfirmation, createReadiness, createProof },
) {
  if (!isPilotRuntime()) throw new Error("INTERNAL_PICKUP_PROOF_ONLY");
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
      if (
        issued !== null &&
        (issued.source.brandReference !== resources.scope.brandReference ||
          issued.source.storeReference !== resources.scope.storeReference)
      )
        throw new Error("INTERNAL_PICKUP_PROOF_SOURCE_CONFLICT");
      if (issued?.capability) {
        if (issued.capability.fulfillmentReference !== issued.source.fulfillmentReference)
          throw new Error("INTERNAL_PICKUP_PROOF_SOURCE_CONFLICT");
        // Owner folds and verifies immutable issuance/handoff history. Replays must not regenerate expired or used proofs.
        return { status: "completed" };
      }
      // WP-2423: the pickup state exists before any proof (an in-person handoff needs no proof). An
      // order already handed over in person or closed as not collected gets no proof.
      if (issued !== null && (issued.notCollected || issued.source.canonicalPhase !== "Ready"))
        return { status: "completed" };
      // WP-2423: a pickup proof is valid for at most an hour after the order is ready. A ready event
      // delivered after that window (a delayed or recovered event) can no longer yield a usable
      // proof, so it completes without one instead of failing until it is dead-lettered; the order
      // stays ready for the Store to resolve.
      if (Date.parse(resources.now()) >= Date.parse(event.payload.readyAt) + pickupWindowMs)
        return { status: "completed" };
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
