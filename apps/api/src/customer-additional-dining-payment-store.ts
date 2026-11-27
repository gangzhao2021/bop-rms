import { createCustomerIntactReservationPaymentAction } from "./customer-payment-workflow-action.js";
import { createPostgresAdmittedPaymentIntentCreationStore } from "@rms/payment";
import { createCustomerAdditionalOrderPaymentClaimAdmission } from "./customer-order-payment-admission.js";
import { createCustomerCapacityPaymentClaimAdmission } from "./customer-capacity-payment-admission.js";
import {
  createCustomerInventoryPaymentClaimAdmission,
  type CustomerInventoryPaymentAdmissionOptions,
} from "./customer-inventory-payment-admission.js";

/** Required owner fences are installed in the real Payment claim transaction. */
export function createCustomerAdditionalDiningPaymentStore(options: {
  transactions: Parameters<typeof createPostgresAdmittedPaymentIntentCreationStore>[0];
  scope: CustomerInventoryPaymentAdmissionOptions["scope"];
  clock: Parameters<typeof createPostgresAdmittedPaymentIntentCreationStore>[2];
  quoteVersion: 1 | 2;
  authorizeHistory: Parameters<
    typeof createCustomerAdditionalOrderPaymentClaimAdmission
  >[0]["authorizeHistory"];
  inventory: Omit<CustomerInventoryPaymentAdmissionOptions, "scope" | "evaluate"> &
    Pick<
      Parameters<typeof createCustomerIntactReservationPaymentAction>[0],
      "workflow" | "authorizeOverride"
    >;
}) {
  return createPostgresAdmittedPaymentIntentCreationStore(
    options.transactions,
    { brandReference: options.scope.brandReference, storeReference: options.scope.storeReference },
    options.clock,
    createCustomerAdditionalDiningPaymentAdmission(options),
  );
}

/** Reuses the same current owner fences for a claim and an ephemeral client handoff. */
export function createCustomerAdditionalDiningPaymentAdmission(
  options: Omit<
    Parameters<typeof createCustomerAdditionalDiningPaymentStore>[0],
    "transactions" | "clock"
  >,
) {
  return createCustomerAdditionalOrderPaymentClaimAdmission({
    scope: options.scope,
    quoteVersion: options.quoteVersion,
    authorizeHistory: options.authorizeHistory,
    capacityForSubmission: (snapshot) => {
      const evaluate = createCustomerIntactReservationPaymentAction({
        scope: options.scope,
        currentOrder: snapshot,
        submissionKind: "Additional",
        quoteVersion: options.quoteVersion,
        workflow: options.inventory.workflow,
        authorize: options.inventory.authorize,
        authorizeOverride: options.inventory.authorizeOverride,
      });
      const inventory = createCustomerInventoryPaymentClaimAdmission({
        ...options.inventory,
        scope: options.scope,
        evaluate,
      });
      return createCustomerCapacityPaymentClaimAdmission({
        scope: options.scope,
        owner: "Dining",
        inventory,
      });
    },
  });
}
