import { describe, expect, it } from "vitest";
import {
  createOrderItemSnapshots,
  OrderItemSnapshotError,
  parseOrderItemTransactionSnapshot,
} from "../domain/order-item-snapshot.js";

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

function input(overrides: Record<string, unknown> = {}) {
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

function expectCode(action: () => unknown, code: string) {
  expect(action).toThrowError(OrderItemSnapshotError);
  try {
    action();
  } catch (error) {
    expect((error as OrderItemSnapshotError).code).toBe(code);
  }
}

describe("WP-1222 immutable Order Item transaction snapshot", () => {
  it("captures Catalog, Option, Price and Tax facts without recalculation", () => {
    const [snapshot] = createOrderItemSnapshots(input());
    expect(snapshot).toMatchObject({
      orderItemReference: id(52),
      orderBatchReference: id(51),
      cartItemReference: id(10),
      quantity: 2,
      customerNote: "No onions",
      catalog: {
        sellableReference: id(11),
        productVersionReference: id(14),
        menuVersionReference: id(13),
        taxClassificationReference: id(33),
      },
      pricing: {
        quoteReference: id(21),
        unitPrice: { amountMinor: 1000n, currencyCode: "CAD" },
        tax: { amountMinor: 260n, currencyCode: "CAD" },
        total: { amountMinor: 2260n, currencyCode: "CAD" },
      },
    });
    expect(snapshot?.catalog.options).toHaveLength(1);
  });

  it("deep-copies and freezes source names so later Catalog mutation cannot change history", () => {
    const source = catalogSnapshot();
    const candidate = input({
      lines: [
        {
          orderItemReference: id(52),
          cartItemReference: id(10),
          catalog: source,
          pricing: pricingSnapshot(),
        },
      ],
    });
    const [snapshot] = createOrderItemSnapshots(candidate);
    (source.localizedNames as Record<string, string>)["en-CA"] = "Changed later";
    expect(snapshot?.catalog.localizedNames["en-CA"]).toBe("Burger");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot?.catalog)).toBe(true);
    expect(Object.isFrozen(snapshot?.catalog.options)).toBe(true);
    expect(Object.isFrozen(snapshot?.pricing.taxComponents)).toBe(true);
  });

  it("rejects at the exact Checkout validation expiry instant", () => {
    expectCode(
      () => createOrderItemSnapshots(input({ snapshotCapturedAt: "2026-08-02T18:05:00.000Z" })),
      "ORDER_ITEM_SNAPSHOT_VALIDATION_EXPIRED",
    );
  });

  it("rejects stale Cart scope or version", () => {
    expectCode(
      () => createOrderItemSnapshots(input({ cart: cart({ aggregateVersion: 4 }) })),
      "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
    );
  });

  it("rejects Catalog version or Store drift", () => {
    for (const changed of [
      catalogSnapshot({ productVersionReference: id(99) }),
      catalogSnapshot({ storeReference: id(99) }),
    ]) {
      expectCode(
        () =>
          createOrderItemSnapshots(
            input({
              lines: [
                {
                  orderItemReference: id(52),
                  cartItemReference: id(10),
                  catalog: changed,
                  pricing: pricingSnapshot(),
                },
              ],
            }),
          ),
        "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
      );
    }
  });

  it("rejects missing, changed or unvalidated Option configuration", () => {
    const variants = [
      catalogSnapshot({ options: [] }),
      catalogSnapshot({
        options: [
          {
            ...(catalogSnapshot().options as Record<string, unknown>[])[0],
            bindingReference: id(99),
          },
        ],
      }),
    ];
    for (const changed of variants)
      expectCode(
        () =>
          createOrderItemSnapshots(
            input({
              lines: [
                {
                  orderItemReference: id(52),
                  cartItemReference: id(10),
                  catalog: changed,
                  pricing: pricingSnapshot(),
                },
              ],
            }),
          ),
        "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
      );
  });

  it("rejects Quote reference, digest, line or quantity drift", () => {
    for (const changed of [
      pricingSnapshot({ quoteReference: id(99) }),
      pricingSnapshot({ quoteInputDigest: digest("9") }),
      pricingSnapshot({ lineReference: id(99) }),
      pricingSnapshot({ quantity: 3 }),
    ])
      expectCode(
        () =>
          createOrderItemSnapshots(
            input({
              lines: [
                {
                  orderItemReference: id(52),
                  cartItemReference: id(10),
                  catalog: catalogSnapshot(),
                  pricing: changed,
                },
              ],
            }),
          ),
        "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
      );
  });

  it("rejects Currency metadata or Price/Tax resolution scope and effective-period drift", () => {
    for (const changed of [
      pricingSnapshot({ currencyMinorUnitExponent: 7 }),
      pricingSnapshot({
        priceResolution: {
          ...pricingSnapshot().priceResolution,
          channelCode: "OTHER_CHANNEL",
        },
      }),
      pricingSnapshot({
        priceResolution: {
          ...pricingSnapshot().priceResolution,
          effectiveUntil: "2026-08-02T17:59:00.000Z",
        },
      }),
      pricingSnapshot({ taxEffectiveUntil: "2026-08-02T17:59:00.000Z" }),
    ])
      expectCode(
        () =>
          createOrderItemSnapshots(
            input({
              lines: [
                {
                  orderItemReference: id(52),
                  cartItemReference: id(10),
                  catalog: catalogSnapshot(),
                  pricing: changed,
                },
              ],
            }),
          ),
        "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
      );
  });

  it("rejects inconsistent Money, Currency and Tax component totals", () => {
    for (const changed of [
      pricingSnapshot({ total: { amountMinor: 2259n, currencyCode: "CAD" } }),
      pricingSnapshot({ tax: { amountMinor: 260n, currencyCode: "USD" } }),
      pricingSnapshot({ taxComponents: [] }),
    ])
      expectCode(
        () =>
          createOrderItemSnapshots(
            input({
              lines: [
                {
                  orderItemReference: id(52),
                  cartItemReference: id(10),
                  catalog: catalogSnapshot(),
                  pricing: changed,
                },
              ],
            }),
          ),
        "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
      );
  });

  it("rejects a Tax classification not owned by the Catalog snapshot", () => {
    const changed = pricingSnapshot({
      taxComponents: [
        {
          ...(pricingSnapshot().taxComponents as Record<string, unknown>[])[0],
          taxClassificationReference: id(99),
        },
      ],
    });
    expectCode(
      () =>
        createOrderItemSnapshots(
          input({
            lines: [
              {
                orderItemReference: id(52),
                cartItemReference: id(10),
                catalog: catalogSnapshot(),
                pricing: changed,
              },
            ],
          }),
        ),
      "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
    );
  });

  it("rejects duplicate identities and extra fields", () => {
    expectCode(
      () =>
        createOrderItemSnapshots({ ...input(), unexpected: true } as unknown as ReturnType<
          typeof input
        >),
      "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
    );
    expectCode(
      () => createOrderItemSnapshots(input({ orderReference: id(51) })),
      "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
    );
  });

  it("round-trips the closed public snapshot and rejects injected facts", () => {
    const [snapshot] = createOrderItemSnapshots(input());
    expect(parseOrderItemTransactionSnapshot(snapshot)).toEqual(snapshot);
    expectCode(
      () => parseOrderItemTransactionSnapshot({ ...snapshot, paymentStatus: "Paid" }),
      "ORDER_ITEM_SNAPSHOT_INPUT_INVALID",
    );
  });
});
