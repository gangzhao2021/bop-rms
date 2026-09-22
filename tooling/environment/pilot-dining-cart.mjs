import {
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../packages/rms/dining/src/index.ts";
export function createInternalDiningCart(resources, items, { createCart }) {
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...resources.scope,
  };
  const { catalogCartItems: source } = items,
    base = createCart(resources).cartBinding.ordering;
  return {
    catalogDiningCart: {
      participation: createDiningCartParticipationQuery({
        scope: resources.scope,
        repository: createPostgresDiningParticipationStore(resources.transactions, scope),
        now: resources.now,
      }),
      selectionTransactions: resources.transactions,
      selection: {
        sourceChannel: "Qr",
        policy: base.policy,
        generateReference: resources.credentials.reference,
        audit: (record) => ({
          auditId: resources.credentials.reference(),
          brandId: resources.scope.brandReference,
          storeId: resources.scope.storeReference,
          actor: { type: "System" },
          actionCode: "ORDERING_DINING_CART_" + record.action.toUpperCase(),
          targetType: "OrderingCart",
          targetId: record.cartReference,
          reasonCode: "AUTHORIZED_CART_SELECTION",
          correlationId: record.operationReference,
          occurredAt: record.occurredAt,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        }),
      },
      items: {
        writeTransactions: source.writeTransactions,
        references: source.references,
        audit: source.audit,
      },
      catalogTransactions: source.catalogTransactions,
      catalogScope: { ...source.catalogScope, orderTypeCode: "DINE_IN" },
      catalogSafety: source.catalogSafety,
      selectedInventory: source.selectedInventory,
    },
  };
}
