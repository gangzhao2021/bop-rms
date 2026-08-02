import { describe, expect, it } from "vitest";

import {
  createMoney,
  createPriceQuote,
  parseCurrencyCode,
  parsePricingDigest,
  parsePricingReference,
  parseTaxRate,
  PriceQuoteLifecycleError,
  requoteExpiredPriceQuote,
  type CreatePriceQuoteInput,
  type PriceQuoteSnapshot,
} from "../index.js";
import { input as quoteInput } from "./price-quote.fixture.js";

const expiredAt = "2026-08-02T16:05:00.000Z";
const replacementExpiresAt = "2026-08-02T16:10:00.000Z";
const reference = (n: number) =>
  parsePricingReference(`018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const digest = (character: string) => parsePricingDigest(`sha256:${character.repeat(64)}`);

function first<T>(values: readonly T[], fixture: string): T {
  const value = values[0];
  if (value === undefined) throw new Error(`${fixture} requires one value`);
  return value;
}

function required<T>(value: T | null | undefined, fixture: string): T {
  if (value === null || value === undefined) throw new Error(`${fixture} is required`);
  return value;
}

function recalculationInput(
  quoteReference: number,
  overrides: Partial<CreatePriceQuoteInput> = {},
): CreatePriceQuoteInput {
  const base = quoteInput();
  return {
    ...base,
    quoteReference: reference(quoteReference),
    createdAt: expiredAt,
    expiresAt: replacementExpiresAt,
    lines: base.lines.map((line) => ({
      ...line,
      priceContext: { ...line.priceContext, evaluatedAt: expiredAt },
      taxContext: { ...line.taxContext, evaluatedAt: expiredAt },
    })),
    ...overrides,
  };
}

function calculationEvidence(quote: PriceQuoteSnapshot) {
  return {
    currencyMetadata: quote.currencyMetadata,
    subtotal: quote.subtotal,
    discount: quote.discount,
    tax: quote.tax,
    fee: quote.fee,
    total: quote.total,
    lines: quote.lines,
    appliedPromotionReferences: quote.appliedPromotionReferences,
    warnings: quote.warnings,
    blockingReasons: quote.blockingReasons,
  };
}

function expectLifecycleCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(PriceQuoteLifecycleError);
    expect((error as PriceQuoteLifecycleError).code).toBe(code);
  }
}

describe("WP-1105 Quote recalculation acceptance", () => {
  it("replays the exact same input and versions byte-for-byte at the contract level", () => {
    const input = quoteInput();
    const firstQuote = createPriceQuote(input);
    const replayedQuote = createPriceQuote(input);

    expect(replayedQuote).toEqual(firstQuote);
    expect(Object.isFrozen(firstQuote)).toBe(true);
    expect(Object.isFrozen(firstQuote.lines)).toBe(true);
  });

  it("keeps calculation evidence stable when only Quote identity changes", () => {
    const firstQuote = createPriceQuote(quoteInput());
    const secondQuote = createPriceQuote(quoteInput({ quoteReference: reference(101) }));

    expect(secondQuote.quoteReference).not.toBe(firstQuote.quoteReference);
    expect(calculationEvidence(secondQuote)).toEqual(calculationEvidence(firstQuote));
  });

  it("requotes an expired Quote with unchanged authoritative versions and no reconfirmation", () => {
    const previousQuote = createPriceQuote(quoteInput());
    const previousEvidence = calculationEvidence(previousQuote);
    const result = requoteExpiredPriceQuote({
      previousQuote,
      replacementInput: recalculationInput(102),
      evaluatedAt: expiredAt,
    });

    expect(result.change).toBe("Unchanged");
    expect(result.totalChange.amountMinor).toBe(0n);
    expect(result.requiresReconfirmation).toBe(false);
    expect(calculationEvidence(result.replacementQuote)).toEqual(previousEvidence);
    expect(calculationEvidence(previousQuote)).toEqual(previousEvidence);
  });

  it("recalculates from a new Price Book version and retains both immutable evidence sets", () => {
    const previousQuote = createPriceQuote(quoteInput());
    const replacement = recalculationInput(103);
    const entry = first(replacement.priceBook.entries, "price book fixture");
    const nextVersion = reference(104);
    const result = requoteExpiredPriceQuote({
      previousQuote,
      replacementInput: {
        ...replacement,
        priceBook: {
          ...replacement.priceBook,
          versionReference: nextVersion,
          aggregateVersion: 2,
          versionNumber: 2,
          snapshotDigest: digest("f"),
          entries: [
            {
              ...entry,
              amount: createMoney({
                amountMinor: 1100n,
                currencyCode: parseCurrencyCode("CAD"),
              }),
            },
          ],
        },
      },
      evaluatedAt: expiredAt,
    });

    expect(result.change).toBe("ReconfirmationRequired");
    expect(result.totalChange.amountMinor).toBe(226n);
    expect(result.replacementQuote.lines[0]?.resolvedPrice.versionReference).toBe(nextVersion);
    expect(previousQuote.lines[0]?.resolvedPrice.versionReference).not.toBe(nextVersion);
    expect(previousQuote.total.amountMinor).toBe(2260n);
  });

  it("recalculates deterministic tax rounding from a new exact Tax configuration version", () => {
    const previousQuote = createPriceQuote(quoteInput());
    const replacement = recalculationInput(105);
    const rule = first(replacement.taxConfiguration.rules, "tax fixture");
    const professionalEvidence = required(
      replacement.taxConfiguration.professionalEvidence,
      "tax professional evidence fixture",
    );
    const nextVersion = reference(106);
    const nextDigest = digest("9");
    const result = requoteExpiredPriceQuote({
      previousQuote,
      replacementInput: {
        ...replacement,
        taxConfiguration: {
          ...replacement.taxConfiguration,
          versionReference: nextVersion,
          aggregateVersion: 2,
          versionNumber: 2,
          snapshotDigest: nextDigest,
          professionalEvidence: {
            ...professionalEvidence,
            snapshotReference: nextVersion,
            snapshotDigest: nextDigest,
          },
          rules: [{ ...rule, rate: parseTaxRate("0.15") }],
        },
      },
      evaluatedAt: expiredAt,
    });

    expect(result.replacementQuote.tax.amountMinor).toBe(300n);
    expect(result.replacementQuote.total.amountMinor).toBe(2300n);
    expect(result.totalChange.amountMinor).toBe(40n);
    expect(result.change).toBe("ReconfirmationRequired");
    expect(result.replacementQuote.lines[0]?.taxResolution.versionReference).toBe(nextVersion);
    expect(previousQuote.tax.amountMinor).toBe(260n);
  });

  it.each([1n, 2n, 3n, 5n, 99n, 1000n, 999_999n])(
    "keeps minor-unit rounding deterministic for a unit amount of %s",
    (amountMinor) => {
      const base = quoteInput();
      const entry = first(base.priceBook.entries, "price book fixture");
      const input = quoteInput({
        priceBook: {
          ...base.priceBook,
          entries: [
            {
              ...entry,
              amount: createMoney({
                amountMinor,
                currencyCode: parseCurrencyCode("CAD"),
              }),
            },
          ],
        },
      });

      expect(createPriceQuote(input)).toEqual(createPriceQuote(input));
    },
  );

  it("requires a fresh Quote path for changed Cart input instead of mis-scoped expired requote", () => {
    const previousQuote = createPriceQuote(quoteInput());
    const changedInput = recalculationInput(107, {
      cartVersion: previousQuote.cartVersion + 1,
      inputDigest: digest("8"),
    });

    expectLifecycleCode(
      () =>
        requoteExpiredPriceQuote({
          previousQuote,
          replacementInput: changedInput,
          evaluatedAt: expiredAt,
        }),
      "QUOTE_REQUOTE_SCOPE_MISMATCH",
    );

    const changedQuote = createPriceQuote(changedInput);
    expect(changedQuote.cartVersion).toBe(5);
    expect(changedQuote.inputDigest).toBe(digest("8"));
    expect(previousQuote.cartVersion).toBe(4);
  });
});
