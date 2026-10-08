import { createHash } from "node:crypto";
import { createInternalExpiryCutoff } from "./pilot-expiry-cutoff.mjs";
import { createCustomerSessionPaymentIntent } from "../../apps/api/dist/customer-session-payment-intent.js";
import { createCustomerCheckoutSessionRead } from "../../apps/api/dist/customer-checkout-session-read.js";
import { createCustomerCheckoutSessionAuthorization } from "../../apps/api/dist/customer-checkout-session-authorization.js";
import { createCustomerConfiguredDiningPaymentAuthorization } from "../../apps/api/dist/customer-dining-payment-authorization.js";
import { diningOrderCapacityLinkFromHistory } from "../../apps/api/dist/customer-dining-checkout-composition.js";
import { createCustomerConfiguredPickupPaymentAuthorization } from "../../apps/api/dist/customer-pickup-payment-authorization.js";
import { pickupOrderCapacityLinkFromHistory } from "../../apps/api/dist/customer-pickup-checkout-composition.js";
import { createCustomerOrderPaymentClaimAdmission } from "../../apps/api/dist/customer-order-payment-admission.js";
import { createCustomerCapacityPaymentClaimAdmission } from "../../apps/api/dist/customer-capacity-payment-admission.js";
import { createCustomerInventoryPaymentClaimAdmission } from "../../apps/api/dist/customer-inventory-payment-admission.js";
import { createCustomerIntactReservationPaymentAction } from "../../apps/api/dist/customer-payment-workflow-action.js";
import { createPostgresSubmissionFinalValidationStore } from "../../packages/rms/inventory/src/index.ts";
import {
  createPostgresAdmittedPaymentIntentCreationStore,
  paymentProviderAdmissionKillSwitchKey,
} from "../../packages/rms/payment/src/index.ts";
import { createInternalPaymentPreparation } from "./pilot-payment-preparation.mjs";
function frozen(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") frozen(child);
  return Object.freeze(value);
}
export async function createInternalPaymentIntent(
  resources,
  checkout,
  orders,
  simulator,
  orderType = "Pickup",
  { loadWorkflow, expectedDatabaseName, controlReference },
) {
  if (!["Pickup", "DineIn"].includes(orderType))
    throw new Error("INTERNAL_PAYMENT_CHANNEL_INVALID");
  const dining = orderType === "DineIn",
    authorizePayment = dining
      ? createCustomerConfiguredDiningPaymentAuthorization
      : createCustomerConfiguredPickupPaymentAuthorization,
    capacityLink = dining ? diningOrderCapacityLinkFromHistory : pickupOrderCapacityLinkFromHistory;
  const { scope: identityScope, transactions, now, credentials } = resources,
    reference = credentials.reference;
  const scope = {
    tenantReference: resources.publicProfile.binding.tenantReference,
    ...identityScope,
  };
  const saved = await loadWorkflow(orderType);
  if (
    saved.environment !== "InternalTest" ||
    saved.database !== expectedDatabaseName ||
    saved.scope.storeReference !== scope.storeReference ||
    simulator.simulation !== true
  )
    throw new Error("INTERNAL_PAYMENT_ONLY");
  const prepared = createInternalPaymentPreparation(resources, checkout, orders, orderType),
    reader = createCustomerCheckoutSessionRead(checkout.accessOptions);
  async function resolveRequest(input) {
    const auth = {
        sessionCredential: input.sessionCredential,
        csrfCredential: input.csrfCredential,
      },
      session = await reader.read({
        ...auth,
        checkoutSessionReference: input.checkoutSessionReference,
      }),
      v = session.validation;
    const access = createCustomerCheckoutSessionAuthorization(checkout.accessOptions, {
      ...auth,
      cartReference: v.cartReference,
    });
    const request = {
      createOperationReference: session.createOperationReference,
      cartReference: v.cartReference,
      cartVersion: v.cartVersion,
      quoteReference: v.quoteReference,
      quoteVersion: 2,
    };
    const authority = await access.authorize(request, now());
    if (!authority) throw new Error("INTERNAL_PAYMENT_DENIED");
    const authorize = async (tx, value) =>
      value.submissionReference === session.submissionReference &&
      value.actorReference === v.guestSessionReference &&
      (await access.authorizeInTransaction(tx, authority, now()));
    const inventory = createPostgresSubmissionFinalValidationStore(transactions, scope, {
      authorize,
      resolveCurrent: async () => {
        throw new Error("READ_ONLY_INVENTORY_SOURCE");
      },
    });
    const admission = createCustomerOrderPaymentClaimAdmission({
      scope: identityScope,
      quoteVersion: 2,
      capacityForOrder: (currentOrder) => {
        const action = createCustomerIntactReservationPaymentAction({
          scope,
          currentOrder,
          quoteVersion: 2,
          workflow: saved.workflow.payment,
          authorize,
          authorizeOverride: async () => false,
        });
        return createCustomerCapacityPaymentClaimAdmission({
          scope,
          owner: dining ? "Dining" : "AsapPickup",
          inventory: createCustomerInventoryPaymentClaimAdmission({
            scope,
            authorize,
            evaluate: action,
            resolveExpiryCutoff: createInternalExpiryCutoff(resources),
          }),
        });
      },
    });
    const store = createPostgresAdmittedPaymentIntentCreationStore(
      transactions,
      identityScope,
      { now, generateObservationReference: reference },
      admission,
    );
    const orderOptions = await orders.createOptions({
      ...auth,
      submissionReference: session.submissionReference,
      cartReference: v.cartReference,
      expectedCartVersion: v.cartVersion,
      quoteReference: v.quoteReference,
    });
    const capacity = await (
      dining ? checkout.preparation.dining.repository : checkout.preparation.capacity.repository
    ).loadSubmission(session.submissionReference);
    if (!capacity) throw new Error("INTERNAL_CAPACITY_UNAVAILABLE");
    const service = createCustomerSessionPaymentIntent({
      access: checkout.accessOptions,
      tenantReference: scope.tenantReference,
      orders: prepared.orders,
      tips: prepared.tips,
      inventory,
      history: store,
      nextPreparationReference: reference,
      payment: (context) => ({
        providerEnvironment: "Test",
        clock: { now },
        repository: store,
        provider: simulator.adapter,
        authorization: authorizePayment(
          {
            preparation: orderOptions.preparation,
            ordering: orderOptions.repository(capacityLink(capacity)),
          },
          context.credentials,
        ),
        killSwitch: {
          evaluate: async (request) =>
            frozen({
              effectiveControl: {
                controlId: controlReference,
                version: 1,
                scope: { kind: "Store", ...identityScope },
              },
              backendExecution: "Allow",
              frontendVisibility: "Show",
              reason: "KILL_INACTIVE",
              killMode: "BlockNew",
              inFlightPolicy: "AllowToComplete",
              record: {
                key: paymentProviderAdmissionKillSwitchKey,
                kind: "KillSwitch",
                version: 1,
                scopeKind: "Store",
                backendExecution: "Allow",
                frontendVisibility: "Show",
                reason: "KILL_INACTIVE",
                killMode: "BlockNew",
                evaluatedAt: request.evaluatedAt,
              },
            }),
        },
        references: {
          generate: reference,
          hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
          equals: (a, b) => a === b,
          providerIdempotencyKey: reference,
        },
        audit: {
          create: async (value) => ({
            auditId: reference(),
            brandId: scope.brandReference,
            storeId: scope.storeReference,
            actor: { type: "System" },
            actionCode: "PAYMENT_INTENT_CREATE",
            targetType: "PaymentIntent",
            targetId: value.paymentIntentReference,
            reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
            occurredAt: value.observedAt,
            correlationId: value.paymentOperationReference,
            sourceChannel: "CUSTOMER_PWA",
            dataClassification: "Restricted",
            retentionPolicyCode: "AUDIT_DEFAULT",
            retentionPolicyVersion: 1,
          }),
        },
      }),
    });
    return { service, admission, store, session };
  }
  return {
    resolveRequest,
    async create(input) {
      return (await resolveRequest(input)).service.create(input);
    },
  };
}
