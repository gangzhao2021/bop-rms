import {
  GuestSessionService,
  createPostgresGuestSessionEntryStore,
} from "../../packages/bop/identity/src/index.ts";
import {
  createCatalogSelectionDisplayQuery,
  createCustomerMenuQueryService,
  createPostgresPublishedMenuQueryStore,
} from "../../packages/rms/catalog/src/index.ts";
import {
  createCustomerCartViewQuery,
  createPickupCartReadService,
  createPostgresAnyCartQuoteReader,
  createPostgresPickupCartBindingReader,
} from "../../packages/rms/ordering/src/index.ts";
import { createPostgresSubmissionFinalValidationStore } from "../../packages/rms/inventory/src/index.ts";
import { createPersistentCustomerEntryComposition } from "../../apps/api/dist/persistent-customer-entry.js";
import { createPersistentPublicStoreProfileReader } from "../../apps/api/dist/persistent-public-store-profile.js";
import { createCustomerCartBindingComposition } from "../../apps/api/dist/customer-cart-binding-composition.js";
import { createCustomerCartItemWithCatalogComposition } from "../../apps/api/dist/customer-cart-item-composition.js";
import { createCustomerCartReadPort } from "../../apps/api/dist/customer-cart-read-composition.js";
import { createCustomerCheckoutSessionComposition } from "../../apps/api/dist/customer-checkout-session-composition.js";
import { createCustomerCheckoutSessionRead } from "../../apps/api/dist/customer-checkout-session-read.js";
import { createCustomerOrderPaymentClaimAdmission } from "../../apps/api/dist/customer-order-payment-admission.js";
import { createCustomerCapacityPaymentClaimAdmission } from "../../apps/api/dist/customer-capacity-payment-admission.js";
import { createCustomerInventoryPaymentClaimAdmission } from "../../apps/api/dist/customer-inventory-payment-admission.js";
import { createCustomerIntactReservationPaymentAction } from "../../apps/api/dist/customer-payment-workflow-action.js";
import {
  counterEntryOperatingReader,
  createCounterGuestPipeline,
} from "../../apps/api/dist/counter-guest-pipeline.js";
import {
  counterTakesOrder,
  createMerchantCounterOrder,
} from "../../apps/api/dist/merchant-counter-order.js";
import { createMerchantCounterMenu } from "../../apps/api/dist/merchant-counter-menu.js";
import { createMerchantCardMachinePayment } from "../../apps/api/dist/merchant-card-machine-payment.js";
import { createMerchantCardMachineCancellationRefund } from "../../apps/api/dist/merchant-card-machine-refund.js";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../packages/rms/store/src/index.ts";
import { createInternalPaymentPreparation } from "./pilot-payment-preparation.mjs";
import { reportUnexpected } from "./pilot-merchant-pickup.mjs";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { matchesPilotEnvironment } from "./pilot-environment.mjs";

/**
 * WP-2423 Q7 slice 1 (DEC-COUNTER-PAYMENT-RECORD): staff take a pickup order at the counter for a
 * guest without a phone, or enter a paper order taken during an outage, and record the payment the
 * Store's own card machine approved. The walk-up guest goes through the same customer owner ports
 * the customer app uses (entry with the Store's pickup QR, counter Cart, items with sold-out
 * checks, configured Quote with tax, store-open gate, checkout, submission, tip and payment clock);
 * the Cart is a counter (Pos) Cart and staff are recorded by Ordering. No Provider is involved.
 */
export async function createInternalCounterOrder(
  resources,
  persistence,
  authentication,
  { customer, loadPickupWorkflow, loadPickupQrToken, expectedDatabaseName },
) {
  const saved = await loadPickupWorkflow();
  if (
    !matchesPilotEnvironment(saved.environment) ||
    saved.database !== expectedDatabaseName ||
    saved.scope.storeReference !== resources.scope.storeReference
  )
    throw new Error("INTERNAL_COUNTER_ORDER_ONLY");
  const { scope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const tenantReference = resources.publicProfile.binding.tenantReference;
  const fullScope = { tenantReference, ...scope };
  const configuredEntry = await customer.createInternalCustomerEntry(resources);
  const entry = configuredEntry.entry;
  // The counter sells the same pickup menu as the customer app, from a counter (Pos) Cart.
  const items = await customer.createInternalTestItems(resources, "Pos");
  const testCart = customer.createInternalTestCart(resources);
  // A counter Cart: the same Cart policy as a customer's, created at the counter (Pos).
  const cartBinding = {
    ...testCart.cartBinding,
    ordering: { ...testCart.cartBinding.ordering, sourceChannel: "Pos" },
  };
  const diningCart = customer.createInternalDiningCart(
    resources,
    await customer.createInternalTestItems(resources),
  );
  const quotes = (
    await customer.createInternalChannelQuote(resources, configuredEntry, diningCart, items)
  ).configuredCartQuote.pickup;
  const checkout = customer.createInternalCheckout(
    resources,
    configuredEntry,
    items.catalogCartItems,
  );
  // The same checkout details record a customer saves (a walk-up guest gives no contact).
  const { checkoutDetails } = customer.createInternalCheckoutDetails(resources, entry);
  const orders = await customer.createInternalOrder(resources, checkout, items.catalogCartItems);
  const prepared = createInternalPaymentPreparation(resources, checkout, orders);
  const store = createPostgresGuestSessionEntryStore(transactions, scope);
  const sessions = new GuestSessionService({
    ...entry.session,
    store,
    admission: { consume: async () => null },
    now,
  });
  const readOnly = {
    run: (work) =>
      transactions.run(async (tx) => {
        await tx.query("SET TRANSACTION READ ONLY", []);
        return work(tx);
      }),
  };
  const projections = createPostgresPublishedMenuQueryStore(readOnly, scope);
  const stores = createPersistentPublicStoreProfileReader({
    ...entry.persistent.profile,
    transactions: entry.persistent.transactions,
  });
  const query = createCustomerCartViewQuery({
    reads: createPickupCartReadService({
      sessions,
      binding: createPostgresPickupCartBindingReader(transactions, scope),
      scope,
      now,
    }),
    catalog: createCatalogSelectionDisplayQuery(projections),
    stores,
    quotes: createPostgresAnyCartQuoteReader(transactions, scope),
  });
  const cart = createCustomerCartItemWithCatalogComposition({
    ...items.catalogCartItems,
    scope,
    session: entry.session,
    sessionTransactions: transactions,
    cartTransactions: transactions,
    query,
    now,
    fallback: createCustomerCartReadPort(query),
  });
  const checkoutRead = createCustomerCheckoutSessionRead(checkout.accessOptions);
  // The pickup checkout without the customer's open gate: the counter's own rule
  // (counterTakesOrder) is applied by the staff command before the guest opens and at payment.
  const checkoutWrite = createCustomerCheckoutSessionComposition(checkout.checkoutSessions);
  const operatingNow = () =>
    transactions.run((tx) =>
      createPostgresPublishedStoreOperatingStatusReader(resources.operating)(tx, now()),
    );
  const pipeline = createCounterGuestPipeline({
    pickupQrToken: loadPickupQrToken,
    entry: createPersistentCustomerEntryComposition({
      ...entry.persistent,
      // The counter's guest enters while online ordering is paused (see counterEntryOperatingReader).
      sources: async (tx, input) => {
        const sources = await entry.persistent.sources(tx, input);
        if (sources.operatingReader === undefined) throw new Error("INTERNAL_COUNTER_ENTRY_ONLY");
        return {
          ...sources,
          operatingReader: counterEntryOperatingReader(sources.operatingReader),
        };
      },
      session: entry.session,
    }),
    binding: createCustomerCartBindingComposition({
      ...cartBinding,
      scope,
      session: entry.session,
      sessionTransactions: transactions,
      now,
    }),
    sessions: {
      authorize: async (input) => {
        const guest = await sessions.authorize(input);
        return { sessionReference: String(guest.sessionReference) };
      },
    },
    cart,
    quote: quotes,
    details: checkoutDetails,
    checkout: {
      create: (value) => checkoutWrite.create(value),
      read: (value) => checkoutRead.read(value),
    },
    takesOrder: async (input) => counterTakesOrder(await operatingNow(), input),
    payment: (guest) => ({
      access: checkout.accessOptions,
      tenantReference,
      orders: prepared.orders,
      tips: prepared.tips,
      inventory: createPostgresSubmissionFinalValidationStore(transactions, fullScope, {
        authorize: async (_tx, value) => {
          const current = await sessions.authorize({ ...guest, observedAt: now() });
          return value.actorReference === String(current.sessionReference);
        },
        resolveCurrent: async () => {
          throw new Error("READ_ONLY_INVENTORY_SOURCE");
        },
      }),
      nextPreparationReference: reference,
    }),
    nextReference: reference,
    now,
  });
  const menu = createCustomerMenuQueryService({
    stores: {
      resolvePublic: async (value) => {
        if (String(value) !== resources.publicProfile.binding.publicStoreReference) return null;
        const result = await resources.stores.getPublicStore({
          publicStoreReference: value,
          evaluatedAt: now(),
          purpose: "CustomerEntry",
          requestedLocale: "en-CA",
        });
        return result.status === "Available" ? { ...scope, status: "Active" } : null;
      },
    },
    projections,
    ...(customer.createInternalMenuStoreFacts === undefined
      ? {}
      : { storeFacts: await customer.createInternalMenuStoreFacts(resources) }),
  });
  return {
    counterMenu: createMerchantCounterMenu({
      persistence,
      menu,
      publicStoreReference: () => resources.publicProfile.binding.publicStoreReference,
      locale: "en-CA",
    }),
    counterOrder: createMerchantCounterOrder({
      persistence,
      authentication,
      pipeline,
      nextReference: reference,
      onUnexpected: (error) => reportUnexpected("INTERNAL_COUNTER_ORDER_UNAVAILABLE", error),
    }),
    cardMachinePayment: createMerchantCardMachinePayment({
      persistence,
      authentication,
      // TEST-ONLY: the pilot payment environment is Test (internal testing).
      environment: "Test",
      nextReference: reference,
      onUnexpected: (error) => reportUnexpected("INTERNAL_CARD_MACHINE_PAYMENT_UNAVAILABLE", error),
      // The same owner admission an online payment of a pickup Order passes (order payable,
      // pickup capacity clock open, reserved stock intact), under this staff member's authority.
      admission: ({ scope: selected, preparation, allowed }) => {
        const authorize = async (_tx, value) =>
          value.submissionReference === String(preparation.submissionReference) &&
          value.actorReference === String(preparation.guestSessionReference) &&
          (await allowed());
        return createCustomerOrderPaymentClaimAdmission({
          scope: {
            brandReference: selected.brandReference,
            storeReference: selected.storeReference,
          },
          quoteVersion: 2,
          capacityForOrder: (currentOrder) =>
            createCustomerCapacityPaymentClaimAdmission({
              scope: selected,
              owner: "AsapPickup",
              inventory: createCustomerInventoryPaymentClaimAdmission({
                scope: selected,
                authorize,
                evaluate: createCustomerIntactReservationPaymentAction({
                  scope: selected,
                  currentOrder,
                  quoteVersion: 2,
                  workflow: saved.workflow.payment,
                  authorize,
                  authorizeOverride: async () => false,
                }),
                resolveExpiryCutoff: createInternalExpiryCutoff(resources),
              }),
            }),
        });
      },
    }),
    cardMachineRefund: createMerchantCardMachineCancellationRefund({
      persistence,
      authentication,
      nextReference: reference,
      onUnexpected: (error) => reportUnexpected("INTERNAL_CARD_MACHINE_REFUND_UNAVAILABLE", error),
    }),
  };
}
