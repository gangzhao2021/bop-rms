import { join } from "node:path";
import process from "node:process";
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
import { createPilotPaymentProvider, isStripeProvider } from "./pilot-stripe-provider.mjs";
import { loadPilotPaymentConfig } from "./pilot-payment-config.mjs";
import { createPilotStripeWebhookReceiver } from "./pilot-stripe-webhook.mjs";
import { currentPilotEnvironment } from "./pilot-environment.mjs";
import { createInternalOrder } from "./pilot-order.mjs";
import { createInternalCheckout } from "./pilot-checkout.mjs";
import { createInternalCheckoutDetails } from "./pilot-checkout-details.mjs";
import {
  createInternalInventoryEvidence,
  createInternalStaffStockShortage,
  createInternalTestItems,
} from "./pilot-items.mjs";
import { createInternalTestCart } from "./pilot-cart.mjs";
import { createInternalCustomerEntry } from "./pilot-customer-entry.mjs";
import { createInternalPickupEntry } from "./pilot-entry.mjs";
import { createIssuedDiningEntries } from "./pilot-dining-issued-entry.mjs";
import { createInternalDiningSession } from "./pilot-dining-session.mjs";
import { createInternalMerchantSession } from "./pilot-merchant-session.mjs";
import { createInternalQrLoaders } from "./pilot-qr.mjs";
import { createInternalDiningCredentialLoaders } from "./pilot-dining-credentials.mjs";
import { createInternalCredentialLoaders } from "./pilot-credentials.mjs";
import { createInternalConfiguredQuote } from "./pilot-configured-quote.mjs";
import { createInternalPricingPolicy } from "./pilot-pricing-policy.mjs";
import { createInternalReadTransactions } from "./pilot-read-transactions.mjs";
import { createCustomerMenuStoreFacts } from "../../apps/api/dist/customer-menu-store-facts.js";
import { createInternalAdditionalPayment } from "./pilot-additional-payment.mjs";
import { createInternalPaymentIntent } from "./pilot-payment-intent.mjs";
import { createInternalOrderConfirmation } from "./pilot-order-confirmation.mjs";
import { INTERNAL_CUSTOMER_ORIGIN, loadPilotHosting } from "./pilot-hosting.mjs";

export async function createConfiguredPilotApiRuntime(
  directory,
  options,
  {
    loadInstallation = loadPilotInstallation,
    createResources = createConfiguredPilotResources,
    composeRuntime = createRuntime,
    loadHosting = loadPilotHosting,
  } = {},
) {
  const installation = await loadInstallation(directory);
  const config = await installation.loadCustomerRuntime();
  const dependencies = composeCustomerDependencies(
    directory,
    installation,
    config,
    await loadHosting(directory),
  );
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
export function composeCustomerDependencies(directory, installation, config, hosting = null) {
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
      // WP-2423 Q11: dine-in entry uses the table codes staff issued on DIN-TABLE-LIST.
      createInternalDiningEntries: (resources) =>
        createIssuedDiningEntries(resources, {
          loadProfile: installation.loadProfile,
          loadKeys: qr.loadIssuedTableQrKeys,
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
    // hosting.json customerOrigin: exact Origin/Host the customer and staff pages are served on.
    publicOrigin: hosting?.origin ?? INTERNAL_CUSTOMER_ORIGIN,
    paymentChannel: "InternalTestOnlineCardAutomatic",
    ...account,
    createInternalCustomerEntry: entry,
    createInternalTestCart: cart,
    createInternalCartReplacement: (r, e) =>
      createInternalCartReplacement(r, e, { createCart: cart, ...account }),
    createInternalDiningCart: (r, items) =>
      createInternalDiningCart(r, items, { createCart: cart }),
    createInternalTestItems: async (r, sourceChannel = "Qr") =>
      createInternalTestItems(
        r,
        {
          saved: await installation.loadCustomerData("internal-test-inventory.json"),
          expectedDatabaseName,
        },
        sourceChannel,
      ),
    // WP-2423 8.6: the menu shows the Store's offers, sold-out items and the prices the Quote uses.
    // WP-2423 Q12: items whose ingredients have run out show sold out, from the Store's stock.
    createInternalMenuStoreFacts: async (r) =>
      createCustomerMenuStoreFacts({
        transactions: createInternalReadTransactions(r),
        currencyMetadata: (await pricing()).currencyMetadata,
        priceChannelCode: "CUSTOMER_WEB",
        inventory: createInternalInventoryEvidence(r, {
          saved: await installation.loadCustomerData("internal-test-inventory.json"),
          expectedDatabaseName,
        }),
      }),
    // WP-2423 (2026-10-16): staff see why an item shows sold out to guests from stock.
    createInternalStaffStockShortage: async (r) =>
      createInternalStaffStockShortage(r, {
        saved: await installation.loadCustomerData("internal-test-inventory.json"),
        expectedDatabaseName,
      }),
    createInternalChannelQuote: (r, e, c, i) =>
      createInternalChannelQuote(r, e, c, i, {
        createConfiguredQuote: (resources, orderType) =>
          createInternalConfiguredQuote(resources, orderType, { loadPricingPolicy: pricing }),
      }),
    createInternalCheckout,
    createInternalCheckoutDetails,
    createInternalDiningCheckout,
    createInternalOrder: (r, c, items, type = "Pickup") =>
      createInternalOrder(r, c, items, type, workflow),
    createInternalPickupReadiness: readiness,
    createInternalPickupProof: proof,
    // DEC-STRIPE-PILOT-WIRING: the configured Provider (payment.json): Stripe test mode, or the
    // TEST-ONLY internal simulator when the installation has no Stripe configuration.
    createInternalSimulatedProvider: (opts = {}) =>
      createPilotPaymentProvider(opts, {
        directory,
        path: join(directory, "simulated-provider.sqlite"),
        loadProfile: installation.loadProfile,
        expectedDatabaseName,
      }),
    // Stripe mode only: the webhook receiver of the API runtime.
    createPaymentWebhookReceiver: (resources, provider) =>
      createPaymentWebhookReceiver(directory, resources, provider, account),
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
/** DEC-STRIPE-PILOT-WIRING: the Stripe webhook receiver, or null in simulation mode. */
async function createPaymentWebhookReceiver(directory, resources, provider, account) {
  if (!isStripeProvider(provider)) return null;
  const config = await loadPilotPaymentConfig(directory, {
    environment: currentPilotEnvironment(),
  });
  if (config.provider !== "stripe") return null;
  return createPilotStripeWebhookReceiver(resources, {
    provider,
    directory,
    stripe: config.stripe,
    providerAccountReference: account.providerAccountReference,
    // Reason code only; never the body, signature, Provider IDs or payment data.
    onRejected: (reasonCode) =>
      process.stderr.write(
        JSON.stringify({ event: "payment_webhook_rejected", reasonCode }) + "\n",
      ),
  });
}
