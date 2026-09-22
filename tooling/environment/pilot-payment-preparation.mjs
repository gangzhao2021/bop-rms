import { readClosedRecord } from "../../packages/bop/identity/src/index.ts";
import { createPostgresPaymentTipSelectionStore } from "../../packages/rms/payment/src/index.ts";
import { createCustomerCheckoutSessionRead } from "../../apps/api/dist/customer-checkout-session-read.js";
import {
  createCustomerPickupSessionOrderSubmission,
  createCustomerDiningSessionOrderSubmission,
} from "../../apps/api/dist/customer-session-order-submission.js";
import {
  createCustomerPickupSessionTipSelection,
  createCustomerDiningSessionTipSelection,
} from "../../apps/api/dist/customer-session-tip-selection.js";
export function createInternalPaymentPreparation(
  resources,
  checkout,
  orders,
  orderType = "Pickup",
) {
  if (!["Pickup", "DineIn"].includes(orderType))
    throw new Error("INTERNAL_PAYMENT_CHANNEL_INVALID");
  const orderComposition =
      orderType === "DineIn"
        ? createCustomerDiningSessionOrderSubmission
        : createCustomerPickupSessionOrderSubmission,
    tipComposition =
      orderType === "DineIn"
        ? createCustomerDiningSessionTipSelection
        : createCustomerPickupSessionTipSelection;
  const { scope, now, transactions, credentials } = resources;
  const reader = createCustomerCheckoutSessionRead(checkout.accessOptions);
  async function resolve(value, tip = false) {
    const raw = readClosedRecord(value, [
      "sessionCredential",
      "csrfCredential",
      "checkoutSessionReference",
      ...(tip ? ["selectionReference", "tip"] : []),
    ]);
    const input = {
      sessionCredential: raw.sessionCredential,
      csrfCredential: raw.csrfCredential,
      checkoutSessionReference: raw.checkoutSessionReference,
    };
    const session = await reader.read(input),
      v = session.validation;
    const options = await orders.createOptions({
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
      submissionReference: session.submissionReference,
      cartReference: v.cartReference,
      expectedCartVersion: v.cartVersion,
      quoteReference: v.quoteReference,
    });
    return { input, options };
  }
  const tip = {
    repository: createPostgresPaymentTipSelectionStore(transactions, scope, { now }),
    audit: {
      create: async (record) => ({
        auditId: credentials.reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TIP_SELECT",
        targetType: "PaymentTipSelection",
        targetId: record.selectionReference,
        reasonCode: "AUTHORIZED_PAYMENT_TIP_SELECT",
        correlationId: record.submissionReference,
        occurredAt: record.selectedAt,
        sourceChannel: "CUSTOMER_PWA",
        dataClassification: "Restricted",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      }),
    },
  };
  return {
    orders: {
      async create(value) {
        const { input, options } = await resolve(value);
        return orderComposition(checkout.accessOptions, options).create(input);
      },
      async preparePaymentClock(value) {
        const { input, options } = await resolve(value);
        return orderComposition(checkout.accessOptions, options).preparePaymentClock(input);
      },
    },
    tips: {
      async select(value) {
        const { options } = await resolve(value, true);
        return tipComposition(checkout.accessOptions, { submission: options, tip }).select(value);
      },
    },
  };
}
