import { parsePublishingDigest } from "@bop/publishing";
import {
  CatalogError,
  parseCatalogReference,
  parseCatalogCode,
  parseCatalogInstant,
} from "../../contracts/product.js";
import type { AvailabilityQueryTransactionRunner } from "./availability-query-store.js";

function closed(value: unknown, fields: readonly string[]): Readonly<Record<string, unknown>> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    throw new Error("invalid release input");
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== fields.length ||
    keys.some((key) => typeof key !== "string" || !fields.includes(key))
  )
    throw new Error("invalid release input");
  const output: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) throw new Error("invalid release input");
    output[field] = d.value;
  }
  return output;
}
const select = `SELECT CASE WHEN
  v.state = 'Published' AND v.lifecycle_version = r.lifecycle_version
  AND v.menu_id = r.menu_id AND v.menu_version_id = r.menu_version_id
  AND v.brand_id = r.brand_id AND v.snapshot_digest = r.snapshot_digest
  AND v.changed_at <= r.created_at AND r.created_at <= $6::timestamptz
  AND p.created_at <= $6::timestamptz
  AND date_trunc('milliseconds',p.effective_from) = p.effective_from
  AND (p.effective_until IS NULL OR date_trunc('milliseconds',p.effective_until) = p.effective_until)
  AND date_trunc('milliseconds',r.created_at) = r.created_at
  AND EXISTS (SELECT 1 FROM rms_catalog.menu_version_store s
    WHERE s.brand_id = r.brand_id AND s.menu_id = r.menu_id
      AND s.menu_version_id = r.menu_version_id AND s.store_id = $2)
  AND EXISTS (SELECT 1 FROM rms_catalog.menu_version_channel c
    WHERE c.brand_id = r.brand_id AND c.menu_id = r.menu_id
      AND c.menu_version_id = r.menu_version_id AND c.channel_code = $4)
  AND EXISTS (SELECT 1 FROM rms_catalog.menu_version_order_type o
    WHERE o.brand_id = r.brand_id AND o.menu_id = r.menu_id
      AND o.menu_version_id = r.menu_version_id AND o.order_type_code = $5)
THEN jsonb_build_object(
  'brandReference',r.brand_id, 'storeReference',$2::text,
  'menuReference',r.menu_id, 'menuVersionReference',r.menu_version_id,
  'releaseReference',r.release_id, 'snapshotDigest',r.snapshot_digest,
  'lifecycleVersion',v.lifecycle_version, 'channelCode',$4::text,'orderTypeCode',$5::text,
  'releasedAt',to_char(r.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'effectiveFrom',to_char(p.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'effectiveUntil',to_char(p.effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'observedAt',to_char($6::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
) ELSE NULL END AS release
FROM rms_catalog.menu_release_effective_period p
JOIN rms_catalog.menu_publication_release r
 ON r.release_id = p.release_id AND r.menu_id = p.menu_id AND r.brand_id = p.brand_id
LEFT JOIN LATERAL (
 SELECT revision.* FROM rms_catalog.menu_publication_revision revision
 WHERE revision.lifecycle_id = r.lifecycle_id
 ORDER BY revision.lifecycle_version DESC LIMIT 1
) v ON true
WHERE p.brand_id = $1 AND p.menu_id = $3
  AND p.effective_from <= $6::timestamptz
  AND (p.effective_until IS NULL OR p.effective_until > $6::timestamptz)
  -- DEC-MENU-REVISION: a superseded release ends where its successor takes effect.
  AND NOT EXISTS (SELECT 1 FROM rms_catalog.menu_release_effective_end e
    WHERE e.release_id = p.release_id AND e.ended_at <= $6::timestamptz)`;

/** Current owner publication fact only; no sale, Inventory, price or allergen authorization. */
export function createPostgresCurrentMenuReleaseStore(
  runner: AvailabilityQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
) {
  const fixed = closed(scope, ["brandReference", "storeReference"]);
  const brand = parseCatalogReference(fixed.brandReference);
  const store = parseCatalogReference(fixed.storeReference);
  return Object.freeze({
    async load(value: {
      readonly menuReference: string;
      readonly channelCode: string;
      readonly orderTypeCode: string;
      readonly observedAt: string;
    }) {
      try {
        const raw = closed(value, ["menuReference", "channelCode", "orderTypeCode", "observedAt"]);
        const menu = parseCatalogReference(raw.menuReference);
        const channel = parseCatalogCode(raw.channelCode);
        const orderType = parseCatalogCode(raw.orderTypeCode);
        const observedAt = parseCatalogInstant(raw.observedAt);
        return await runner.run(async (transaction) => {
          // Brand-owned Catalog RLS; Store applicability is explicit in the same SELECT.
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await transaction.query(select, [
            brand,
            store,
            menu,
            channel,
            orderType,
            observedAt,
          ]);
          const rows = Object.getOwnPropertyDescriptor(result, "rows")?.value as unknown;
          if (!Array.isArray(rows) || rows.length > 1) throw new Error("ambiguous release");
          if (rows.length === 0) return null;
          const record = closed(rows[0], ["release"]).release;
          if (record === null) return null;
          const r = closed(record, [
            "brandReference",
            "storeReference",
            "menuReference",
            "menuVersionReference",
            "releaseReference",
            "snapshotDigest",
            "lifecycleVersion",
            "channelCode",
            "orderTypeCode",
            "releasedAt",
            "effectiveFrom",
            "effectiveUntil",
            "observedAt",
          ]);
          const parsed = Object.freeze({
            brandReference: parseCatalogReference(r.brandReference),
            storeReference: parseCatalogReference(r.storeReference),
            menuReference: parseCatalogReference(r.menuReference),
            menuVersionReference: parseCatalogReference(r.menuVersionReference),
            releaseReference: parseCatalogReference(r.releaseReference),
            snapshotDigest: parsePublishingDigest(r.snapshotDigest),
            lifecycleVersion: r.lifecycleVersion as number,
            channelCode: parseCatalogCode(r.channelCode),
            orderTypeCode: parseCatalogCode(r.orderTypeCode),
            releasedAt: parseCatalogInstant(r.releasedAt),
            effectiveFrom: parseCatalogInstant(r.effectiveFrom),
            effectiveUntil:
              r.effectiveUntil === null ? null : parseCatalogInstant(r.effectiveUntil),
            observedAt: parseCatalogInstant(r.observedAt),
          });
          if (
            parsed.brandReference !== brand ||
            parsed.storeReference !== store ||
            parsed.menuReference !== menu ||
            parsed.channelCode !== channel ||
            parsed.orderTypeCode !== orderType ||
            parsed.observedAt !== observedAt ||
            !Number.isSafeInteger(parsed.lifecycleVersion) ||
            parsed.lifecycleVersion < 1 ||
            parsed.releasedAt > observedAt ||
            parsed.effectiveFrom > observedAt ||
            (parsed.effectiveUntil !== null && parsed.effectiveUntil <= observedAt)
          )
            throw new Error("incoherent release");
          return parsed;
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
