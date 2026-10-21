import { CustomerStoreClosedError } from "../../apps/api/dist/customer-store-open-gate.js";
import { createLocalCustomerRuntime } from "../../apps/api/dist/local-customer-runtime.js";
import { HealthReadinessController } from "../../apps/api/dist/health-readiness.js";
import { INTERNAL_CUSTOMER_ORIGIN } from "./pilot-hosting.mjs";
import { pilotProviderEnvironment } from "./pilot-environment.mjs";
/** Internal test composition only. All unconfigured business routes remain unavailable. */
export async function createRuntime(
  { port },
  {
    createInternalCartReplacement,
    createInternalDiningCheckout,
    createInternalChannelQuote,
    createInternalDiningCart,
    createInternalPickupReadiness,
    createInternalPickupProof,
    createInternalPaymentTerminal,
    createInternalChannelPayment,
    createInternalSimulatedProvider,
    createInternalOrder,
    createInternalCheckout,
    createInternalCheckoutDetails,
    createInternalTestItems,
    createInternalMenuStoreFacts,
    createInternalTestCart,
    createInternalTestResources,
    createInternalCustomerEntry,
    createPaymentWebhookReceiver,
    providerAccountReference,
    publicOrigin = INTERNAL_CUSTOMER_ORIGIN,
  },
) {
  const resources = await createInternalTestResources();
  let simulator;
  try {
    const configuredEntry = await createInternalCustomerEntry(resources),
      { entry } = configuredEntry;
    const items = await createInternalTestItems(resources);
    const diningCart = createInternalDiningCart(resources, items);
    const quote = await createInternalChannelQuote(resources, configuredEntry, diningCart, items);
    const checkout = createInternalCheckout(resources, configuredEntry, items.catalogCartItems);
    const diningCheckout = createInternalDiningCheckout(resources, configuredEntry, checkout);
    const orders = await createInternalOrder(resources, checkout, items.catalogCartItems);
    const diningOrders = await createInternalOrder(
      resources,
      { ...checkout, preparation: diningCheckout.preparation },
      items.catalogCartItems,
      "DineIn",
    );
    simulator = await createInternalSimulatedProvider();
    // DEC-STRIPE-PILOT-WIRING: Stripe mode receives Stripe's signed events on the API runtime.
    const paymentProviderWebhook =
      createPaymentWebhookReceiver === undefined
        ? null
        : await createPaymentWebhookReceiver(resources, simulator);
    const paymentIntent = await createInternalChannelPayment(
      resources,
      checkout,
      diningCheckout,
      orders,
      diningOrders,
      simulator,
      items.catalogCartItems,
    );
    const paymentTerminal = createInternalPaymentTerminal(
      resources,
      checkout,
      paymentIntent,
      simulator,
    );
    const ready = createInternalPickupReadiness(resources),
      proof = createInternalPickupProof(resources);
    const runtime = createLocalCustomerRuntime({
      cartReplacement: createInternalCartReplacement(resources, configuredEntry),
      ...diningCart,
      diningAdmission: configuredEntry.diningAdmission,
      diningInvitation: configuredEntry.diningInvitation,
      pickupCode: {
        readiness: ready.storeOptions,
        proof: proof.storeOptions,
        credentials: resources.credentials.pickup,
        // Fallback only: the panel names the Store from its published profile (WP-2423
        // DEC-STORE-CUSTOMER-NAME); the Store record name is used when none is published.
        storeDisplayName: resources.store.displayName,
        pickupInstruction: "Show this pickup confirmation to staff at the pickup counter.",
      },
      ...createInternalTestCart(resources),
      ...items,
      // WP-2423: guests remove an item from a pickup Cart with the same Cart writes, references
      // and audit as adding one (without it removal fell back to a read-only port: always 503).
      cartRemoval: {
        writeTransactions: items.catalogCartItems.writeTransactions,
        references: items.catalogCartItems.references,
        audit: items.catalogCartItems.audit,
      },
      channelOrderSubmission: {
        pickup: orders.orderSubmission,
        dining: diningOrders.orderSubmission,
      },
      // WP-2423 Q4: payment does not start once the Store stops taking this order.
      paymentIntent: {
        ...paymentIntent,
        async create(input) {
          if (!(await diningCheckout.takesOrder(input))) throw new CustomerStoreClosedError();
          return paymentIntent.create(input);
        },
      },
      paymentResult: paymentTerminal.resultOptions,
      ...(paymentProviderWebhook === null ? {} : { paymentProviderWebhook }),
      receipt: {
        financial: {
          scope: {
            tenantReference: resources.publicProfile.binding.tenantReference,
            ...resources.scope,
          },
          providerAccountReference,
          environment: pilotProviderEnvironment(),
        },
        transactions: resources.transactions,
        binding: (tx) => configuredEntry.binding({ run: (work) => work(tx) }),
        // WP-2423 Q16: the receipt links the Store's privacy notice once its Owner entered one.
        privacyNotice: true,
      },
      orderStatus: {
        diningScope: {
          tenantReference: resources.publicProfile.binding.tenantReference,
          ...resources.scope,
        },
        transactions: resources.transactions,
        binding: (tx) => configuredEntry.binding({ run: (work) => work(tx) }),
        paymentScope: {
          ...resources.scope,
          providerAccountReference,
          environment: pilotProviderEnvironment(),
        },
        // WP-2423 Q16: the order page offers "Remove my contact details" and the privacy notice.
        contactPrivacy: true,
        itemRefundScope: {
          tenantReference: resources.publicProfile.binding.tenantReference,
          providerAccountReference,
          environment: pilotProviderEnvironment(),
        },
      },
      // WP-2423: the start and menu pages show the Store's address and today's hours from the
      // same published operating reader the entry gate uses.
      storeOperatingReader: resources.operatingReader,
      checkoutSessions: diningCheckout.checkoutSessions,
      ...quote,
      ...createInternalCheckoutDetails(resources, entry, diningCheckout.preparation),
      scope: resources.scope,
      entry,
      entryRequestAdmission: resources.requestAdmission,
      sessionTransactions: resources.transactions,
      menuTransactions: {
        run: (work) =>
          resources.transactions.run(async (tx) => {
            await tx.query("SET TRANSACTION READ ONLY", []);
            return work(tx);
          }),
      },
      ...(createInternalMenuStoreFacts === undefined
        ? {}
        : { menuStoreFacts: await createInternalMenuStoreFacts(resources) }),
      menuStores: {
        resolvePublic: async (reference) => {
          if (String(reference) !== resources.publicProfile.binding.publicStoreReference)
            return null;
          const result = await resources.stores.getPublicStore({
            publicStoreReference: reference,
            evaluatedAt: resources.now(),
            purpose: "CustomerEntry",
            requestedLocale: "en-CA",
          });
          return result.status === "Available" ? { ...resources.scope, status: "Active" } : null;
        },
      },
      allowedOrigin: publicOrigin,
      // DEC-PILOT-NOTIFICATIONS: order-message options, one-time order link, SES feedback.
      // Without composed order messaging (no runtime directory) nothing is offered.
      orderMessaging:
        resources.orderMessaging === undefined
          ? { availability: () => ({ sms: false, email: false }) }
          : {
              availability: resources.orderMessaging.availability,
              recovery: resources.orderMessaging.recovery,
              ...(resources.orderMessaging.feedback === undefined
                ? {}
                : { feedback: resources.orderMessaging.feedback }),
            },
      now: resources.now,
      uuidV7Factory: resources.credentials.reference,
      runtime: {
        port,
        healthReadiness: new HealthReadinessController({ databaseProbe: resources.database.probe }),
      },
    });
    let closing;
    return {
      ...runtime,
      shutdown(signal) {
        closing ??= (async () => {
          try {
            await runtime.shutdown(signal);
          } finally {
            try {
              simulator?.close();
            } finally {
              await resources.close();
            }
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    try {
      simulator?.close();
    } finally {
      await resources.close();
    }
    throw error;
  }
}
