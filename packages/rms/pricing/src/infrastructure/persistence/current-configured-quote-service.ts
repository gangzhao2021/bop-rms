import { parseEffectivePeriodInstant } from "@bop/effective-period";
import {
  createCurrencyMetadataSnapshot,
  parsePricingReference,
} from "../../domain/money-tax-contract.js";
import {
  createConfiguredPriceQuote,
  type ConfiguredQuoteOptionInput,
} from "../../domain/configured-price-quote.js";
import type { CreatePriceQuoteInput } from "../../domain/price-quote.js";
import { createPostgresCurrentPriceBookStore } from "./current-price-book-store.js";
import { createPostgresCurrentTaxConfigurationStore } from "./current-tax-configuration-store.js";
import { createPostgresCurrentOptionPriceStore } from "./current-option-price-store.js";
import type { PriceQuoteQueryTransactionRunner } from "./price-quote-query-store.js";
import type { createPostgresCurrentQuoteService } from "./current-quote-service.js";

export type CurrentConfiguredQuoteInput = Readonly<{
  base: Omit<CreatePriceQuoteInput, "priceBook" | "taxConfiguration" | "currencyMetadata">;
  options: readonly Omit<ConfiguredQuoteOptionInput, "rules">[];
}>;
export class CurrentConfiguredQuoteError extends Error {
  readonly code = "CURRENT_CONFIGURED_QUOTE_UNAVAILABLE";
  constructor() {
    super("current configured quote is unavailable");
    this.name = "CurrentConfiguredQuoteError";
  }
}
/** Server-resolved Catalog and tax classification remain caller authority. No policy writes. */
export function createPostgresCurrentConfiguredQuoteService(
  runner: PriceQuoteQueryTransactionRunner,
  options: Parameters<typeof createPostgresCurrentQuoteService>[1],
) {
  const scope = Object.freeze({
    brandReference: parsePricingReference(options.scope.brandReference),
    storeReference: parsePricingReference(options.scope.storeReference),
  });
  const priceBookReference = parsePricingReference(options.priceBookReference);
  const configurationReference = parsePricingReference(options.taxConfigurationReference);
  const currencyMetadata = createCurrencyMetadataSnapshot(options.currencyMetadata);
  return Object.freeze({
    async create(input: CurrentConfiguredQuoteInput) {
      try {
        const source = structuredClone(input);
        const start = parseEffectivePeriodInstant(options.clock.now());
        let lastAt = start;
        const createdAt = parseEffectivePeriodInstant(source.base.createdAt);
        const expiresAt = parseEffectivePeriodInstant(source.base.expiresAt);
        const checkClock = () => {
          const now = parseEffectivePeriodInstant(options.clock.now());
          if (now < lastAt || now >= expiresAt) throw new Error();
          lastAt = now;
          return now;
        };
        if (
          source.base.brandReference !== scope.brandReference ||
          source.base.storeReference !== scope.storeReference ||
          createdAt > start ||
          expiresAt <= start ||
          !Array.isArray(source.options) ||
          source.options.length < 1 ||
          source.options.length > 1000
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
          const priceBook = await createPostgresCurrentPriceBookStore(
            shared,
            { brandReference: scope.brandReference },
            currencyMetadata,
          ).load({
            priceBookReference,
            observedAt: createdAt,
          });
          checkClock();
          if (priceBook === null) throw new Error();
          const taxConfiguration = await createPostgresCurrentTaxConfigurationStore(
            shared,
            scope,
            currencyMetadata,
            options.evidence,
          ).load({ configurationReference, observedAt: createdAt });
          checkClock();
          if (taxConfiguration === null) throw new Error();
          const reader = createPostgresCurrentOptionPriceStore(shared, scope, currencyMetadata);
          const selected: ConfiguredQuoteOptionInput[] = [];
          for (const option of source.options) {
            if (Object.hasOwn(option, "rules")) throw new Error();
            const line = source.base.lines.find(
              (entry) => entry.lineReference === option.lineReference,
            );
            if (line === undefined) throw new Error();
            const rules = await reader.load({
              bindingReference: option.bindingReference,
              optionReference: option.optionReference,
              skuReference: line.sellableReference,
              storeGroupReference: line.priceContext.storeGroupReference,
              regionReference: line.priceContext.regionReference,
              channelCode: line.priceContext.channelCode,
              orderType: line.priceContext.orderType,
              observedAt: createdAt,
            });
            checkClock();
            selected.push({ ...option, rules });
          }
          const quote = createConfiguredPriceQuote({
            base: { ...source.base, priceBook, taxConfiguration, currencyMetadata },
            options: selected,
          });
          if (checkClock() >= quote.expiresAt) throw new Error();
          return quote;
        });
      } catch {
        throw new CurrentConfiguredQuoteError();
      }
    },
  });
}
