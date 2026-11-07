import { expect, it, vi } from "vitest";
import type { ConfiguredPriceQuoteSnapshot } from "@rms/pricing";
import { fixture as configuredFixture } from "./configured-cart-quote.fixture.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { createConfiguredOrderPricingSource } from "../application/configured-order-pricing-source.js";
import {
  parseCheckoutValidationEvidence,
  parseConfiguredCheckoutValidationEvidence,
} from "../domain/checkout-validation.js";
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
function fixture() {
  const quote = configuredFixture().quote;
  const original = orderWriteFixture({ at: "2026-08-02T16:00:30.000Z" }).request
    .checkoutValidationEvidence;
  const scope = {
    brandReference: String(quote.brandReference),
    storeReference: String(quote.storeReference),
  };
  const binding = {
    ...scope,
    cartReference: String(quote.cartReference),
    cartVersion: quote.cartVersion,
    quoteReference: String(quote.quoteReference),
  };
  const evidence = {
    ...original,
    ...binding,
    quoteVersion: quote.quoteVersion,
    quoteInputDigest: String(quote.inputDigest),
    validatedAt: "2026-08-02T16:00:30.000Z",
    validUntil: quote.expiresAt,
    catalogLines: quote.lines.map((line) => ({
      cartItemReference: String(line.lineReference),
      sellableReference: String(line.sellableReference),
      productVersionReference: String(line.productVersionReference),
      menuVersionReference: String(line.menuVersionReference),
      validatedAt: "2026-08-02T16:00:30.000Z",
    })),
    fulfillment: {
      ...original.fulfillment,
      ...binding,
      checkedAt: "2026-08-02T16:00:30.000Z",
      validUntil: quote.expiresAt,
    },
  };
  let now = evidence.validatedAt;
  const load = vi.fn(async (): Promise<ConfiguredPriceQuoteSnapshot | null> => quote);
  return {
    quote,
    evidence,
    load,
    setTime: (at: string) => {
      now = at;
    },
    source: createConfiguredOrderPricingSource({
      scope,
      history: { load },
      clock: { now: () => now },
    }),
  };
}

it("maps original configured Quote rule provenance and amounts without repricing", async () => {
  const f = fixture(),
    line = required((await f.source.load({ evidence: f.evidence }))[0]);
  expect(line.quoteVersion).toBe(2);
  expect(line.total.amountMinor).toBe(2825n);
  expect(line.unitPrice.amountMinor).toBe(1250n);
  expect(line.priceResolution.unitPrice.amountMinor).toBe(1000n);
  const option = required(line.optionPrices[0]),
    original = required(required(f.quote.lines[0]).optionPrices[0]);
  expect(option.ruleVersionReference).toBe(original.rule.versionReference);
  expect(option.ruleDigest).toBe(original.rule.snapshotDigest);
  expect(option.chargedQuantity).toBe(4n);
  expect(option.subtotal.amountMinor).toBe(500n);
  expect(option.includedQuantity).toBe(1);
  expect(f.load).toHaveBeenCalledOnce();
  expect(Object.isFrozen(line.optionPrices)).toBe(true);
});
it("keeps configured Checkout evidence explicitly versioned", () => {
  const f = fixture();
  expect(parseConfiguredCheckoutValidationEvidence(f.evidence).quoteVersion).toBe(2);
  expect(() => parseCheckoutValidationEvidence(f.evidence)).toThrow();
  expect(() =>
    parseConfiguredCheckoutValidationEvidence({ ...f.evidence, quoteVersion: 1 }),
  ).toThrow();
});
it.each(["missing", "digest", "scope", "option"])("rejects %s original history", async (mode) => {
  const f = fixture();
  if (mode === "missing") f.load.mockResolvedValue(null);
  if (mode === "digest")
    f.load.mockResolvedValue({ ...f.quote, inputDigest: ("sha256:" + "f".repeat(64)) as never });
  if (mode === "scope")
    f.load.mockResolvedValue({ ...f.quote, storeReference: f.quote.brandReference });
  if (mode === "option")
    f.load.mockResolvedValue({
      ...f.quote,
      lines: f.quote.lines.map((line) => ({
        ...line,
        optionPrices: line.optionPrices.map((option) => ({ ...option, chargedQuantity: 9n })),
      })),
    });
  await expect(f.source.load({ evidence: f.evidence })).rejects.toMatchObject({
    code: "ORDER_PRICING_SOURCE_UNAVAILABLE",
  });
});
it("rejects expired evidence without reading history", async () => {
  const f = fixture();
  f.setTime(f.evidence.validUntil);
  await expect(f.source.load({ evidence: f.evidence })).rejects.toThrow();
  expect(f.load).not.toHaveBeenCalled();
});
