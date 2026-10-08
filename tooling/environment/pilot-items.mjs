import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { createHash } from "node:crypto";
export async function createInternalTestItems(resources, { saved, expectedDatabaseName }) {
  if (
    saved.environment !== "InternalTest" ||
    saved.database !== expectedDatabaseName ||
    saved.scope.brandReference !== resources.scope.brandReference ||
    saved.scope.storeReference !== resources.scope.storeReference
  )
    throw new Error("INTERNAL_INVENTORY_REQUIRED");
  const reads = createInternalReadTransactions(resources);
  const evidence = (request, kind, status) => ({
    kind,
    status,
    brandReference: request.brandReference,
    storeReference: request.storeReference,
    sellableReference: request.sellableReference,
    observedAt: request.observedAt,
    expiresAt: new Date(
      Math.min(
        Date.parse(request.observedAt) + 60000,
        Date.parse(resources.publicProfile.binding.validUntil),
      ),
    ).toISOString(),
    reasonCode: "SYNTHETIC_SAFETY",
  });
  return {
    catalogCartItems: {
      catalogTransactions: reads,
      catalogScope: {
        menuReference: resources.menu.menuReference,
        sourceChannel: "Qr",
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
      },
      // Explicit isolated DEMO safety policy; selected quantity inventory still reads owner tables.
      catalogSafety: {
        killSwitch: { loadEvidence: async (request) => evidence(request, "KillSwitch", "Clear") },
        inventory: { loadEvidence: async (request) => evidence(request, "Inventory", "Available") },
      },
      selectedInventory: {
        scope: saved.scope,
        transactions: reads,
        resolveExpiryCutoff: createInternalExpiryCutoff(resources),
      },
      writeTransactions: resources.transactions,
      references: {
        generate: resources.credentials.reference,
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
      },
      audit: (record) => ({
        auditId: resources.credentials.reference(),
        brandId: resources.scope.brandReference,
        storeId: resources.scope.storeReference,
        actor: { type: "System" },
        actionCode: "ORDERING_CART_ITEM_" + record.action.toUpperCase(),
        targetType: "OrderingCart",
        targetId: record.cartReference,
        reasonCode: "AUTHORIZED_CART_MUTATION",
        correlationId: record.operationReference,
        occurredAt: record.observedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
  };
}
