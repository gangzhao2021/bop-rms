import { exerciseCustomerCheckoutDetailsHttp } from "./customer-checkout-details-http.mjs";
import assert from "node:assert/strict";
import {
  createCustomerDiningCheckoutDetailsComposition,
  createCustomerPickupCheckoutDetailsComposition,
} from "../../../apps/api/src/customer-checkout-details-composition.ts";
const id = (n) => "01909997-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export async function exerciseCustomerCheckoutDetails({
  journey,
  mode,
  scope,
  quoteVersion,
  cart,
  quote,
  credentials,
  sessionTransactions,
  cartTransactions,
  detailsTransactions,
  session,
  identity,
  now,
}) {
  let policyRead = false;
  let policyMode = "Ready",
    sequence = 100;
  const options = {
    scope,
    quoteVersion,
    cartTransactions,
    detailsTransactions,
    now,
    policies: {
      current: async (input) => {
        policyRead = true;
        return policyMode === "Missing"
          ? null
          : {
              brandReference: input.brandReference,
              storeReference: policyMode === "Foreign" ? id(99) : input.storeReference,
              orderType: input.orderType,
              checkedAt: input.observedAt,
              validUntil:
                policyMode === "Expired"
                  ? input.observedAt
                  : policyMode === "DatabaseExpired"
                    ? new Date(Date.parse(input.observedAt) + 1).toISOString()
                    : quote.quoteExpiresAt,
              required:
                policyMode === "Changed"
                  ? [
                      {
                        documentReference: id(300),
                        documentVersion: 1,
                        documentDigest: "sha256:" + "a".repeat(64),
                        purposeCode: "ORDER_TERMS",
                      },
                    ]
                  : [],
            };
      },
    },
    audit: async (input) => ({
      auditId: id(++sequence),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CHECKOUT_DETAILS_SAVE",
      reasonCode: "AUTHORIZED_CHECKOUT_UPDATE",
      targetType: "CheckoutDetails",
      targetId: input.detailsReference,
      occurredAt: input.observedAt,
      correlationId: id(90),
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  };
  const service =
    mode === "DineIn"
      ? createCustomerDiningCheckoutDetailsComposition({ ...options, identity })
      : createCustomerPickupCheckoutDetailsComposition({ ...options, session });
  const input = {
    ...credentials,
    command: {
      operationReference: id(1),
      detailsReference: id(2),
      expectedVersion: 0,
      cartReference: cart.cartReference,
      cartVersion: cart.aggregateVersion,
      quoteReference: quote.quoteReference,
      quoteVersion,
      pickupContact:
        mode === "Pickup"
          ? { name: "Synthetic guest", channel: "Phone", value: "+12025550123" }
          : null,
      receipt: { choice: "InSession", email: null },
      policies: [],
    },
  };
  await assert.rejects(service.save({ ...input, csrfCredential: "x".repeat(43) }), {
    code: "CART_PERMISSION_DENIED",
  });
  for (const invalid of ["Foreign", "Expired"]) {
    policyMode = invalid;
    await assert.rejects(service.save(input), { code: "CART_DEPENDENCY_UNAVAILABLE" });
  }
  policyMode = "Ready";
  const saved = await exerciseCustomerCheckoutDetailsHttp({
    journey,
    service,
    input,
    quoteVersion,
    runtimeOptions: { mode, scope, sessionTransactions, cartTransactions, session, identity, now },
    changePolicy: (value) => {
      policyMode = value;
      policyRead = false;
    },
  });
  assert.equal(saved.status, "Saved");
  assert.equal(saved.snapshot.orderType, mode);
  assert.equal(saved.snapshot.cartReference, cart.cartReference);
  assert.equal(saved.snapshot.quoteReference, quote.quoteReference);
  // Current policy changes cannot rewrite historical acknowledgement/receipt choices.
  policyMode = "Expired";
  assert.deepEqual(await service.save(input), { ...saved, status: "AlreadySaved" });
  policyMode = "Ready";
  return {
    service,
    input,
    saved,
    policies: options.policies,
    wrapAuthorization: (authorization) =>
      authorization === undefined
        ? undefined
        : {
            authorize: async (request) => {
              const result = await authorization.authorize(request);
              if (policyRead && policyMode === "Denied") return null;
              if (policyRead && policyMode === "ChangedIdentity" && result !== null)
                return {
                  guestSession: {
                    ...result.guestSession,
                    version: result.guestSession.version + 1,
                  },
                };
              return result;
            },
          },
    replaceForRecovery: async () => {
      policyMode = "Ready";
      const replacement = await service.save({
        ...input,
        command: {
          ...input.command,
          operationReference: id(3),
          expectedVersion: 1,
          receipt: { choice: "TransactionalEmail", email: "receipt@example.invalid" },
        },
      });
      assert.equal(replacement.status, "Saved");
      assert.equal(replacement.snapshot.detailsVersion, 2);
      policyMode = "Expired";
      return replacement.snapshot;
    },
    setPolicy: (value) => {
      policyMode = value;
      policyRead = false;
    },
  };
}
