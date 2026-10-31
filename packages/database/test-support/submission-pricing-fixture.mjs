import { seedOptionPriceRule } from "./option-price-seed.mjs";
import { seedPriceBook } from "./price-book-seed.mjs";
import { seedTaxConfiguration } from "./tax-configuration-seed.mjs";
import {
  createPostgresCurrentQuoteService,
  createPostgresCurrentConfiguredQuoteService,
} from "../../rms/pricing/src/index.ts";
import { input } from "../../rms/pricing/src/tests/price-quote.fixture.ts";

/** Explicit synthetic policies persisted through the existing PriceBook schema; tax and price policies are synthetic. */
export async function createSubmissionPricingFixture(cart, pricing, expiresAt, database) {
  const base = input();
  const currencyMetadata = {
    currencyCode: pricing.unitPrice.currencyCode,
    minorUnitExponent: pricing.currencyMinorUnitExponent,
    metadataVersion: pricing.currencyMetadataVersion,
    metadataVersionReference: pricing.currencyMetadataVersionReference,
    metadataDigest: pricing.currencyMetadataDigest,
  };
  const scope = { brandReference: cart.brandReference, storeReference: cart.storeReference };
  const classification = pricing.taxComponents[0].taxClassificationReference;
  const source = {
    ...base,
    ...scope,
    quoteReference: pricing.quoteReference,
    cartReference: cart.cartReference,
    cartVersion: cart.aggregateVersion,
    inputDigest: pricing.quoteInputDigest,
    createdAt: pricing.quotedAt,
    expiresAt,
    currencyMetadata,
    priceBook: {
      ...base.priceBook,
      brandReference: cart.brandReference,
      currencyMetadata,
      entries: base.priceBook.entries.map((entry) => ({
        ...entry,
        sellableReference: cart.items[0].sellableReference,
        amount: pricing.unitPrice,
      })),
    },
    taxConfiguration: {
      ...base.taxConfiguration,
      ...scope,
      currencyMetadata,
      registrationEvidence: {
        ...base.taxConfiguration.registrationEvidence,
        validUntil: "2099-01-01T00:00:00.000Z",
      },
      professionalEvidence: {
        ...base.taxConfiguration.professionalEvidence,
        validUntil: "2099-01-01T00:00:00.000Z",
      },
      rules: base.taxConfiguration.rules.map((rule) => ({
        ...rule,
        taxClassificationReference: classification,
        orderType: cart.orderType,
      })),
    },
    lines: cart.items.map((item) => ({
      ...base.lines[0],
      lineReference: item.cartItemReference,
      sellableReference: item.sellableReference,
      productVersionReference: item.catalogSelectionEvidence.productVersionReference,
      menuVersionReference: item.catalogSelectionEvidence.menuVersionReference,
      quantity: item.quantity,
      priceContext: {
        ...base.lines[0].priceContext,
        ...scope,
        sellableReference: item.sellableReference,
        orderType: cart.orderType,
        evaluatedAt: pricing.quotedAt,
      },
      taxContext: {
        ...base.lines[0].taxContext,
        ...scope,
        taxClassificationReference: classification,
        orderType: cart.orderType,
        evaluatedAt: pricing.quotedAt,
      },
    })),
  };
  const { priceBook, ...quoteInput } = source;
  const { admin, readerTransactions } = database;
  if (!database.reusePolicies) {
    await seedPriceBook(admin, priceBook, base.quoteReference);
    await seedTaxConfiguration(admin, source.taxConfiguration, base.quoteReference);
  }
  const { taxConfiguration, ...requestWithCurrency } = quoteInput;
  const request = { ...requestWithCurrency };
  delete request.currencyMetadata;
  const policies = {
    scope,
    priceBookReference: priceBook.priceBookReference,
    taxConfigurationReference: taxConfiguration.configurationReference,
    currencyMetadata,
    evidence: {
      load: async () => ({
        registrationEvidence: taxConfiguration.registrationEvidence,
        professionalEvidence: taxConfiguration.professionalEvidence,
      }),
    },
    clock: { now: () => pricing.quotedAt },
  };
  if (!database.configured)
    return createPostgresCurrentQuoteService(readerTransactions, policies).create(request);
  const options = [];
  let ordinal = 250000;
  const ref = () => cart.cartReference.slice(0, -12) + (++ordinal).toString(16).padStart(12, "0");
  for (const line of cart.items) {
    for (const selection of line.optionSelections) {
      const binding = line.catalogSelectionEvidence.ruleEvidence[0];
      if (line.catalogSelectionEvidence.ruleEvidence.length !== 1)
        throw new Error("synthetic binding must be explicit");
      const rule = {
        ruleReference: ref(),
        versionReference: ref(),
        snapshotDigest: pricing.quoteInputDigest,
        brandReference: cart.brandReference,
        bindingReference: binding.bindingReference,
        optionReference: selection.optionReference,
        skuReference: line.sellableReference,
        scopeKind: "Brand",
        scopeReference: null,
        channelCode: null,
        orderType: null,
        lifecycle: "Published",
        currencyMetadata,
        unitAmount: { amountMinor: 125n, currencyCode: currencyMetadata.currencyCode },
        includedQuantity: 0,
        quantityBasis: "PerItemChoice",
        effectivePeriod: priceBook.entries[0].effectivePeriod,
        createdAt: pricing.quotedAt,
      };
      if (!database.reusePolicies) await seedOptionPriceRule(admin, rule, base.quoteReference);
      options.push({
        lineReference: line.cartItemReference,
        bindingReference: binding.bindingReference,
        optionReference: selection.optionReference,
        selectedQuantity: selection.quantity,
        taxBasis: "ParentSellable",
        taxClassificationReference: classification,
      });
    }
  }
  database.captureConfiguration?.({ policies, request: { base: request, options } });
  return createPostgresCurrentConfiguredQuoteService(readerTransactions, policies).create({
    base: request,
    options,
  });
}
