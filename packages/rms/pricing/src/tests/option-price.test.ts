import { describe, expect, it, vi } from "vitest";
import {
  createMoney,
  parsePricingReference,
  resolveOptionPrice,
  createOptionPriceRuleSnapshot,
  type OptionPriceContext,
  type OptionPriceRuleSnapshot,
} from "../index.js";
import { input } from "./price-quote.fixture.js";
const id = (n: number) =>
  parsePricingReference("018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
function fixture() {
  const q = input();
  const entry = q.priceBook.entries[0],
    line = q.lines[0];
  if (entry === undefined || line === undefined) throw new Error("synthetic fixture is incomplete");
  const rule: OptionPriceRuleSnapshot = {
    ruleReference: id(101),
    versionReference: id(102),
    snapshotDigest: q.inputDigest,
    brandReference: q.brandReference,
    bindingReference: id(103),
    optionReference: id(104),
    skuReference: null,
    scopeKind: "Brand",
    scopeReference: null,
    channelCode: null,
    orderType: null,
    lifecycle: "Published",
    currencyMetadata: q.currencyMetadata,
    unitAmount: createMoney({ amountMinor: 125n, currencyCode: q.currencyMetadata.currencyCode }),
    includedQuantity: 1,
    quantityBasis: "PerItemChoice",
    effectivePeriod: entry.effectivePeriod,
    createdAt: q.createdAt,
  };
  const context: OptionPriceContext = {
    brandReference: q.brandReference,
    storeReference: q.storeReference,
    storeGroupReference: id(105),
    regionReference: id(106),
    bindingReference: rule.bindingReference,
    optionReference: rule.optionReference,
    skuReference: line.sellableReference,
    channelCode: line.priceContext.channelCode,
    orderType: "Pickup",
    currencyMetadata: q.currencyMetadata,
    selectedQuantity: 3,
    itemQuantity: 2,
    evaluatedAt: q.createdAt,
  };
  return { rule, context };
}
describe("versioned Option price rules", () => {
  it("charges only quantities above explicit per-item allowance and retains provenance", () => {
    const { rule, context } = fixture();
    const result = resolveOptionPrice([rule], context);
    expect(result).toMatchObject({
      rule: { ruleReference: rule.ruleReference, versionReference: rule.versionReference },
      chargedQuantityPerItem: 2,
      chargedQuantity: 4n,
      amount: { amountMinor: 500n },
    });
    expect(Object.isFrozen(result.rule.unitAmount)).toBe(true);
  });
  it("allows explicit free choices without inventing missing rules", () => {
    const { rule, context } = fixture();
    expect(resolveOptionPrice([rule], { ...context, selectedQuantity: 1 }).amount.amountMinor).toBe(
      0n,
    );
    expect(() => resolveOptionPrice([], context)).toThrowError(
      expect.objectContaining({ code: "OPTION_PRICE_MISSING" }),
    );
  });
  it("preserves amounts above binary floating point exactness", () => {
    const { rule, context } = fixture();
    const priced = {
      ...rule,
      includedQuantity: 0,
      unitAmount: createMoney({ ...rule.unitAmount, amountMinor: 9007199254740993n }),
    };
    expect(
      resolveOptionPrice([priced], { ...context, selectedQuantity: 1, itemQuantity: 2 }).amount
        .amountMinor,
    ).toBe(18014398509481986n);
  });
  it("applies Store/context priority over Brand and preserves explicit zero", () => {
    const { rule, context } = fixture();
    const store: OptionPriceRuleSnapshot = {
      ...rule,
      ruleReference: id(107),
      versionReference: id(108),
      scopeKind: "Store",
      scopeReference: context.storeReference,
      channelCode: context.channelCode,
      unitAmount: createMoney({ ...rule.unitAmount, amountMinor: 0n }),
    };
    expect(resolveOptionPrice([rule, store], context)).toMatchObject({
      priority: 1,
      rule: { ruleReference: store.ruleReference },
      amount: { amountMinor: 0n },
    });
  });
  it.each(["bindingReference", "optionReference", "brandReference", "skuReference"] as const)(
    "does not apply another %s",
    (field) => {
      const { rule, context } = fixture();
      expect(() => resolveOptionPrice([{ ...rule, [field]: id(109) }], context)).toThrowError(
        expect.objectContaining({ code: "OPTION_PRICE_MISSING" }),
      );
    },
  );
  it("does not give an unaccepted priority to a SKU-specific rule", () => {
    const { rule, context } = fixture();
    expect(() =>
      resolveOptionPrice(
        [rule, { ...rule, ruleReference: id(110), skuReference: context.skuReference }],
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "OPTION_PRICE_CONFLICT" }));
  });
  it("rejects channel/order-type ties and duplicate rule identities", () => {
    const { rule, context } = fixture();
    expect(() =>
      resolveOptionPrice(
        [
          { ...rule, channelCode: context.channelCode },
          { ...rule, ruleReference: id(111), orderType: context.orderType },
        ],
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "OPTION_PRICE_CONFLICT" }));
    expect(() => resolveOptionPrice([rule, rule], context)).toThrowError(
      expect.objectContaining({ code: "OPTION_PRICE_CONFLICT" }),
    );
  });
  it("uses half-open effective periods and rejects unpublished rules", () => {
    const { rule, context } = fixture();
    const ended = {
      ...rule,
      effectivePeriod: {
        ...rule.effectivePeriod,
        effectiveUntil: {
          instant: context.evaluatedAt as never,
          localDateTime: "2026-08-02T12:00:00.000",
          utcOffsetMinutes: -240,
        },
      },
    };
    expect(() => resolveOptionPrice([ended], context)).toThrowError(
      expect.objectContaining({ code: "OPTION_PRICE_MISSING" }),
    );
    expect(() => resolveOptionPrice([{ ...rule, lifecycle: "Draft" }], context)).toThrowError(
      expect.objectContaining({ code: "OPTION_PRICE_MISSING" }),
    );
  });
  it("rejects currency metadata drift and future rule facts", () => {
    const { rule, context } = fixture();
    expect(() =>
      resolveOptionPrice([rule], {
        ...context,
        currencyMetadata: {
          ...context.currencyMetadata,
          metadataVersion: 2,
        },
      }),
    ).toThrowError(expect.objectContaining({ code: "OPTION_PRICE_SCOPE_MISMATCH" }));
    expect(() =>
      resolveOptionPrice([{ ...rule, createdAt: "2026-08-03T00:00:00.000Z" }], context),
    ).toThrowError(expect.objectContaining({ code: "OPTION_PRICE_SCOPE_MISMATCH" }));
  });
  it("rejects nonintegral quantities and bounds monetary overflow", () => {
    const { rule, context } = fixture();
    expect(() => resolveOptionPrice([rule], { ...context, selectedQuantity: 1.5 })).toThrowError(
      expect.objectContaining({ code: "OPTION_PRICE_INPUT_INVALID" }),
    );
    expect(() =>
      resolveOptionPrice(
        [
          {
            ...rule,
            includedQuantity: 0,
            unitAmount: createMoney({ ...rule.unitAmount, amountMinor: 2n ** 63n - 1n }),
          },
        ],
        context,
      ),
    ).toThrowError(expect.objectContaining({ code: "OPTION_PRICE_CALCULATION_FAILED" }));
  });
  it("rejects accessors without executing them", () => {
    const { rule } = fixture();
    const getter = vi.fn();
    const malformed = Object.defineProperty({ ...rule }, "unitAmount", {
      get: getter,
      enumerable: true,
    });
    expect(() => createOptionPriceRuleSnapshot(malformed)).toThrowError(
      expect.objectContaining({ code: "OPTION_PRICE_INPUT_INVALID" }),
    );
    expect(getter).not.toHaveBeenCalled();
  });
});
