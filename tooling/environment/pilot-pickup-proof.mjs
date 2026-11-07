import { randomBytes } from "node:crypto";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import {
  createPostgresPickupProofIssuer,
  createPostgresPickupProofStore,
} from "../../packages/rms/fulfillment/src/index.ts";
export function createInternalPickupProof(resources, confirmation = null, { createReadiness }) {
  const ready = createReadiness(resources, confirmation),
    reference = resources.credentials.reference;
  const store = {
    ...ready.storeOptions,
    authorize: async (_tx, input) =>
      resources.now() < resources.publicProfile.binding.validUntil &&
      (confirmation === null || input.orderReference === confirmation.payload.orderReference),
    appendAudit: async (transaction, fact) =>
      appendAuditRecordInTransaction(transaction, {
        auditId: reference(),
        brandId: resources.scope.brandReference,
        storeId: resources.scope.storeReference,
        actor: { type: "System" },
        actionCode: "PICKUP_PROOF_" + fact.kind.toUpperCase(),
        targetType: "Fulfillment",
        targetId: fact.fulfillmentReference,
        beforeSummary: null,
        afterSummary: { operation: fact.kind },
        reasonCode: "PICKUP_PROOF",
        correlationId: fact.correlationReference,
        occurredAt: fact.occurredAt,
        sourceChannel: "EVENT_CONSUMER",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      }),
  };
  return {
    storeOptions: store,
    store: createPostgresPickupProofStore(store),
    issuer: createPostgresPickupProofIssuer({
      store,
      credentials: resources.credentials.pickup,
      pepperVersion: 1,
      nextReference: reference,
      publicOrderReference: () => randomBytes(16).toString("base64url"),
    }),
  };
}
