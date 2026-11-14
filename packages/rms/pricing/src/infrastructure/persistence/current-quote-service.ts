import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
  type CurrencyMetadataSnapshot,
} from "../../domain/money-tax-contract.js";
import type { CreatePriceQuoteInput } from "../../domain/price-quote.js";
import {
  createCurrentPriceBookQuoteService,
  CurrentPriceBookQuoteError,
} from "../../application/current-price-book-quote.js";
import { createPostgresCurrentPriceBookStore } from "./current-price-book-store.js";
import {
  createPostgresCurrentTaxConfigurationStore,
  type CurrentTaxEvidenceSource,
} from "./current-tax-configuration-store.js";
import type { PriceQuoteQueryTransactionRunner } from "./price-quote-query-store.js";

/** Caller owns authorization and a dedicated read-only Repeatable Read transaction. */
export function createPostgresCurrentQuoteService(
  runner: PriceQuoteQueryTransactionRunner,
  options: {
    readonly scope: Readonly<{ brandReference: string; storeReference: string }>;
    readonly priceBookReference: string;
    readonly taxConfigurationReference: string;
    readonly currencyMetadata: CurrencyMetadataSnapshot;
    readonly evidence: CurrentTaxEvidenceSource;
    readonly clock: { now(): string };
  },
) {
  const scope = Object.freeze({
    brandReference: parsePricingReference(options.scope.brandReference),
    storeReference: parsePricingReference(options.scope.storeReference),
  });
  const priceBookReference = parsePricingReference(options.priceBookReference);
  const configurationReference = parsePricingReference(options.taxConfigurationReference);
  const currencyMetadata = createCurrencyMetadataSnapshot(options.currencyMetadata);
  return Object.freeze({
    async create(
      input: Omit<CreatePriceQuoteInput, "priceBook" | "taxConfiguration" | "currencyMetadata">,
    ) {
      try {
        const source = structuredClone(input);
        const start = parseEffectivePeriodInstant(options.clock.now());
        let lastAt = start;
        const clock = {
          now() {
            const value = parseEffectivePeriodInstant(options.clock.now());
            if (value < lastAt) throw new Error();
            lastAt = value;
            return value;
          },
        };
        const createdAt = parseEffectivePeriodInstant(source.createdAt);
        const expiresAt = parseEffectivePeriodInstant(source.expiresAt);
        if (
          source.brandReference !== scope.brandReference ||
          source.storeReference !== scope.storeReference ||
          createdAt > start ||
          expiresAt <= start
        )
          throw new Error();
        return await runner.run(async (tx) => {
          const result = await tx.query(
            "SELECT current_setting('transaction_isolation') AS isolation, current_setting('transaction_read_only') AS read_only",
            [],
          );
          if (result === null || typeof result !== "object") throw new Error();
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length !== 1) throw new Error();
          const isolation = Object.getOwnPropertyDescriptor(rows[0], "isolation")?.value as unknown;
          const readOnly = Object.getOwnPropertyDescriptor(rows[0], "read_only")?.value as unknown;
          if (
            (isolation !== "repeatable read" && isolation !== "serializable") ||
            readOnly !== "on"
          )
            throw new Error();
          const shared: PriceQuoteQueryTransactionRunner = { run: (work) => work(tx) };
          const taxConfiguration = await createPostgresCurrentTaxConfigurationStore(
            shared,
            scope,
            currencyMetadata,
            options.evidence,
          ).load({ configurationReference, observedAt: createdAt });
          if (taxConfiguration === null) throw new Error();
          const afterTax = parseEffectivePeriodInstant(clock.now());
          if (afterTax < start || afterTax >= expiresAt) throw new Error();
          return createCurrentPriceBookQuoteService({
            scope,
            priceBookReference,
            clock,
            books: createPostgresCurrentPriceBookStore(
              shared,
              { brandReference: scope.brandReference },
              currencyMetadata,
            ),
          }).create({ ...source, currencyMetadata, taxConfiguration });
        });
      } catch {
        throw new CurrentPriceBookQuoteError();
      }
    },
  });
}
