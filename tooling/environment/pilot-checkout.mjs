import { createHash } from "node:crypto";
import { createPostgresGuestSessionEntryStore } from "../../packages/bop/identity/src/index.ts";
import { createPostgresAsapCapacityStore } from "../../packages/rms/fulfillment/src/index.ts";
import {
  createPostgresCartQueryStore,
  createPostgresConfiguredCartQuoteReader,
} from "../../packages/rms/ordering/src/index.ts";
import { createPostgresConfiguredPriceQuoteHistoryReader } from "../../packages/rms/pricing/src/index.ts";
import { createPostgresCatalogOrderSnapshotSource } from "../../packages/rms/catalog/src/index.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../apps/api/dist/customer-checkout-session-authorization.js";
import { createCustomerConfiguredPickupCapacitySources } from "../../apps/api/dist/customer-pickup-capacity-sources.js";
import { createCustomerConfiguredPickupSessionValidation } from "../../apps/api/dist/customer-pickup-session-validation.js";
import { createCustomerCartSelectionInventory } from "../../apps/api/dist/customer-cart-selection-inventory.js";
export function createInternalCheckout(resources, configuredEntry, catalogOptions) {
  const { scope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const audit = (actionCode, targetType, targetId, occurredAt, correlationId) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    occurredAt,
    correlationId,
    reasonCode:
      targetType === "FulfillmentAsapCapacity"
        ? "AUTHORIZED_CHECKOUT_CAPACITY"
        : "AUTHORIZED_CHECKOUT_CREATE",
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const accessOptions = {
    scope,
    transactions,
    credentials: credentials.sessions,
    binding: (tx) => configuredEntry.binding({ run: (work) => work(tx) }),
    now,
  };
  const preparation = {
    scope,
    now,
    session: {
      ...configuredEntry.entry.session,
      store: createPostgresGuestSessionEntryStore(transactions, scope),
    },
    sources: createCustomerConfiguredPickupCapacitySources({
      scope,
      orderingTransactions: transactions,
      capacityTransactions: transactions,
      now,
      unitPolicy: { resolve: async () => ({ mode: "PerFulfillment", ruleVersion: 1 }) },
    }),
    capacity: {
      repository: createPostgresAsapCapacityStore(transactions, scope, { now }),
      audit: {
        prepare: async (record) =>
          audit(
            "FULFILLMENT_ASAP_CAPACITY_" + record.state.toUpperCase(),
            "FulfillmentAsapCapacity",
            record.allocationReference,
            record.paymentRequestedAt ?? record.preparedAt,
            record.submissionReference,
          ),
      },
    },
    references: { generate: reference },
  };
  const carts = createPostgresCartQueryStore(transactions, scope),
    quotes = createPostgresConfiguredCartQuoteReader(transactions, scope);
  const options = {
    ...accessOptions,
    quoteVersion: 2,
    nextReference: reference,
    allocationAudit: (record) =>
      audit(
        "ORDERING_CHECKOUT_SESSION_ALLOCATE",
        "CheckoutSession",
        record.checkoutSessionReference,
        record.allocatedAt,
        record.createOperationReference,
      ),
    audit: (record) =>
      audit(
        "ORDERING_CHECKOUT_SESSION_CREATE",
        "CheckoutSession",
        record.checkoutSessionReference,
        record.createdAt,
        record.createOperationReference,
      ),
    validate: async (input) =>
      createCustomerConfiguredPickupSessionValidation({
        preparation,
        checkout: checkoutPorts({
          ...input,
          guestSessionReference: input.allocation.guestSessionReference,
        }),
      })(input),
  };
  function checkoutPorts({
    request,
    sessionCredential,
    csrfCredential,
    guestSessionReference,
    orderType = "Pickup",
  }) {
    const access = createCustomerCheckoutSessionAuthorization(accessOptions, {
      sessionCredential: sessionCredential,
      csrfCredential: csrfCredential,
      cartReference: request.cartReference,
    });
    const catalog = {
      async validateSelection(selection) {
        const authority = await access.authorize(request, selection.observedAt);
        if (!authority) throw new Error("INTERNAL_CHECKOUT_AUTHORITY_UNAVAILABLE");
        const cart = await carts.load(request.cartReference);
        if (!cart || cart.aggregateVersion !== request.cartVersion)
          throw new Error("INTERNAL_CHECKOUT_CART_CHANGED");
        // Stock is checked per configuration: the same item with the same options.
        const configuration = (selections) =>
          JSON.stringify(
            [...selections]
              .map((option) => [option.optionReference, option.quantity])
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
          );
        const quantity = cart.items
          .filter(
            (item) =>
              item.sellableReference === selection.sellableReference &&
              configuration(item.optionSelections) ===
                configuration(selection.optionSelections ?? []),
          )
          .reduce((sum, item) => sum + item.quantity, 0);
        return transactions.run(async (authorityTx) => {
          const selected = createCustomerCartSelectionInventory(
            catalogOptions.catalogTransactions,
            {
              ...scope,
              ...catalogOptions.catalogScope,
              orderType,
              orderTypeCode:
                orderType === "DineIn" ? "DINE_IN" : catalogOptions.catalogScope.orderTypeCode,
            },
            { ...catalogOptions.catalogSafety, clock: { now } },
            {
              ...catalogOptions.selectedInventory,
              authorize: async (_tx, request, context) =>
                request.quantity === quantity &&
                context.cartVersion === cart.aggregateVersion &&
                (await access.authorizeInTransaction(authorityTx, authority, request.observedAt)),
            },
          );
          return selected.validateSelection(selection, {
            diningSessionReference: cart.diningSessionReference,
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            guestSessionReference: guestSessionReference,
            quantity,
          });
        });
      },
    };
    return {
      catalog,
      repository: {
        loadCart: (ref) => carts.load(ref),
        loadQuote: (ref) =>
          quotes.loadLatest({
            cartReference: ref,
            cartVersion: request.cartVersion,
            observedAt: now(),
          }),
      },
      references: { hashIntent },
      // Configured Quote (v2) evidence: the priced options and the current Catalog snapshot.
      history: createPostgresConfiguredPriceQuoteHistoryReader(transactions, scope),
      pricingChannelCode: "CUSTOMER_WEB",
      snapshots: createPostgresCatalogOrderSnapshotSource(
        catalogOptions.catalogTransactions,
        {
          ...scope,
          ...catalogOptions.catalogScope,
          orderType,
          orderTypeCode:
            orderType === "DineIn" ? "DINE_IN" : catalogOptions.catalogScope.orderTypeCode,
        },
        { ...catalogOptions.catalogSafety, clock: { now } },
        { generate: reference, hash: hashIntent },
      ),
    };
  }

  return { checkoutSessions: options, preparation, checkoutPorts, accessOptions };
}
