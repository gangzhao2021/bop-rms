import {
  CatalogError,
  parseCatalogReference,
  parseCatalogInstant,
} from "../../contracts/product.js";
import type { AvailabilityQueryTransactionRunner } from "./availability-query-store.js";

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid menu placement source");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("invalid menu placement source");
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) throw new Error("invalid menu placement source");
    result[field] = d.value;
  }
  return result;
}
const select = `SELECT jsonb_build_object(
 'brandReference',s.brand_id,'sellableReference',s.sku_id,
 'productVersionReference',s.product_version_id,'menuReference',m.menu_id,
 'menuVersionReference',v.menu_version_id,
 'presentationRoles',(SELECT jsonb_agg(DISTINCT p.presentation_role ORDER BY p.presentation_role)
   FROM rms_catalog.sellable_placement p
   JOIN rms_catalog.menu_section section ON section.menu_section_id=p.menu_section_id
    AND section.menu_id=p.menu_id AND section.brand_id=p.brand_id
   WHERE p.brand_id=s.brand_id AND p.sku_id=s.sku_id AND p.menu_id=m.menu_id
    AND section.menu_version_id=v.menu_version_id AND p.created_at <= $5::timestamptz),
 'observedAt',to_char($5::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) AS placement
FROM rms_catalog.sku s
JOIN rms_catalog.menu m ON m.brand_id=s.brand_id AND m.menu_id=$2
JOIN rms_catalog.menu_version v ON v.menu_id=m.menu_id AND v.brand_id=m.brand_id AND v.menu_version_id=$3
WHERE s.brand_id=$1 AND s.sku_id=$4 AND s.created_at <= $5::timestamptz
 AND m.created_at <= $5::timestamptz AND m.updated_at <= $5::timestamptz
 AND v.created_at <= $5::timestamptz AND v.updated_at <= $5::timestamptz`;

/** Structural membership only. Publication, Store applicability and sale safety are separate. */
export function createPostgresCurrentMenuPlacementStore(
  runner: AvailabilityQueryTransactionRunner,
  scope: Readonly<{ brandReference: string }>,
) {
  const brand = parseCatalogReference(closed(scope, ["brandReference"]).brandReference);
  return Object.freeze({
    async load(value: {
      readonly menuReference: string;
      readonly menuVersionReference: string;
      readonly sellableReference: string;
      readonly observedAt: string;
    }) {
      try {
        const raw = closed(value, [
          "menuReference",
          "menuVersionReference",
          "sellableReference",
          "observedAt",
        ]);
        const menu = parseCatalogReference(raw.menuReference);
        const version = parseCatalogReference(raw.menuVersionReference);
        const sku = parseCatalogReference(raw.sellableReference);
        const at = parseCatalogInstant(raw.observedAt);
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await transaction.query(select, [brand, menu, version, sku, at]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 1) throw new Error("ambiguous placement");
          if (rows.length === 0) return null;
          const r = closed(closed(rows[0], ["placement"]).placement, [
            "brandReference",
            "sellableReference",
            "productVersionReference",
            "menuReference",
            "menuVersionReference",
            "presentationRoles",
            "observedAt",
          ]);
          if (r.presentationRoles === null) return null;
          const roles = r.presentationRoles;
          if (
            !Array.isArray(roles) ||
            roles.length === 0 ||
            roles.length > 5 ||
            roles.some(
              (role) =>
                !["Standard", "Featured", "Promotional", "Sponsored", "Hidden"].includes(role),
            ) ||
            new Set(roles).size !== roles.length
          )
            throw new Error("invalid presentation roles");
          const parsed = Object.freeze({
            brandReference: parseCatalogReference(r.brandReference),
            sellableReference: parseCatalogReference(r.sellableReference),
            productVersionReference: parseCatalogReference(r.productVersionReference),
            menuReference: parseCatalogReference(r.menuReference),
            menuVersionReference: parseCatalogReference(r.menuVersionReference),
            presentationRoles: Object.freeze(roles as string[]),
            observedAt: parseCatalogInstant(r.observedAt),
          });
          if (
            parsed.brandReference !== brand ||
            parsed.sellableReference !== sku ||
            parsed.menuReference !== menu ||
            parsed.menuVersionReference !== version ||
            parsed.observedAt !== at
          )
            throw new Error("incoherent placement");
          return parsed;
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
