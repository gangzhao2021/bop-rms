import { CustomerStoreClosedError } from "../../apps/api/dist/customer-store-open-gate.js";
import { createLocalCustomerRuntime } from "../../apps/api/dist/local-customer-runtime.js";
import { HealthReadinessController } from "../../apps/api/dist/health-readiness.js";
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
    providerAccountReference,
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
      pickupCode: {
        readiness: ready.storeOptions,
        proof: proof.storeOptions,
        credentials: resources.credentials.pickup,
        storeDisplayName: "DEMO Store - Simulated payments only",
        pickupInstruction: "Show this pickup confirmation to DEMO staff at the pickup counter.",
      },
      ...createInternalTestCart(resources),
      ...items,
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
      receipt: {
        financial: {
          scope: {
            tenantReference: resources.publicProfile.binding.tenantReference,
            ...resources.scope,
          },
          providerAccountReference,
          environment: "Test",
        },
        transactions: resources.transactions,
        binding: (tx) => configuredEntry.binding({ run: (work) => work(tx) }),
      },
      orderStatus: {
        diningScope: {
          tenantReference: resources.publicProfile.binding.tenantReference,
          ...resources.scope,
        },
        transactions: resources.transactions,
        binding: (tx) => configuredEntry.binding({ run: (work) => work(tx) }),
        paymentScope: { ...resources.scope, providerAccountReference, environment: "Test" },
      },
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
      allowedOrigin: "https://127.0.0.1:4443",
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
