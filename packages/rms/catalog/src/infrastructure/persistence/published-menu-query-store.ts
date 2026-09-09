import type { CatalogSelectionDisplayPorts } from "../../application/selection-display-query-service.js";
import type { CustomerMenuQueryPorts } from "../../application/ports/customer-menu-query-ports.js";
import { CatalogError, parseCatalogReference } from "../../contracts/product.js";
import {
  parsePublishedMenuProjection,
  type PublishedMenuProjection,
} from "../../contracts/published-menu-projection.js";

export interface PublishedMenuQueryTransaction {
  query(sql: string, values: readonly unknown[]): Promise<unknown>;
}

export interface PublishedMenuQueryTransactionRunner {
  // Own a dedicated read-only transaction/connection; clear local context before releasing it.
  run<T>(action: (transaction: PublishedMenuQueryTransaction) => Promise<T>): Promise<T>;
}

const select = `SELECT CASE WHEN
  g.source_aggregate_version = c.source_aggregate_version AND
  g.source_event_id = c.source_event_id AND g.source_checkpoint = c.source_event_id
  THEN jsonb_build_object(
    'projectionName', g.projection_name, 'projectionVersion', g.projection_version,
    'generationReference', g.generation_id, 'sourceEventReference', g.source_event_id,
    'sourceAggregateVersion', g.source_aggregate_version, 'sourceCheckpoint', g.source_checkpoint,
    'lastRebuiltAt', to_char(g.last_rebuilt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'freshnessStatus', g.freshness_status,
    'snapshot', jsonb_build_object(
      'brandReference', p.brand_id, 'menuReference', p.menu_id,
      'menuVersionReference', p.menu_version_id, 'releaseReference', p.release_id,
      'snapshotDigest', p.snapshot_digest, 'defaultLocale', p.default_locale,
      'localizedNames', p.localized_names_json, 'storeReferences', p.store_ids_json,
      'channelCodes', p.channel_codes_json, 'orderTypeCodes', p.order_type_codes_json,
      'timeZone', p.time_zone,
      'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveUntil', to_char(p.effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sections', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'sectionReference', s.section_id, 'internalCode', s.internal_code,
        'localizedNames', s.localized_names_json, 'sortOrder', s.sort_order,
        'sellables', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'placementReference', v.placement_id, 'sellableReference', v.sellable_id,
          'productVersionReference', v.product_version_id, 'localizedNames', v.localized_names_json,
          'presentationRole', v.presentation_role, 'sortOrder', v.sort_order, 'pinned', v.pinned,
          'configuredAvailability', v.configured_availability,
          'optionRules', v.option_rules_json, 'allergenDisclosure', v.allergen_disclosure_json
        ) ORDER BY v.sort_order, v.placement_id)
        FROM rms_catalog.published_menu_projection_sellable v
        WHERE v.generation_id = s.generation_id AND v.section_id = s.section_id
          AND v.menu_id = s.menu_id AND v.brand_id = $1), '[]'::jsonb)
      ) ORDER BY s.sort_order, s.section_id)
      FROM rms_catalog.published_menu_projection_section s
      WHERE s.generation_id = p.generation_id AND s.menu_id = p.menu_id
        AND s.brand_id = $1), '[]'::jsonb)
    )
  ) ELSE NULL END AS projection
FROM rms_catalog.published_menu_projection_checkpoint c
LEFT JOIN rms_catalog.published_menu_projection_generation g
  ON g.generation_id = c.active_generation_id AND g.menu_id = c.menu_id
    AND g.brand_id = c.brand_id AND g.generation_status = 'Active'
LEFT JOIN rms_catalog.published_menu_projection p
  ON p.generation_id = g.generation_id AND p.menu_id = g.menu_id AND p.brand_id = g.brand_id
WHERE c.consumer_name = 'catalog.published-menu-projection' AND c.brand_id = $1
  AND (p.store_ids_json IS NULL OR p.store_ids_json = '[]'::jsonb
    OR p.store_ids_json @> jsonb_build_array($2::text))
ORDER BY c.menu_id`;

const selectVersion = `SELECT jsonb_build_object(
    'projectionName', g.projection_name, 'projectionVersion', g.projection_version,
    'generationReference', g.generation_id, 'sourceEventReference', g.source_event_id,
    'sourceAggregateVersion', g.source_aggregate_version, 'sourceCheckpoint', g.source_checkpoint,
    'lastRebuiltAt', to_char(g.last_rebuilt_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'freshnessStatus', g.freshness_status,
    'snapshot', jsonb_build_object(
      'brandReference', p.brand_id, 'menuReference', p.menu_id,
      'menuVersionReference', p.menu_version_id, 'releaseReference', p.release_id,
      'snapshotDigest', p.snapshot_digest, 'defaultLocale', p.default_locale,
      'localizedNames', p.localized_names_json, 'storeReferences', p.store_ids_json,
      'channelCodes', p.channel_codes_json, 'orderTypeCodes', p.order_type_codes_json,
      'timeZone', p.time_zone,
      'effectiveFrom', to_char(p.effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'effectiveUntil', to_char(p.effective_until AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'sections', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'sectionReference', s.section_id, 'internalCode', s.internal_code,
        'localizedNames', s.localized_names_json, 'sortOrder', s.sort_order,
        'sellables', COALESCE((SELECT jsonb_agg(jsonb_build_object(
          'placementReference', v.placement_id, 'sellableReference', v.sellable_id,
          'productVersionReference', v.product_version_id, 'localizedNames', v.localized_names_json,
          'presentationRole', v.presentation_role, 'sortOrder', v.sort_order, 'pinned', v.pinned,
          'configuredAvailability', v.configured_availability,
          'optionRules', v.option_rules_json, 'allergenDisclosure', v.allergen_disclosure_json
        ) ORDER BY v.sort_order, v.placement_id)
        FROM rms_catalog.published_menu_projection_sellable v
        WHERE v.generation_id = s.generation_id AND v.section_id = s.section_id
          AND v.menu_id = s.menu_id AND v.brand_id = $1), '[]'::jsonb)
      ) ORDER BY s.sort_order, s.section_id)
      FROM rms_catalog.published_menu_projection_section s
      WHERE s.generation_id = p.generation_id AND s.menu_id = p.menu_id
        AND s.brand_id = $1), '[]'::jsonb)
    )
  ) AS projection
FROM rms_catalog.published_menu_projection_generation g
JOIN rms_catalog.published_menu_projection p
  ON p.generation_id = g.generation_id AND p.menu_id = g.menu_id AND p.brand_id = g.brand_id
WHERE g.brand_id = $1 AND p.menu_version_id = $3
  AND g.generation_status IN ('Active', 'Retired') AND g.source_checkpoint = g.source_event_id
  AND p.store_ids_json @> jsonb_build_array($2::text)
ORDER BY g.generation_id`;

export function createPostgresPublishedMenuQueryStore(
  runner: PublishedMenuQueryTransactionRunner,
  scope: Readonly<{ brandReference: string; storeReference: string }>,
): CustomerMenuQueryPorts["projections"] & CatalogSelectionDisplayPorts {
  const brand = parseCatalogReference(scope.brandReference);
  const store = parseCatalogReference(scope.storeReference);
  return Object.freeze({
    async loadVersionCandidates(
      input: Parameters<CatalogSelectionDisplayPorts["loadVersionCandidates"]>[0],
    ) {
      try {
        if (
          parseCatalogReference(input.brandReference) !== brand ||
          parseCatalogReference(input.storeReference) !== store
        )
          throw new Error("scope mismatch");
        const menuVersion = parseCatalogReference(input.menuVersionReference);
        return await runner.run(async (transaction) => {
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await transaction.query(selectVersion, [brand, store, menuVersion]);
          if (
            result === null ||
            typeof result !== "object" ||
            !("rows" in result) ||
            !Array.isArray(result.rows)
          )
            throw new Error("invalid result");
          const candidates = result.rows.map((row: { projection?: unknown } | null) => {
            const projection = parsePublishedMenuProjection(
              row?.projection as PublishedMenuProjection,
            );
            if (
              projection.snapshot.brandReference !== brand ||
              projection.snapshot.menuVersionReference !== menuVersion ||
              !projection.snapshot.storeReferences.includes(store) ||
              projection.sourceCheckpoint !== projection.sourceEventReference
            )
              throw new Error("invalid snapshot");
            return projection;
          });
          if (
            new Set(candidates.map((item) => item.generationReference)).size !== candidates.length
          )
            throw new Error("ambiguous generation");
          return Object.freeze(candidates);
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
    async loadCandidates(
      input: Parameters<CustomerMenuQueryPorts["projections"]["loadCandidates"]>[0],
    ) {
      try {
        if (
          parseCatalogReference(input.brandReference) !== brand ||
          parseCatalogReference(input.storeReference) !== store
        )
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        return await runner.run(async (transaction) => {
          // Projection RLS is Brand-only; Store applicability is filtered in the read below.
          await transaction.query(
            "SELECT set_config('bop.brand_id', $1, true), set_config('bop.store_id', $2, true)",
            [brand, ""],
          );
          const result = await transaction.query(select, [brand, store]);
          if (result === null || typeof result !== "object" || !("rows" in result))
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          if (!Array.isArray(result.rows)) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          const candidates = result.rows.map((row: { projection?: unknown } | null) => {
            const projection = parsePublishedMenuProjection(
              row?.projection as PublishedMenuProjection,
            );
            if (
              projection.snapshot.brandReference !== brand ||
              (projection.snapshot.storeReferences.length > 0 &&
                !projection.snapshot.storeReferences.includes(store))
            )
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            return projection;
          });
          if (
            new Set(candidates.map((item) => item.snapshot.menuReference)).size !==
            candidates.length
          )
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          return Object.freeze(candidates);
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}
