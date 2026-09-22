import assert from "node:assert/strict";
import { createPriceQuote, createPostgresPriceQuoteStore } from "../../rms/pricing/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";

// Synthetic fixture setup only: the earlier Additional journey seeded Order
// snapshots directly and omitted the full Pricing record. Persist a coherent
// original quote before submission; never backfill real production history.
export async function seedAdditionalOriginalQuote({ runner, scope, snapshot }) {
  assert.equal(snapshot.items.length, 1);
  const item = snapshot.items[0],
    original = item.pricing;
  const base = quoteInput();
  const expiresAt = new Date(Date.parse(original.quotedAt) + 300000).toISOString();
  const currencyMetadata = {
    ...base.currencyMetadata,
    metadataVersion: original.currencyMetadataVersion,
    metadataVersionReference: original.currencyMetadataVersionReference,
    metadataDigest: original.currencyMetadataDigest,
  };
  const quote = createPriceQuote({
    ...base,
    quoteReference: snapshot.batch.quoteReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    cartReference: snapshot.batch.sourceCartReference,
    cartVersion: snapshot.batch.sourceCartVersion,
    inputDigest: original.quoteInputDigest,
    createdAt: original.quotedAt,
    expiresAt,
    currencyMetadata,
    priceBook: {
      ...base.priceBook,
      brandReference: scope.brandReference,
      currencyMetadata,
      priceBookReference: original.priceResolution.priceBookReference,
      versionReference: original.priceResolution.priceBookVersionReference,
      snapshotDigest: original.priceResolution.priceBookDigest,
      entries: [
        {
          ...base.priceBook.entries[0],
          entryReference: original.priceResolution.priceEntryReference,
          sellableReference: original.sellableReference,
          amount: original.unitPrice,
          scopeKind: "Store",
          scopeReference: scope.storeReference,
          channelCode: original.priceResolution.channelCode,
          orderType: "DineIn",
          reasonCode: original.priceResolution.reasonCode,
        },
      ],
    },
    taxConfiguration: {
      ...base.taxConfiguration,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      configurationReference: original.taxConfigurationReference,
      versionReference: original.taxConfigurationVersionReference,
      snapshotDigest: original.taxConfigurationDigest,
      jurisdictionCode: original.taxComponents[0].jurisdictionCode,
      currencyMetadata,
      registrationEvidence: {
        ...base.taxConfiguration.registrationEvidence,
        validUntil: expiresAt,
      },
      professionalEvidence: {
        ...base.taxConfiguration.professionalEvidence,
        validUntil: expiresAt,
        snapshotReference: original.taxConfigurationVersionReference,
        snapshotDigest: original.taxConfigurationDigest,
      },
      rules: [
        {
          ...base.taxConfiguration.rules[0],
          orderType: "DineIn",
          ruleReference: original.taxComponents[0].ruleVersionReference,
          taxClassificationReference: original.taxComponents[0].taxClassificationReference,
          taxComponentCode: original.taxComponents[0].taxComponentCode,
          rate: original.taxComponents[0].rate,
        },
      ],
    },
    lines: [
      {
        ...base.lines[0],
        lineReference: original.lineReference,
        sellableReference: original.sellableReference,
        productVersionReference: item.catalog.productVersionReference,
        menuVersionReference: item.catalog.menuVersionReference,
        quantity: item.quantity,
        priceContext: {
          ...base.lines[0].priceContext,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          sellableReference: original.sellableReference,
          channelCode: original.priceResolution.channelCode,
          orderType: "DineIn",
          evaluatedAt: original.quotedAt,
        },
        taxContext: {
          ...base.lines[0].taxContext,
          brandReference: scope.brandReference,
          storeReference: scope.storeReference,
          jurisdictionCode: original.taxComponents[0].jurisdictionCode,
          taxClassificationReference: original.taxComponents[0].taxClassificationReference,
          orderType: "DineIn",
          evaluatedAt: original.quotedAt,
        },
      },
    ],
  });
  for (const component of ["subtotal", "discount", "tax", "fee", "total"])
    assert.equal(quote.lines[0][component].amountMinor, original[component].amountMinor);
  let sequence = 0;
  const id = (n) => "01909976-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  await createPostgresPriceQuoteStore(
    runner(),
    {
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    { generateReference: () => id(++sequence) },
  ).append({
    quote,
    audit: {
      auditId: id(90),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "PRICING_QUOTE_CREATE",
      targetType: "PricingPriceQuote",
      targetId: quote.quoteReference,
      reasonCode: "AUTHORIZED_CART_QUOTE",
      correlationId: id(91),
      occurredAt: quote.createdAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });
}
