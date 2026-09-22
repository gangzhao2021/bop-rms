import {
  createCustomerPickupCheckoutDetailsComposition,
  createCustomerDiningCheckoutDetailsComposition,
} from "../../apps/api/dist/customer-checkout-details-composition.js";
import { createPostgresGuestSessionEntryStore } from "../../packages/bop/identity/src/index.ts";
export function createInternalCheckoutDetails(resources, entry, diningIdentity) {
  const { scope, transactions, now, credentials } = resources;
  const common = {
    scope,
    quoteVersion: 1,
    cartTransactions: transactions,
    detailsTransactions: transactions,
    now,
    // Explicit InternalTest policy only; real Store legal documents remain an external gate.
    policies: {
      current: async (input) => ({
        brandReference: input.brandReference,
        storeReference: input.storeReference,
        orderType: input.orderType,
        checkedAt: input.observedAt,
        validUntil: resources.publicProfile.binding.validUntil,
        required: [],
      }),
    },
    audit: async (input) => ({
      auditId: credentials.reference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CHECKOUT_DETAILS_SAVE",
      reasonCode: "AUTHORIZED_CHECKOUT_UPDATE",
      targetType: "CheckoutDetails",
      targetId: input.detailsReference,
      occurredAt: input.observedAt,
      correlationId: input.operationReference,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  };
  const pickup = {
    quoteVersion: 1,
    ...createCustomerPickupCheckoutDetailsComposition({
      ...common,
      session: {
        ...entry.session,
        store: createPostgresGuestSessionEntryStore(transactions, scope),
      },
    }),
  };
  if (!diningIdentity) return { checkoutDetails: pickup };
  return {
    channelCheckoutDetails: {
      pickup,
      dining: {
        quoteVersion: 1,
        ...createCustomerDiningCheckoutDetailsComposition({ ...common, identity: diningIdentity }),
      },
    },
  };
}
