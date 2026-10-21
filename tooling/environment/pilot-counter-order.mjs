import { createHash } from "node:crypto";
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
import { createPostgresCurrentPickupCapacityStore } from "../../packages/rms/fulfillment/src/index.ts";
import { createPersistentCustomerEntryComposition } from "../../apps/api/dist/persistent-customer-entry.js";
import { createPersistentPublicStoreProfileReader } from "../../apps/api/dist/persistent-public-store-profile.js";
import { createCustomerCartBindingComposition } from "../../apps/api/dist/customer-cart-binding-composition.js";
import { createCustomerCartItemWithCatalogComposition } from "../../apps/api/dist/customer-cart-item-composition.js";
import { createCustomerCartSelectionInventory } from "../../apps/api/dist/customer-cart-selection-inventory.js";
import { createCustomerPickupCartInventoryAuthorization } from "../../apps/api/dist/customer-pickup-cart-inventory-authorization.js";
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
import { createMerchantStaffDiningRound } from "../../apps/api/dist/merchant-staff-dining-round.js";
import {
  createStaffTableAbandonment,
  createStaffTableCode,
  createStaffTableGuestPipeline,
} from "../../apps/api/dist/table-guest-pipeline.js";
import { createMerchantDiningJoinState } from "../../apps/api/dist/merchant-dining-join-state.js";
import { createCustomerDiningJoinComposition } from "../../apps/api/dist/customer-dining-join-composition.js";
import { createCustomerDiningBindingComposition } from "../../apps/api/dist/customer-dining-binding-composition.js";
import { createCustomerDiningCartWithCatalogInventoryComposition } from "../../apps/api/dist/customer-dining-cart-composition.js";
import { createCustomerAdditionalDiningPaymentAdmission } from "../../apps/api/dist/customer-additional-dining-payment-store.js";
import { storeTakesOrder } from "../../apps/api/dist/customer-store-open-gate.js";
import { createPostgresDiningTableStore } from "../../packages/rms/dining/src/index.ts";
import { createPostgresPublishedStoreOperatingStatusReader } from "../../packages/rms/store/src/index.ts";
import { createInternalPaymentPreparation } from "./pilot-payment-preparation.mjs";
import { reportUnexpected } from "./pilot-merchant-pickup.mjs";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { matchesPilotEnvironment, pilotProviderEnvironment } from "./pilot-environment.mjs";

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
  {
    customer,
    loadPickupWorkflow,
    loadDiningWorkflow,
    loadPickupQrToken,
    expectedDatabaseName,
    diningClosing,
    issueRefundReceipt,
  },
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
    // WP-2423: whether a pickup time covers now, asked only to explain an unexpected refusal.
    pickupTimesNow: () =>
      createPostgresCurrentPickupCapacityStore(transactions, scope).covers(now()),
    // The same stock check the counter Cart makes when an item is added (its own Cart as context),
    // so staff are told how many of a short item are left.
    stock: {
      scope,
      catalog: createCustomerCartSelectionInventory(
        items.catalogCartItems.catalogTransactions,
        {
          ...items.catalogCartItems.catalogScope,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          orderType: "Pickup",
        },
        {
          killSwitch: items.catalogCartItems.catalogSafety.killSwitch,
          inventory: items.catalogCartItems.catalogSafety.inventory,
          clock: { now },
        },
        {
          ...items.catalogCartItems.selectedInventory,
          authorize: createCustomerPickupCartInventoryAuthorization(scope, now),
        },
      ),
    },
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
  const staffDiningRound =
    loadDiningWorkflow === undefined
      ? undefined
      : await createInternalStaffDiningRound(resources, persistence, authentication, {
          customer,
          configuredEntry,
          sessions,
          store,
          stores,
          projections,
          loadDiningWorkflow,
          expectedDatabaseName,
          diningClosing,
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
      environment: pilotProviderEnvironment(),
      nextReference: reference,
      onUnexpected: (error) => reportUnexpected("INTERNAL_CARD_MACHINE_PAYMENT_UNAVAILABLE", error),
      // The same owner admission an online payment of a pickup Order passes (order payable,
      // pickup capacity clock open, reserved stock intact), under this staff member's authority.
      admission: ({ scope: selected, preparation, allowed, kind }) => {
        const authorize = async (_tx, value) =>
          value.submissionReference === String(preparation.submissionReference) &&
          value.actorReference === String(preparation.guestSessionReference) &&
          (await allowed());
        // WP-2423 Q7 slice 2: a staff-entered table round passes the dine-in payment admission.
        if (kind !== "CounterPickup") {
          if (staffDiningRound === undefined) throw new Error("INTERNAL_STAFF_ROUND_UNAVAILABLE");
          return staffDiningRound.admission({ selected, preparation, allowed, kind, authorize });
        }
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
    ...(staffDiningRound === undefined ? {} : { staffDiningRound: staffDiningRound.command }),
    cardMachineRefund: createMerchantCardMachineCancellationRefund({
      persistence,
      authentication,
      nextReference: reference,
      onUnexpected: (error) => reportUnexpected("INTERNAL_CARD_MACHINE_REFUND_UNAVAILABLE", error),
      // WP-2423 (v15 3cd0f8dd M4): the table's receipt states the refunded round.
      ...(issueRefundReceipt === undefined ? {} : { issueRefundReceipt }),
    }),
  };
}

/**
 * WP-2423 Q7 slice 2 (DEC-STAFF-DINE-IN-ROUND): staff enter a dine-in round for a table on behalf
 * of its guests (or a paper round taken during an outage) and take the payment on the Store's card
 * machine. The table guest goes through the same customer owner ports a guest scanning the table
 * QR uses: the table code staff issue on the Tables page (start session or fresh code, under the
 * staff member's table authority), table QR entry, join, dining binding, the table's shared Cart
 * with menu and sold-out checks, configured Quote with tax, checkout details, the dine-in
 * checkout, the first-or-later round submission, tip and payment clock. No Provider is called.
 */
async function createInternalStaffDiningRound(
  resources,
  persistence,
  authentication,
  {
    customer,
    configuredEntry,
    sessions,
    store,
    stores,
    projections,
    loadDiningWorkflow,
    expectedDatabaseName,
    diningClosing,
  },
) {
  const saved = await loadDiningWorkflow();
  if (
    !matchesPilotEnvironment(saved.environment) ||
    saved.database !== expectedDatabaseName ||
    saved.scope.storeReference !== resources.scope.storeReference
  )
    throw new Error("INTERNAL_STAFF_ROUND_ONLY");
  const { scope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const tenantReference = resources.publicProfile.binding.tenantReference;
  const fullScope = { tenantReference, ...scope };
  const entry = configuredEntry.entry;
  const items = await customer.createInternalTestItems(resources);
  const diningCart = customer.createInternalDiningCart(resources, items);
  const quote = (
    await customer.createInternalChannelQuote(resources, configuredEntry, diningCart, items)
  ).configuredCartQuote.dining;
  const base = customer.createInternalCheckout(resources, configuredEntry, items.catalogCartItems);
  // The staff command applies the opening rule itself (paper rounds are entered after closing).
  const diningCheckout = customer.createInternalDiningCheckout(resources, configuredEntry, base, {
    openGate: false,
  });
  const details = customer.createInternalCheckoutDetails(
    resources,
    entry,
    diningCheckout.preparation,
  ).channelCheckoutDetails.dining;
  const pickupOrders = await customer.createInternalOrder(resources, base, items.catalogCartItems);
  const diningOrders = await customer.createInternalOrder(
    resources,
    { ...base, preparation: diningCheckout.preparation },
    items.catalogCartItems,
    "DineIn",
  );
  // No Provider takes part: staff charge the round on the Store's own card machine.
  const noProvider = {
    simulation: true,
    adapter: new Proxy(
      {},
      {
        get: () => async () => {
          throw new Error("INTERNAL_STAFF_ROUND_NO_PROVIDER");
        },
      },
    ),
  };
  const payment = await customer.createInternalChannelPayment(
    resources,
    base,
    diningCheckout,
    pickupOrders,
    diningOrders,
    noProvider,
    items.catalogCartItems,
  );
  const catalog = createCatalogSelectionDisplayQuery(projections);
  const cart = createCustomerDiningCartWithCatalogInventoryComposition({
    ...diningCart.catalogDiningCart,
    scope,
    sessions,
    cartTransactions: transactions,
    catalog,
    stores,
    now,
    replacement: customer.createInternalCartReplacement(resources, configuredEntry),
  });
  const diningSession = {
    store,
    credentials: entry.session.credentials,
    binding: entry.session.binding,
  };
  const join = createCustomerDiningJoinComposition({
    ...configuredEntry.diningAdmission.join,
    scope,
    session: diningSession,
    now,
  });
  const binding = createCustomerDiningBindingComposition({
    ...configuredEntry.diningAdmission.binding,
    scope,
    session: diningSession,
    now,
  });
  const owner = configuredEntry.diningOwner;
  const joinState = createMerchantDiningJoinState({
    persistence,
    authentication,
    credentials: owner.credentials,
  });
  const operatingNow = () =>
    transactions.run((tx) =>
      createPostgresPublishedStoreOperatingStatusReader(resources.operating)(tx, now()),
    );
  const loadJoinState = async (staff, diningSessionReference) => {
    try {
      return await joinState({ ...staff, query: { diningSessionReference } });
    } catch {
      return null;
    }
  };
  const pipeline = createStaffTableGuestPipeline({
    takesOrder: async (input) =>
      input.recordedAfterOutage || storeTakesOrder(await operatingNow(), "SeatedDineIn"),
    openTable: createStaffTableCode({
      loadTable: (tableReference) =>
        transactions.run(async (tx) => {
          const table = await createPostgresDiningTableStore(
            { run: (work) => work(tx) },
            fullScope,
            {
              hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
              equals: (a, b) => a === b,
            },
          ).loadTable(tableReference);
          return table === null
            ? null
            : {
                aggregateVersion: table.aggregateVersion,
                activeDiningSessionReference: table.activeDiningSessionReference,
                seatable: table.lifecycle === "Published" && table.operationalState === "Available",
              };
        }),
      loadJoinState,
      start: (staff, command) => owner.start({ ...staff, command }),
      regenerate: (staff, command) => owner.regenerate({ ...staff, command }),
      nextReference: reference,
    }),
    // WP-2423 item 7: a session the staff round started is closed again (existing closing
    // commands, staff member's own authority) when the round fails before anything was ordered.
    abandonTable:
      diningClosing === undefined
        ? async () => "Kept"
        : createStaffTableAbandonment({
            loadJoinState,
            close: (staff, command) => diningClosing({ ...staff, command }),
            nextReference: reference,
          }),
    // The table's printed QR, as a guest scanning it would enter; null when it has none (the
    // staff command then refuses before opening the table).
    tableQrToken: async (tableReference) => {
      const token = await configuredEntry.dining.currentToken(tableReference);
      return typeof token === "string" ? token : null;
    },
    entry: createPersistentCustomerEntryComposition({
      ...entry.persistent,
      // A paper round is entered after an outage even once the Store has closed; the staff
      // command's own rule decides (see counterEntryOperatingReader).
      sources: async (tx, input) => {
        const sources = await entry.persistent.sources(tx, input);
        if (sources.operatingReader === undefined) throw new Error("INTERNAL_STAFF_ENTRY_ONLY");
        return {
          ...sources,
          operatingReader: counterEntryOperatingReader(sources.operatingReader, "DineIn"),
        };
      },
      session: entry.session,
    }),
    join,
    joinRequest: () => configuredEntry.diningAdmission.resolveRequestContext(),
    binding,
    sessions: {
      authorize: async (input) => {
        const guest = await sessions.authorize(input);
        return { sessionReference: String(guest.sessionReference) };
      },
    },
    cart,
    quote,
    details,
    checkout: {
      create: (value) =>
        createCustomerCheckoutSessionComposition(diningCheckout.checkoutSessions).create(value),
    },
    payment,
    nextReference: reference,
    now,
  });
  return {
    command: createMerchantStaffDiningRound({
      persistence,
      authentication,
      pipeline,
      nextReference: reference,
      onUnexpected: (error) => reportUnexpected("INTERNAL_STAFF_DINING_ROUND_UNAVAILABLE", error),
    }),
    /** The online payment admission of the round's kind, under this staff member's authority. */
    admission: ({ selected, preparation, kind, authorize }) => {
      void preparation;
      const inventory = {
        workflow: saved.workflow.payment,
        authorize,
        authorizeOverride: async () => false,
        resolveExpiryCutoff: createInternalExpiryCutoff(resources),
      };
      const owners = {
        tenantReference: selected.tenantReference,
        brandReference: selected.brandReference,
        storeReference: selected.storeReference,
      };
      if (kind === "DiningAdditional")
        return createCustomerAdditionalDiningPaymentAdmission({
          scope: owners,
          quoteVersion: 2,
          authorizeHistory: async (tx, value) =>
            value.submissionReference === String(preparation.submissionReference) &&
            (await authorize(tx, {
              submissionReference: value.submissionReference,
              actorReference: String(preparation.guestSessionReference),
            })),
          inventory,
        });
      return createCustomerOrderPaymentClaimAdmission({
        scope: { brandReference: selected.brandReference, storeReference: selected.storeReference },
        quoteVersion: 2,
        capacityForOrder: (currentOrder) =>
          createCustomerCapacityPaymentClaimAdmission({
            scope: owners,
            owner: "Dining",
            inventory: createCustomerInventoryPaymentClaimAdmission({
              scope: owners,
              authorize,
              evaluate: createCustomerIntactReservationPaymentAction({
                scope: owners,
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
  };
}
