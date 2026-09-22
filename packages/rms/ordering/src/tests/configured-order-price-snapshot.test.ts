import { expect, it } from "vitest";
import {
  parseConfiguredOrderPricingLineSnapshot,
  parseOrderPricingLineSnapshot,
} from "../domain/order-item-snapshot.js";
const id = (n: number) => "018f5500-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (c: string) => "sha256:" + c.repeat(64);
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

function fixture() {
  const source = pricingSnapshot();
  return {
    ...source,
    quoteVersion: 2,
    unitPrice: { amountMinor: 1250n, currencyCode: "CAD" },
    subtotal: { amountMinor: 2500n, currencyCode: "CAD" },
    tax: { amountMinor: 325n, currencyCode: "CAD" },
    total: { amountMinor: 2825n, currencyCode: "CAD" },
    taxComponents: source.taxComponents.map((tax) => ({
      ...tax,
      taxAmount: { amountMinor: 325n, currencyCode: "CAD" },
    })),
    optionPrices: [
      {
        ruleReference: id(70),
        ruleVersionReference: id(71),
        ruleDigest: digest("a"),
        bindingReference: id(15),
        optionReference: id(12),
        brandReference: id(2),
        storeReference: id(3),
        sellableReference: id(11),
        storeGroupReference: null,
        regionReference: null,
        channelCode: source.priceResolution.channelCode,
        orderType: "Pickup",
        ruleSkuReference: id(11),
        scopeKind: "Brand",
        scopeReference: null,
        ruleChannelCode: null,
        ruleOrderType: null,
        priority: 8,
        selectedQuantity: 3,
        includedQuantity: 1,
        chargedQuantityPerItem: 2,
        chargedQuantity: 4n,
        quantityBasis: "PerItemChoice",
        unitPrice: { amountMinor: 125n, currencyCode: "CAD" },
        subtotal: { amountMinor: 500n, currencyCode: "CAD" },
        taxBasis: "ParentSellable",
        taxClassificationReference: id(33),
        effectiveFrom: "2026-08-02T17:00:00.000Z",
        effectiveUntil: "2026-08-02T19:00:00.000Z",
        ruleCreatedAt: "2026-08-02T17:00:00.000Z",
      },
    ],
  };
}
it("preserves base and selected-option prices as separate immutable transaction facts", () => {
  const parsed = parseConfiguredOrderPricingLineSnapshot(fixture());
  expect(parsed.quoteVersion).toBe(2);
  expect(parsed.priceResolution.unitPrice.amountMinor).toBe(1000n);
  expect(parsed.unitPrice.amountMinor).toBe(1250n);
  expect(parsed.total.amountMinor).toBe(2825n);
  expect(parsed.optionPrices[0]).toMatchObject({ includedQuantity: 1, chargedQuantity: 4n });
  expect(Object.isFrozen(parsed.optionPrices)).toBe(true);
  expect(Object.isFrozen(parsed.optionPrices[0])).toBe(true);
});
it.each([
  ["includedQuantity", 2],
  ["selectedQuantity", 4],
  ["chargedQuantity", 2n],
  ["chargedQuantityPerItem", 1],
  ["ruleSkuReference", id(999)],
  ["sellableReference", id(999)],
  ["priority", 7],
  ["scopeKind", "Store"],
  ["ruleChannelCode", "FOREIGN"],
  ["ruleOrderType", "DineIn"],
  ["taxClassificationReference", id(999)],
  ["effectiveUntil", pricingSnapshot().quotedAt],
  ["effectiveFrom", "2026-08-02T18:01:00.000Z"],
  ["ruleCreatedAt", "2026-08-02T18:01:00.000Z"],
  ["quantityBasis", "PerOrder"],
  ["taxBasis", "Separate"],
  ["ruleDigest", "invalid"],
  ["subtotal", { amountMinor: 501n, currencyCode: "CAD" }],
  ["unitPrice", { amountMinor: 125n, currencyCode: "USD" }],
  ["unitPrice", { amountMinor: 9223372036854775808n, currencyCode: "CAD" }],
])("rejects altered option evidence %s", (field, value) => {
  const f = fixture();
  expect(() =>
    parseConfiguredOrderPricingLineSnapshot({
      ...f,
      optionPrices: [{ ...f.optionPrices[0], [field]: value }],
    }),
  ).toThrow();
});
it("rejects missing, duplicated and sparse option evidence", () => {
  const f = fixture();
  expect(() => parseConfiguredOrderPricingLineSnapshot({ ...f, optionPrices: [] })).toThrow();
  expect(() =>
    parseConfiguredOrderPricingLineSnapshot({
      ...f,
      optionPrices: [...f.optionPrices, ...f.optionPrices],
    }),
  ).toThrow();
  expect(() =>
    parseConfiguredOrderPricingLineSnapshot({ ...f, optionPrices: new Array(1) }),
  ).toThrow();
});
it("retains explicit zero-charge included choices", () => {
  const f = fixture(),
    original = pricingSnapshot();
  const parsed = parseConfiguredOrderPricingLineSnapshot({
    ...original,
    quoteVersion: 2,
    optionPrices: [
      {
        ...f.optionPrices[0],
        includedQuantity: 3,
        chargedQuantityPerItem: 0,
        chargedQuantity: 0n,
        subtotal: { amountMinor: 0n, currencyCode: "CAD" },
      },
    ],
  });
  expect(parsed.unitPrice.amountMinor).toBe(1000n);
  expect(parsed.optionPrices[0]?.includedQuantity).toBe(3);
});
it("keeps the legacy parser closed to v2 and the v2 parser closed to v1", () => {
  expect(() => parseOrderPricingLineSnapshot(fixture())).toThrow();
  expect(() => parseConfiguredOrderPricingLineSnapshot(pricingSnapshot())).toThrow();
  expect(parseOrderPricingLineSnapshot(pricingSnapshot()).quoteVersion).toBe(1);
});

it("rejects holes and getters even when no surcharge would alter the total", () => {
  const source = { ...pricingSnapshot(), quoteVersion: 2 };
  expect(() =>
    parseConfiguredOrderPricingLineSnapshot({ ...source, optionPrices: new Array(1) }),
  ).toThrow();
  let read = false;
  const options = new Array(1);
  Object.defineProperty(options, "0", {
    enumerable: true,
    get() {
      read = true;
      return fixture().optionPrices[0];
    },
  });
  expect(() =>
    parseConfiguredOrderPricingLineSnapshot({ ...source, optionPrices: options }),
  ).toThrow();
  expect(read).toBe(false);
});
