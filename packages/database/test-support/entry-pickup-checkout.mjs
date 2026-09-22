import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { createCustomerCheckoutSessionAuthorization } from "../../../apps/api/src/customer-checkout-session-authorization.ts";
import { createCustomerCheckoutSessionComposition } from "../../../apps/api/src/customer-checkout-session-composition.ts";
import { createCustomerPickupSessionValidation } from "../../../apps/api/src/customer-pickup-session-validation.ts";
import { createCustomerPickupCapacitySources } from "../../../apps/api/src/customer-pickup-capacity-sources.ts";
import { createCustomerCartSelectionInventory } from "../../../apps/api/src/customer-cart-selection-inventory.ts";
import { createPostgresGuestSessionEntryStore } from "../../bop/identity/src/index.ts";
import { createPostgresAsapCapacityStore } from "../../rms/fulfillment/src/index.ts";
import {
  createPostgresCartQueryStore,
  createPostgresCartQuoteStore,
} from "../../rms/ordering/src/index.ts";

/** Existing owner services over the original Entry Guest/Cart. Capacity configuration
 * and safety/publication approvals remain synthetic fixture inputs. */
export async function prepareEntryPickupCheckout({
  admin,
  role,
  run,
  scope,
  at,
  session,
  binding,
}) {
  await admin.query("GRANT USAGE ON SCHEMA rms_fulfillment TO " + role);
  await admin.query("GRANT SELECT,UPDATE ON rms_fulfillment.capacity_slot TO " + role);
  await admin.query(
    "GRANT SELECT ON rms_fulfillment.capacity_slot_configuration,rms_fulfillment.capacity_hold,rms_fulfillment.capacity_hold_terminal,rms_fulfillment.capacity_allocation,rms_fulfillment.capacity_allocation_terminal TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_fulfillment.capacity_asap_commitment,rms_ordering.checkout_session_allocation,rms_ordering.checkout_session_record TO " +
      role,
  );
  const timeZone = "America/Toronto";
  const businessDate = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(at));
  const shift = (ms) => new Date(Date.parse(at) + ms).toISOString();
  await admin.query(
    "INSERT INTO rms_fulfillment.capacity_slot (brand_id,store_id,slot_id,fulfillment_type,starts_at,ends_at,time_zone,business_date) VALUES ($1,$2,$3,'Pickup',$4,$5,$6,$7)",
    [
      scope.brandReference,
      scope.storeReference,
      id(95000),
      shift(-60000),
      shift(1800000),
      timeZone,
      businessDate,
    ],
  );
  await admin.query(
    "INSERT INTO rms_fulfillment.capacity_slot_configuration (brand_id,store_id,slot_id,config_version,capacity_limit,published_at) VALUES ($1,$2,$3,1,1,$4)",
    [scope.brandReference, scope.storeReference, id(95000), shift(-120000)],
  );
  const originalRun = run;
  const failures = [];
  run = (work) =>
    originalRun((tx) =>
      work({
        ...tx,
        query: async (sql, values) => {
          try {
            return await tx.query(sql, values);
          } catch (error) {
            failures.push({
              stage: "database",
              code: /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : "UNKNOWN",
            });
            throw error;
          }
        },
      }),
    );
  const now = () => new Date().toISOString();
  let sequence = 95100;
  const reference = () => id(++sequence);
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
    retentionPolicyCode: "SYNTHETIC_RETENTION",
    retentionPolicyVersion: 1,
  });
  const accessOptions = {
    scope,
    transactions: { run },
    credentials: session.credentials,
    binding,
    now,
  };
  const preparation = {
    scope,
    now,
    session: { ...session, store: createPostgresGuestSessionEntryStore({ run }, scope) },
    sources: createCustomerPickupCapacitySources({
      scope,
      orderingTransactions: { run },
      capacityTransactions: { run },
      now,
      unitPolicy: { resolve: async () => ({ mode: "PerFulfillment", ruleVersion: 1 }) },
    }),
    capacity: {
      repository: createPostgresAsapCapacityStore({ run }, scope, { now }),
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
  let validate;
  const options = {
    ...accessOptions,
    quoteVersion: 1,
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
    validate: async (input) => {
      if (!validate) throw new Error("Pickup validation not attached");
      try {
        return await validate(input);
      } catch (error) {
        failures.push({
          stage: "validation",
          code: /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : "UNKNOWN",
        });
        throw error;
      }
    },
  };
  return {
    options,
    failures,
    preparation,
    attach(value) {
      assert.equal(validate, undefined);
      validate = value;
    },
  };
}

export async function exerciseEntryPickupCheckout({
  admin,
  run,
  scope,
  base,
  pickup,
  quote,
  http,
  catalogOptions,
}) {
  const now = http.options.now;
  const hashIntent = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const carts = createPostgresCartQueryStore({ run }, scope);
  const quotes = createPostgresCartQuoteStore({ run }, scope, {
    hashIntent,
    equals: (a, b) => a === b,
  });
  let validations = 0,
    observations = 0;
  let submissionOptions;
  http.attach(async (input) => {
    validations++;
    const access = createCustomerCheckoutSessionAuthorization(http.options, {
      sessionCredential: input.sessionCredential,
      csrfCredential: input.csrfCredential,
      cartReference: quote.cartReference,
    });
    const catalog = {
      async validateSelection(selection) {
        const authority = await access.authorize(input.request, selection.observedAt);
        assert(authority);
        const cart = await carts.load(quote.cartReference);
        assert(cart);
        assert.equal(cart.aggregateVersion, quote.cartVersion);
        assert(cart.items.every((item) => item.optionSelections.length === 0));
        const quantity = cart.items
          .filter((item) => item.sellableReference === selection.sellableReference)
          .reduce((sum, item) => sum + item.quantity, 0);
        assert.equal(quantity, 2);
        // Keep current Guest/Tenant binding locks in a separate retained transaction:
        // Inventory observation must remain Repeatable Read / read-only.
        return http.options.transactions.run(async (authorityTx) => {
          const selected = createCustomerCartSelectionInventory(
            catalogOptions.catalogTransactions,
            { ...scope, ...catalogOptions.catalogScope, orderType: "Pickup" },
            { ...catalogOptions.catalogSafety, clock: { now } },
            {
              ...catalogOptions.selectedInventory,
              authorize: async (_inventoryTx, request, context) => {
                if (request.quantity !== quantity || context.cartVersion !== cart.aggregateVersion)
                  return false;
                const allowed = await access.authorizeInTransaction(
                  authorityTx,
                  authority,
                  request.observedAt,
                );
                if (allowed) observations++;
                return allowed;
              },
            },
          );
          return selected.validateSelection(selection, {
            diningSessionReference: null,
            cartReference: cart.cartReference,
            cartVersion: cart.aggregateVersion,
            guestSessionReference: quote.guestSessionReference,
            quantity,
          });
        });
      },
    };
    const validateSelection = catalog.validateSelection;
    catalog.validateSelection = async (selection) => {
      try {
        return await validateSelection(selection);
      } catch (error) {
        http.failures.push({
          stage: "catalog",
          code: /^[A-Z0-9_]{1,64}$/.test(error?.code) ? error.code : "UNKNOWN",
        });
        throw error;
      }
    };
    submissionOptions = {
      preparation: http.preparation,
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
        references: { hashIntent },
      },
    };
    return createCustomerPickupSessionValidation(submissionOptions)(input);
  });
  const request = {
    createOperationReference: id(95900),
    cartReference: quote.cartReference,
    cartVersion: quote.cartVersion,
    quoteReference: quote.quoteReference,
    quoteVersion: 1,
  };
  const headers = {
    origin: "https://customer.invalid",
    "sec-fetch-site": "same-origin",
    "content-type": "application/json",
    "x-csrf-token": pickup.csrfToken,
  };
  const send = (cookie = pickup.cookie) =>
    globalThis.fetch(base + "/api/v1/carts/" + quote.cartReference + "/checkout-sessions", {
      method: "POST",
      headers: { ...headers, cookie, "idempotency-key": request.createOperationReference },
      body: JSON.stringify({
        cartVersion: quote.cartVersion,
        quoteReference: quote.quoteReference,
      }),
    });
  const first = await send();
  assert.equal(
    first.status,
    201,
    JSON.stringify({ failures: http.failures, validations, observations }),
  );
  assert.equal(first.headers.get("cache-control"), "no-store");
  const view = await first.json();
  const repeated = await send();
  assert.equal(repeated.status, 200);
  assert.deepEqual(await repeated.json(), view);
  const read = (cookie = pickup.cookie) =>
    globalThis.fetch(base + "/api/v1/checkout-sessions/" + view.session.checkoutSessionReference, {
      headers: { ...headers, cookie },
    });
  const current = await read();
  assert.equal(current.status, 200);
  assert.deepEqual(await current.json(), view);
  for (const denied of [await send(pickup.oldCookie), await read(pickup.oldCookie)]) {
    assert.equal(denied.status, 404);
    assert.equal((await denied.json()).error.code, "checkout_session_not_found");
  }
  const created = await createCustomerCheckoutSessionComposition(http.options).create({
    sessionCredential: pickup.cookie.split("=")[1],
    csrfCredential: pickup.csrfToken,
    command: request,
  });
  assert.equal(created.status, "AlreadyCreated");
  const saved = created.session;
  assert.equal(saved.checkoutSessionReference, view.session.checkoutSessionReference);
  assert.equal(saved.validation.cartReference, quote.cartReference);
  assert.equal(saved.validation.quoteReference, quote.quoteReference);
  const capacity = await http.preparation.capacity.repository.loadSubmission(
    saved.submissionReference,
  );
  assert(capacity);
  assert.equal(capacity.guestSessionReference, quote.guestSessionReference);
  assert.equal(capacity.cartReference, quote.cartReference);
  assert.equal(capacity.cartVersion, quote.cartVersion);
  assert.equal(capacity.quoteReference, quote.quoteReference);
  assert.equal(capacity.paymentOperationReference, saved.paymentOperationReference);
  assert.equal(capacity.allocationReference, saved.validation.fulfillment.evidenceReference);
  assert.equal(capacity.units, 1);
  assert.equal(validations, 1);
  assert(observations >= 2);
  const counts = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.checkout_session_allocation) allocations,(SELECT count(*)::int FROM rms_ordering.checkout_session_record) sessions,(SELECT count(*)::int FROM rms_fulfillment.capacity_asap_commitment) commitments,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='FULFILLMENT_ASAP_CAPACITY_PREPARED') capacity_audits,(SELECT count(*)::int FROM rms_ordering.order_header) orders,(SELECT count(*)::int FROM rms_inventory.stock_reservation_version) reservations",
  );
  assert.deepEqual(counts.rows[0], {
    allocations: 1,
    sessions: 1,
    commitments: 1,
    capacity_audits: 1,
    orders: 0,
    reservations: 0,
  });
  return {
    session: saved,
    request,
    capacity,
    preparation: http.preparation,
    access: http.options,
    submissionOptions,
  };
}
