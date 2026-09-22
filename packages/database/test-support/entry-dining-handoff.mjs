import assert from "node:assert/strict";
import { createStripeOnlineClientHandoff } from "../../rms/payment/src/infrastructure/stripe/stripe-online-client-handoff.ts";

export function prepareEntryDiningHandoffHttp(access) {
  let attached;
  const current = () => {
    assert(attached, "Entry payment handoff not attached");
    return attached;
  };
  return {
    options: {
      access,
      allowedOrigin: "https://customer.invalid",
      history: { resolveOperation: (input) => current().store.resolveOperation(input) },
      transactions: { run: (work) => current().transactions.run(work) },
      currentAdmission: (session) => {
        assert.equal(session.submissionReference, current().submissionReference);
        return current().admission;
      },
      allowConfirmation: (...args) => current().allowConfirmation(...args),
      provider: { retrieve: (...args) => current().provider.retrieve(...args) },
    },
    attach(value) {
      assert.equal(attached, undefined);
      attached = value;
    },
  };
}

/** Actual persisted Entry intent/admission, explicit synthetic confirmation policy and transport. */
export async function exerciseEntryDiningHandoff({
  scope,
  checkout,
  order,
  payment,
  http,
  base,
  oldCookie,
  now,
  amountMinor = 5650,
}) {
  assert(Number.isSafeInteger(amountMinor) && amountMinor > 0);
  const original = await payment.store.resolveOperation(checkout.session.paymentOperationReference);
  assert(original);
  assert.equal(original.providerOutcome.providerIntentReference, "pi_SYNTHETICENTRY0001");
  let reads = 0,
    confirmationAllowed = true;
  const clientSecret = "pi_SYNTHETICENTRY0001_secret_SYNTHETICONLY";
  const provider = createStripeOnlineClientHandoff({
    ...scope,
    environment: "Test",
    apiVersion: "2024-06-20",
    secretKey: "sk_test_SYNTHETICONLY",
    connectedAccount: null,
    now,
    fetch: async () => {
      reads++;
      return globalThis.Response.json({
        object: "payment_intent",
        id: "pi_SYNTHETICENTRY0001",
        currency: "cad",
        livemode: false,
        capture_method: "automatic",
        payment_method_types: ["card"],
        amount: amountMinor,
        amount_received: 0,
        amount_capturable: 0,
        status: "requires_payment_method",
        latest_charge: null,
        client_secret: clientSecret,
      });
    },
  });
  http.attach({
    ...payment,
    provider,
    submissionReference: order.record.submissionReference,
    allowConfirmation: async (session) =>
      confirmationAllowed && session.submissionReference === order.record.submissionReference,
  });
  const request = (cookie) =>
    globalThis.fetch(
      base +
        "/api/v1/checkout-sessions/" +
        checkout.session.checkoutSessionReference +
        "/payment-handoff",
      {
        method: "POST",
        headers: {
          origin: "https://customer.invalid",
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          cookie,
          "x-csrf-token": order.input.csrfCredential,
        },
        body: "{}",
      },
    );
  const cookie = "__Host-bop-guest=" + order.input.sessionCredential;
  const first = await request(cookie);
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  const body = await first.json();
  assert.equal(body.schemaVersion, 1);
  // Do not include even this synthetic client secret in assertion output.
  assert(body.clientSecret === clientSecret);
  assert.deepEqual(Object.keys(body).sort(), ["clientSecret", "schemaVersion"]);
  assert.equal(reads, 1);
  const stale = await request(oldCookie);
  assert.equal(stale.status, 404);
  assert.equal(reads, 1);
  confirmationAllowed = false;
  const denied = await request(cookie);
  assert.equal(denied.status, 422);
  assert.equal((await denied.json()).error.code, "payment_handoff_not_ready");
  assert.equal(reads, 1);
  const recovered = await payment.store.resolveOperation(
    checkout.session.paymentOperationReference,
  );
  assert.deepEqual(recovered, original);
  assert(
    !JSON.stringify(recovered, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ).includes(clientSecret),
  );
  return { provider };
}
