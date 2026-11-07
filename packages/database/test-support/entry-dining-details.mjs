import assert from "node:assert/strict";
import { CustomerCheckoutDetailsHandler } from "../../../apps/api/src/customer-checkout-details.ts";
import {
  createCustomerDiningCheckoutDetailsComposition,
  createCustomerPickupCheckoutDetailsComposition,
} from "../../../apps/api/src/customer-checkout-details-composition.ts";

/** Retained-server details port; real owner service attaches after Entry checkout exists. */
export function prepareEntryDiningDetailsHttp() {
  let service;
  const invoke = (method, input) => {
    if (!service) throw new Error("Entry checkout details not attached");
    return service[method](input);
  };
  const port = {
    quoteVersion: 1,
    read: (input) => invoke("read", input),
    policy: (input) => invoke("policy", input),
    save: (input) => invoke("save", input),
  };
  return {
    port,
    handler: new CustomerCheckoutDetailsHandler({
      allowedOrigin: "https://customer.invalid",
      port,
    }),
    attach(value) {
      assert.equal(service, undefined);
      service = value;
    },
  };
}

export async function exerciseEntryDiningDetails({
  admin,
  role,
  run,
  scope,
  quote,
  cookie,
  csrfToken,
  oldCookie,
  commitment,
  checkout,
  http,
  base,
  reference,
  mode = "DineIn",
  pickupPreparation,
}) {
  assert.equal(checkout.session.validation.cartReference, quote.cartReference);
  assert.equal(checkout.session.validation.quoteReference, quote.quoteReference);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.checkout_details_record TO " + role);
  const now = mode === "Pickup" ? pickupPreparation.now : commitment.allocated.options.now;
  // Explicit synthetic no-required-policy fixture; not real Store legal approval.
  const policies = {
    current: async (input) => ({
      brandReference: input.brandReference,
      storeReference: input.storeReference,
      orderType: input.orderType,
      checkedAt: input.observedAt,
      validUntil: quote.quoteExpiresAt,
      required: [],
    }),
  };
  const service = (
    mode === "Pickup"
      ? createCustomerPickupCheckoutDetailsComposition
      : createCustomerDiningCheckoutDetailsComposition
  )({
    scope,
    quoteVersion: 1,
    cartTransactions: { run },
    detailsTransactions: { run },
    ...(mode === "Pickup"
      ? { session: pickupPreparation.session }
      : { identity: commitment.preparation }),
    now,
    policies,
    audit: async (input) => ({
      auditId: reference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "ORDERING_CHECKOUT_DETAILS_SAVE",
      reasonCode: "AUTHORIZED_CHECKOUT_UPDATE",
      targetType: "CheckoutDetails",
      targetId: input.detailsReference,
      occurredAt: input.observedAt,
      correlationId: input.operationReference,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    }),
  });
  http.attach(service);
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    cookie,
    "x-csrf-token": csrfToken,
  };
  const post = (path, body, selectedCookie = cookie, operation = undefined) =>
    globalThis.fetch(base + path, {
      method: "POST",
      headers: {
        ...headers,
        cookie: selectedCookie,
        ...(operation ? { "idempotency-key": operation } : {}),
      },
      body: JSON.stringify(body),
    });
  const query = { cartReference: quote.cartReference, cartVersion: quote.cartVersion };
  const policy = await post("/bff/customer/checkout-details/policy", query);
  assert.equal(policy.status, 200);
  assert.deepEqual((await policy.json()).policy.documents, []);
  const empty = await post("/bff/customer/checkout-details/current", query);
  assert.equal(empty.status, 200);
  assert.equal((await empty.json()).checkout.details, null);
  const operationReference = reference();
  const body = {
    detailsReference: reference(),
    expectedVersion: 0,
    ...query,
    quoteReference: quote.quoteReference,
    quoteVersion: 1,
    pickupContact:
      mode === "Pickup"
        ? { name: "Synthetic guest", channel: "Phone", value: "+12025550123" }
        : null,
    receipt: { choice: "InSession", email: null },
    policies: [],
  };
  const first = await post("/bff/customer/checkout-details", body, cookie, operationReference);
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  const view = await first.json();
  const replay = await post("/bff/customer/checkout-details", body, cookie, operationReference);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), view);
  const latest = await post("/bff/customer/checkout-details/current", query);
  assert.equal(latest.status, 200);
  const current = (await latest.json()).checkout.details;
  assert.equal(current.detailsReference, body.detailsReference);
  assert.equal(current.detailsVersion, 1);
  const denied = await post("/bff/customer/checkout-details", body, oldCookie, operationReference);
  assert.equal(denied.status, 404);
  await denied.text();
  const input = {
    sessionCredential: cookie.split("=")[1],
    csrfCredential: csrfToken,
    command: { operationReference, ...body },
  };
  const saved = await service.save(input);
  assert.equal(saved.status, "AlreadySaved");
  assert.equal(saved.snapshot.guestSessionReference, quote.guestSessionReference);
  assert.equal(saved.snapshot.cartReference, checkout.session.validation.cartReference);
  assert.equal(saved.snapshot.quoteReference, quote.quoteReference);
  assert.deepEqual(saved.snapshot.receipt, body.receipt);
  assert.deepEqual(saved.snapshot.pickupContact, body.pickupContact);
  assert.equal(saved.snapshot.orderType, mode);
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_details_record) records,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_CHECKOUT_DETAILS_SAVE') audits",
  );
  assert.deepEqual(counts.rows[0], { records: 1, audits: 1 });
  return { service, input, saved, policies };
}
