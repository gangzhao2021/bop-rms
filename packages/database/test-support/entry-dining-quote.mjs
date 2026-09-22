import { entryTorontoBoundary } from "./entry-toronto-boundary.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createEffectivePeriod } from "../../bop/effective-period/src/index.ts";
import { input as pricingInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import {
  createDiningCartParticipationQuery,
  createPostgresDiningParticipationStore,
} from "../../rms/dining/src/index.ts";
import { createPostgresCartQuoteStore } from "../../rms/ordering/src/index.ts";
import { createCustomerDiningQuoteComposition } from "../../../apps/api/src/customer-quote-composition.ts";
import { createPostgresCurrentQuoteService } from "../../rms/pricing/src/index.ts";
import { CustomerQuoteHandler } from "../../../apps/api/src/customer-quote.ts";
import { id } from "../../../apps/api/test-support/customer-entry-composition-fixture.ts";
import { seedPriceBook } from "./price-book-seed.mjs";
import { seedTaxConfiguration } from "./tax-configuration-seed.mjs";

export const syntheticDiningTaxClassification =
  pricingInput().taxConfiguration.rules[0].taxClassificationReference;

/** Synthetic commercial policies only; Guest/Cart/lines come from actual Entry and owner HTTP commands. */
export async function prepareEntryDiningQuote({
  admin,
  role,
  run,
  scope: ownerScope,
  sessions,
  at,
  skuReference,
  orderType = "DineIn",
}) {
  const scope = {
    brandReference: ownerScope.brandReference,
    storeReference: ownerScope.storeReference,
  };
  const diagnostics = [];
  const transactions = {
    run: (work) =>
      run((tx) =>
        work({
          query: async (sql, values) => {
            const table =
              /(?:FROM|INTO|UPDATE)\s+([a-z_]+\.[a-z_]+)/i.exec(sql)?.[1] ?? "owner-query";
            try {
              const result = await tx.query(sql, values);
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
  };
  const template = pricingInput();
  const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
  const references = { hashIntent: hash, equals: (a, b) => a === b };
  let sequence = 970000;
  const reference = () => id(++sequence);
  const validUntil = new Date(Date.parse(at) + 3600000).toISOString();
  const effectivePeriod = createEffectivePeriod({
    timeZone: "America/Toronto",
    effectiveFrom: entryTorontoBoundary(at),
    effectiveUntil: null,
  });
  const priceBook = {
    ...template.priceBook,
    brandReference: scope.brandReference,
    createdAt: at,
    entries: template.priceBook.entries.map((entry) => ({
      ...entry,
      sellableReference: skuReference,
      effectivePeriod,
    })),
  };
  const taxConfiguration = {
    ...template.taxConfiguration,
    ...scope,
    createdAt: at,
    effectivePeriod,
    registrationEvidence: { ...template.taxConfiguration.registrationEvidence, validUntil },
    professionalEvidence: {
      ...template.taxConfiguration.professionalEvidence,
      reviewedAt: at,
      validUntil,
    },
    rules: template.taxConfiguration.rules.map((rule) => ({ ...rule, orderType })),
  };
  await seedPriceBook(admin, priceBook, reference());
  await seedTaxConfiguration(admin, taxConfiguration, reference());
  await admin.query("GRANT USAGE ON SCHEMA rms_pricing TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_pricing.price_quote,rms_pricing.price_quote_line,rms_pricing.price_quote_tax_line,rms_pricing.price_quote_request TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT ON rms_pricing.price_book,rms_pricing.price_book_version,rms_pricing.price_entry,rms_pricing.tax_configuration,rms_pricing.tax_configuration_version,rms_pricing.tax_configuration_rule TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_ordering.cart_quote_attachment,rms_ordering.cart_quote_attachment_line,rms_ordering.cart_quote_expiry_record TO " +
      role,
  );
  const audit = (actionCode, targetType, targetId, occurredAt) => ({
    auditId: reference(),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    occurredAt,
    reasonCode:
      actionCode === "ORDERING_CART_QUOTE_EXPIRE"
        ? "QUOTE_VALIDITY_ENDED"
        : "AUTHORIZED_CART_QUOTE",
    correlationId: reference(),
    sourceChannel: "CUSTOMER_PWA",
    dataClassification: "Restricted",
    retentionPolicyCode: "SYNTHETIC_RETENTION",
    retentionPolicyVersion: 1,
  });
  let requests = 0;
  const policies = createPostgresCurrentQuoteService(
    {
      run: (work) =>
        transactions.run(async (tx) => {
          await tx.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY", []);
          return work(tx);
        }),
    },
    {
      ...{
        priceBookReference: priceBook.priceBookReference,
        taxConfigurationReference: taxConfiguration.configurationReference,
        currencyMetadata: template.currencyMetadata,
        evidence: {
          load: async () => ({
            registrationEvidence: taxConfiguration.registrationEvidence,
            professionalEvidence: taxConfiguration.professionalEvidence,
          }),
        },
      },
      scope,
      clock: { now: () => at },
    },
  );
  const configuration = {
    scope,
    now: () => at,
    references,
    cartTransactions: transactions,
    attachmentTransactions: transactions,
    pricingTransactions: transactions,
    pricingReferences: { ...references, generateReference: reference },
    candidate: async (input) => {
      requests++;
      diagnostics.push({ stage: "quote-request" });
      assert.equal(input.orderType, orderType);
      assert.equal(input.lines.length, orderType === "Pickup" ? 1 : 2);
      assert.deepEqual(
        input.lines.map((line) => line.quantity).sort(),
        orderType === "Pickup" ? [2] : [2, 3],
      );
      const quote = await policies.create({
        ...scope,
        quoteReference: reference(),
        cartReference: input.cartReference,
        cartVersion: input.cartVersion,
        inputDigest: hash(JSON.stringify(input)),
        createdAt: input.requestedAt,
        expiresAt: new Date(Date.parse(at) + 300000).toISOString(),
        lines: input.lines.map((line) => ({
          lineReference: line.lineReference,
          sellableReference: line.sellableReference,
          productVersionReference: line.catalogSelectionEvidence.productVersionReference,
          menuVersionReference: line.catalogSelectionEvidence.menuVersionReference,
          quantity: line.quantity,
          priceContext: {
            ...template.lines[0].priceContext,
            ...scope,
            orderType: input.orderType,
            sellableReference: line.sellableReference,
            evaluatedAt: input.requestedAt,
          },
          taxContext: {
            ...template.lines[0].taxContext,
            ...scope,
            orderType: input.orderType,
            evaluatedAt: input.requestedAt,
          },
        })),
      });
      return {
        quote,
        audit: audit(
          "PRICING_QUOTE_CREATE",
          "PricingPriceQuote",
          quote.quoteReference,
          quote.createdAt,
        ),
      };
    },
    audit: (input) =>
      audit("ORDERING_CART_ATTACH_QUOTE", "OrderingCart", input.cartReference, input.observedAt),
    expiryAudit: (record) =>
      audit("ORDERING_CART_QUOTE_EXPIRE", "OrderingCart", record.cartReference, record.expiredAt),
  };
  const port =
    orderType === "DineIn"
      ? createCustomerDiningQuoteComposition({
          ...configuration,
          sessions,
          participation: createDiningCartParticipationQuery({
            scope,
            repository: createPostgresDiningParticipationStore(transactions, ownerScope),
            now: () => at,
          }),
        })
      : null;
  const attachments = createPostgresCartQuoteStore({ run }, scope, references);
  return {
    configuration,
    ...(port === null
      ? {}
      : {
          handler: new CustomerQuoteHandler({
            port,
            now: () => at,
            allowedOrigin: "https://customer.invalid",
          }),
        }),
    async exercise({ base, cookie, csrfToken, cart, guestSessionReference, oldCookie }) {
      const operationReference = reference();
      const send = (selectedCookie = cookie) =>
        globalThis.fetch(base + "/api/v1/carts/" + cart.cartReference + "/quote", {
          method: "POST",
          headers: {
            origin: "https://customer.invalid",
            "sec-fetch-site": "same-origin",
            "content-type": "application/json",
            cookie: selectedCookie,
            "x-csrf-token": csrfToken,
            "idempotency-key": operationReference,
          },
          body: JSON.stringify({ cartVersion: cart.version }),
        });
      const first = await send();
      assert.equal(first.status, 201, JSON.stringify(diagnostics));
      assert.equal(first.headers.get("cache-control"), "no-store");
      const original = await first.json();
      const replay = await send();
      assert.equal(replay.status, 201);
      assert.deepEqual(await replay.json(), original);
      assert.equal(requests, 1);
      const quote = await attachments.resolveOperation(operationReference);
      assert(quote);
      assert.equal(quote.cartReference, cart.cartReference);
      assert.equal(quote.cartVersion, cart.version);
      assert.equal(quote.guestSessionReference, guestSessionReference);
      assert.equal(quote.quoteVersion, 1);
      assert.equal(quote.total.amountMinor, orderType === "Pickup" ? 2260n : 5650n);
      const denied = await send(oldCookie);
      assert.equal(denied.status, 404);
      assert.equal((await denied.json()).error.code, "quote_not_found");
      assert.equal(requests, 1);
      assert.deepEqual(await attachments.resolveOperation(operationReference), quote);
      return quote;
    },
  };
}

export function prepareEntryPickupQuote(options) {
  return prepareEntryDiningQuote({ ...options, orderType: "Pickup" });
}
