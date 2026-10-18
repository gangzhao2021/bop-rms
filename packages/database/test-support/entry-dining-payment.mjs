import { createCustomerDiningSessionBinding } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import { createPostgresDiningGuestBindingStore } from "../../rms/dining/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerDiningPaymentAuthorization } from "../../../apps/api/src/customer-dining-payment-authorization.ts";
import { createCustomerOrderPaymentClaimAdmission } from "../../../apps/api/src/customer-order-payment-admission.ts";
import { createCustomerCapacityPaymentClaimAdmission } from "../../../apps/api/src/customer-capacity-payment-admission.ts";
import { createCustomerInventoryPaymentClaimAdmission } from "../../../apps/api/src/customer-inventory-payment-admission.ts";
import { createCustomerIntactReservationPaymentAction } from "../../../apps/api/src/customer-payment-workflow-action.ts";
import { createPostgresSubmissionFinalValidationStore } from "../../rms/inventory/src/index.ts";
import { createPostgresAdmittedPaymentIntentCreationStore } from "../../rms/payment/src/index.ts";
import { normalizeStripeOnlineIntentResponse } from "../../rms/payment/src/infrastructure/stripe/stripe-online-intent-response.ts";
import { killSwitchEvaluation } from "../../rms/payment/src/tests/payment-intent-creation.fixture.ts";

export function prepareEntryDiningPaymentHttp(access, tenantReference) {
  let attached;
  const diagnostics = [];
  const invoke = async (stage, work) => {
    diagnostics.push({ stage });
    try {
      return await work();
    } catch (error) {
      diagnostics.push({
        stage,
        code: /^[A-Z_]{1,64}$/.test(error.code ?? "") ? error.code : "unknown",
      });
      throw error;
    }
  };
  const current = () => {
    assert(attached, "Entry payment ports not attached");
    return attached;
  };
  return {
    diagnostics,
    options: {
      allowedOrigin: "https://customer.invalid",
      access,
      tenantReference,
      orders: {
        create: (input) => invoke("order", () => current().orders.create(input)),
        preparePaymentClock: (input) =>
          invoke("clock", () => current().orders.preparePaymentClock(input)),
      },
      tips: { select: (input) => invoke("tip", () => current().tips.select(input)) },
      inventory: {
        load: (input) => invoke("inventory-read", () => current().inventory.load(input)),
      },
      history: {
        resolveOperation: (input) =>
          invoke("payment-history", () => current().history.resolveOperation(input)),
      },
      nextPreparationReference: () => current().nextPreparationReference(),
      payment: (input) => {
        const ports = current().payment(input);
        const wrap = (port, name) =>
          Object.fromEntries(
            Object.entries(port).map(([method, value]) => [
              method,
              typeof value === "function"
                ? (...args) => invoke(name + "." + method, () => value(...args))
                : value,
            ]),
          );
        return {
          ...ports,
          authorization: wrap(ports.authorization, "authorization"),
          killSwitch: wrap(ports.killSwitch, "kill-switch"),
          audit: wrap(ports.audit, "audit"),
          repository: wrap(ports.repository, "payment-store"),
        };
      },
    },
    attach(value) {
      assert.equal(attached, undefined);
      attached = value;
    },
  };
}

/** Actual owner admission and persistence; synthetic Test Provider and kill-switch policy only. */
export async function exerciseEntryDiningPayment({
  contextsForTransaction,
  admin,
  role,
  run,
  scope,
  commitment,
  checkout,
  order,
  preparation,
  http,
  base,
  oldCookie,
  reference,
}) {
  const now = commitment.allocated.options.now;
  const transactions = {
    run: (work) =>
      run((tx) =>
        work({
          query: async (sql, values) => {
            const table =
              /(?:FROM|INTO|UPDATE|TABLE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner-query";
            try {
              const result = await tx.query(sql, values);
              http.diagnostics.push({ table, rows: result.rows.length });
              return result;
            } catch (error) {
              http.diagnostics.push({
                table,
                code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
              });
              throw error;
            }
          },
        }),
      ),
  };
  const identityScope = {
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
  };
  await admin.query("GRANT UPDATE(order_id) ON rms_ordering.order_header TO " + role);
  await admin.query("GRANT UPDATE(order_batch_id) ON rms_ordering.order_batch TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_intent,rms_payment.payment_attempt,rms_payment.payment_intent_operation_record,rms_payment.payment_provider_observation TO " +
      role,
  );
  const credentials = {
    sessionCredential: order.input.sessionCredential,
    csrfCredential: order.input.csrfCredential,
  };
  const access = createCustomerCheckoutSessionAuthorization(
    {
      ...commitment.allocated.options,
      binding: (tx) => {
        const contexts = contextsForTransaction(tx);
        return createCustomerDiningSessionBinding({
          scope: identityScope,
          binding: contexts,
          contexts,
          now,
          repository: createPostgresDiningGuestBindingStore({ run: (work) => work(tx) }, scope),
        });
      },
    },
    {
      ...credentials,
      cartReference: checkout.session.validation.cartReference,
    },
  );
  const authority = await access.authorize(commitment.allocated.request, now());
  assert(authority);
  const authorize = async (tx, input) =>
    input.submissionReference === order.record.submissionReference &&
    input.actorReference === order.record.guestSessionReference &&
    access.authorizeInTransaction(tx, authority, now());
  const inventory = createPostgresSubmissionFinalValidationStore(transactions, scope, {
    authorize,
    resolveCurrent: async () => {
      throw new Error("Read-only final validation source");
    },
  });
  const admission = createCustomerOrderPaymentClaimAdmission({
    scope: identityScope,
    quoteVersion: 1,
    capacityForOrder: (currentOrder) => {
      const action = createCustomerIntactReservationPaymentAction({
        scope,
        currentOrder,
        quoteVersion: 1,
        workflow: order.workflow.payment,
        authorize,
        authorizeOverride: async () => false,
      });
      return createCustomerCapacityPaymentClaimAdmission({
        scope,
        owner: "Dining",
        inventory: createCustomerInventoryPaymentClaimAdmission({
          scope,
          authorize,
          evaluate: action,
          resolveExpiryCutoff: async () => {
            throw new Error("NoLot fixture");
          },
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
  let providerCalls = 0;
  const unsupported = async () => {
    throw new Error("Unused synthetic Provider operation");
  };
  const provider = {
    createIntent: async (request) => {
      providerCalls++;
      assert.equal(request.amount.amountMinor, 5650n);
      return normalizeStripeOnlineIntentResponse(
        request,
        {
          object: "payment_intent",
          id: "pi_SYNTHETICENTRY0001",
          currency: "cad",
          livemode: false,
          capture_method: "automatic",
          payment_method_types: ["card"],
          amount: 5650,
          amount_received: 0,
          amount_capturable: 0,
          status: "requires_payment_method",
          latest_charge: null,
        },
        now(),
      );
    },
    retrieveIntent: unsupported,
    confirmIntent: unsupported,
    cancelIntent: unsupported,
    captureIntent: unsupported,
    refundPayment: unsupported,
  };
  http.attach({
    orders: order.service,
    tips: preparation.tips,
    inventory,
    history: store,
    nextPreparationReference: reference,
    payment: (context) => ({
      providerEnvironment: "Test",
      clock: { now },
      repository: store,
      provider,
      authorization: createCustomerDiningPaymentAuthorization(
        {
          preparation: order.options.preparation,
          ordering: order.options.repository(commitment.link),
        },
        context.credentials,
      ),
      killSwitch: {
        evaluate: async (request) => {
          const evaluation = killSwitchEvaluation({ evaluatedAt: request.evaluatedAt });
          return Object.freeze({
            ...evaluation,
            effectiveControl: Object.freeze({
              ...evaluation.effectiveControl,
              scope: Object.freeze({ kind: "Store", ...identityScope }),
            }),
          });
        },
      },
      references: {
        generate: reference,
        hash: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
        equals: (a, b) => a === b,
        providerIdempotencyKey: reference,
      },
      audit: {
        create: async (input) => ({
          auditId: reference(),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "System" },
          actionCode: "PAYMENT_INTENT_CREATE",
          targetType: "PaymentIntent",
          targetId: input.paymentIntentReference,
          reasonCode: "AUTHORIZED_PAYMENT_INTENT_CREATE",
          occurredAt: input.observedAt,
          correlationId: input.paymentOperationReference,
          sourceChannel: "CUSTOMER_PWA",
          dataClassification: "Restricted",
          retentionPolicyCode: "SYNTHETIC_AUDIT",
          retentionPolicyVersion: 1,
        }),
      },
    }),
  });
  const post = (cookie) =>
    globalThis.fetch(
      base +
        "/api/v1/checkout-sessions/" +
        checkout.session.checkoutSessionReference +
        "/payment-intents",
      {
        method: "POST",
        headers: {
          origin: "https://customer.invalid",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          cookie,
          "x-csrf-token": credentials.csrfCredential,
          "idempotency-key": preparation.input.selectionReference,
        },
        body: JSON.stringify({ tip: { amountMinor: "0", currency: "CAD" } }),
      },
    );
  const first = await post("__Host-bop-guest=" + credentials.sessionCredential);
  assert.equal(first.status, 201, JSON.stringify(http.diagnostics.slice(-45)));
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  const created = await first.json();
  assert.equal(created.payment.orderReference, order.record.order.orderReference);
  assert.deepEqual(created.payment.total, { amountMinor: "5650", currency: "CAD" });
  const replay = await post("__Host-bop-guest=" + credentials.sessionCredential);
  assert.equal(replay.status, 200);
  const recovered = await replay.json();
  assert.deepEqual(recovered.payment, { ...created.payment, creationStatus: "AlreadyCreated" });
  const denied = await post(oldCookie);
  assert.equal(denied.status, 404);
  assert.equal((await denied.json()).error.code, "payment_not_found");
  assert.equal(providerCalls, 1);
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_payment.payment_intent) intents,(SELECT count(*)::int FROM rms_payment.payment_attempt) attempts,(SELECT count(*)::int FROM rms_payment.payment_intent_operation_record) operations",
  );
  assert.deepEqual(counts.rows[0], { intents: 1, attempts: 1, operations: 1 });
  return { store, provider, created, admission, transactions };
}
