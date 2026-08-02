import { describe, expect, it } from "vitest";

import {
  createMoney,
  createPriceQuote,
  evaluatePriceQuoteValidity,
  parseCurrencyCode,
  PriceQuoteLifecycleError,
  requoteExpiredPriceQuote,
} from "../index.js";
import { input as quoteInput } from "./price-quote.fixture.js";

const expiredAt = "2026-08-02T16:05:00.000Z";
const replacementExpiresAt = "2026-08-02T16:10:00.000Z";

function replacement(amountMinor: bigint) {
  const base = quoteInput();
  const entry = base.priceBook.entries[0];
  const line = base.lines[0];
  if (entry === undefined || line === undefined) throw new Error("fixture requires one entry/line");
  return {
    ...base,
    quoteReference: "018fb000-0000-7000-8000-000000000099" as never,
    createdAt: expiredAt,
    expiresAt: replacementExpiresAt,
    priceBook: {
      ...base.priceBook,
      entries: [
        {
          ...entry,
          amount: createMoney({ amountMinor, currencyCode: parseCurrencyCode("CAD") }),
        },
      ],
    },
    lines: [
      {
        ...line,
        priceContext: { ...line.priceContext, evaluatedAt: expiredAt },
        taxContext: { ...line.taxContext, evaluatedAt: expiredAt },
      },
    ],
  };
}

function expectCode(action: () => unknown, code: string): void {
  try {
    action();
    throw new Error("expected error");
  } catch (error) {
    expect(error).toBeInstanceOf(PriceQuoteLifecycleError);
    expect((error as PriceQuoteLifecycleError).code).toBe(code);
  }
}

describe("WP-1104 Price Quote lifecycle", () => {
  it("keeps the exact immutable Quote current before expiry", () => {
    const quote = createPriceQuote(quoteInput());
    expect(evaluatePriceQuoteValidity(quote, "2026-08-02T16:04:59.999Z")).toBe("Current");
    expect(Object.isFrozen(quote)).toBe(true);
  });

  it("treats the exact expiry instant as expired", () => {
    expect(evaluatePriceQuoteValidity(createPriceQuote(quoteInput()), expiredAt)).toBe("Expired");
  });

  it.each([
    [1000n, "Unchanged", 0n, false],
    [900n, "Decreased", -226n, false],
    [1100n, "ReconfirmationRequired", 226n, true],
  ] as const)("classifies a recalculated unit amount of %s", (amount, change, delta, required) => {
    const previousQuote = createPriceQuote(quoteInput());
    const result = requoteExpiredPriceQuote({
      previousQuote,
      replacementInput: replacement(amount),
      evaluatedAt: expiredAt,
    });
    expect(result.change).toBe(change);
    expect(result.totalChange.amountMinor).toBe(delta);
    expect(result.requiresReconfirmation).toBe(required);
    expect(result.previousQuoteReference).toBe(previousQuote.quoteReference);
    expect(result.replacementQuote.quoteReference).not.toBe(previousQuote.quoteReference);
    expect(previousQuote.total.amountMinor).toBe(2260n);
  });

  it("rejects requote before expiry", () => {
    expectCode(
      () =>
        requoteExpiredPriceQuote({
          previousQuote: createPriceQuote(quoteInput()),
          replacementInput: replacement(1000n),
          evaluatedAt: "2026-08-02T16:04:59.999Z",
        }),
      "QUOTE_NOT_EXPIRED",
    );
  });

  it("rejects cross-Cart/version scope and Quote identity reuse", () => {
    const previousQuote = createPriceQuote(quoteInput());
    expectCode(
      () =>
        requoteExpiredPriceQuote({
          previousQuote,
          replacementInput: { ...replacement(1000n), cartVersion: 5 },
          evaluatedAt: expiredAt,
        }),
      "QUOTE_REQUOTE_SCOPE_MISMATCH",
    );
    expectCode(
      () =>
        requoteExpiredPriceQuote({
          previousQuote,
          replacementInput: {
            ...replacement(1000n),
            quoteReference: previousQuote.quoteReference,
          },
          evaluatedAt: expiredAt,
        }),
      "QUOTE_REQUOTE_REFERENCE_REUSED",
    );
  });
});
