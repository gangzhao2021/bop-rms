import { createConfiguredPriceQuote, type OptionPriceRuleSnapshot } from "@rms/pricing";
import { input } from "./order-pricing-quote.fixture.js";
export const id = (n: number) => "018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export function fixture(dining = false) {
  const source = input();
  const first = source.lines[0],
    entry = source.priceBook.entries[0];
  if (first === undefined || entry === undefined) throw new Error("synthetic fixture missing");
  const orderType = dining ? ("DineIn" as const) : ("Pickup" as const);
  const base = {
    ...source,
    lines: [
      {
        ...first,
        priceContext: { ...first.priceContext, orderType },
        taxContext: { ...first.taxContext, orderType },
      },
    ],
    taxConfiguration: {
      ...source.taxConfiguration,
      rules: source.taxConfiguration.rules.map((rule) => ({ ...rule, orderType })),
    },
  };
  const rule = {
    ruleReference: id(60),
    versionReference: id(61),
    snapshotDigest: base.inputDigest,
    brandReference: base.brandReference,
    bindingReference: id(62),
    optionReference: id(63),
    skuReference: first.sellableReference,
    scopeKind: "Brand",
    scopeReference: null,
    channelCode: null,
    orderType: null,
    lifecycle: "Published",
    currencyMetadata: base.currencyMetadata,
    unitAmount: { amountMinor: 125n, currencyCode: base.currencyMetadata.currencyCode },
    includedQuantity: 1,
    quantityBasis: "PerItemChoice",
    effectivePeriod: entry.effectivePeriod,
    createdAt: base.createdAt,
  } as OptionPriceRuleSnapshot;
  const quote = createConfiguredPriceQuote({
    base,
    options: [
      {
        lineReference: first.lineReference,
        bindingReference: rule.bindingReference,
        optionReference: rule.optionReference,
        selectedQuantity: 3,
        rules: [rule],
        taxBasis: "ParentSellable",
        taxClassificationReference: first.taxContext.taxClassificationReference,
      },
    ],
  });
  const evidence = {
    menuVersionReference: first.menuVersionReference,
    productVersionReference: first.productVersionReference,
    catalogChannelCode: "SYNTHETIC",
    catalogOrderTypeCode: dining ? "DINE_IN" : "PICKUP",
    ruleEvidence: [{ bindingReference: rule.bindingReference, optionSetVersionReference: id(64) }],
    validatedAt: base.createdAt,
  };
  const cart = {
    brandReference: base.brandReference,
    storeReference: base.storeReference,
    cartReference: base.cartReference,
    aggregateVersion: base.cartVersion,
    orderType,
    sourceChannel: "Web",
    diningSessionReference: dining ? id(67) : null,
    createdByActorReference: id(65),
    createdAt: base.createdAt,
    updatedAt: base.createdAt,
    lifecycle: {
      status: "Active",
      policyVersionReference: id(66),
      policyDigest: base.inputDigest,
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T17:00:00.000Z",
      absoluteExpiresAt: "2026-08-03T16:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: first.lineReference,
        cartReference: base.cartReference,
        sellableReference: first.sellableReference,
        quantity: first.quantity,
        optionSelections: [{ optionReference: rule.optionReference, quantity: 3 }],
        customerNote: null,
        catalogSelectionEvidence: evidence,
        addedByActorReference: id(65),
        addedByParticipantReference: dining ? id(68) : null,
        addedAt: base.createdAt,
      },
    ],
  };
  const snapshot = {
    snapshotReference: id(70),
    snapshotDigest: base.inputDigest,
    brandReference: base.brandReference,
    storeReference: base.storeReference,
    sellableReference: first.sellableReference,
    sellableType: "Sku",
    productReference: id(71),
    productVersionReference: first.productVersionReference,
    skuReference: first.sellableReference,
    menuVersionReference: first.menuVersionReference,
    localizedNames: { "en-CA": "Synthetic item" },
    unitOfSale: "EACH",
    unitQuantity: "1",
    taxClassificationReference: first.taxContext.taxClassificationReference,
    options: [
      {
        optionReference: rule.optionReference,
        quantity: 3,
        bindingReference: rule.bindingReference,
        optionSetVersionReference: id(64),
        localizedNames: { "en-CA": "Synthetic option" },
      },
    ],
    capturedAt: base.createdAt,
  };
  return {
    cart,
    quote,
    catalogLines: [{ cartItemReference: first.lineReference, snapshot }],
    pricingChannelCode: first.priceContext.channelCode,
    observedAt: base.createdAt,
  };
}
