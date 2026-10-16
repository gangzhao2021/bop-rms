import { createPriceQuote, createPostgresPriceQuoteStore } from "../../rms/pricing/src/index.ts";
import { input as quoteInput } from "../../rms/pricing/src/tests/price-quote.fixture.ts";
import { encodeOrderItemSnapshot } from "../../rms/ordering/src/index.ts";
import { orderSnapshotInput } from "../../rms/ordering/src/tests/order-item-snapshot.fixture.ts";

/**
 * WP-2423 Q6 step 2a test support: one persisted Pricing quote (quoteVersion 1) for a pickup cart
 * with several lines, and the immutable Ordering line snapshots that captured exactly that quote.
 * Prices and tax are synthetic (13% exclusive test-only tax); the quote is computed by the Pricing
 * owner (createPriceQuote) and persisted through its owner store, never hand-written.
 *
 * lines: [{ cartLineReference, orderItemReference, sellableReference, unitAmountMinor, quantity,
 *   name?, localizedNames? }] (name: the sellable's display name, default "Synthetic item N";
 *   localizedNames: names per locale, default { "en-CA": name })
 */
export async function seedStaffItemCancellationQuote({
  runner,
  scope,
  orderBatchReference,
  quoteReference,
  cartReference,
  cartVersion,
  inputDigest,
  quotedAt,
  capturedAt,
  addedAt,
  actorReference,
  lines,
  nextReference,
}) {
  const base = quoteInput();
  const expiresAt = new Date(Date.parse(quotedAt) + 300000).toISOString();
  const entry = base.priceBook.entries[0];
  const quote = createPriceQuote({
    ...base,
    quoteReference,
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    cartReference,
    cartVersion,
    inputDigest,
    createdAt: quotedAt,
    expiresAt,
    priceBook: {
      ...base.priceBook,
      brandReference: scope.brandReference,
      entries: lines.map((line) => ({
        ...entry,
        entryReference: line.priceEntryReference,
        sellableReference: line.sellableReference,
        amount: { amountMinor: BigInt(line.unitAmountMinor), currencyCode: "CAD" },
      })),
    },
    taxConfiguration: {
      ...base.taxConfiguration,
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      registrationEvidence: {
        ...base.taxConfiguration.registrationEvidence,
        validUntil: "2099-01-01T00:00:00.000Z",
      },
      professionalEvidence: {
        ...base.taxConfiguration.professionalEvidence,
        validUntil: "2099-01-01T00:00:00.000Z",
      },
    },
    lines: lines.map((line) => ({
      ...base.lines[0],
      lineReference: line.cartLineReference,
      sellableReference: line.sellableReference,
      quantity: line.quantity,
      priceContext: {
        ...base.lines[0].priceContext,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        sellableReference: line.sellableReference,
        evaluatedAt: quotedAt,
      },
      taxContext: {
        ...base.lines[0].taxContext,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        evaluatedAt: quotedAt,
      },
    })),
  });
  await createPostgresPriceQuoteStore(
    runner,
    { brandReference: scope.brandReference, storeReference: scope.storeReference },
    { generateReference: nextReference },
  ).append({
    quote,
    audit: {
      auditId: nextReference(),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "PRICING_QUOTE_CREATE",
      targetType: "PricingPriceQuote",
      targetId: quote.quoteReference,
      reasonCode: "AUTHORIZED_CART_QUOTE",
      correlationId: nextReference(),
      occurredAt: quote.createdAt,
      sourceChannel: "CUSTOMER_PWA",
      dataClassification: "Restricted",
      retentionPolicyCode: "FINANCIAL_COMPLIANCE",
      retentionPolicyVersion: 1,
    },
  });

  // The Ordering snapshot of each line copies that line of the quote.
  const sample = orderSnapshotInput().lines[0];
  const classification = base.taxConfiguration.rules[0].taxClassificationReference;
  const snapshots = lines.map((line, index) => {
    const priced = quote.lines[index];
    const price = priced.resolvedPrice;
    const tax = priced.taxResolution;
    const taxLine = priced.taxLines[0];
    return encodeOrderItemSnapshot({
      orderItemReference: line.orderItemReference,
      orderBatchReference,
      cartItemReference: line.cartLineReference,
      quantity: line.quantity,
      customerNote: null,
      addedByActorReference: actorReference,
      addedByParticipantReference: null,
      addedAt,
      catalog: {
        ...sample.catalog,
        brandReference: scope.brandReference,
        storeReference: scope.storeReference,
        sellableReference: line.sellableReference,
        productVersionReference: priced.productVersionReference,
        menuVersionReference: priced.menuVersionReference,
        localizedNames: line.localizedNames ?? {
          "en-CA": line.name ?? "Synthetic item " + (index + 1),
        },
        taxClassificationReference: classification,
        options: [],
        capturedAt,
      },
      pricing: {
        ...sample.pricing,
        quoteReference,
        quoteVersion: 1,
        quoteInputDigest: inputDigest,
        lineReference: line.cartLineReference,
        sellableReference: line.sellableReference,
        quantity: line.quantity,
        currencyMinorUnitExponent: quote.currencyMetadata.minorUnitExponent,
        currencyMetadataVersion: quote.currencyMetadata.metadataVersion,
        currencyMetadataVersionReference: quote.currencyMetadata.metadataVersionReference,
        currencyMetadataDigest: quote.currencyMetadata.metadataDigest,
        unitPrice: priced.unitPrice,
        subtotal: priced.subtotal,
        discount: priced.discount,
        tax: priced.tax,
        fee: priced.fee,
        total: priced.total,
        priceResolution: {
          ...sample.pricing.priceResolution,
          priceBookReference: price.priceBookReference,
          priceBookVersionReference: price.versionReference,
          priceBookDigest: price.snapshotDigest,
          priceEntryReference: price.entryReference,
          unitPrice: priced.unitPrice,
          scopeKind: "Brand",
          scopeReference: null,
          channelCode: null,
          orderType: null,
        },
        taxConfigurationReference: tax.configurationReference,
        taxConfigurationVersionReference: tax.versionReference,
        taxConfigurationDigest: tax.snapshotDigest,
        taxComponents: [
          {
            ...sample.pricing.taxComponents[0],
            ruleVersionReference: taxLine.ruleReference,
            taxClassificationReference: classification,
            rate: taxLine.explanation.rate,
            taxAmount: taxLine.taxAmount,
          },
        ],
        quotedAt,
      },
      snapshotCapturedAt: capturedAt,
    });
  });
  return { quote, snapshots };
}
