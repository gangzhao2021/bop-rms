import { join } from "node:path";
import { createConfiguredPilotResources } from "./pilot-configured-resources.mjs";
import { loadPilotInstallation } from "./pilot-installation.mjs";
import { createRuntime } from "./pilot-api.mjs";
import { createInternalCartReplacement } from "./pilot-cart-replacement.mjs";
import { createInternalDiningCheckout } from "./pilot-dining-checkout.mjs";
import { createInternalChannelQuote } from "./pilot-channel-quote.mjs";
import { createInternalDiningCart } from "./pilot-dining-cart.mjs";
import { createInternalPickupReadiness } from "./pilot-pickup-readiness.mjs";
import { createInternalPickupProof } from "./pilot-pickup-proof.mjs";
import { createInternalPaymentTerminal } from "./pilot-payment-terminal.mjs";
import { createInternalChannelPayment } from "./pilot-channel-payment.mjs";
import { createInternalSimulatedProvider } from "./pilot-payment-provider.mjs";
import { createInternalOrder } from "./pilot-order.mjs";
import { createInternalCheckout } from "./pilot-checkout.mjs";
import { createInternalCheckoutDetails } from "./pilot-checkout-details.mjs";
import { createInternalTestItems } from "./pilot-items.mjs";
import { createInternalTestCart } from "./pilot-cart.mjs";
import { createInternalCustomerEntry } from "./pilot-customer-entry.mjs";
import { createInternalPickupEntry } from "./pilot-entry.mjs";
import { createInternalDiningEntries } from "./pilot-dining-entry.mjs";
import { createInternalDiningEntry } from "./pilot-dining-entry.mjs";
import { createInternalDiningSession } from "./pilot-dining-session.mjs";
import { createInternalMerchantSession } from "./pilot-merchant-session.mjs";
import { createInternalQrLoaders } from "./pilot-qr.mjs";
import { createInternalDiningCredentialLoaders } from "./pilot-dining-credentials.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createInternalTestQuote } from "./pilot-quote.mjs";
import { createInternalPricingPolicy } from "./pilot-pricing-policy.mjs";
import { createInternalAdditionalPayment } from "./pilot-additional-payment.mjs";
import { createInternalPaymentIntent } from "./pilot-payment-intent.mjs";
import { createInternalOrderConfirmation } from "./pilot-order-confirmation.mjs";

export async function createConfiguredPilotApiRuntime(
  directory,
  options,
  {
    loadInstallation = loadPilotInstallation,
    createResources = createConfiguredPilotResources,
    composeRuntime = createRuntime,
  } = {},
) {
  const installation = await loadInstallation(directory);
  const config = await installation.loadCustomerRuntime();
  const dependencies = composeCustomerDependencies(directory, installation, config);
  return composeRuntime(options, {
    ...dependencies,
    createInternalTestResources: async () => {
      const resources = await createResources(directory);
      if (
        Object.entries(config.scope).some(
          ([key, value]) => resources.publicProfile.binding[key] !== value,
        )
      ) {
        await resources.close();
        throw Error("CUSTOMER_RUNTIME_SCOPE_CHANGED");
      }
      return resources;
    },
  });
}
export function composeCustomerDependencies(directory, installation, config) {
  const expectedDatabaseName = installation.database;
  const account = { providerAccountReference: config.providerAccountReference };
  const workflow = { loadWorkflow: installation.loadWorkflow, expectedDatabaseName };
  const qr = createInternalQrLoaders({
    file: join(directory, "internal-test-qr-key.pem"),
    loadProfile: installation.loadProfile,
    expectedDatabaseName,
  });
  const credentials = createInternalCredentialLoaders({
    file: join(directory, "internal-test-keys.json"),
    loadProfile: installation.loadProfile,
    expectedDatabaseName,
  });
  const diningCredentials = createInternalDiningCredentialLoaders({
    path: join(directory, "internal-test-dining-key"),
  });
  const merchant = (r) =>
    createInternalMerchantSession(r, {
      loadEmployee: () => installation.loadCustomerData("internal-test-merchant.json"),
      expectedDatabaseName,
      createInternalMerchantCredentials: credentials.createInternalMerchantCredentials,
    });
  const entry = (r) =>
    createInternalCustomerEntry(r, {
      createInternalPickupEntry: (resources) =>
        createInternalPickupEntry(resources, {
          loadProfile: installation.loadProfile,
          loadQr: qr.loadInternalPickupQr,
        }),
      createInternalDiningEntries: (resources) =>
        createInternalDiningEntries(resources, {
          loadEntries: () =>
            Promise.all(
              config.diningTableFiles.map((name) =>
                createInternalDiningEntry(resources, {
                  loadProfile: installation.loadProfile,
                  loadTable: () => installation.loadCustomerData(name),
                  loadQr: qr.loadInternalDiningQr,
                }),
              ),
            ),
        }),
      createInternalDiningSession: (resources, m) =>
        createInternalDiningSession(resources, m, {
          loadCredentials: diningCredentials.createInternalDiningCredentials,
        }),
      createInternalMerchantSession: merchant,
    });
  const cart = (r) => createInternalTestCart(r, config.cart);
  const confirmation = (r) => createInternalOrderConfirmation(r, account);
  const readiness = (r, c = null) =>
    createInternalPickupReadiness(r, c, { createConfirmation: confirmation });
  const proof = (r, c = null) => createInternalPickupProof(r, c, { createReadiness: readiness });
  const pricing = () =>
    createInternalPricingPolicy({
      loadProfile: installation.loadProfile,
      loadMenu: installation.loadMenu,
      expectedDatabaseName,
    });
  return {
    paymentChannel: "InternalTestOnlineCardAutomatic",
    ...account,
    createInternalCustomerEntry: entry,
    createInternalTestCart: cart,
    createInternalCartReplacement: (r, e) =>
      createInternalCartReplacement(r, e, { createCart: cart, ...account }),
    createInternalDiningCart: (r, items) =>
      createInternalDiningCart(r, items, { createCart: cart }),
    createInternalTestItems: async (r) =>
      createInternalTestItems(r, {
        saved: await installation.loadCustomerData("internal-test-inventory.json"),
        expectedDatabaseName,
      }),
    createInternalChannelQuote: (r, e, c) =>
      createInternalChannelQuote(r, e, c, {
        createQuote: (resources, orderType = "Pickup") =>
          createInternalTestQuote(resources, orderType, { loadPricingPolicy: pricing }),
      }),
    createInternalCheckout,
    createInternalCheckoutDetails,
    createInternalDiningCheckout,
    createInternalOrder: (r, c, items, type = "Pickup") =>
      createInternalOrder(r, c, items, type, workflow),
    createInternalPickupReadiness: readiness,
    createInternalPickupProof: proof,
    createInternalSimulatedProvider: (opts = {}) =>
      createInternalSimulatedProvider(opts, {
        path: join(directory, "simulated-provider.sqlite"),
        loadProfile: installation.loadProfile,
        expectedDatabaseName,
      }),
    createInternalPaymentTerminal: (r, c, i, s) =>
      createInternalPaymentTerminal(r, c, i, s, account),
    createInternalChannelPayment: (r, c, d, o, orders, simulator, items) =>
      createInternalChannelPayment(r, c, d, o, orders, simulator, items, {
        createPaymentIntent: (resources, checkout, order, provider, type = "Pickup") =>
          createInternalPaymentIntent(resources, checkout, order, provider, type, {
            ...workflow,
            controlReference: config.controlReference,
          }),
        createAdditionalPayment: async (
          resources,
          checkout,
          diningCheckout,
          order,
          catalogOptions,
          provider,
          route,
        ) =>
          createInternalAdditionalPayment(
            resources,
            checkout,
            diningCheckout,
            order,
            catalogOptions,
            provider,
            route,
            {
              saved: await installation.loadWorkflow("DineIn"),
              expectedDatabaseName,
              controlReference: config.controlReference,
            },
          ),
      }),
  };
}
