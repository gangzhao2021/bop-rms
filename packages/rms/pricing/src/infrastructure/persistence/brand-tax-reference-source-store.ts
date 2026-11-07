import {
  createPostgresTenantStoreReferenceSource,
  type TenantStoreReferenceSourceOptions,
} from "@bop/tenant";
import { parseEffectivePeriodInstant } from "@bop/effective-period";
import { parsePricingReference } from "../../domain/money-tax-contract.js";
import {
  parsePriceBookReferenceSourceRequest,
  type PriceBookReferenceSourceRequest,
} from "../../contracts/price-book-reference-source.js";
import {
  BrandTaxReferenceSourceError,
  brandTaxReferenceSourceFields,
  buildBrandTaxReferenceSnapshot,
  maximumBrandTaxRootReferences,
  type BrandTaxReferenceSnapshot,
} from "../../contracts/brand-tax-reference-source.js";
import {
  createPostgresTaxConfigurationReferenceSourceStore,
  type TaxConfigurationReferenceSourceAuthority,
} from "./tax-configuration-reference-source-store.js";
import type {
  PriceQuoteQueryTransaction,
  PriceQuoteQueryTransactionRunner,
} from "./price-quote-query-store.js";
const fail = (): never => {
  throw new BrandTaxReferenceSourceError();
};
function rows(result: unknown, max: number): Record<string, unknown>[] {
  const d =
    result && typeof result === "object" ? Object.getOwnPropertyDescriptor(result, "rows") : null;
  if (!d || !("value" in d) || !Array.isArray(d.value) || d.value.length > max) return fail();
  return d.value as Record<string, unknown>[];
}
export interface BrandTaxReferenceSourceOptions {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly actorReference: string;
  readonly transactions: PriceQuoteQueryTransactionRunner;
  readonly tenantAuthority: TenantStoreReferenceSourceOptions["authority"];
  readonly taxAuthority: TaxConfigurationReferenceSourceAuthority;
  readonly brandAuthority: {
    /** Complete Brand Tax scope metadata/fields/purpose/Phase permission, held through caller COMMIT. */
    holdUntilTransactionCompletes(
      tx: PriceQuoteQueryTransaction,
      input: {
        tenantReference: string;
        request: PriceBookReferenceSourceRequest;
        permission: "pricing.tax-config.manage";
        observedAt: string;
        requiredScope: "Brand";
        requiredFields: typeof brandTaxReferenceSourceFields;
      },
    ): Promise<void>;
  };
  readonly clock: { now(): string };
}
/** The owning transaction and Tenant callback hold both source fences through
 * consumer work/COMMIT. Per-Store authority includes known empty Stores. */
export function createPostgresBrandTaxReferenceSourceStore(
  options: BrandTaxReferenceSourceOptions,
) {
  const tenant = parsePricingReference(options.tenantReference),
    brand = parsePricingReference(options.brandReference),
    actor = parsePricingReference(options.actorReference);
  return Object.freeze({
    async withCurrentSnapshot<T>(
      value: PriceBookReferenceSourceRequest,
      work: (snapshot: BrandTaxReferenceSnapshot) => Promise<T>,
    ): Promise<T> {
      try {
        const request = parsePriceBookReferenceSourceRequest(value);
        if (request.brandReference !== brand || request.actorReference !== actor) return fail();
        let tx: PriceQuoteQueryTransaction | undefined,
          calls = 0;
        const inventory = createPostgresTenantStoreReferenceSource({
          brandReference: brand,
          authority: options.tenantAuthority,
          transactions: {
            run: (action) =>
              options.transactions.run(async (bound) => {
                if (++calls !== 1) return fail();
                tx = bound;
                return action(bound);
              }),
          },
        });
        return await inventory.withCurrentSnapshot(
          {
            brandReference: brand,
            actorReference: actor,
            purposeCode: request.purposeCode,
            originalIntentDigest: request.catalogIntentDigest,
            observedAt: options.clock.now(),
          },
          async (roster) => {
            const bound = tx;
            if (!bound) return fail();
            const authorize = () =>
              options.brandAuthority.holdUntilTransactionCompletes(bound, {
                tenantReference: tenant,
                request,
                permission: "pricing.tax-config.manage",
                observedAt: options.clock.now(),
                requiredScope: "Brand",
                requiredFields: brandTaxReferenceSourceFields,
              });
            const scope = async () => {
              await bound.query(
                "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)",
                [brand],
              );
            };
            await authorize();
            await scope();
            await bound.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))", [
              "PricingTaxReferenceV1:" + brand,
            ]);
            const head = async () => {
              await scope();
              const result = rows(
                await bound.query(
                  "SELECT generation::text,reference_count::text FROM rms_pricing.tax_reference_generation WHERE brand_id=$1",
                  [brand],
                ),
                1,
              );
              return result[0] ?? { generation: "0", reference_count: "0" };
            };
            const selected = await head();
            const rootScope = rows(
              await bound.query(
                `SELECT tax_configuration_id AS "configurationReference",store_id AS "storeReference",present,aggregate_version::text AS "aggregateVersion",current_version_id AS "currentVersionReference" FROM rms_pricing.tax_reference_scope WHERE brand_id=$1 ORDER BY store_id,tax_configuration_id LIMIT $2`,
                [brand, maximumBrandTaxRootReferences + 1],
              ),
              maximumBrandTaxRootReferences,
            );
            const registered = new Set(roster.references.map((s) => s.storeReference));
            if (rootScope.some((r) => !registered.has(r.storeReference as string))) return fail();
            const stores = [];
            for (const store of roster.references) {
              const source = createPostgresTaxConfigurationReferenceSourceStore({
                tenantReference: tenant,
                brandReference: brand,
                actorReference: actor,
                storeReference: store.storeReference,
                clock: options.clock,
                authority: options.taxAuthority,
                transactions: { run: (action) => action(bound) },
              });
              stores.push(
                await source.loadSnapshot({ ...request, storeReference: store.storeReference }),
              );
            }
            const snapshot = buildBrandTaxReferenceSnapshot(
              {
                storeInventory: roster,
                generation: selected.generation,
                referenceCount: selected.reference_count,
                rootScope,
                stores,
              },
              request,
              options.clock.now(),
            );
            await authorize();
            await scope();
            const result = await work(snapshot);
            await authorize();
            const final = await head();
            if (
              final.generation !== selected.generation ||
              final.reference_count !== selected.reference_count
            )
              return fail();
            const finishedAt = parseEffectivePeriodInstant(options.clock.now());
            if (
              finishedAt < snapshot.observedAt ||
              Date.parse(finishedAt) - Date.parse(snapshot.observedAt) > 5000
            )
              return fail();
            return result;
          },
        );
      } catch {
        return fail();
      }
    },
  });
}
