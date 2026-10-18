import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { createHash } from "node:crypto";
import {
  createCustomerCatalogInventoryPort,
  createCustomerInventoryEvidence,
  createStaffStockShortageSource,
} from "../../apps/api/dist/customer-menu-inventory-evidence.js";
function checkedInventory(resources, { saved, expectedDatabaseName }) {
  if (
    saved.environment !== "InternalTest" ||
    saved.database !== expectedDatabaseName ||
    saved.scope.brandReference !== resources.scope.brandReference ||
    saved.scope.storeReference !== resources.scope.storeReference
  )
    throw new Error("INTERNAL_INVENTORY_REQUIRED");
  return saved;
}
/** WP-2423 Q12: the Store's stock observation shared by the menu, cart, Quote and checkout. */
export function createInternalInventoryEvidence(resources, installed) {
  const saved = checkedInventory(resources, installed);
  return createCustomerInventoryEvidence({
    scope: saved.scope,
    resolveExpiryCutoff: createInternalExpiryCutoff(resources),
  });
}
/**
 * WP-2423 (2026-10-16): the same stock observation for staff, with the reason an item shows sold
 * out to guests (short ingredients, on hand / set aside / available).
 */
export function createInternalStaffStockShortage(resources, installed) {
  const saved = checkedInventory(resources, installed);
  return createStaffStockShortageSource({
    scope: saved.scope,
    resolveExpiryCutoff: createInternalExpiryCutoff(resources),
    menuReference: resources.menu.menuReference,
  });
}
/** sourceChannel: "Qr" for the customer app; "Pos" for a counter order staff take (WP-2423 Q7). */
export async function createInternalTestItems(resources, installed, sourceChannel = "Qr") {
  if (sourceChannel !== "Qr" && sourceChannel !== "Pos")
    throw new Error("INTERNAL_ITEMS_CHANNEL_INVALID");
  const saved = checkedInventory(resources, installed);
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
        sourceChannel,
        channelCode: "CUSTOMER_PWA",
        orderTypeCode: "PICKUP",
      },
      // Explicit isolated DEMO kill-switch policy. Inventory is the Store's actual stock for the
      // item as normally ordered (the menu's sold-out source); the selected quantity and options
      // are still checked against stock separately.
      catalogSafety: {
        killSwitch: { loadEvidence: async (request) => evidence(request, "KillSwitch", "Clear") },
        inventory: createCustomerCatalogInventoryPort({
          evidence: createInternalInventoryEvidence(resources, installed),
          transactions: reads,
          menuReference: resources.menu.menuReference,
          sourceChannel,
        }),
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
