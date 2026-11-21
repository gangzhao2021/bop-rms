import { entryDiningCheckoutAccessOptions } from "./entry-dining-allocation.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createCustomerCheckoutSessionComposition } from "../../../apps/api/src/customer-checkout-session-composition.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerDiningSessionValidation } from "../../../apps/api/src/customer-dining-session-validation.ts";
import { createCustomerCartSelectionInventory } from "../../../apps/api/src/customer-cart-selection-inventory.ts";
import {
  createPostgresCartQueryStore,
  createPostgresCartQuoteStore,
} from "../../rms/ordering/src/index.ts";

/** Actual Entry allocation/commitment and owner sources; no fabricated checkout validation. */
export async function exerciseEntryDiningCheckoutSession({
  admin,
  role,
  run,
  scope,
  quote,
  cookie,
  csrfToken,
  oldCookie,
  commitment,
  sources,
  http,
  base,
}) {
  const { allocated } = commitment;
  assert(allocated);
  const now = allocated.options.now;
  const credentials = { sessionCredential: cookie.split("=")[1], csrfCredential: csrfToken };
  const access = createCustomerCheckoutSessionAuthorization(allocated.options, {
    ...credentials,
    cartReference: quote.cartReference,
  });
  const carts = createPostgresCartQueryStore({ run }, scope);
  const quotes = createPostgresCartQuoteStore({ run }, scope, {
    hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
    equals: (a, b) => a === b,
  });
  let observations = 0;
  const catalog = {
    async validateSelection(input) {
      const authority = await access.authorize(allocated.request, input.observedAt);
      assert(authority);
      const cart = await carts.load(quote.cartReference);
      assert(cart);
      assert.equal(cart.aggregateVersion, quote.cartVersion);
      // This ordinary-entry scenario contains one SKU, no option variations.
      assert(cart.items.every((item) => item.optionSelections.length === 0));
      const quantity = cart.items
        .filter((item) => item.sellableReference === input.sellableReference)
        .reduce((sum, item) => sum + item.quantity, 0);
      assert.equal(quantity, 5);
      const selected = createCustomerCartSelectionInventory(
        sources.reads,
        {
          ...scope,
          ...sources.catalogOptions.catalogScope,
          orderType: "DineIn",
        },
        { ...sources.catalogOptions.catalogSafety, clock: { now } },
        {
          scope: sources.inventoryScope,
          transactions: sources.reads,
          resolveExpiryCutoff: async () => {
            throw new Error("NoLot fixture");
          },
          authorize: async (tx, selection, context) => {
            if (selection.quantity !== quantity || context.cartVersion !== cart.aggregateVersion)
              return false;
            const allowed = await access.authorizeInTransaction(
              tx,
              authority,
              selection.observedAt,
            );
            if (allowed) observations++;
            return allowed;
          },
        },
      );
      return selected.validateSelection(input, {
        diningSessionReference: cart.diningSessionReference,
        cartReference: cart.cartReference,
        cartVersion: cart.aggregateVersion,
        guestSessionReference: quote.guestSessionReference,
        quantity,
      });
    },
  };
  const submissionOptions = {
    preparation: { ...commitment.preparation, now },
    checkout: {
      catalog,
      repository: {
        loadCart: (ref) => carts.load(ref),
        loadQuote: (ref) =>
          quotes.loadLatest({
            cartReference: ref,
            cartVersion: quote.cartVersion,
            observedAt: now(),
          }),
      },
      references: {
        hashIntent: (value) => "sha256:" + createHash("sha256").update(value).digest("hex"),
      },
    },
  };
  const validation = createCustomerDiningSessionValidation(submissionOptions);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.checkout_session_record TO " + role);
  let validations = 0;
  http.attach(async (input) => {
    validations++;
    return validation(input);
  });
  const service = createCustomerCheckoutSessionComposition(http.options);
  const envelope = { ...credentials, command: allocated.request };
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    cookie,
    "x-csrf-token": csrfToken,
  };
  const send = (selectedCookie = cookie) =>
    globalThis.fetch(base + "/api/v1/carts/" + quote.cartReference + "/checkout-sessions", {
      method: "POST",
      headers: {
        ...headers,
        cookie: selectedCookie,
        "idempotency-key": allocated.request.createOperationReference,
      },
      body: JSON.stringify({
        cartVersion: quote.cartVersion,
        quoteReference: quote.quoteReference,
      }),
    });
  const first = await send();
  assert.equal(first.status, 201);
  assert.equal(first.headers.get("cache-control"), "no-store");
  assert.equal(first.headers.get("referrer-policy"), "no-referrer");
  const view = await first.json();
  const repeated = await send();
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), view);
  const read = (selectedCookie = cookie) =>
    globalThis.fetch(base + "/api/v1/checkout-sessions/" + view.session.checkoutSessionReference, {
      headers: { ...headers, cookie: selectedCookie },
    });
  const current = await read();
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), view);
  for (const denied of [await send(oldCookie), await read(oldCookie)]) {
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).error.code, "checkout_session_not_found");
  }
  const created = await service.create(envelope);
  assert.equal(created.status, "AlreadyCreated");
  assert.equal(view.session.checkoutSessionReference, created.session.checkoutSessionReference);
  assert.equal(
    created.session.checkoutSessionReference,
    allocated.allocation.checkoutSessionReference,
  );
  assert.equal(created.session.submissionReference, commitment.record.submissionReference);
  assert.equal(
    created.session.paymentOperationReference,
    commitment.record.paymentOperationReference,
  );
  assert.equal(created.session.validation.cartReference, quote.cartReference);
  assert.equal(created.session.validation.quoteReference, quote.quoteReference);
  assert.equal(
    created.session.validation.fulfillment.evidenceReference,
    commitment.record.commitmentReference,
  );
  assert.equal(validations, 1);
  assert(observations >= 2);
  const replay = await service.create(envelope);
  assert.equal(replay.status, "AlreadyCreated");
  assert.deepEqual(replay.session, created.session);
  assert.equal(validations, 1);
  await assert.rejects(service.create({ ...envelope, sessionCredential: oldCookie.split("=")[1] }));
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) allocations,(SELECT count(*)::int FROM rms_ordering.checkout_session_record) sessions,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='ORDERING_CHECKOUT_SESSION_CREATE') audits",
  );
  assert.deepEqual(counts.rows[0], { allocations: 1, sessions: 1, audits: 1 });
  return { session: created.session, service, envelope, submissionOptions };
}

/** Validation is attached after actual owner inputs exist; early requests fail closed. */
export function prepareEntryDiningCheckoutRuntime({
  run,
  scope: ownerScope,
  session,
  contexts,
  reference,
}) {
  const access = entryDiningCheckoutAccessOptions({ run, scope: ownerScope, session, contexts });
  const scope = access.scope;
  const audit = (record, actionCode, occurredAt) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    reasonCode: "AUTHORIZED_CHECKOUT_CREATE",
    targetType: "CheckoutSession",
    targetId: record.checkoutSessionReference,
    occurredAt,
    correlationId: record.createOperationReference,
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "SYNTHETIC_RETENTION",
    retentionPolicyVersion: 1,
  });

  let validate;
  const options = {
    ...access,
    quoteVersion: 1,
    allowedOrigin: "https://customer.invalid",
    nextReference: reference,
    allocationAudit: (record) =>
      audit(record, "ORDERING_CHECKOUT_SESSION_ALLOCATE", record.allocatedAt),
    audit: (record) => audit(record, "ORDERING_CHECKOUT_SESSION_CREATE", record.createdAt),
    validate: (input) => {
      if (!validate) throw new Error("Entry checkout validation not attached");
      return validate(input);
    },
  };
  return {
    options,
    attach(value) {
      assert.equal(validate, undefined);
      validate = value;
    },
  };
}
