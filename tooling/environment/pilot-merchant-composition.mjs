import { join } from "node:path";
import { createInternalRefundReconciliation } from "./pilot-refund-reconciliation.mjs";
import { createInternalRefundSend } from "./pilot-refund-send.mjs";
import { createInternalRefundPreparation } from "./pilot-refund-preparation.mjs";
import { createInternalMerchantDining } from "./pilot-merchant-dining.mjs";
import { createInternalMerchantPickup } from "./pilot-merchant-pickup.mjs";
import { createInternalKitchenCommand } from "./pilot-kitchen-command.mjs";
import { createInternalMerchantAcceptance } from "./pilot-merchant-acceptance.mjs";
import { createInternalMerchantSession } from "./pilot-merchant-session.mjs";
import { createInternalMerchant } from "./pilot-merchant.mjs";
import { createInternalDiningCredentialLoaders } from "./pilot-dining-credentials.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { refreshInternalOrderReceiptObservations } from "./pilot-receipt-observations.mjs";
const factories = {
  createInternalRefundReconciliation,
  createInternalRefundSend,
  createInternalRefundPreparation,
  createInternalMerchantDining,
  createInternalMerchantPickup,
  createInternalKitchenCommand,
  createInternalMerchantAcceptance,
  createInternalMerchantSession,
  createInternalMerchant,
  createInternalDiningCredentialLoaders,
  createInternalCredentialLoaders,
  refreshInternalOrderReceiptObservations,
};
export function composeMerchantDependencies(
  directory,
  installation,
  config,
  customerConfig,
  customer,
  { implementations = factories } = {},
) {
  const f = implementations,
    account = { providerAccountReference: customerConfig.providerAccountReference };
  const credentials = f.createInternalCredentialLoaders({
    file: join(directory, "internal-test-keys.json"),
    loadProfile: installation.loadProfile,
    expectedDatabaseName: installation.database,
  });
  const dining = f.createInternalDiningCredentialLoaders({
    path: join(directory, "internal-test-dining-key"),
  });
  const provider = customer.createInternalSimulatedProvider;
  return {
    exceptionPaymentMode: customer.paymentChannel,
    ...account,
    expectedDatabaseName: installation.database,
    roleMapping: config.roleMapping,
    loadTaskQueue: installation.loadTaskQueue,
    createInternalRefundPreparation: f.createInternalRefundPreparation,
    createInternalRefundSend: (options) =>
      f.createInternalRefundSend({ ...options, ...account, createSimulatedProvider: provider }),
    createInternalRefundReconciliation: (options) =>
      f.createInternalRefundReconciliation({
        ...options,
        ...account,
        createSimulatedProvider: provider,
        refreshOrderReceiptObservations: (r, order, authorize) =>
          f.refreshInternalOrderReceiptObservations(r, order, authorize, {
            ...account,
            createSimulatedProvider: provider,
          }),
      }),
    createInternalDiningCredentials: dining.createInternalDiningCredentials,
    createInternalMerchantDining: f.createInternalMerchantDining,
    createInternalKitchenCommand: f.createInternalKitchenCommand,
    createInternalMerchantPickup: (r, merchant, confirmation = null) =>
      f.createInternalMerchantPickup(r, merchant, confirmation, {
        createProof: customer.createInternalPickupProof,
        loadCredentials: credentials.createInternalMerchantCredentials,
        workstation: config.workstation,
      }),
    createInternalMerchantAcceptance: (r, persistence, authentication) =>
      f.createInternalMerchantAcceptance(r, persistence, authentication, {
        loadPickupWorkflow: () => installation.loadWorkflow("Pickup"),
        loadDiningWorkflow: () => installation.loadWorkflow("DineIn"),
        expectedDatabaseName: installation.database,
        ...account,
      }),
    createInternalMerchantSession: (r) =>
      f.createInternalMerchantSession(r, {
        loadEmployee: () => installation.loadCustomerData("internal-test-merchant.json"),
        expectedDatabaseName: installation.database,
        createInternalMerchantCredentials: credentials.createInternalMerchantCredentials,
      }),
  };
}
export function composeConfiguredMerchant(
  directory,
  installation,
  config,
  customerConfig,
  customer,
) {
  const dependencies = composeMerchantDependencies(
    directory,
    installation,
    config,
    customerConfig,
    customer,
  );
  return (resources) => createInternalMerchant(resources, dependencies);
}
