import { describe, expect, it } from "vitest";
import {
  createConfiguredPriceQuote,
  createPriceQuote,
  createMoney,
  parsePricingReference,
  encodePriceQuoteSnapshot,
  encodeConfiguredPriceQuoteSnapshot,
  decodeConfiguredPriceQuoteSnapshot,
  decodePriceQuoteSnapshot,
  type ConfiguredQuoteOptionInput,
  type OptionPriceRuleSnapshot,
} from "../index.js";
import { input } from "./price-quote.fixture.js";
const id = (n: number) =>
  parsePricingReference("018fb000-0000-7000-8000-" + n.toString(16).padStart(12, "0"));
function fixture() {
  const base = input();
  const line = base.lines[0],
    entry = base.priceBook.entries[0];
  if (line === undefined || entry === undefined) throw new Error("synthetic fixture missing");
  const rule: OptionPriceRuleSnapshot = {
    ruleReference: id(301),
    versionReference: id(302),
    snapshotDigest: base.inputDigest,
    brandReference: base.brandReference,
    bindingReference: id(303),
    optionReference: id(304),
    skuReference: line.sellableReference,
    scopeKind: "Brand",
    scopeReference: null,
    channelCode: null,
    orderType: null,
    lifecycle: "Published",
    currencyMetadata: base.currencyMetadata,
    unitAmount: createMoney({
      amountMinor: 125n,
      currencyCode: base.currencyMetadata.currencyCode,
    }),
    includedQuantity: 1,
    quantityBasis: "PerItemChoice",
    effectivePeriod: entry.effectivePeriod,
    createdAt: base.createdAt,
  };
  const option: ConfiguredQuoteOptionInput = {
    lineReference: line.lineReference,
    bindingReference: rule.bindingReference,
    optionReference: rule.optionReference,
    selectedQuantity: 3,
    rules: [rule],
    taxBasis: "ParentSellable",
    taxClassificationReference: line.taxContext.taxClassificationReference,
  };
  return { base, line, entry, rule, option };
}
describe("configured Quote v2", () => {
  it("includes exact Option charge and taxes the configured Sellable line", () => {
    const f = fixture();
    const quote = createConfiguredPriceQuote({ base: f.base, options: [f.option] });
    expect(quote).toMatchObject({
      quoteVersion: 2,
      subtotal: { amountMinor: 2500n },
      tax: { amountMinor: 325n },
      total: { amountMinor: 2825n },
    });
    expect(quote.lines[0]).toMatchObject({
      baseUnitPrice: { amountMinor: 1000n },
      unitPrice: { amountMinor: 1250n },
      resolvedPrice: { amount: { amountMinor: 1000n } },
      optionPrices: [{ rule: { versionReference: f.rule.versionReference }, chargedQuantity: 4n }],
    });
  });
  it("rounds tax once on the configured line instead of separately rounding each charge", () => {
    const f = fixture();
    const amount = createMoney({
      amountMinor: 2n,
      currencyCode: f.base.currencyMetadata.currencyCode,
    });
    const base = {
      ...f.base,
      lines: [{ ...f.line, quantity: 1 }],
      priceBook: { ...f.base.priceBook, entries: [{ ...f.entry, amount }] },
    };
    const quote = createConfiguredPriceQuote({
      base,
      options: [
        {
          ...f.option,
          selectedQuantity: 1,
          rules: [{ ...f.rule, includedQuantity: 0, unitAmount: amount }],
        },
      ],
    });
    expect(quote).toMatchObject({
      subtotal: { amountMinor: 4n },
      tax: { amountMinor: 1n },
      total: { amountMinor: 5n },
    });
  });
  it("retains explicit free selection evidence without changing amounts", () => {
    const f = fixture();
    const quote = createConfiguredPriceQuote({
      base: f.base,
      options: [{ ...f.option, selectedQuantity: 1 }],
    });
    expect(quote.subtotal).toEqual(createPriceQuote(f.base).subtotal);
    expect(quote.lines[0]?.optionPrices[0]?.chargedQuantity).toBe(0n);
  });
  it("bounds Quote expiry by the selected Option rule", () => {
    const f = fixture();
    const end = {
      instant: "2026-08-02T16:01:00.000Z" as never,
      localDateTime: "2026-08-02T12:01:00.000",
      utcOffsetMinutes: -240,
    };
    const quote = createConfiguredPriceQuote({
      base: f.base,
      options: [
        {
          ...f.option,
          rules: [
            { ...f.rule, effectivePeriod: { ...f.rule.effectivePeriod, effectiveUntil: end } },
          ],
        },
      ],
    });
    expect(quote.expiresAt).toBe(end.instant);
  });
  it.each(["line", "duplicate", "classification", "missing"] as const)(
    "rejects incomplete or conflicting selected-option evidence: %s",
    (kind) => {
      const f = fixture();
      const options =
        kind === "duplicate"
          ? [f.option, f.option]
          : [
              {
                ...f.option,
                ...(kind === "line"
                  ? { lineReference: id(305) }
                  : kind === "classification"
                    ? { taxClassificationReference: id(306) }
                    : { rules: [] }),
              },
            ];
      expect(() => createConfiguredPriceQuote({ base: f.base, options })).toThrow();
    },
  );
  it("supports DineIn with its own explicit tax applicability", () => {
    const f = fixture();
    const base = {
      ...f.base,
      lines: [
        {
          ...f.line,
          priceContext: { ...f.line.priceContext, orderType: "DineIn" as const },
          taxContext: { ...f.line.taxContext, orderType: "DineIn" as const },
        },
      ],
      taxConfiguration: {
        ...f.base.taxConfiguration,
        rules: f.base.taxConfiguration.rules.map((rule) => ({
          ...rule,
          orderType: "DineIn" as const,
        })),
      },
    };
    expect(createConfiguredPriceQuote({ base, options: [f.option] }).total.amountMinor).toBe(2825n);
  });
  it("does not mutate v1 or let its codec silently discard Option evidence", () => {
    const f = fixture();
    const original = createPriceQuote(f.base);
    const encoded = encodePriceQuoteSnapshot(original);
    const configured = createConfiguredPriceQuote({ base: f.base, options: [f.option] });
    expect(encodePriceQuoteSnapshot(createPriceQuote(f.base))).toBe(encoded);
    expect(() => encodePriceQuoteSnapshot(configured as never)).toThrow();
    expect(Object.isFrozen(configured.lines[0]?.optionPrices)).toBe(true);
  });
});

describe("configured Quote canonical persistence evidence", () => {
  function quote() {
    const f = fixture();
    return createConfiguredPriceQuote({ base: f.base, options: [f.option] });
  }
  it("round trips complete immutable option/context/tax evidence", () => {
    const original = quote();
    const encoded = encodeConfiguredPriceQuoteSnapshot(original);
    expect(decodeConfiguredPriceQuoteSnapshot(encoded)).toEqual(original);
    expect(encodeConfiguredPriceQuoteSnapshot(decodeConfiguredPriceQuoteSnapshot(encoded))).toBe(
      encoded,
    );
    expect(
      Object.isFrozen(
        decodeConfiguredPriceQuoteSnapshot(encoded).lines[0]?.optionPrices[0]?.context,
      ),
    ).toBe(true);
    expect(() => decodePriceQuoteSnapshot(encoded)).toThrow();
  });
  it.each([
    "amount",
    "quantity",
    "store",
    "binding",
    "classification",
    "context",
    "base",
    "tax",
    "expiry",
    "duplicate",
  ] as const)("rejects substituted %s evidence", (kind) => {
    const modified = structuredClone(quote());
    const line = modified.lines[0],
      option = line?.optionPrices[0];
    if (line === undefined || option === undefined) throw new Error("synthetic fixture missing");
    const write = (target: object, key: string, value: unknown) =>
      Object.assign(target, { [key]: value });
    if (kind === "amount") write(option.amount, "amountMinor", 0n);
    if (kind === "quantity") write(option, "chargedQuantity", 5n);
    if (kind === "store") write(option.context, "storeReference", id(401));
    if (kind === "binding") write(option.context, "bindingReference", id(402));
    if (kind === "classification") write(option, "taxClassificationReference", id(403));
    if (kind === "context") write(option.context, "itemQuantity", 4);
    if (kind === "base") write(line.baseUnitPrice, "amountMinor", 2n);
    if (kind === "tax") write(line.tax, "amountMinor", 1n);
    if (kind === "expiry")
      write(option.rule, "effectivePeriod", {
        ...option.rule.effectivePeriod,
        effectiveUntil: {
          instant: "2026-08-02T16:01:00.000Z",
          localDateTime: "2026-08-02T12:01:00.000",
          utcOffsetMinutes: -240,
        },
      });
    if (kind === "duplicate") write(line, "optionPrices", [option, option]);
    expect(() => encodeConfiguredPriceQuoteSnapshot(modified)).toThrow();
  });
  it("rejects alternative wire encodings and unknown fields", () => {
    const encoded = encodeConfiguredPriceQuoteSnapshot(quote());
    expect(() => decodeConfiguredPriceQuoteSnapshot(" " + encoded)).toThrow();
    expect(() =>
      decodeConfiguredPriceQuoteSnapshot(
        encoded.replace('"chargedQuantity":"4"', '"chargedQuantity":"04"'),
      ),
    ).toThrow();
    const extra = JSON.parse(encoded);
    extra.snapshot.extra = true;
    expect(() => decodeConfiguredPriceQuoteSnapshot(JSON.stringify(extra))).toThrow();
  });
  it.each(["Region", "StoreGroup"] as const)(
    "binds base %s price to retained option context",
    (scopeKind) => {
      const f = fixture();
      const scopeReference = scopeKind === "Region" ? id(501) : id(502);
      const base = {
        ...f.base,
        priceBook: { ...f.base.priceBook, entries: [{ ...f.entry, scopeKind, scopeReference }] },
        lines: [
          {
            ...f.line,
            priceContext: {
              ...f.line.priceContext,
              ...(scopeKind === "Region"
                ? { regionReference: scopeReference }
                : { storeGroupReference: scopeReference }),
            },
          },
        ],
      };
      const quote = createConfiguredPriceQuote({ base, options: [f.option] });
      expect(decodeConfiguredPriceQuoteSnapshot(encodeConfiguredPriceQuoteSnapshot(quote))).toEqual(
        quote,
      );
      const altered = structuredClone(quote),
        option = altered.lines[0]?.optionPrices[0];
      if (option === undefined) throw new Error("synthetic option missing");
      Object.assign(
        option.context,
        scopeKind === "Region" ? { regionReference: id(503) } : { storeGroupReference: id(504) },
      );
      expect(() => encodeConfiguredPriceQuoteSnapshot(altered)).toThrow();
    },
  );
  it("rejects accessor and cyclic input without executing getters", () => {
    const modified = structuredClone(quote());
    let reads = 0;
    Object.defineProperty(modified, "lines", {
      enumerable: true,
      get() {
        reads++;
        return [];
      },
    });
    expect(() => encodeConfiguredPriceQuoteSnapshot(modified)).toThrow();
    expect(reads).toBe(0);
    const cyclic = Object.assign(structuredClone(quote()), { extra: {} });
    cyclic.extra = cyclic;
    expect(() => encodeConfiguredPriceQuoteSnapshot(cyclic)).toThrow();
  });
});
