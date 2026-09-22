import { createCustomerDiningSessionBinding } from "../../../apps/api/src/customer-dining-binding-composition.ts";
import {
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import assert from "node:assert/strict";
import { GuestSessionService } from "../../bop/identity/src/index.ts";
import { createPostgresConfiguredCartQuoteStore } from "../../rms/ordering/src/index.ts";
import { createCustomerConfiguredQuoteHttpComposition } from "../../../apps/api/src/customer-configured-quote-composition.ts";
import { createLocalCustomerRuntime } from "../../../apps/api/src/local-customer-runtime.ts";
import { createApiRuntimeLogger } from "../../../apps/api/src/server.ts";
import { fixture as entryFixture } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { deferredCheckoutPayment } from "./deferred-checkout-payment.mjs";

/** Same Cart and retained server. Commercial/QR/safety policy remains explicit synthetic input. */
export async function exerciseConfiguredJourneyQuote({
  admin,
  runner,
  roles,
  journey,
  scope,
  ownerScope,
  identity,
  cart,
  id,
  configuration,
  credentials,
  sessionCredential,
  csrfCredential,
  sessions,
  now,
  hash,
  operationReference,
  catalogScope,
  catalogSafety,
}) {
  assert(configuration);
  const dining = cart.orderType === "DineIn";
  assert(dining || cart.orderType === "Pickup");
  const cartRole = roles[dining ? 2 : 1];
  assert.equal(journey.runtime, undefined);
  const diagnostics = [];
  const checkedRunner = (role) => ({
    run: (work) =>
      runner(role).run((transaction) =>
        work({
          query: async (sql, values) => {
            const table =
              /(?:FROM|INTO|UPDATE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner-query";
            try {
              const result = await transaction.query(sql, values);
              diagnostics.push({ table, rows: result.rows.length });
              return result;
            } catch (error) {
              diagnostics.push({
                table,
                code: /^[0-9A-Z]{5}$/.test(error.code ?? "") ? error.code : "unknown",
              });
              throw error;
            }
          },
        }),
      ),
  });
  let sequence = 960000;
  const reference = () => id(++sequence);
  const audit = (actionCode, targetType, targetId, occurredAt, reasonCode) => ({
    auditId: reference(),
    ...{ brandId: scope.brandReference, storeId: scope.storeReference },
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    occurredAt,
    reasonCode,
    correlationId: reference(),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "SYNTHETIC_RETENTION",
    retentionPolicyVersion: 1,
  });
  await admin.query("GRANT SELECT,INSERT ON rms_pricing.price_quote_request TO " + roles[6]);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.cart_quote_expiry_record TO " + cartRole);
  const session = dining
    ? {
        ...identity.session,
        binding: createCustomerDiningSessionBinding({
          scope,
          binding: identity.session.binding,
          repository: identity.dining.current,
          contexts: identity.contexts,
          now,
        }),
      }
    : { credentials, binding: { validate: async () => "Current" } };
  const participation = dining
    ? createDiningCartParticipationQuery({
        scope,
        now,
        repository: createPostgresDiningParticipationStore(checkedRunner(roles[1]), ownerScope),
      })
    : null;
  const port = createCustomerConfiguredQuoteHttpComposition({
    scope,
    ...(dining ? { orderType: "DineIn", participation } : { orderType: "Pickup" }),
    sessions: new GuestSessionService({
      ...session,
      store: sessions,
      admission: { consume: async () => null },
      now,
    }),
    now,
    references: { hashIntent: hash, equals: (a, b) => a === b },
    cartTransactions: checkedRunner(cartRole),
    attachmentTransactions: checkedRunner(cartRole),
    pricingTransactions: checkedRunner(roles[6]),
    pricingReferences: {
      generateReference: reference,
      hashIntent: hash,
      equals: (a, b) => a === b,
    },
    catalogTransactions: checkedRunner(roles[5]),
    catalogScope,
    catalogSafety,
    catalogReferences: { generate: reference, hash },
    pricingChannelCode: configuration.request.base.lines[0].priceContext.channelCode,
    audit: (input) =>
      audit(
        "ORDERING_CART_ATTACH_QUOTE",
        "OrderingCart",
        cart.cartReference,
        input.observedAt,
        "AUTHORIZED_CART_QUOTE",
      ),
    policyTransactions: checkedRunner(roles[7]),
    policies: configuration.policies,
    quoteRequest: async (input) => {
      diagnostics.push({ stage: "quote-request" });
      assert.equal(input.cartReference, cart.cartReference);
      assert.equal(input.cartVersion, cart.aggregateVersion);
      return {
        ...configuration.request,
        base: {
          ...configuration.request.base,
          createdAt: input.requestedAt,
          lines: configuration.request.base.lines.map((line) => ({
            ...line,
            priceContext: { ...line.priceContext, evaluatedAt: input.requestedAt },
            taxContext: { ...line.taxContext, evaluatedAt: input.requestedAt },
          })),
        },
      };
    },
    quoteAudit: async (quote) =>
      audit(
        "PRICING_QUOTE_CREATE",
        "PricingPriceQuote",
        quote.quoteReference,
        quote.createdAt,
        "AUTHORIZED_CART_QUOTE",
      ),
    expiryAudit: (record) =>
      audit(
        "ORDERING_CART_QUOTE_EXPIRE",
        "OrderingCart",
        record.cartReference,
        record.expiredAt,
        "QUOTE_VALIDITY_ENDED",
      ),
  });
  const wrong = async () => {
    throw new Error("wrong or unavailable channel");
  };
  const details = (method, input) => {
    if (!journey.detailsPort) throw new Error("Checkout details not attached");
    return journey.detailsPort[method](input);
  };
  const order = {
    quoteVersion: 2,
    create: (input) => {
      if (!journey.orderPort) throw new Error("Order not attached");
      return journey.orderPort.create(input);
    },
  };
  const downstream = deferredCheckoutPayment(journey, scope);
  journey.attachPayment = (options) => downstream.attach(options);
  const entry = entryFixture().options;
  const origin = "https://customer.example";
  const channels = (active, inactive) =>
    dining ? { pickup: inactive, dining: active } : { pickup: active, dining: inactive };
  const detailsPort = {
    quoteVersion: 2,
    read: (input) => details("read", input),
    policy: (input) => details("policy", input),
    save: (input) => details("save", input),
  };
  const runtime = createLocalCustomerRuntime({
    scope,
    entry: { ...entry, session: { ...entry.session, ...session } },
    sessionTransactions: checkedRunner(roles[0]),
    cartTransactions: checkedRunner(cartRole),
    menuTransactions: checkedRunner(roles[5]),
    menuStores: { resolvePublic: async () => null },
    configuredCartQuote: channels(port, { quoteCart: wrong }),
    channelCheckoutDetails: channels(detailsPort, {
      quoteVersion: 2,
      read: wrong,
      policy: wrong,
      save: wrong,
    }),
    channelOrderSubmission: channels(order, { quoteVersion: 2, create: wrong }),
    payment: downstream.payment,
    receipt: downstream.receipt,
    orderStatus: downstream.orderStatus,
    allowedOrigin: origin,
    now: () => (journey.paymentOptions ? journey.paymentOptions.payment.access.now() : now()),
    uuidV7Factory: reference,
    runtime: { logger: createApiRuntimeLogger({ write: () => undefined }) },
  });
  Object.assign(journey, { runtime, scope, mode: cart.orderType, origin });
  await runtime.listen();
  const send = () =>
    globalThis.fetch(
      `http://127.0.0.1:${runtime.server.address().port}/api/v1/carts/${cart.cartReference}/quote`,
      {
        method: "POST",
        headers: {
          origin,
          "sec-fetch-site": "same-origin",
          "content-type": "application/json",
          cookie: "__Host-bop-guest=" + sessionCredential,
          "x-csrf-token": csrfCredential,
          "idempotency-key": operationReference,
        },
        body: JSON.stringify({ cartVersion: cart.aggregateVersion }),
      },
    );
  const first = await send();
  assert.equal(first.status, 201, JSON.stringify(diagnostics));
  assert.equal(first.headers.get("cache-control"), "no-store");
  const replay = await send();
  assert.equal(replay.status, 201);
  assert.deepEqual(await replay.json(), await first.json());
  const attachments = createPostgresConfiguredCartQuoteStore(checkedRunner(cartRole), scope, {
    hashIntent: hash,
    equals: (a, b) => a === b,
  });
  const quote = await attachments.resolveOperation(operationReference);
  assert(quote);
  assert.equal(quote.cartReference, cart.cartReference);
  assert.equal(quote.cartVersion, cart.aggregateVersion);
  assert.equal(quote.quoteVersion, 2);
  return quote;
}
