import assert from "node:assert/strict";
import {
  createPostgresPaymentTerminalStore,
  createPostgresPaymentTerminalSource,
  createPostgresPaymentProviderObservationStore,
  createPaymentTerminalService,
} from "../../rms/payment/src/index.ts";
import { normalizeStripeOnlineIntentResponse } from "../../rms/payment/src/infrastructure/stripe/stripe-online-intent-response.ts";

export function prepareEntryDiningResultHttp(access) {
  let attached;
  const current = () => {
    assert(attached, "Entry payment result not attached");
    return attached;
  };
  return {
    options: {
      access,
      allowedOrigin: "https://customer.invalid",
      history: { resolveOperation: (input) => current().history.resolveOperation(input) },
      terminal: { read: (input) => current().terminal.read(input) },
    },
    attach(value) {
      assert.equal(attached, undefined);
      attached = value;
    },
  };
}

/** Synthetic captured Provider observation, actual owner observation/terminal/Event/Audit persistence. */
export async function exerciseEntryDiningResult({
  admin,
  role,
  run,
  scope,
  checkout,
  order,
  payment,
  http,
  base,
  oldCookie,
  now,
  reference,
  amountMinor = 5650,
  providerAccountReference,
}) {
  assert(Number.isSafeInteger(amountMinor) && amountMinor > 0);
  await admin.query("GRANT SELECT ON rms_payment.provider_webhook_record TO " + role);
  await admin.query("GRANT SELECT,INSERT ON rms_payment.payment_terminal_fact TO " + role);
  const terminalScope = {
    ...scope,
    providerAccountReference: providerAccountReference ?? reference(),
    environment: "Test",
  };
  const runner = { run };
  const terminal = createPostgresPaymentTerminalStore(runner, terminalScope);
  http.attach({ history: payment.store, terminal });
  const read = (cookie) =>
    globalThis.fetch(
      base +
        "/api/v1/checkout-sessions/" +
        checkout.session.checkoutSessionReference +
        "/payment-result",
      {
        headers: {
          "sec-fetch-site": "same-origin",
          cookie,
          "x-csrf-token": order.input.csrfCredential,
        },
      },
    );
  const cookie = "__Host-bop-guest=" + order.input.sessionCredential;
  const initial = await read(cookie);
  assert.equal(initial.status, 200);
  assert.equal((await initial.json()).payment.status, "Pending");
  const record = await payment.store.resolveOperation(checkout.session.paymentOperationReference);
  assert(record);
  const causationReference = reference();
  const observationReference = reference();
  const captured = normalizeStripeOnlineIntentResponse(
    {
      operation: "RetrieveIntent",
      purpose: "RetrievePaymentIntent",
      context: { ...record.providerOutcome.context, operationReference: causationReference },
      providerIntentReference: record.providerOutcome.providerIntentReference,
    },
    {
      object: "payment_intent",
      id: "pi_SYNTHETICENTRY0001",
      currency: "cad",
      livemode: false,
      capture_method: "automatic",
      payment_method_types: ["card"],
      amount: amountMinor,
      amount_received: amountMinor,
      amount_capturable: 0,
      status: "succeeded",
      latest_charge: {
        object: "charge",
        id: "ch_SYNTHETICENTRY0001",
        payment_intent: "pi_SYNTHETICENTRY0001",
        currency: "cad",
        livemode: false,
        amount: amountMinor,
        amount_captured: amountMinor,
        amount_refunded: 0,
        paid: true,
        captured: true,
        status: "succeeded",
        payment_method_details: { type: "card" },
      },
    },
    now(),
  );
  const observations = createPostgresPaymentProviderObservationStore(runner, scope, { now });
  const observed = await observations.record({
    observationReference,
    paymentIntentReference: record.intent.paymentIntentReference,
    snapshot: captured,
  });
  assert.equal(observed.status, "Recorded");
  assert.equal(
    (await (await read(cookie)).json()).payment.status,
    "Pending",
    "Provider capture observation alone must not become a successful customer result",
  );
  const service = createPaymentTerminalService({
    source: createPostgresPaymentTerminalSource(runner, terminalScope),
    repository: terminal,
    clock: { now },
    references: { generate: reference },
    audit: {
      create: async ({ fact, correlationReference }) => ({
        auditId: reference(),
        brandId: scope.brandReference,
        storeId: scope.storeReference,
        actor: { type: "System" },
        actionCode: "PAYMENT_TERMINAL_RECORDED",
        targetType: "PaymentIntent",
        targetId: fact.paymentIntentReference,
        afterSummary: { outcome: fact.outcome },
        reasonCode: "PAYMENT_CAPTURED",
        correlationId: correlationReference,
        occurredAt: fact.recordedAt,
        sourceChannel: "PAYMENT_RECONCILIATION",
        dataClassification: "Restricted",
        retentionPolicyCode: "FINANCIAL_COMPLIANCE",
        retentionPolicyVersion: 1,
      }),
    },
  });
  const input = {
    observationReference,
    causationReference,
    webhookReceiptReference: null,
    providerEventReference: null,
    providerAccountReference: terminalScope.providerAccountReference,
    providerIntentReference: captured.providerIntentReference,
    environment: "Test",
    paymentIntentReference: record.intent.paymentIntentReference,
    paymentAttemptReference: record.attempt.paymentAttemptReference,
    ...scope,
    source: "ProviderRetrieval",
    status: "Captured",
    amount: captured.capturedAmount,
    failureReason: null,
    retryDisposition: null,
    occurredAt: captured.observedAt,
    evidenceDigest: captured.evidenceDigest,
  };
  const committed = await service.record(input);
  assert.equal(committed.status, "Created");
  assert.equal((await service.record(input)).status, "AlreadyCommitted");
  const result = await read(cookie);
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("cache-control"), "no-store");
  assert.equal(result.headers.get("referrer-policy"), "no-referrer");
  const body = await result.json();
  assert.equal(body.payment.status, "Succeeded");
  assert.equal(body.payment.orderReference, order.record.order.orderReference);
  assert.deepEqual(body.payment.total, { amountMinor: String(amountMinor), currency: "CAD" });
  assert.equal((await read(oldCookie)).status, 404);
  const counts = await admin.query(
    "SELECT count(*)::int AS terminals FROM rms_payment.payment_terminal_fact",
  );
  assert.equal(counts.rows[0].terminals, 1);
  return { terminal, terminalScope, committed, record, captured };
}
