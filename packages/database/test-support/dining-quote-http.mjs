import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { createApp } from "../../../apps/api/src/app.ts";
import { CustomerQuoteHandler } from "../../../apps/api/src/customer-quote.ts";
import { createCustomerDiningQuoteComposition } from "../../../apps/api/src/customer-quote-composition.ts";
import { createCustomerDiningCheckoutIdentity } from "../../../apps/api/src/customer-dining-checkout-composition.ts";
import {
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import {
  createPostgresCurrentQuoteService,
  encodePriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
} from "../../rms/pricing/src/index.ts";
import { createPostgresCartQuoteExpiryStore } from "../../rms/ordering/src/index.ts";
import { input as policyInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { seedSubmissionCart } from "./dining-order-submission-seed.mjs";

/** Isolated no-option Quote contract fixture, not current Catalog selection acceptance. */
export async function exerciseDiningQuoteHttp({
  admin,
  runner,
  roles,
  f,
  cart,
  pricedQuote,
  scope,
  ownerScope,
  id,
}) {
  const at = f.options.preparation.now();
  let currentAt = at;
  const now = () => currentAt;
  let sequence = 260100,
    candidates = 0,
    lost = false,
    loseQuote = true,
    loseExpiry = true,
    shortQuote = false;
  const reference = () => id(++sequence);
  const quoteCart = {
    ...cart,
    cartReference: id(260001),
    aggregateVersion: 1,
    createdByActorReference: id(260002),
    createdAt: at,
    updatedAt: at,
    lifecycle: {
      ...cart.lifecycle,
      idleExpiresAt: new Date(Date.parse(at) + 3600000).toISOString(),
      absoluteExpiresAt: new Date(Date.parse(at) + 86400000).toISOString(),
      status: "Active",
      terminalAt: null,
      terminalReason: null,
    },
    items: cart.items.map((item, index) => ({
      ...item,
      cartReference: id(260001),
      cartItemReference: id(260010 + index),
      optionSelections: [],
      customerNote: null,
      addedAt: at,
      catalogSelectionEvidence: {
        ...item.catalogSelectionEvidence,
        ruleEvidence: [],
        validatedAt: at,
      },
    })),
  };
  await seedSubmissionCart(admin, { cart: quoteCart });
  await admin.query("GRANT SELECT,INSERT ON rms_pricing.price_quote_request TO " + roles[6]);
  await admin.query("GRANT SELECT,INSERT ON rms_ordering.cart_quote_expiry_record TO " + roles[2]);
  const attachmentTransactions = {
    async run(work) {
      let expired = false;
      const result = await runner(roles[2]).run((tx) =>
        work({
          query: async (sql, values) => {
            const rows = await tx.query(sql, values);
            if (sql.startsWith("INSERT INTO rms_ordering.cart_quote_expiry_record")) expired = true;
            return rows;
          },
        }),
      );
      if (expired && loseExpiry) {
        loseExpiry = false;
        throw new Error("synthetic committed expiry response loss");
      }
      return result;
    },
  };
  const identity = createCustomerDiningCheckoutIdentity(f.options.preparation, scope, now);
  const participation = createDiningCartParticipationQuery({
    scope,
    repository: createPostgresDiningParticipationStore(runner(roles[1]), ownerScope),
    now,
  });
  const template = policyInput();
  const policies = createPostgresCurrentQuoteService(runner(roles[7]), {
    scope,
    priceBookReference: pricedQuote.lines[0].resolvedPrice.priceBookReference,
    taxConfigurationReference: pricedQuote.lines[0].taxResolution.configurationReference,
    currencyMetadata: pricedQuote.currencyMetadata,
    evidence: {
      load: async () => ({
        registrationEvidence: {
          ...template.taxConfiguration.registrationEvidence,
          validUntil: "2099-01-01T00:00:00.000Z",
        },
        professionalEvidence: {
          ...template.taxConfiguration.professionalEvidence,
          validUntil: "2099-01-01T00:00:00.000Z",
        },
      }),
    },
    clock: { now },
  });
  const audit = (actionCode, reasonCode, targetType, targetId, occurredAt) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    reasonCode,
    targetType,
    targetId,
    occurredAt,
    correlationId: reference(),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "SYNTHETIC_RETENTION",
    retentionPolicyVersion: 1,
  });
  const diagnostics = [];
  const pricingTransactions = {
    async run(work) {
      let wrote = false;
      const result = await runner(roles[6])
        .run((tx) =>
          work({
            query: async (sql, values) => {
              let result;
              try {
                result = await tx.query(sql, values);
              } catch (error) {
                diagnostics.push({
                  stage: "pricing-sql",
                  code: /^[0-9A-Z]{5}$/u.test(error.code ?? "") ? error.code : "bounded",
                });
                throw error;
              }
              if (sql.startsWith("INSERT INTO rms_pricing.price_quote_request")) wrote = true;
              return result;
            },
          }),
        )
        .catch((error) => {
          diagnostics.push({ stage: "pricing-error", code: error.code ?? "bounded" });
          throw error;
        });
      diagnostics.push({ stage: "pricing-transaction", wrote });
      if (wrote && loseQuote) {
        loseQuote = false;
        lost = true;
        throw new Error("synthetic committed Quote response loss");
      }
      return result;
    },
  };
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const references = { hashIntent: hash, equals: (a, b) => a === b };
  const port = createCustomerDiningQuoteComposition({
    scope,
    sessions: identity,
    participation,
    now,
    cartTransactions: runner(roles[2]),
    attachmentTransactions,
    pricingTransactions,
    references,
    pricingReferences: { ...references, generateReference: reference },
    audit: (d) =>
      audit(
        "ORDERING_CART_ATTACH_QUOTE",
        "AUTHORIZED_CART_QUOTE",
        "OrderingCart",
        d.cartReference,
        d.observedAt,
      ),
    expiryAudit: (record) =>
      audit(
        "ORDERING_CART_QUOTE_EXPIRE",
        "QUOTE_VALIDITY_ENDED",
        "OrderingCart",
        record.cartReference,
        record.expiredAt,
      ),
    candidate: async (input) => {
      candidates++;
      let quote;
      try {
        quote = await policies.create({
          ...scope,
          quoteReference: reference(),
          cartReference: input.cartReference,
          cartVersion: input.cartVersion,
          inputDigest: hash(JSON.stringify(input)),
          createdAt: input.requestedAt,
          expiresAt: new Date(
            Date.parse(input.requestedAt) + (shortQuote ? 1 : 300000),
          ).toISOString(),
          lines: input.lines.map((item) => ({
            lineReference: item.lineReference,
            sellableReference: item.sellableReference,
            productVersionReference: item.catalogSelectionEvidence.productVersionReference,
            menuVersionReference: item.catalogSelectionEvidence.menuVersionReference,
            quantity: item.quantity,
            priceContext: {
              ...template.lines[0].priceContext,
              ...scope,
              sellableReference: item.sellableReference,
              orderType: "DineIn",
              evaluatedAt: input.requestedAt,
            },
            taxContext: {
              ...template.lines[0].taxContext,
              ...scope,
              taxClassificationReference:
                pricedQuote.lines[0].taxLines[0].explanation.taxClassificationReference,
              orderType: "DineIn",
              evaluatedAt: input.requestedAt,
            },
          })),
        });
      } catch (error) {
        diagnostics.push({ stage: "candidate", code: error.code });
        throw error;
      }
      try {
        decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(quote));
        diagnostics.push({ stage: "candidate-codec", valid: true });
      } catch (error) {
        diagnostics.push({ stage: "candidate-codec", valid: false, code: error.code });
        throw error;
      }
      return {
        quote,
        audit: audit(
          "PRICING_QUOTE_CREATE",
          "AUTHORIZED_CART_QUOTE",
          "PricingPriceQuote",
          quote.quoteReference,
          quote.createdAt,
        ),
      };
    },
  });
  const server = createServer(
    createApp({
      customerQuote: new CustomerQuoteHandler({
        port,
        allowedOrigin: "https://customer.example.test",
        now,
      }),
    }),
  );
  const close = async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  };
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    const operation = id(260090);
    const send = async ({
      csrf = f.orderInput.csrfCredential,
      version = 1,
      operationReference = operation,
    } = {}) => {
      const response = await globalThis.fetch(
        "http://127.0.0.1:" + address.port + "/api/v1/carts/" + quoteCart.cartReference + "/quote",
        {
          method: "POST",
          headers: {
            origin: "https://customer.example.test",
            "sec-fetch-site": "same-origin",
            "sec-fetch-mode": "cors",
            "content-type": "application/json",
            cookie: "__Host-bop-guest=" + f.orderInput.sessionCredential,
            "x-csrf-token": csrf,
            "idempotency-key": operationReference,
          },
          body: JSON.stringify({ cartVersion: version }),
        },
      );
      const body = await response.json();
      return { status: response.status, body };
    };
    assert.equal((await send({ csrf: "x".repeat(43) })).status, 404);
    assert.equal((await send({ version: 2 })).status, 409);
    assert.equal(candidates, 0);
    assert.equal((await send()).status, 503);
    assert.equal(lost, true, JSON.stringify({ candidates, diagnostics }));
    const recovered = await send();
    assert.equal(recovered.status, 201);
    assert.deepEqual(await send(), recovered);
    assert.equal(candidates, 1);
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_pricing.price_quote WHERE cart_id=$1) AS quotes,(SELECT count(*)::int FROM rms_pricing.price_quote_request WHERE cart_id=$1) AS requests,(SELECT count(*)::int FROM rms_ordering.cart_quote_attachment WHERE cart_id=$1) AS attachments",
          [quoteCart.cartReference],
        )
      ).rows[0];
    assert.deepEqual(await counts(), { quotes: 1, requests: 1, attachments: 1 });
    // A second request saves its Quote but loses the response before attachment.
    const pendingOperation = id(260091);
    shortQuote = true;
    loseQuote = true;
    assert.equal((await send({ operationReference: pendingOperation })).status, 503);
    assert.equal(loseQuote, false);
    currentAt = new Date(Date.parse(at) + 1).toISOString();
    assert.equal((await send({ operationReference: pendingOperation })).status, 503);
    assert.equal(loseExpiry, false);
    const terminal = await send({ operationReference: pendingOperation });
    assert.equal(terminal.status, 410);
    assert.deepEqual(terminal.body.resolution, {
      operationReference: pendingOperation,
      cartReference: quoteCart.cartReference,
      cartVersion: 1,
    });
    assert.deepEqual(await send({ operationReference: pendingOperation }), terminal);
    assert.equal(candidates, 2);
    const expiryCounts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_ordering.cart_quote_expiry_record WHERE cart_id=$1) AS expiries,(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='ORDERING_CART_QUOTE_EXPIRE') AS audits",
          [quoteCart.cartReference],
        )
      ).rows[0];
    assert.deepEqual(await counts(), { quotes: 2, requests: 2, attachments: 1 });
    assert.deepEqual(await expiryCounts(), { expiries: 1, audits: 1 });
    const expiryStore = createPostgresCartQuoteExpiryStore(runner(roles[2]), scope);
    const savedExpiry = await expiryStore.resolveOperation(pendingOperation);
    assert.ok(savedExpiry);
    const savedAudit = audit(
      "ORDERING_CART_QUOTE_EXPIRE",
      "QUOTE_VALIDITY_ENDED",
      "OrderingCart",
      quoteCart.cartReference,
      savedExpiry.expiredAt,
    );
    await assert.rejects(
      expiryStore.expire({
        record: savedExpiry,
        audit: savedAudit,
      }),
      { code: "CART_DEPENDENCY_UNAVAILABLE" },
    );
    await assert.rejects(
      expiryStore.expire({
        record: savedExpiry,
        audit: savedAudit,
        diningSessionReference: id(260099),
      }),
      { code: "CART_DEPENDENCY_UNAVAILABLE" },
    );
    assert.deepEqual(await expiryCounts(), { expiries: 1, audits: 1 });
    // An already-attached Quote remains its original result after Quote validity ends.
    currentAt = new Date(Date.parse(at) + 300001).toISOString();
    assert.deepEqual(await send(), recovered);
    assert.deepEqual(await expiryCounts(), { expiries: 1, audits: 1 });
    return {
      close,
      assertRevoked: async () => {
        currentAt = f.options.preparation.now();
        assert.equal((await send()).status, 404);
        assert.equal((await send({ operationReference: pendingOperation })).status, 404);
        assert.equal(candidates, 2);
        assert.deepEqual(await counts(), { quotes: 2, requests: 2, attachments: 1 });
        assert.deepEqual(await expiryCounts(), { expiries: 1, audits: 1 });
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
}
