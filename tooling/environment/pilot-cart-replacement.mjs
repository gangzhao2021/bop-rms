import { createCustomerDiningCartReplacement } from "../../apps/api/dist/customer-dining-cart-replacement.js";
export function createInternalCartReplacement(
  resources,
  entry,
  { createCart, providerAccountReference },
) {
  const { scope, transactions, credentials, now, publicProfile } = resources;
  return createCustomerDiningCartReplacement({
    scope: { tenantReference: publicProfile.binding.tenantReference, ...scope },
    transactions,
    credentials: credentials.sessions,
    binding: (tx) => entry.binding({ run: (work) => work(tx) }),
    policy: createCart(resources).cartBinding.ordering.policy,
    payment: { providerAccountReference: providerAccountReference, environment: "Test" },
    generateReference: credentials.reference,
    now,
    audit: (record) => ({
      auditId: credentials.reference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_DINING_CART_REPLACE",
      targetType: "OrderingCart",
      targetId: record.cartReference,
      occurredAt: record.occurredAt,
      correlationId: record.operationReference,
      reasonCode: "AUTHORIZED_CART_REPLACEMENT",
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  });
}
