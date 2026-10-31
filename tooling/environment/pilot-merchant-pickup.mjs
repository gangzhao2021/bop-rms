import console from "node:console";
import { Buffer } from "node:buffer";
import { appendAuditRecordInTransaction } from "../../packages/bop/audit/src/index.ts";
import { createAbuseBudgetConsumer } from "../../packages/database/src/index.ts";
import { pickupHandoffAuditDetails } from "../../packages/rms/fulfillment/src/index.ts";
import { createMerchantPickupProof } from "../../apps/api/dist/merchant-pickup-proof.js";
import { createMerchantPickupNotCollected } from "../../apps/api/dist/merchant-pickup-not-collected.js";
import { createMerchantPickupHandoff } from "../../apps/api/dist/merchant-pickup-handoff.js";
import { createMerchantPickupIdentityCheck } from "../../apps/api/dist/merchant-pickup-identity-check.js";
import {
  createMerchantPickupQuery,
  waitingPickupOrders,
} from "../../apps/api/dist/merchant-pickup-query.js";
export async function createInternalMerchantPickup(
  resources,
  merchant,
  confirmation = null,
  { createProof, loadCredentials, workstation },
) {
  const proof = createProof(resources, confirmation),
    scope = resources.scope,
    active = () => resources.now() < resources.publicProfile.binding.validUntil;
  const crypto = await loadCredentials(),
    nextReference = resources.credentials.reference;
  const installContext = async (_tx, input) => {
    if (
      !active() ||
      input.brandReference !== scope.brandReference ||
      input.storeReference !== scope.storeReference
    )
      throw new Error("INTERNAL_PICKUP_SCOPE_DENIED");
  };
  const store = {
    sha256: proof.storeOptions.sha256,
    validateCurrentSource: proof.storeOptions.validateCurrentSource,
  };
  const common = {
    persistence: merchant.persistence,
    authentication: merchant.service,
    store,
    installContext,
  };
  const pickupProof = createMerchantPickupProof({
    ...common,
    nextReference,
    hashCredential: async (input) => resources.credentials.pickup.hashCredential(input),
    consumeAttempt: async (input) => {
      if (
        !active() ||
        input.brandReference !== scope.brandReference ||
        input.storeReference !== scope.storeReference ||
        (confirmation !== null && input.orderReference !== confirmation.payload.orderReference)
      )
        return false;
      const digest = crypto.hasher.hash(
        JSON.stringify([
          "internal-test:pickup-proof-attempt:v1",
          input.brandReference,
          input.storeReference,
          input.actorReference,
          input.orderReference,
        ]),
      );
      const result = await createAbuseBudgetConsumer({
        bucketClass: "PICKUP_PROOF_FAILURE",
        windowSeconds: 300,
        limitCount: 10,
        now: resources.now,
        query: async (sql, values) => {
          const connection = await resources.database.acquire();
          try {
            return await connection.query(sql, [...values]);
          } finally {
            connection.release();
          }
        },
      }).consume(Buffer.from(digest, "hex"));
      return result.allowed;
    },
    appendAudit: async (transaction, fact, actorReference) =>
      appendAuditRecordInTransaction(transaction, {
        auditId: nextReference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: actorReference },
        actionCode: "PICKUP_PROOF_" + fact.kind.toUpperCase(),
        targetType: "Fulfillment",
        targetId: fact.fulfillmentReference,
        beforeSummary: null,
        afterSummary: { operation: fact.kind },
        reasonCode: "PICKUP_PROOF",
        correlationId: fact.correlationReference,
        occurredAt: fact.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      }),
  });
  const handoffStore = {
    ...store,
    deriveCompletionReference: (kind, identity) => {
      const d = store.sha256(kind + ":" + identity).slice(7);
      return (
        "0190fa39-" +
        d.slice(0, 4) +
        "-7" +
        d.slice(4, 7) +
        "-8" +
        d.slice(7, 10) +
        "-" +
        d.slice(10, 22)
      );
    },
    admit: async (_tx, command) =>
      active() &&
      command.deviceReference === workstation.deviceReference &&
      command.pickupLocationReference === workstation.pickupLocationReference,
    appendAudit: async (transaction, audit) =>
      appendAuditRecordInTransaction(transaction, {
        auditId: audit.auditReference,
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "User", reference: audit.actorReference },
        actionCode: audit.actionCode,
        targetType: "Fulfillment",
        targetId: audit.fulfillmentReference,
        // WP-2423: a handover without the code while it was still valid is named apart, with the
        // cause staff chose.
        ...(audit.actionCode === "PICKUP_NOT_COLLECTED"
          ? { afterSummary: { action: audit.purpose }, reasonCode: "PICKUP_NOT_COLLECTED" }
          : pickupHandoffAuditDetails(audit)),
        correlationId: audit.correlationReference,
        occurredAt: audit.occurredAt,
        sourceChannel: "MERCHANT_WEB",
        dataClassification: "Confidential",
        retentionPolicyCode: "FULFILLMENT_BUSINESS_RECORD",
        retentionPolicyVersion: 1,
      }),
  };
  const pickupHandoff = createMerchantPickupHandoff({
    ...common,
    nextReference,
    store: handoffStore,
  });
  // WP-2423: closing a ready pickup nobody collected after the pickup hold.
  const pickupNotCollected = createMerchantPickupNotCollected({
    ...common,
    nextReference,
    store: handoffStore,
  });
  // WP-2423: the name and last four phone digits staff compare for an in-person check.
  const pickupIdentityCheck = createMerchantPickupIdentityCheck({ ...common, store: handoffStore });
  return {
    pickupProof,
    pickupHandoff,
    pickupNotCollected,
    pickupIdentityCheck,
    // WP-2423 item 8 ⑦ (v15 finding v): how many pickups are still to hand over (a number only).
    waitingPickups: (tx) =>
      active()
        ? waitingPickupOrders(tx, {
            ...store,
            brandReference: scope.brandReference,
            storeReference: scope.storeReference,
            now: resources.now,
          })
        : Promise.resolve(null),
    pickupQuery: logUnexpected(
      "INTERNAL_PICKUP_QUERY_UNAVAILABLE",
      createMerchantPickupQuery({
        ...common,
        resolveWorkstation: async () => (active() ? workstation : null),
      }),
    ),
    workstation,
  };
}

/**
 * Logs an unexpected failure as its event, error code and source frames only: never the message
 * text of a non-code error, the request, credentials or any order content.
 */
export function reportUnexpected(event, error) {
  // A plain Error whose message is an error code (UPPER_SNAKE) carries that code.
  const codeMessage = /^[A-Z][A-Z0-9_]{2,79}$/.test(error?.message ?? "") ? error.message : null;
  const code = error?.code ?? codeMessage ?? error?.name;
  console.error(
    JSON.stringify({
      event,
      code: /^[A-Za-z0-9_]{1,80}$/.test(code ?? "") ? code : "UNAVAILABLE",
      // A database error raised with a code as its message (e.g. SQLSTATE 55000 with
      // STORE_REFERENCE_SOURCE_INVALID) names that code too; never other message text.
      ...(codeMessage !== null && codeMessage !== code ? { reason: codeMessage } : {}),
      frames:
        String(error?.stack ?? "")
          .match(
            /(?:apps\/api\/(?:dist|src)|packages\/[a-z]+\/[a-z-]+\/src|tooling\/environment)\/[a-zA-Z0-9_./-]+:\d+:\d+/g,
          )
          ?.slice(0, 5) ?? [],
    }),
  );
}
export function logUnexpected(event, call) {
  return async (input) => {
    try {
      return await call(input);
    } catch (error) {
      // Expected business refusals are answered to the caller, not logged.
      if (
        error?.name !== "FulfillmentReadinessError" &&
        !/^Merchant[A-Za-z]*Error$/.test(error?.name ?? "")
      )
        reportUnexpected(event, error);
      throw error;
    }
  };
}
