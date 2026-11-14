import {
  parsePricingProductPublicationReferenceRequestV2,
  type PricingProductPublicationReferenceRequestV2,
} from "../../contracts/product-publication-reference-request-v2.js";
import {
  buildProductPublicationConfigurationReferenceSourceSnapshotV2,
  productPublicationConfigurationReferenceSourceFieldsV2,
  type ProductPublicationConfigurationReferenceSourceSnapshotV2,
} from "../../contracts/configuration-reference-source.js";
import {
  createPostgresProductPublicationPriceBookReferenceSourceV2,
  type ProductPublicationPriceBookReferenceSourceOptionsV2,
} from "./price-book-reference-source-store.js";
import {
  createPostgresProductPublicationOptionPriceReferenceSourceV2,
  type ProductPublicationOptionPriceReferenceSourceOptionsV2,
} from "./option-price-reference-source-store.js";
import {
  createPostgresProductPublicationPromotionReferenceSourceV2,
  type ProductPublicationPromotionReferenceSourceOptionsV2,
} from "./promotion-reference-source-store.js";
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

function publicationRow(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !d ||
    !("value" in d) ||
    !Array.isArray(d.value) ||
    Object.getPrototypeOf(d.value) !== Array.prototype ||
    d.value.length !== 1 ||
    Reflect.ownKeys(d.value).length !== 2
  )
    return fail();
  const item = Object.getOwnPropertyDescriptor(d.value, "0");
  if (
    !item?.enumerable ||
    !("value" in item) ||
    !item.value ||
    Object.getPrototypeOf(item.value) !== Object.prototype ||
    Reflect.ownKeys(item.value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const v = Object.getOwnPropertyDescriptor(item.value, field);
    if (!v?.enumerable || !("value" in v)) return fail();
    result[field] = v.value;
  }
  return result;
}

export interface ProductPublicationConfigurationReferenceSourceOptionsV2 {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly actorKind: "User" | "System";
  readonly transactions: PriceQuoteQueryTransactionRunner;
  readonly clock: { now(): string };
  readonly registerBeforeCommit: (
    tx: PriceQuoteQueryTransaction,
    guard: () => Promise<void>,
    finalAssert: () => void,
  ) => void | Promise<void>;
  readonly priceBookAuthority: ProductPublicationPriceBookReferenceSourceOptionsV2["authority"];
  readonly optionPriceAuthority: ProductPublicationOptionPriceReferenceSourceOptionsV2["authority"];
  readonly promotionAuthority: ProductPublicationPromotionReferenceSourceOptionsV2["authority"];
  readonly authority: {
    holdUntilTransactionCompletes(
      tx: PriceQuoteQueryTransaction,
      input: {
        readonly tenantReference: string;
        readonly actorKind: "User" | "System";
        readonly request: PricingProductPublicationReferenceRequestV2;
        readonly purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ";
        readonly requiredScope: "FullBrandScope";
        readonly requiredPermissions: readonly [
          "pricing.price-book.manage",
          "pricing.promotion.manage",
        ];
        readonly requiredFields: typeof productPublicationConfigurationReferenceSourceFieldsV2;
        readonly observedAt: string;
      },
    ): Promise<void>;
  };
}
/** Complete stored PriceBook/OptionPrice/Promotion graph, held on the existing owning writer barrier. No sale qualification. */
export function createPostgresProductPublicationConfigurationReferenceSourceV2(
  options: ProductPublicationConfigurationReferenceSourceOptionsV2,
) {
  const tenant = parsePricingReference(options.tenantReference),
    brand = parsePricingReference(options.brandReference),
    actor = parsePricingReference(options.actorReference),
    kind = options.actorKind;
  if (
    (kind !== "User" && kind !== "System") ||
    typeof options.clock?.now !== "function" ||
    typeof options.transactions?.run !== "function" ||
    typeof options.authority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.priceBookAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.optionPriceAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.promotionAuthority?.holdUntilTransactionCompletes !== "function" ||
    typeof options.registerBeforeCommit !== "function"
  )
    return fail();
  const now = options.clock.now.bind(options.clock),
    run = options.transactions.run.bind(options.transactions),
    hold = options.authority.holdUntilTransactionCompletes.bind(options.authority),
    register = options.registerBeforeCommit.bind(options),
    priceBookAuthority = Object.freeze({
      holdUntilTransactionCompletes: options.priceBookAuthority.holdUntilTransactionCompletes.bind(
        options.priceBookAuthority,
      ),
    }),
    optionPriceAuthority = Object.freeze({
      holdUntilTransactionCompletes:
        options.optionPriceAuthority.holdUntilTransactionCompletes.bind(
          options.optionPriceAuthority,
        ),
    }),
    promotionAuthority = Object.freeze({
      holdUntilTransactionCompletes: options.promotionAuthority.holdUntilTransactionCompletes.bind(
        options.promotionAuthority,
      ),
    }),
    active = new WeakSet<object>(),
    failed = new WeakSet<object>();
  return Object.freeze({
    async withCurrentSnapshot<T>(
      input: PricingProductPublicationReferenceRequestV2,
      work: (
        snapshot: ProductPublicationConfigurationReferenceSourceSnapshotV2,
        tx: PriceQuoteQueryTransaction,
      ) => Promise<T>,
    ): Promise<T> {
      let calls = 0,
        transaction: PriceQuoteQueryTransaction | undefined,
        completed: { readonly value: T } | undefined,
        poisoned = false,
        finalCheck: (() => void) | undefined;
      const poison = (): never => {
        poisoned = true;
        if (transaction) failed.add(transaction);
        return fail();
      };
      try {
        const request = parsePricingProductPublicationReferenceRequestV2(input);
        if (
          typeof work !== "function" ||
          request.tenantReference !== tenant ||
          request.brandReference !== brand ||
          request.actorReference !== actor ||
          request.actorKind !== kind
        )
          return poison();
        const result = await run(async (tx) => {
          if (++calls !== 1 || !tx || typeof tx !== "object" || typeof tx.query !== "function")
            return poison();
          transaction = tx;
          if (active.has(tx) || failed.has(tx)) return poison();
          active.add(tx);
          const originalQuery = tx.query,
            queryPort = originalQuery.bind(tx);
          let latest = request.observedAt,
            ready = false,
            guardCalls = 0,
            source: ProductPublicationConfigurationReferenceSourceSnapshotV2 | undefined,
            originalGeneration: string | null | undefined;
          const check = () => {
            let at: string;
            try {
              at = parseEffectivePeriodInstant(now());
            } catch {
              return poison();
            }
            if (
              poisoned ||
              failed.has(tx) ||
              tx.query !== originalQuery ||
              at < latest ||
              at >= request.validUntil
            )
              return poison();
            latest = at;
            return at;
          };
          const assertFinal = () => {
            if (!ready || !source) return poison();
            check();
          };
          finalCheck = assertFinal;
          const query: PriceQuoteQueryTransaction["query"] = async (sql, values) => {
            check();
            const result = await queryPort(sql, values);
            check();
            return result;
          };
          const authorize = async () => {
            const observedAt = check();
            if (
              (await hold(
                tx,
                Object.freeze({
                  tenantReference: tenant,
                  actorKind: kind,
                  request,
                  purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
                  requiredScope: "FullBrandScope",
                  requiredPermissions: Object.freeze([
                    "pricing.price-book.manage",
                    "pricing.promotion.manage",
                  ] as const),
                  requiredFields: productPublicationConfigurationReferenceSourceFieldsV2,
                  observedAt,
                }),
              )) !== undefined
            )
              return poison();
            check();
          };
          const context = () =>
            query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('statement_timeout','60000',true)",
              [tenant, brand],
            );
          const head = async () => {
            await context();
            const row = publicationRow(
              await query(
                `SELECT g.generation::text generation,
       EXISTS(SELECT 1 FROM rms_pricing.price_book WHERE brand_id=$1) OR EXISTS(SELECT 1 FROM rms_pricing.option_price_rule WHERE brand_id=$1) OR EXISTS(SELECT 1 FROM rms_pricing.promotion WHERE brand_id=$1) has_source
       FROM (SELECT generation FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1 UNION ALL SELECT NULL::bigint WHERE NOT EXISTS(SELECT 1 FROM rms_pricing.configuration_reference_generation WHERE brand_id=$1)) g`,
                [brand],
              ),
              ["generation", "has_source"],
            );
            if (typeof row.has_source !== "boolean" || (row.generation === null && row.has_source))
              return poison();
            if (
              row.generation !== null &&
              (typeof row.generation !== "string" ||
                !/^(0|[1-9][0-9]{0,18})$/.test(row.generation) ||
                BigInt(row.generation) > 9223372036854775807n)
            )
              return poison();
            return row.generation as string | null;
          };
          const verifyGeneration = async () => {
            if (originalGeneration === undefined || (await head()) !== originalGeneration)
              return poison();
          };
          try {
            if (
              (await register(
                tx,
                async () => {
                  try {
                    if (++guardCalls !== 1) return poison();
                    assertFinal();
                    await authorize();
                    await verifyGeneration();
                    assertFinal();
                  } catch (error) {
                    failed.add(tx);
                    poisoned = true;
                    throw error;
                  }
                },
                assertFinal,
              )) !== undefined
            )
              return poison();
            check();
            await authorize();
            if (
              publicationRow(
                await query("SELECT current_setting('transaction_isolation') isolation", []),
                ["isolation"],
              ).isolation !== "read committed"
            )
              return poison();
            await context();
            await query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
              "PricingConfigurationReferenceV1:" + brand,
            ]);
            originalGeneration = await head();
            const bound = {
              tenantReference: tenant,
              brandReference: brand,
              actorReference: actor,
              actorKind: kind,
              clock: { now },
              transactions: {
                run: <R>(action: (actual: PriceQuoteQueryTransaction) => Promise<R>) => action(tx),
              },
              registerBeforeCommit: register,
            };
            const priceBooks = await createPostgresProductPublicationPriceBookReferenceSourceV2({
              ...bound,
              authority: priceBookAuthority,
            }).loadSnapshot(request);
            check();
            const optionPrices = await createPostgresProductPublicationOptionPriceReferenceSourceV2(
              { ...bound, authority: optionPriceAuthority },
            ).loadSnapshot(request);
            check();
            const promotions = await createPostgresProductPublicationPromotionReferenceSourceV2({
              ...bound,
              authority: promotionAuthority,
            }).loadSnapshot(request);
            check();
            // A virgin generation is valid only when actual source graphs are all empty.
            if (
              originalGeneration === null &&
              (priceBooks.references.length ||
                optionPrices.roots.length ||
                optionPrices.versions.length ||
                promotions.roots.length ||
                promotions.versions.length)
            )
              return poison();
            source = buildProductPublicationConfigurationReferenceSourceSnapshotV2(
              { generation: originalGeneration ?? "0", priceBooks, optionPrices, promotions },
              request,
              check(),
            );
            await authorize();
            const value = await work(source, tx);
            check();
            await authorize();
            await verifyGeneration();
            check();
            ready = true;
            completed = Object.freeze({ value });
            return completed;
          } catch (error) {
            failed.add(tx);
            poisoned = true;
            throw error;
          } finally {
            active.delete(tx);
          }
        });
        if (
          poisoned ||
          calls !== 1 ||
          !completed ||
          result !== completed ||
          !transaction ||
          failed.has(transaction) ||
          !finalCheck
        )
          return poison();
        finalCheck();
        return completed.value;
      } catch {
        if (transaction) failed.add(transaction);
        return fail();
      }
    },
  });
}
