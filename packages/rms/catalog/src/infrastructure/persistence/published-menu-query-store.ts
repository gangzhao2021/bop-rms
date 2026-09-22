import { createPostgresMenuReviewContentStore } from "./menu-review-content-store.js";
import {
  publishedMenuConsumerRegistration,
  createPublishedMenuProjectionService,
} from "../../application/published-menu-projection-service.js";
import { createPostgresCurrentMenuReleaseStore } from "./current-menu-release-store.js";
import { parseCatalogCode, parseCatalogInstant } from "../../contracts/product.js";
import { canonicalizeRfc8785 } from "@bop/audit";
import {
  validateDomainEventEnvelope,
  type ConsumerTransaction,
  type ConsumerRegistration,
  type DomainEventEnvelope,
} from "@bop/eventing";
import {
  buildPublishedMenuProjection,
  type MenuPublishedEnvelope,
  type PublishedMenuSnapshot,
} from "../../contracts/published-menu-projection.js";
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
        const channelCode = parseCatalogCode(input.channelCode);
        const orderTypeCode = parseCatalogCode(input.orderTypeCode);
        const observedAt = parseCatalogInstant(input.requestedAt);
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
          const releases = createPostgresCurrentMenuReleaseStore(
            { run: (work) => work(transaction) },
            { brandReference: brand, storeReference: store },
          );
          const current: PublishedMenuProjection[] = [];
          for (const candidate of candidates) {
            const snapshot = candidate.snapshot;
            if (
              !snapshot.channelCodes.includes(channelCode) ||
              !snapshot.orderTypeCodes.includes(orderTypeCode)
            )
              continue;
            const release = await releases.load({
              menuReference: snapshot.menuReference,
              channelCode,
              orderTypeCode,
              observedAt,
            });
            if (release === null) continue;
            if (
              release.menuVersionReference !== snapshot.menuVersionReference ||
              release.releaseReference !== snapshot.releaseReference ||
              release.snapshotDigest !== snapshot.snapshotDigest ||
              release.effectiveFrom !== snapshot.effectiveFrom ||
              release.effectiveUntil !== snapshot.effectiveUntil
            )
              throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
            current.push(candidate);
          }
          return Object.freeze(current);
        });
      } catch {
        throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      }
    },
  });
}

const selectCurrentMenu =
  select.slice(0, select.indexOf("\nWHERE c.consumer_name")) +
  "\nWHERE c.consumer_name='catalog.published-menu-projection' AND c.brand_id=$1 AND c.menu_id=$2";

/** Owner storage joined to the Eventing consumer transaction. Exact historical
 * publication verification is mandatory; caller owns commit/rollback and Inbox.
 */
export function createPostgresPublishedMenuProjectionStore(options: {
  transaction: ConsumerTransaction;
  brandReference: string;
  menuReference: string;
  verifyPublished(
    transaction: ConsumerTransaction,
    envelope: MenuPublishedEnvelope,
    snapshot: PublishedMenuSnapshot,
  ): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  const menu = parseCatalogReference(options.menuReference);
  const tx = options.transaction;
  const fail = (): never => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  };
  const context = () =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)", [
      brand,
    ]);
  const load = async (reference: string): Promise<PublishedMenuProjection | null> => {
    if (reference !== menu) return fail();
    await context();
    const result = await tx.query<{ projection: unknown }>(selectCurrentMenu, [brand, menu]);
    if (result.rows.length > 1) return fail();
    if (result.rows.length === 0) return null;
    const value = parsePublishedMenuProjection(
      result.rows[0]?.projection as PublishedMenuProjection,
    );
    if (value.snapshot.brandReference !== brand || value.snapshot.menuReference !== menu)
      return fail();
    return value;
  };
  return Object.freeze({
    load,
    async replace(input: {
      projection: PublishedMenuProjection;
      envelope: MenuPublishedEnvelope;
      transaction: ConsumerTransaction;
    }): Promise<PublishedMenuProjection> {
      if (input.transaction !== tx) return fail();
      const envelope = validateDomainEventEnvelope(input.envelope) as MenuPublishedEnvelope;
      const projection = parsePublishedMenuProjection(input.projection);
      const expected = buildPublishedMenuProjection({
        envelope,
        snapshot: projection.snapshot,
        generationReference: projection.generationReference,
        projectedAt: projection.lastRebuiltAt,
      });
      if (
        projection.snapshot.brandReference !== brand ||
        projection.snapshot.menuReference !== menu ||
        canonicalizeRfc8785(expected) !== canonicalizeRfc8785(projection) ||
        (await options.verifyPublished(tx, envelope, projection.snapshot)) !== true
      )
        return fail();
      await context();
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "catalog.published-menu:" + brand + ":" + menu,
      ]);
      const current = await load(menu);
      if (current && current.sourceAggregateVersion >= projection.sourceAggregateVersion) {
        if (
          current.sourceAggregateVersion === projection.sourceAggregateVersion &&
          (current.sourceEventReference !== projection.sourceEventReference ||
            canonicalizeRfc8785(current.snapshot) !== canonicalizeRfc8785(projection.snapshot))
        )
          return fail();
        if ((await options.verifyPublished(tx, envelope, projection.snapshot)) !== true)
          return fail();
        return current;
      }
      const snapshot = projection.snapshot;
      const generation = projection.generationReference;
      await tx.query(
        "INSERT INTO rms_catalog.published_menu_projection_generation (generation_id,brand_id,menu_id,projection_name,projection_version,generation_status,source_event_id,source_aggregate_version,source_checkpoint,last_rebuilt_at,freshness_status) VALUES($1,$2,$3,'catalog_published_menu_v1',1,'Building',$4,$5,$4,$6,'Fresh')",
        [
          generation,
          brand,
          menu,
          projection.sourceEventReference,
          projection.sourceAggregateVersion,
          projection.lastRebuiltAt,
        ],
      );
      await tx.query(
        "INSERT INTO rms_catalog.published_menu_projection (generation_id,brand_id,menu_id,menu_version_id,release_id,snapshot_digest,default_locale,localized_names_json,store_ids_json,channel_codes_json,order_type_codes_json,time_zone,effective_from,effective_until) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12,$13,$14)",
        [
          generation,
          brand,
          menu,
          snapshot.menuVersionReference,
          snapshot.releaseReference,
          snapshot.snapshotDigest,
          snapshot.defaultLocale,
          JSON.stringify(snapshot.localizedNames),
          JSON.stringify(snapshot.storeReferences),
          JSON.stringify(snapshot.channelCodes),
          JSON.stringify(snapshot.orderTypeCodes),
          snapshot.timeZone,
          snapshot.effectiveFrom,
          snapshot.effectiveUntil,
        ],
      );
      for (const section of snapshot.sections) {
        await tx.query(
          "INSERT INTO rms_catalog.published_menu_projection_section (generation_id,brand_id,menu_id,section_id,internal_code,localized_names_json,sort_order) VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)",
          [
            generation,
            brand,
            menu,
            section.sectionReference,
            section.internalCode,
            JSON.stringify(section.localizedNames),
            section.sortOrder,
          ],
        );
        for (const item of section.sellables)
          await tx.query(
            "INSERT INTO rms_catalog.published_menu_projection_sellable (generation_id,brand_id,menu_id,section_id,placement_id,sellable_id,product_version_id,localized_names_json,presentation_role,sort_order,pinned,configured_availability,option_rules_json,allergen_disclosure_json) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10,$11,$12,$13::jsonb,$14::jsonb)",
            [
              generation,
              brand,
              menu,
              section.sectionReference,
              item.placementReference,
              item.sellableReference,
              item.productVersionReference,
              JSON.stringify(item.localizedNames),
              item.presentationRole,
              item.sortOrder,
              item.pinned,
              item.configuredAvailability,
              JSON.stringify(item.optionRules),
              JSON.stringify(item.allergenDisclosure),
            ],
          );
      }
      await tx.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET generation_status='Retired' WHERE brand_id=$1 AND menu_id=$2 AND generation_status='Active'",
        [brand, menu],
      );
      await tx.query(
        "UPDATE rms_catalog.published_menu_projection_generation SET generation_status='Active' WHERE brand_id=$1 AND menu_id=$2 AND generation_id=$3 AND generation_status='Building'",
        [brand, menu, generation],
      );
      await tx.query(
        "INSERT INTO rms_catalog.published_menu_projection_checkpoint (consumer_name,brand_id,menu_id,active_generation_id,source_event_id,source_aggregate_version,projected_at) VALUES('catalog.published-menu-projection',$1,$2,$3,$4,$5,$6) ON CONFLICT (consumer_name,brand_id,menu_id) DO UPDATE SET active_generation_id=EXCLUDED.active_generation_id,source_event_id=EXCLUDED.source_event_id,source_aggregate_version=EXCLUDED.source_aggregate_version,projected_at=EXCLUDED.projected_at",
        [
          brand,
          menu,
          generation,
          projection.sourceEventReference,
          projection.sourceAggregateVersion,
          projection.lastRebuiltAt,
        ],
      );
      if ((await options.verifyPublished(tx, envelope, snapshot)) !== true) return fail();
      const saved = await load(menu);
      if (!saved || canonicalizeRfc8785(saved) !== canonicalizeRfc8785(projection)) return fail();
      return saved;
    },
  });
}

/** One owner/event-consumer transaction; caller commits only after consume succeeds.
 * Intended for a real dispatcher, not a background loop created by this factory.
 */
export function createPostgresPublishedMenuConsumer(options: {
  transaction: ConsumerTransaction;
  brandReference: string;
  menuReference: string;
  authorize: Parameters<typeof createPostgresMenuReviewContentStore>[0]["authorize"];
  generateGeneration(): string;
  now(): string;
}) {
  const brand = parseCatalogReference(options.brandReference);
  const menu = parseCatalogReference(options.menuReference);
  const tx = options.transaction;
  const content = createPostgresMenuReviewContentStore({
    brandReference: brand,
    menuReference: menu,
    authorize: options.authorize,
  });
  const exact = (event: MenuPublishedEnvelope) => ({
    brandReference: brand,
    menuReference: menu,
    menuVersionReference: parseCatalogReference(event.payload.menuVersionReference),
    releaseReference: parseCatalogReference(event.payload.releaseReference),
    snapshotDigest: event.payload.snapshotDigest,
  });
  const projections = createPostgresPublishedMenuProjectionStore({
    transaction: tx,
    brandReference: brand,
    menuReference: menu,
    verifyPublished: async (transaction, event, snapshot) =>
      canonicalizeRfc8785(await content.loadExact(transaction, exact(event))) ===
      canonicalizeRfc8785(snapshot),
  });
  const service = createPublishedMenuProjectionService({
    snapshots: { loadExact: (input) => content.loadExact(tx, input) },
    projections,
    references: {
      generateGeneration: options.generateGeneration,
      now: () => parseCatalogInstant(options.now()),
    },
  });
  async function prepare(input: MenuPublishedEnvelope) {
    const event = validateDomainEventEnvelope(input) as MenuPublishedEnvelope;
    if (
      event.tenantId !== brand ||
      event.aggregateId !== menu ||
      event.payload.menuReference !== menu ||
      event.eventType !== "MenuPublished" ||
      event.producerModule !== "@rms/catalog" ||
      event.schemaVersion !== 1 ||
      event.storeId !== undefined
    )
      throw new CatalogError("CATALOG_INPUT_INVALID");
    // Exact historical owner read also establishes Brand context before Inbox.
    if ((await content.loadExact(tx, exact(event))) === null)
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    return event;
  }
  const registration: ConsumerRegistration = Object.freeze({
    ...service.registration,
    async handler(input: Parameters<ConsumerRegistration["handler"]>[0]) {
      if (input.transaction !== tx) throw new CatalogError("CATALOG_INPUT_INVALID");
      await prepare(input.envelope as MenuPublishedEnvelope);
      return service.registration.handler(input);
    },
  });
  return Object.freeze({
    registration,
    async consume(input: MenuPublishedEnvelope) {
      return service.consume(tx, await prepare(input));
    },
  });
}

/** Brand-bound owner service accepted by the Worker runtime. The reviewed snapshot
 * authorizer must authorize the actual Menu; envelope identifiers grant no rights.
 */
export function createPostgresPublishedMenuConsumerService(
  options: Omit<
    Parameters<typeof createPostgresPublishedMenuConsumer>[0],
    "transaction" | "menuReference" | "authorize"
  > & {
    authorize(
      transaction: ConsumerTransaction,
      request: Readonly<{
        brandReference: string;
        menuReference: string;
        menuVersionReference: string;
        operation: "Read" | "Save";
      }>,
    ): Promise<boolean>;
  },
) {
  const brand = parseCatalogReference(options.brandReference);
  const owner = (transaction: ConsumerTransaction, envelope: DomainEventEnvelope) =>
    createPostgresPublishedMenuConsumer({
      ...options,
      brandReference: brand,
      transaction,
      menuReference: envelope.aggregateId,
      authorize: (_tx, operation, menuVersionReference) =>
        options.authorize(transaction, {
          brandReference: brand,
          menuReference: envelope.aggregateId,
          menuVersionReference,
          operation,
        }),
    });
  const registration: ConsumerRegistration = Object.freeze({
    ...publishedMenuConsumerRegistration,
    handler: (input: Parameters<ConsumerRegistration["handler"]>[0]) =>
      owner(input.transaction, input.envelope).registration.handler(input),
  });
  return Object.freeze({
    registration,
    consume: (transaction: ConsumerTransaction, envelope: DomainEventEnvelope) =>
      owner(transaction, envelope).consume(envelope as MenuPublishedEnvelope),
  });
}
