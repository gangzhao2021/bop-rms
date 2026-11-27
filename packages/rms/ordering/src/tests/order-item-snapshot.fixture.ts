// Synthetic full snapshot inputs shared by codec and PostgreSQL acceptance.
const id = (n: number) => `018f5500-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character: string) => `sha256:${character.repeat(64)}`;
const validatedAt = "2026-08-02T18:00:00.000Z";
const capturedAt = "2026-08-02T18:01:00.000Z";

function cart(overrides: Record<string, unknown> = {}) {
  return {
    cartReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderType: "Pickup",
    sourceChannel: "Qr",
    diningSessionReference: null,
    createdByActorReference: id(4),
    aggregateVersion: 5,
    createdAt: "2026-08-02T17:00:00.000Z",
    updatedAt: "2026-08-02T17:55:00.000Z",
    lifecycle: {
      status: "Active",
      policyVersionReference: id(5),
      policyDigest: digest("a"),
      idleTimeoutSeconds: 3600,
      absoluteTimeoutSeconds: 86400,
      idleExpiresAt: "2026-08-02T18:30:00.000Z",
      absoluteExpiresAt: "2026-08-03T17:00:00.000Z",
      terminalAt: null,
      terminalReason: null,
    },
    items: [
      {
        cartItemReference: id(10),
        cartReference: id(1),
        sellableReference: id(11),
        quantity: 2,
        optionSelections: [{ optionReference: id(12), quantity: 1 }],
        customerNote: "No onions",
        catalogSelectionEvidence: {
          menuVersionReference: id(13),
          productVersionReference: id(14),
          catalogChannelCode: "PILOT_CHANNEL",
          catalogOrderTypeCode: "PILOT_ORDER_TYPE",
          ruleEvidence: [{ bindingReference: id(15), optionSetVersionReference: id(16) }],
          validatedAt: "2026-08-02T17:55:00.000Z",
        },
        addedByActorReference: id(4),
        addedByParticipantReference: null,
        addedAt: "2026-08-02T17:30:00.000Z",
      },
    ],
    ...overrides,
  };
}

function evidence(overrides: Record<string, unknown> = {}) {
  return {
    validationReference: id(20),
    validationIntentHash: digest("b"),
    guestSessionReference: id(4),
    brandReference: id(2),
    storeReference: id(3),
    cartReference: id(1),
    cartVersion: 5,
    quoteReference: id(21),
    quoteVersion: 1,
    quoteInputDigest: digest("c"),
    orderType: "Pickup",
    sourceChannel: "Qr",
    catalogLines: [
      {
        cartItemReference: id(10),
        sellableReference: id(11),
        menuVersionReference: id(13),
        productVersionReference: id(14),
        validatedAt,
      },
    ],
    fulfillment: {
      status: "Accepted",
      brandReference: id(2),
      storeReference: id(3),
      cartReference: id(1),
      cartVersion: 5,
      quoteReference: id(21),
      orderType: "Pickup",
      sourceChannel: "Qr",
      evidenceReference: id(22),
      evidenceVersion: 1,
      evidenceDigest: digest("d"),
      checkedAt: validatedAt,
      validUntil: "2026-08-02T18:05:00.000Z",
    },
    validatedAt,
    validUntil: "2026-08-02T18:05:00.000Z",
    ...overrides,
  };
}

function catalogSnapshot(overrides: Record<string, unknown> = {}) {
  return {
    snapshotReference: id(30),
    snapshotDigest: digest("e"),
    brandReference: id(2),
    storeReference: id(3),
    sellableReference: id(11),
    sellableType: "Sku",
    productReference: id(31),
    productVersionReference: id(14),
    skuReference: id(32),
    menuVersionReference: id(13),
    localizedNames: { "en-CA": "Burger" },
    unitOfSale: "EACH",
    unitQuantity: "1",
    taxClassificationReference: id(33),
    options: [
      {
        optionReference: id(12),
        quantity: 1,
        bindingReference: id(15),
        optionSetVersionReference: id(16),
        localizedNames: { "en-CA": "No onions" },
      },
    ],
    capturedAt,
    ...overrides,
  };
}

function pricingSnapshot(overrides: Record<string, unknown> = {}) {
  const currencyCode = "CAD";
  return {
    quoteReference: id(21),
    quoteVersion: 1,
    quoteInputDigest: digest("c"),
    lineReference: id(10),
    sellableReference: id(11),
    quantity: 2,
    currencyMinorUnitExponent: 2,
    currencyMetadataVersion: 1,
    currencyMetadataVersionReference: id(40),
    currencyMetadataDigest: digest("f"),
    unitPrice: { amountMinor: 1000n, currencyCode },
    subtotal: { amountMinor: 2000n, currencyCode },
    discount: { amountMinor: 0n, currencyCode },
    tax: { amountMinor: 260n, currencyCode },
    fee: { amountMinor: 0n, currencyCode },
    total: { amountMinor: 2260n, currencyCode },
    priceResolution: {
      priceBookReference: id(41),
      priceBookVersionReference: id(42),
      priceBookDigest: digest("1"),
      priceEntryReference: id(43),
      unitPrice: { amountMinor: 1000n, currencyCode },
      scopeKind: "Store",
      scopeReference: id(3),
      channelCode: "PILOT_CHANNEL",
      orderType: "Pickup",
      priority: 0,
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
      reasonCode: "BASE_PRICE",
    },
    taxConfigurationReference: id(44),
    taxConfigurationVersionReference: id(45),
    taxConfigurationDigest: digest("2"),
    taxEffectiveFrom: "2026-08-01T00:00:00.000Z",
    taxEffectiveUntil: null,
    taxComponents: [
      {
        ruleVersionReference: id(46),
        ruleVersionDigest: digest("3"),
        jurisdictionCode: "CA_ON",
        taxComponentCode: "HST",
        taxClassificationReference: id(33),
        treatment: "Taxable",
        rate: "0.13",
        priceInclusion: "Exclusive",
        roundingMode: "HalfUp",
        calculationOrder: 1,
        compoundOnPriorTax: false,
        taxAmount: { amountMinor: 260n, currencyCode },
      },
    ],
    quotedAt: "2026-08-02T17:59:00.000Z",
    ...overrides,
  };
}

export function orderSnapshotInput(overrides: Record<string, unknown> = {}) {
  return {
    orderReference: id(50),
    orderBatchReference: id(51),
    snapshotCapturedAt: capturedAt,
    checkoutValidationEvidence: evidence(),
    cart: cart(),
    lines: [
      {
        orderItemReference: id(52),
        cartItemReference: id(10),
        catalog: catalogSnapshot(),
        pricing: pricingSnapshot(),
      },
    ],
    ...overrides,
  };
}
