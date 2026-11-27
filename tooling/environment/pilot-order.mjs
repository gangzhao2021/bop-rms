import { createHash } from "node:crypto";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { GuestSessionService, readClosedRecord } from "../../packages/bop/identity/src/index.ts";
import {
  CheckoutValidationError,
  OrderCreationError,
  createPostgresInventoryFinalizedOrderCreationRepository,
} from "../../packages/rms/ordering/src/index.ts";
import { confirmCatalogSaleStillCurrent } from "../../packages/rms/catalog/src/index.ts";
import { createCustomerConfiguredDiningOrderSubmissionComposition } from "../../apps/api/dist/customer-dining-order-submission-composition.js";
import { createCustomerConfiguredPickupOrderSubmissionComposition } from "../../apps/api/dist/customer-pickup-order-submission-composition.js";
import { createCustomerCheckoutSessionAuthorization } from "../../apps/api/dist/customer-checkout-session-authorization.js";
import { createCustomerSubmissionInventoryFinalizer } from "../../apps/api/dist/customer-submission-inventory-finalizer.js";
import { createInternalOrderSources } from "./pilot-order-sources.mjs";
import { matchesPilotEnvironment } from "./pilot-environment.mjs";
export async function createInternalOrder(
  resources,
  checkout,
  catalogOptions,
  orderType = "Pickup",
  { loadWorkflow, expectedDatabaseName },
) {
  if (!["Pickup", "DineIn"].includes(orderType)) throw new Error("INTERNAL_ORDER_TYPE_UNAVAILABLE");
  const saved = await loadWorkflow(orderType);
  const scope = {
      tenantReference: resources.publicProfile.binding.tenantReference,
      ...resources.scope,
    },
    now = resources.now,
    reference = resources.credentials.reference;
  if (
    !matchesPilotEnvironment(saved.environment) ||
    saved.database !== expectedDatabaseName ||
    Object.keys(scope).some((key) => saved.scope[key] !== scope[key])
  )
    throw new Error("INTERNAL_WORKFLOW_SCOPE_MISMATCH");
  const sources = createInternalOrderSources(resources, catalogOptions, orderType),
    transactions = resources.transactions;
  const identity = new GuestSessionService({
    ...checkout.preparation.session,
    now,
    admission: { consume: async () => null },
  });
  const policies = {
    current: async (input) => ({
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      orderType: input.orderType,
      checkedAt: input.observedAt,
      validUntil: resources.publicProfile.binding.validUntil,
      required: [],
    }),
  };
  async function createOptions(value) {
    const input = readClosedRecord(value, [
      "sessionCredential",
      "csrfCredential",
      "submissionReference",
      "cartReference",
      "expectedCartVersion",
      "quoteReference",
    ]);
    const credentials = {
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
    };
    const guest = await identity.authorize({ ...credentials, observedAt: now() });
    if (
      guest.channel !== orderType ||
      guest.brandReference !== scope.brandReference ||
      guest.storeReference !== scope.storeReference
    )
      throw new Error("INTERNAL_ORDER_SCOPE_DENIED");
    const request = {
      cartReference: input.cartReference,
      cartVersion: input.expectedCartVersion,
      quoteReference: input.quoteReference,
    };
    const access = createCustomerCheckoutSessionAuthorization(checkout.accessOptions, {
      ...credentials,
      cartReference: input.cartReference,
    });
    const authority = await access.authorize(request, now());
    if (!authority) throw new Error("INTERNAL_ORDER_AUTHORITY_DENIED");
    const authorized = (tx, at) => access.authorizeInTransaction(tx, authority, at);
    const configuration = { ...saved.workflow };
    delete configuration.payment;
    const inventoryOptions = {
      scope,
      stockSiteReference: catalogOptions.selectedInventory.scope.stockSiteReference,
      workflow: {
        ...configuration,
        gates: {
          authorizeResource: async (tx, r) =>
            r.tenantReference === scope.tenantReference &&
            r.brandReference === scope.brandReference &&
            r.storeReference === scope.storeReference &&
            r.actorReference === guest.sessionReference &&
            r.resourceReference === input.cartReference &&
            r.resourceVersion === input.expectedCartVersion &&
            (await authorized(tx, r.observedAt)),
          // Explicit internal test rule policy; resource authorization and published Workflow are independently enforced.
          authorizeAction: async () => true,
          evaluateRule: async () => true,
          authorizeOverride: async () => false,
        },
      },
      authorize: async (tx, r) =>
        r.submissionReference === input.submissionReference &&
        r.actorReference === guest.sessionReference &&
        (await authorized(tx, now())),
      resolveExpiryCutoff: createInternalExpiryCutoff(resources),
      generateReference: reference,
      audit: {
        reasonCode: "INTERNAL_TEST_SUBMISSION",
        sourceChannel: "CUSTOMER_PWA",
        retentionPolicyCode: "AUDIT_DEFAULT",
        retentionPolicyVersion: 1,
      },
    };
    const stock = createCustomerSubmissionInventoryFinalizer(inventoryOptions);
    // v15 b17 (docs/spec/design/later-round-current-checks.md, the opening round): the table's
    // first round checks its dishes (menu, availability, choices, stock) before its write; the
    // write then confirms on its own connection, as later rounds do, that the menu release and
    // every dish's and chosen choice's sale state the check read are still in effect, so a staff
    // sold-out mark made in between is never ordered. Stock is fenced by the reservation next.
    const inventory =
      orderType !== "DineIn"
        ? stock
        : {
            finalize: async (write) => {
              const standing = await confirmCatalogSaleStillCurrent(write.transaction, {
                brandReference: scope.brandReference,
                storeReference: scope.storeReference,
                menuReference: catalogOptions.catalogScope.menuReference,
                channelCode: catalogOptions.catalogScope.channelCode,
                orderTypeCode: "DINE_IN",
                observedAt: write.observedAt,
                menuVersionReferences: write.checkoutValidationEvidence.catalogLines.map(
                  (line) => line.menuVersionReference,
                ),
                sellableReferences: write.checkoutValidationEvidence.catalogLines.map(
                  (line) => line.sellableReference,
                ),
                optionReferences: write.cart.items.flatMap((item) =>
                  item.optionSelections.map((option) => option.optionReference),
                ),
              });
              // A new listing since the check: the cart prices again ("the menu changed").
              if (standing === "MenuChanged")
                throw new CheckoutValidationError("CHECKOUT_REQUOTE_REQUIRED");
              // Marked sold out (or no longer offered) since the check: as a dish that ran out.
              if (standing !== "Current") throw new OrderCreationError("ORDER_CREATE_STOCK_SHORT");
              return stock.finalize(write);
            },
          };
    return {
      inventoryOptions,
      policies,
      preparation: checkout.preparation,
      ...(orderType === "DineIn"
        ? {
            clock: {
              repository: checkout.preparation.dining.repository,
              audit: {
                create: async (input) => ({
                  ...(await checkout.preparation.dining.audit.create(input)),
                  actionCode: "DINING_CHECKOUT_SEAL",
                }),
              },
            },
          }
        : {}),
      checkout: checkout.checkoutPorts({
        request,
        ...credentials,
        guestSessionReference: guest.sessionReference,
        orderType,
      }),
      ordering: {
        ...sources,
        references: {
          generate: reference,
          hashIntent: (v) => "sha256:" + createHash("sha256").update(v).digest("hex"),
          equals: (a, b) => a === b,
        },
        audit: {
          create: async (r) => ({
            auditId: reference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "ORDERING_ORDER_CREATE",
            targetType: "OrderingOrder",
            targetId: r.order.orderReference,
            occurredAt: r.observedAt,
            reasonCode: "AUTHORIZED_ORDER_CREATE",
            correlationId: r.submissionReference,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        },
      },
      repository: (link, authorization) =>
        createPostgresInventoryFinalizedOrderCreationRepository(
          { query: transactions, write: transactions },
          resources.scope,
          link,
          2,
          { now, policies, authorization },
          inventory,
        ),
    };
  }
  return {
    createOptions,
    orderSubmission: {
      quoteVersion: 2,
      async create(value) {
        const compose =
          orderType === "DineIn"
            ? createCustomerConfiguredDiningOrderSubmissionComposition
            : createCustomerConfiguredPickupOrderSubmissionComposition;
        return compose(await createOptions(value)).create(value);
      },
    },
  };
}
