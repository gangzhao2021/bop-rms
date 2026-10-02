import { priceBookReferenceSourceFields } from "../../contracts/price-book-reference-source.js";
import { optionPriceReferenceSourceFields } from "../../contracts/option-price-reference-source.js";
import { promotionReferenceSourceFields } from "../../contracts/promotion-reference-source.js";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parsePricingReference } from "../../domain/money-tax-contract.js";
import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "../../contracts/price-book-reference-source.js";
import {
  ConfigurationReferenceSourceError,
  configurationReferenceSourceFields,
  buildConfigurationReferenceSourceSnapshot,
  type ConfigurationReferenceSourceSnapshot,
} from "../../contracts/configuration-reference-source.js";
import {
  createPostgresPriceBookReferenceSourceStore,
  type PriceBookReferenceSourceAuthority,
} from "./price-book-reference-source-store.js";
import {
  createPostgresOptionPriceReferenceSourceStore,
  type OptionPriceReferenceSourceAuthority,
} from "./option-price-reference-source-store.js";
import {
  createPostgresPromotionReferenceSourceStore,
  type PromotionReferenceSourceAuthority,
} from "./promotion-reference-source-store.js";
import type {
  PriceQuoteQueryTransaction,
  PriceQuoteQueryTransactionRunner,
} from "./price-quote-query-store.js";
const fail = (): never => {
  throw new ConfigurationReferenceSourceError();
};
export interface ConfigurationReferenceSourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: PriceQuoteQueryTransactionRunner;
  readonly clock: { now(): string };
  readonly priceBookAuthority: PriceBookReferenceSourceAuthority;
  readonly optionPriceAuthority: OptionPriceReferenceSourceAuthority;
  readonly promotionAuthority: PromotionReferenceSourceAuthority;
  readonly authority: {
    /** Actual current complete Brand scope/Tenant/Actor/session/purpose/Phase/fields held through caller COMMIT. */
    holdUntilTransactionCompletes(
      tx: PriceQuoteQueryTransaction,
      input: {
        readonly tenantReference: string;
        readonly request: PriceBookReferenceSourceRequest;
        readonly requiredScope: "Brand";
        readonly requiredPermissions: readonly [
          "pricing.price-book.manage",
          "pricing.promotion.manage",
        ];
        readonly requiredFields: typeof configurationReferenceSourceFields;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
/** Own source fence persists through outer COMMIT. Caller binds one UoW before composing
 * with Catalog/Tenant/Tax holders; work cannot mutate these shared-locked Pricing sources. */
export function createPostgresConfigurationReferenceSourceStore(
  options: ConfigurationReferenceSourceOptions,
) {
  const tenant = parsePricingReference(options.tenantReference),
    brand = parsePricingReference(options.brandReference),
    actor = parsePricingReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      value: PriceBookReferenceSourceRequest,
      work: (source: ConfigurationReferenceSourceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parsePriceBookReferenceSourceRequest(value);
        if (request.brandReference !== brand || request.actorReference !== actor) return fail();
        let calls = 0,
          completed: { readonly value: T } | undefined;
        const result = await options.transactions.run(async (tx) => {
          if (++calls !== 1) return fail();
          const authorize = () =>
            options.authority.holdUntilTransactionCompletes(
              tx,
              Object.freeze({
                tenantReference: tenant,
                request,
                requiredScope: "Brand",
                requiredPermissions: Object.freeze([
                  "pricing.price-book.manage",
                  "pricing.promotion.manage",
                ] as const),
                requiredFields: configurationReferenceSourceFields,
                observedAt: parseEffectivePeriodInstant(options.clock.now()),
              }),
            );
          await authorize();
          const isolation = await tx.query(
              "SELECT current_setting('transaction_isolation') isolation",
              [],
            ),
            rows = Object.getOwnPropertyDescriptor(isolation, "rows")?.value;
          if (
            !Array.isArray(rows) ||
            rows.length !== 1 ||
            Object.getOwnPropertyDescriptor(rows[0], "isolation")?.value !== "read committed"
          )
            return fail();
          const scope = () =>
            tx.query(
              "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
              [brand],
            );
          await scope();
          await tx.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
            "PricingConfigurationReferenceV1:" + brand,
          ]);
          const head = async () => {
            await scope();
            const result = await tx.query(
              `SELECT g.generation::text generation,
              EXISTS(SELECT 1 FROM rms_pricing.price_book WHERE brand_id=$1) OR EXISTS(SELECT 1 FROM rms_pricing.option_price_rule WHERE brand_id=$1) OR EXISTS(SELECT 1 FROM rms_pricing.promotion WHERE brand_id=$1) has_source
              FROM (SELECT generation FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1 UNION ALL SELECT NULL::bigint WHERE NOT EXISTS(SELECT 1 FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1)) g`,
              [brand],
            );
            const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value;
            if (!Array.isArray(rows) || rows.length !== 1) return fail();
            const row = Object.getOwnPropertyDescriptor(rows, "0")?.value;
            if (!row || Reflect.ownKeys(row).length !== 2) return fail();
            const generation = Object.getOwnPropertyDescriptor(row, "generation")?.value,
              hasSource = Object.getOwnPropertyDescriptor(row, "has_source")?.value;
            if (typeof hasSource !== "boolean" || (generation === null && hasSource)) return fail();
            if (
              generation !== null &&
              (typeof generation !== "string" ||
                !/^(0|[1-9][0-9]{0,18})$/.test(generation) ||
                BigInt(generation) > 9223372036854775807n)
            )
              return fail();
            return generation;
          };
          const generation = await head(),
            bound = {
              ...options,
              transactions: {
                run: <R>(action: (bound: PriceQuoteQueryTransaction) => Promise<R>) => action(tx),
              },
            };
          const priceBooks = await createPostgresPriceBookReferenceSourceStore({
            ...bound,
            authority: options.priceBookAuthority,
          }).loadSnapshot(request);
          const optionPrices = await createPostgresOptionPriceReferenceSourceStore({
            ...bound,
            authority: options.optionPriceAuthority,
          }).loadSnapshot(request);
          const promotions = await createPostgresPromotionReferenceSourceStore({
            ...bound,
            authority: options.promotionAuthority,
          }).loadSnapshot(request);
          const snapshot = buildConfigurationReferenceSourceSnapshot(
            { generation: generation ?? "0", priceBooks, optionPrices, promotions },
            request,
            options.clock.now(),
          );
          await authorize();
          completed = Object.freeze({ value: await work(snapshot) });
          await authorize();
          const at = parseEffectivePeriodInstant(options.clock.now());
          // Recheck each source's current scope/field permission after the consumer, not only its header.
          await options.priceBookAuthority.holdUntilTransactionCompletes(tx, {
            tenantReference: tenant,
            request,
            permission: "pricing.price-book.manage",
            requiredFields: priceBookReferenceSourceFields,
            observedAt: at,
          });
          await options.optionPriceAuthority.holdUntilTransactionCompletes(tx, {
            tenantReference: tenant,
            request,
            permission: "pricing.price-book.manage",
            requiredFields: optionPriceReferenceSourceFields,
            observedAt: at,
          });
          await options.promotionAuthority.holdUntilTransactionCompletes(tx, {
            tenantReference: tenant,
            request,
            permission: "pricing.promotion.manage",
            requiredFields: promotionReferenceSourceFields,
            observedAt: at,
          });
          if ((await head()) !== generation) return fail();
          const finalAt = parseEffectivePeriodInstant(options.clock.now());
          if (
            finalAt < snapshot.observedAt ||
            Date.parse(finalAt) - Date.parse(snapshot.observedAt) > 5000
          )
            return fail();
          return completed;
        });
        if (calls !== 1 || !completed || result !== completed) return fail();
        return completed.value;
      } catch {
        return fail();
      }
    },
  });
}
