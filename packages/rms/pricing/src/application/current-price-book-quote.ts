import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parsePricingReference } from "../domain/money-tax-contract.js";
import { createPriceBookSnapshot, type PriceBookSnapshot } from "../domain/price-resolution.js";
import { createPriceQuote, type CreatePriceQuoteInput } from "../domain/price-quote.js";

export function createCurrentPriceBookQuoteService(options: {
  readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
  readonly priceBookReference: string;
  readonly books: {
    load(input: {
      priceBookReference: string;
      observedAt: string;
    }): Promise<PriceBookSnapshot | null>;
  };
  readonly clock: { now(): string };
}) {
  const brand = parsePricingReference(options.scope.brandReference);
  const store = parsePricingReference(options.scope.storeReference);
  const bookReference = parsePricingReference(options.priceBookReference);
  return Object.freeze({
    async create(input: Omit<CreatePriceQuoteInput, "priceBook">) {
      try {
        const source = structuredClone(input);
        const startedAt = parseEffectivePeriodInstant(options.clock.now());
        const createdAt = parseEffectivePeriodInstant(source.createdAt);
        const expiresAt = parseEffectivePeriodInstant(source.expiresAt);
        if (
          source.brandReference !== brand ||
          source.storeReference !== store ||
          createdAt > startedAt ||
          expiresAt <= startedAt
        )
          throw new Error();
        const found = await options.books.load({
          priceBookReference: bookReference,
          observedAt: createdAt,
        });
        if (found === null) throw new Error();
        const book = createPriceBookSnapshot(found);
        if (
          book.priceBookReference !== bookReference ||
          book.brandReference !== brand ||
          book.lifecycle !== "Published" ||
          book.createdAt > createdAt
        )
          throw new Error();
        for (const field of [
          "currencyCode",
          "minorUnitExponent",
          "metadataVersion",
          "metadataVersionReference",
          "metadataDigest",
        ] as const)
          if (source.currencyMetadata[field] !== book.currencyMetadata[field]) throw new Error();
        const finishedAt = parseEffectivePeriodInstant(options.clock.now());
        if (finishedAt < startedAt || finishedAt >= expiresAt) throw new Error();
        return createPriceQuote({ ...source, priceBook: book });
      } catch {
        throw new CurrentPriceBookQuoteError();
      }
    },
  });
}
export class CurrentPriceBookQuoteError extends Error {
  readonly code = "CURRENT_PRICE_BOOK_QUOTE_UNAVAILABLE";
  constructor() {
    super("current price book quote is unavailable");
    this.name = "CurrentPriceBookQuoteError";
  }
}
