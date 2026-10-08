import { createHash } from "node:crypto";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { GuestSessionService, readClosedRecord } from "../../packages/bop/identity/src/index.ts";
import { createPostgresInventoryFinalizedOrderCreationRepository } from "../../packages/rms/ordering/src/index.ts";
import { createCustomerDiningOrderSubmissionComposition } from "../../apps/api/dist/customer-dining-order-submission-composition.js";
import { createCustomerPickupOrderSubmissionComposition } from "../../apps/api/dist/customer-pickup-order-submission-composition.js";
import { createCustomerCheckoutSessionAuthorization } from "../../apps/api/dist/customer-checkout-session-authorization.js";
import { createCustomerSubmissionInventoryFinalizer } from "../../apps/api/dist/customer-submission-inventory-finalizer.js";
import { createInternalOrderSources } from "./pilot-order-sources.mjs";
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
    saved.environment !== "InternalTest" ||
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
    const inventory = createCustomerSubmissionInventoryFinalizer(inventoryOptions);
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
          1,
          { now, policies, authorization },
          inventory,
        ),
    };
  }
  return {
    createOptions,
    orderSubmission: {
      quoteVersion: 1,
      async create(value) {
        const compose =
          orderType === "DineIn"
            ? createCustomerDiningOrderSubmissionComposition
            : createCustomerPickupOrderSubmissionComposition;
        return compose(await createOptions(value)).create(value);
      },
    },
  };
}
