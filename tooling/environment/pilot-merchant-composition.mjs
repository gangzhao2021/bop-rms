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
import { createInternalMerchantProduct } from "./pilot-merchant-product.mjs";
import { createInternalPricingPolicy } from "./pilot-pricing-policy.mjs";
import { createInternalDiningCredentialLoaders } from "./pilot-dining-credentials.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { refreshInternalOrderReceiptObservations } from "./pilot-receipt-observations.mjs";
import { createInternalStaffTotpVerifier } from "./pilot-staff-totp.mjs";
import { createInternalCounterOrder } from "./pilot-counter-order.mjs";
import { createInternalQrLoaders } from "./pilot-qr.mjs";
import { createMerchantDiningTableQr } from "../../apps/api/dist/merchant-dining-table-qr.js";
import { createPilotAlertBoardReader } from "./pilot-ops-files.mjs";
import { createInternalBatchCancellation } from "./pilot-batch-cancellation.mjs";
import { createInternalOpenPaymentResolution } from "./pilot-open-payment-resolution.mjs";
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
  createInternalMerchantProduct,
  createInternalDiningCredentialLoaders,
  createInternalCredentialLoaders,
  refreshInternalOrderReceiptObservations,
  createInternalCounterOrder,
  createInternalQrLoaders,
  createMerchantDiningTableQr,
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
    // WP-2423 Q13: the operations monitor's alert board (ops container) for the Home.
    readOperationsAlertBoard: createPilotAlertBoardReader(directory),
    expectedDatabaseName: installation.database,
    roleMapping: config.roleMapping,
    ...(config.product?.optionPriceSources?.currencyMetadata === undefined
      ? {}
      : {
          taxConfigCurrencyMetadata: config.product.optionPriceSources.currencyMetadata,
        }),
    ...(config.product === undefined
      ? {}
      : {
          createInternalMerchantProduct: (resources, persistence, authentication) =>
            f.createInternalMerchantProduct(resources, {
              persistence,
              authentication,
              configuration: { scope: config.scope, product: config.product },
              createCursorKey: credentials.createInternalCatalogCursorKey,
            }),
        }),
    loadTaskQueue: installation.loadTaskQueue,
    // WP-2423 / DEC-PRICE-STORE-ASSIGNMENT: TEST-ONLY synthetic CAD metadata of the internal pricing policy.
    loadPricingCurrencyMetadata: async () =>
      (
        await createInternalPricingPolicy({
          loadProfile: installation.loadProfile,
          loadMenu: installation.loadMenu,
          expectedDatabaseName: installation.database,
        })
      ).currencyMetadata,
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
    // WP-2423 item 4: refresh the online rounds' Provider snapshots before a card-machine refund
    // adds a refund version to a mixed (online and card-machine) dine-in receipt.
    refreshOrderReceiptObservations: (r, order, authorize) =>
      f.refreshInternalOrderReceiptObservations(r, order, authorize, {
        ...account,
        createSimulatedProvider: provider,
      }),
    // WP-2423 Q6 step 2a: TEST-ONLY internal simulator for item cancellation refunds (dispatch
    // through the ordinary refund journal; an unknown result is only looked up).
    cancellationRefundProvider: {
      refundPayment: async (request) => {
        const simulator = await provider();
        try {
          return await simulator.adapter.refundPayment(request);
        } finally {
          simulator.close();
        }
      },
      lookupRefund: async (request) => {
        const simulator = await provider();
        try {
          return await simulator.adapter.lookupRefund(request);
        } finally {
          simulator.close();
        }
      },
    },
    // WP-2423 Q5: TEST-ONLY authenticator secrets in the private runtime directory.
    staffTotpVerifier: createInternalStaffTotpVerifier({ directory }),
    // WP-2423 menu descriptions and photos: pilot storage adapter for product photos (production
    // object storage is an external gate).
    productImageDirectory: join(directory, "media", "product-images"),
    // WP-2423 P6: TEST-ONLY internal simulator for the unmatched capture refund.
    refundUnmatchedCapture: async (request) => {
      const simulator = await provider();
      try {
        return await simulator.adapter.refundPayment(request);
      } finally {
        simulator.close();
      }
    },
    // WP-2423 (2026-10-16): item availability shows staff why guests see an item sold out.
    ...(typeof customer.createInternalStaffStockShortage === "function"
      ? { createInternalStaffStockShortage: customer.createInternalStaffStockShortage }
      : {}),
    // WP-2423 Q7: staff take counter pickup orders paid on the Store's own card machine; the walk-up
    // guest enters through the Store's pickup QR like a customer scanning it at the counter.
    createInternalCounterOrder: (resources, persistence, authentication, extra = {}) => {
      const qr = f.createInternalQrLoaders({
        file: join(directory, "internal-test-qr-key.pem"),
        loadProfile: installation.loadProfile,
        expectedDatabaseName: installation.database,
      });
      return f.createInternalCounterOrder(resources, persistence, authentication, {
        customer,
        loadPickupWorkflow: () => installation.loadWorkflow("Pickup"),
        // WP-2423 Q7 slice 2: staff-entered dine-in rounds pass the dine-in payment workflow.
        loadDiningWorkflow: () => installation.loadWorkflow("DineIn"),
        loadPickupQrToken: async () =>
          (await qr.loadInternalPickupQr(await installation.loadProfile())).token(),
        expectedDatabaseName: installation.database,
        ...extra,
      });
    },
    // WP-2423 Q11 (DEC-TABLE-QR-ISSUANCE): table QR codes signed with the TEST-ONLY local QR key
    // and opening the TEST-ONLY local customer origin. Both are replaced by the managed QR key and
    // the public customer domain (capability gaps "Secrets" and "Tls") without changing this flow.
    createInternalTableQr: (resources, persistence, authentication) => {
      const qr = f.createInternalQrLoaders({
        file: join(directory, "internal-test-qr-key.pem"),
        loadProfile: installation.loadProfile,
        expectedDatabaseName: installation.database,
      });
      return f.createMerchantDiningTableQr({
        persistence,
        authentication,
        newReference: () => resources.credentials.reference(),
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
        signer: {
          sign: async (payload) =>
            (await qr.loadIssuedTableQrKeys(await installation.loadProfile())).signer.sign(payload),
        },
        publicStore: async (storeReference) => {
          const profile = await installation.loadProfile();
          return storeReference === profile.binding.storeReference
            ? { publicStoreReference: profile.binding.publicStoreReference, locale: "en-CA" }
            : null;
        },
        customerOrigin: "https://127.0.0.1:4443",
      });
    },
    // WP-2423 abandoned payment: managers cancel an unpaid dine-in round before its deadline with
    // the System's own unpaid round cancellation (same Workflow, installed for the business worker)
    // after Payment resolved the round's online attempt with the TEST-ONLY simulated Provider.
    createInternalUnpaidRoundCancellation: async (resources) => {
      const worker = await installation.loadBusinessWorker();
      if (worker.workloads?.batchCancellation !== true) return undefined;
      return {
        cancellation: await createInternalBatchCancellation(resources, {
          loadWorkflow: installation.loadCancellationWorkflow,
          expectedDatabaseName: installation.database,
          systemActorReference: worker.actors.paidOutcome,
          ...account,
        }),
        payment: createInternalOpenPaymentResolution(resources, {
          createSimulatedProvider: provider,
          ...account,
        }),
      };
    },
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
    // WP-2423 Q18 option A: staff PIN pepper and shared-tablet key (TEST-ONLY derived keys).
    createInternalStaffPinCredentials: credentials.createInternalStaffPinCredentials,
    // WP-2423: the settlement page answers a day before coverage with the first covered day.
    loadDailySettlementCoverage: installation.loadDailySettlementCoverage,
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
