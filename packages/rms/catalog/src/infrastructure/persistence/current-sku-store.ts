import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogDecimal,
  parseCatalogInstant,
  parseProductLifecycle,
} from "../../contracts/product.js";
import type { AvailabilityQueryTransactionRunner } from "./availability-query-store.js";

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid SKU source");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("invalid SKU source");
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) throw new Error("invalid SKU source");
    result[field] = d.value;
  }
  return result;
}
const select = `SELECT jsonb_build_object(
  'brandReference',s.brand_id,'sellableReference',s.sku_id,
  'productReference',s.product_id,'productVersionReference',s.product_version_id,
  'productLifecycle',p.lifecycle,'skuLifecycle',s.lifecycle,
  'productAggregateVersion',p.aggregate_version,
  'unitOfSale',s.unit_of_sale,'unitQuantity',s.unit_quantity::text,
  'taxClassificationReference',v.tax_classification_id,
  'productUpdatedAt',to_char(p.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'observedAt',to_char($4::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS sku
FROM rms_catalog.sku s
JOIN rms_catalog.product p ON p.product_id = s.product_id AND p.brand_id = s.brand_id
JOIN rms_catalog.product_version v
 ON v.product_version_id = s.product_version_id AND v.product_id = s.product_id AND v.brand_id = s.brand_id
WHERE s.brand_id = $1 AND s.sku_id = $2 AND s.product_version_id = $3
 AND p.created_at <= $4::timestamptz AND p.updated_at <= $4::timestamptz
 AND v.created_at <= $4::timestamptz AND v.updated_at <= $4::timestamptz
 AND s.created_at <= $4::timestamptz
 AND date_trunc('milliseconds',p.updated_at) = p.updated_at`;

/** Brand-owned SKU facts. Store applicability, publication and final Inventory remain separate. */
export function createPostgresCurrentSkuStore(
  runner: AvailabilityQueryTransactionRunner,
  scope: Readonly<{ brandReference: string }>,
) {
  const brand = parseCatalogReference(closed(scope, ["brandReference"]).brandReference);
  return Object.freeze({
    async load(value: {
      readonly sellableReference: string;
      readonly productVersionReference: string;
      readonly observedAt: string;
    }) {
      try {
        const raw = closed(value, ["sellableReference", "productVersionReference", "observedAt"]);
        const sku = parseCatalogReference(raw.sellableReference);
        const version = parseCatalogReference(raw.productVersionReference);
        const observedAt = parseCatalogInstant(raw.observedAt);
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await transaction.query(select, [brand, sku, version, observedAt]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 1) throw new Error("ambiguous SKU");
          if (rows.length === 0) return null;
          const r = closed(closed(rows[0], ["sku"]).sku, [
            "brandReference",
            "sellableReference",
            "productReference",
            "productVersionReference",
            "productLifecycle",
            "skuLifecycle",
            "productAggregateVersion",
            "unitOfSale",
            "unitQuantity",
            "taxClassificationReference",
            "productUpdatedAt",
            "observedAt",
          ]);
          const productLifecycle = parseProductLifecycle(r.productLifecycle);
          const skuLifecycle = parseProductLifecycle(r.skuLifecycle);
          const parsed = Object.freeze({
            brandReference: parseCatalogReference(r.brandReference),
            sellableReference: parseCatalogReference(r.sellableReference),
            productReference: parseCatalogReference(r.productReference),
            productVersionReference: parseCatalogReference(r.productVersionReference),
            productLifecycle,
            skuLifecycle,
            productAggregateVersion: r.productAggregateVersion as number,
            catalogEligible: productLifecycle === "Active" && skuLifecycle === "Active",
            unitOfSale: parseCatalogCode(r.unitOfSale),
            unitQuantity: parseCatalogDecimal(r.unitQuantity),
            taxClassificationReference:
              r.taxClassificationReference === null
                ? null
                : parseCatalogReference(r.taxClassificationReference),
            productUpdatedAt: parseCatalogInstant(r.productUpdatedAt),
            observedAt: parseCatalogInstant(r.observedAt),
          });
          if (
            parsed.brandReference !== brand ||
            parsed.sellableReference !== sku ||
            parsed.productVersionReference !== version ||
            parsed.observedAt !== observedAt ||
            parsed.productUpdatedAt > observedAt ||
            !Number.isSafeInteger(parsed.productAggregateVersion) ||
            parsed.productAggregateVersion < 1
          )
            throw new Error("incoherent SKU");
          return parsed;
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
