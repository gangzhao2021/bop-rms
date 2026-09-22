import { expect, it, vi } from "vitest";
import { createPriceQuote, type PriceQuoteSnapshot } from "@rms/pricing";
import { input as quoteInput } from "./order-pricing-quote.fixture.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
import { createOrderPricingSource } from "../application/order-pricing-source.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("missing synthetic fixture value");
  return value;
}
function fixture() {
  const quote = createPriceQuote(quoteInput());
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
  const load = vi.fn(async (): Promise<PriceQuoteSnapshot | null> => quote);
  return {
    quote,
    evidence,
    load,
    setTime: (at: string) => {
      now = at;
    },
    source: createOrderPricingSource({ scope, history: { load }, clock: { now: () => now } }),
  };
}
it("maps the exact original quote money, currency and tax provenance", async () => {
  const f = fixture(),
    lines = await f.source.load({ evidence: f.evidence });
  const line = required(lines[0]),
    original = required(f.quote.lines[0]);
  expect(line.total).toEqual(original.total);
  expect(line.unitPrice).toEqual(original.unitPrice);
  expect(line.currencyMetadataDigest).toBe(f.quote.currencyMetadata.metadataDigest);
  expect(line.priceResolution.priceBookDigest).toBe(original.resolvedPrice.snapshotDigest);
  expect(line.taxComponents[0]).toMatchObject({
    ruleVersionReference: required(original.taxLines[0]).ruleReference,
    taxAmount: required(original.taxLines[0]).taxAmount,
    rate: "0.13",
  });
  expect(line.quotedAt).toBe(f.quote.createdAt);
  expect(Object.isFrozen(lines)).toBe(true);
});
it("preserves money above the safe integer range without recalculation", async () => {
  const f = fixture(),
    input = quoteInput();
  const quote = createPriceQuote({
    ...input,
    priceBook: {
      ...input.priceBook,
      entries: input.priceBook.entries.map((entry) => ({
        ...entry,
        amount: { ...entry.amount, amountMinor: 9007199254740993n },
      })),
    },
  });
  f.load.mockResolvedValue(quote);
  const lines = await f.source.load({ evidence: f.evidence });
  expect(required(lines[0]).unitPrice.amountMinor).toBe(9007199254740993n);
  expect(required(lines[0]).total).toEqual(required(quote.lines[0]).total);
});
it("rejects foreign scope and expired evidence before reading", async () => {
  const f = fixture();
  await expect(
    f.source.load({ evidence: { ...f.evidence, storeReference: f.evidence.brandReference } }),
  ).rejects.toMatchObject({ code: "ORDER_PRICING_SOURCE_UNAVAILABLE" });
  expect(f.load).not.toHaveBeenCalled();
  f.setTime(f.evidence.validUntil);
  await expect(f.source.load({ evidence: f.evidence })).rejects.toThrow();
  expect(f.load).not.toHaveBeenCalled();
});
it.each(["missing", "version", "digest", "catalog", "blocked", "malformed"] as const)(
  "rejects %s quote history",
  async (mode) => {
    const f = fixture();
    if (mode === "missing") f.load.mockResolvedValue(null);
    if (mode === "version")
      f.load.mockResolvedValue({ ...f.quote, cartVersion: f.quote.cartVersion + 1 });
    if (mode === "digest")
      f.load.mockResolvedValue({ ...f.quote, inputDigest: ("sha256:" + "f".repeat(64)) as never });
    if (mode === "catalog")
      f.load.mockResolvedValue({
        ...f.quote,
        lines: f.quote.lines.map((line) => ({
          ...line,
          menuVersionReference: f.quote.cartReference,
        })),
      });
    if (mode === "blocked")
      f.load.mockResolvedValue({ ...f.quote, blockingReasons: ["SYNTHETIC_BLOCK"] });
    if (mode === "malformed")
      f.load.mockResolvedValue({ ...f.quote, total: { ...f.quote.total, amountMinor: 1n } });
    await expect(f.source.load({ evidence: f.evidence })).rejects.toMatchObject({
      code: "ORDER_PRICING_SOURCE_UNAVAILABLE",
    });
  },
);
it.each(["expiry", "regression"] as const)("rejects clock %s across history I/O", async (mode) => {
  const f = fixture();
  f.load.mockImplementation(async () => {
    f.setTime(mode === "expiry" ? f.quote.expiresAt : f.quote.createdAt);
    return f.quote;
  });
  await expect(f.source.load({ evidence: f.evidence })).rejects.toThrow();
});
