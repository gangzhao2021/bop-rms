import { describe, expect, it } from "vitest";
import {
  createMoney,
  createPriceQuote,
  decodePriceQuoteSnapshot,
  encodePriceQuoteSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  PriceQuoteSnapshotCodecError,
  type CreatePriceQuoteInput,
  type PriceQuoteSnapshot,
} from "../index.js";
import { calculateQuoteTax } from "../domain/quote-tax-allocation.js";
import { input } from "./price-quote.fixture.js";

const id = (n: number) =>
  parsePricingReference(`018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const cad = (amountMinor: bigint) =>
  createMoney({ amountMinor, currencyCode: parseCurrencyCode("CAD") });

/** TEST: three $1.05 dishes at 13% (each line 13.65¢; the whole quote 40.95¢). */
function threeAtOneOhFive(): CreatePriceQuoteInput {
  const base = input();
  const line = base.lines[0];
  if (line === undefined) throw new Error("fixture");
  return {
    ...base,
    priceBook: {
      ...base.priceBook,
      entries: base.priceBook.entries.map((entry) => ({ ...entry, amount: cad(105n) })),
    },
    lines: [70, 71, 72].map((n) => ({ ...line, lineReference: id(n), quantity: 1 })),
  };
}

type Mutable<T> = { -readonly [P in keyof T]: T[P] extends object ? Mutable<T[P]> : T[P] };
/** The same quote with the given tax on each line (and its totals), as a recorded snapshot. */
function withLineTax(quote: PriceQuoteSnapshot, taxes: readonly bigint[]) {
  const copy = structuredClone(quote) as unknown as Mutable<PriceQuoteSnapshot>;
  let tax = 0n;
  copy.lines.forEach((line, index) => {
    const amount = taxes[index] ?? 0n;
    const entry = line.taxLines[0];
    if (entry === undefined) throw new Error("fixture");
    entry.taxAmount = cad(amount);
    line.tax = cad(amount);
    line.total = cad(line.subtotal.amountMinor + amount);
    tax += amount;
  });
  copy.tax = cad(tax);
  copy.total = cad(copy.subtotal.amountMinor + tax);
  return copy as unknown as PriceQuoteSnapshot;
}

describe("WP-2423 DEC-TAX-WHOLE-RECEIPT: tax per tax type on the whole quote", () => {
  it("charges round(Σ taxable × rate) once and allocates it to the lines by largest remainder", () => {
    const quote = createPriceQuote(threeAtOneOhFive());
    // Each line on its own would collect 3 × 14¢ = 42¢; the whole quote is 40.95¢ → 41¢.
    expect(quote.subtotal.amountMinor).toBe(315n);
    expect(quote.tax.amountMinor).toBe(41n);
    expect(quote.total.amountMinor).toBe(356n);
    expect(quote.lines.map((line) => line.tax.amountMinor)).toEqual([14n, 14n, 13n]);
    expect(quote.lines.reduce((sum, line) => sum + line.tax.amountMinor, 0n)).toBe(41n);
    // The earlier rule, for comparison.
    const perLine = calculateQuoteTax(
      quote.lines.map((line) => ({
        lineReference: line.lineReference,
        subtotal: line.subtotal,
        rules: line.taxResolution.rules,
      })),
      quote.currencyMetadata,
      "PerLine",
    );
    expect(perLine.map((entries) => entries[0]?.taxAmount.amountMinor)).toEqual([14n, 14n, 14n]);
  });

  it("keeps a quote recorded under the earlier rule readable exactly as recorded", () => {
    const quote = createPriceQuote(threeAtOneOhFive());
    const legacy = withLineTax(quote, [14n, 14n, 14n]);
    const decoded = decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(legacy));
    expect(decoded.tax.amountMinor).toBe(42n);
    expect(decoded.lines.map((line) => line.tax.amountMinor)).toEqual([14n, 14n, 14n]);
    // New quotes round trip under the new rule.
    expect(decodePriceQuoteSnapshot(encodePriceQuoteSnapshot(quote)).tax.amountMinor).toBe(41n);
  });

  it("refuses any other split of the tax, or a mix of the two rules", () => {
    const quote = createPriceQuote(threeAtOneOhFive());
    for (const taxes of [
      [13n, 14n, 14n], // the right total, but not the largest-remainder allocation
      [14n, 14n, 12n],
      [15n, 14n, 13n],
    ])
      expect(() => encodePriceQuoteSnapshot(withLineTax(quote, taxes))).toThrow(
        PriceQuoteSnapshotCodecError,
      );
  });
});
