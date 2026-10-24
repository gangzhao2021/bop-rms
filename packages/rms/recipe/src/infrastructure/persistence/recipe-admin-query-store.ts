import { RecipeWorkflowError } from "../../application/recipe-service.js";
import { parseRecipeCode, parseRecipeDigest, parseRecipeReference } from "../../domain/recipe.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";

function fail(): never {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  if (Reflect.ownKeys(value).length !== keys.length) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function instant(value: unknown): string {
  if (typeof value !== "string" || new Date(value).toISOString() !== value) return fail();
  return value;
}
function text(value: unknown, maximum?: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    (maximum !== undefined && value.length > maximum)
  )
    return fail();
  return value;
}
function natural(value: unknown): string {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value)) return fail();
  return value;
}
function choice<T extends string>(value: unknown, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) return fail();
  return value as T;
}
const metadataKeys = [
  "generationReference",
  "brandReference",
  "projectionVersion",
  "sourceEventSequence",
  "builtAt",
  "checkpointVersion",
  "checkpointSequence",
  "checkpointUpdatedAt",
  "item",
] as const;
const itemKeys = [
  "generationReference",
  "brandReference",
  "recipeReference",
  "versionReference",
  "stableCode",
  "displayName",
  "lifecycle",
  "yieldSummary",
  "costMinor",
  "allergenStatus",
  "usageSummary",
  "mappingMissing",
  "costChanged",
  "aggregateVersion",
  "snapshotDigest",
  "effectiveFrom",
  "projectedAt",
] as const;
function decodeItem(value: unknown, brand: string, generation: string, reference: string) {
  const row = object(value, itemKeys);
  if (
    row.brandReference !== brand ||
    row.generationReference !== generation ||
    row.recipeReference !== reference ||
    typeof row.mappingMissing !== "boolean" ||
    typeof row.costChanged !== "boolean" ||
    !Number.isSafeInteger(row.aggregateVersion) ||
    (row.aggregateVersion as number) < 1
  )
    return fail();
  return Object.freeze({
    recipeReference: parseRecipeReference(row.recipeReference),
    versionReference: parseRecipeReference(row.versionReference),
    stableCode: parseRecipeCode(row.stableCode),
    displayName: text(row.displayName, 120),
    lifecycle: choice(row.lifecycle, ["Draft", "Published", "Invalidated", "Archived"]),
    yieldSummary: text(row.yieldSummary),
    costMinor: natural(row.costMinor),
    allergenStatus: choice(row.allergenStatus, ["Verified", "Unverified", "MissingEvidence"]),
    usageSummary: text(row.usageSummary),
    mappingMissing: row.mappingMissing,
    costChanged: row.costChanged,
    aggregateVersion: row.aggregateVersion as number,
    snapshotDigest: parseRecipeDigest(row.snapshotDigest),
    effectiveFrom: instant(row.effectiveFrom),
    projectedAt: instant(row.projectedAt),
  });
}

const select = `SELECT
  g.generation_id AS "generationReference", g.brand_id AS "brandReference",
  g.projection_version AS "projectionVersion", g.source_event_sequence::text AS "sourceEventSequence",
  to_char(g.built_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "builtAt",
  c.projection_version AS "checkpointVersion", c.source_event_sequence::text AS "checkpointSequence",
  to_char(c.updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "checkpointUpdatedAt",
  CASE WHEN p.recipe_id IS NULL THEN NULL ELSE jsonb_build_object(
    'generationReference',p.generation_id,'brandReference',p.brand_id,
    'recipeReference',p.recipe_id,'versionReference',p.recipe_version_id,'stableCode',p.stable_code,
    'displayName',p.display_name,'lifecycle',p.lifecycle,'yieldSummary',p.yield_summary,
    'costMinor',trunc(p.cost_minor)::text,'allergenStatus',p.allergen_status,'usageSummary',p.usage_summary,
    'mappingMissing',p.mapping_missing,'costChanged',p.cost_changed,'aggregateVersion',p.aggregate_version,
    'snapshotDigest',p.snapshot_digest,
    'effectiveFrom',to_char(p.effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'projectedAt',to_char(p.projected_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ) END AS item
FROM rms_recipe.recipe_admin_projection_checkpoint c
LEFT JOIN rms_recipe.recipe_admin_projection_generation g
  ON g.generation_id=c.active_generation_id AND g.brand_id=c.brand_id
LEFT JOIN rms_recipe.recipe_admin_projection p
  ON p.generation_id=g.generation_id AND p.brand_id=g.brand_id AND p.recipe_id=$2
WHERE c.brand_id=$1`;

/** Internal owner read: authorize the caller and scope before invoking; no freshness or permission grant. */
export function createPostgresRecipeAdminQueryStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
) {
  const brand = parseRecipeReference(brandInput);
  return Object.freeze({
    async load(reference: string) {
      try {
        const id = parseRecipeReference(reference);
        return await runner.run(async (tx) => {
          await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brand]);
          // One statement observes checkpoint, generation and row in the same database snapshot.
          const result = await tx.query(select, [brand, id]);
          if (result === null || typeof result !== "object") return fail();
          const descriptor = Object.getOwnPropertyDescriptor(result, "rows");
          if (
            !descriptor ||
            !("value" in descriptor) ||
            !Array.isArray(descriptor.value) ||
            descriptor.value.length > 1
          )
            return fail();
          if (descriptor.value.length === 0) return null;
          const first = Object.getOwnPropertyDescriptor(descriptor.value, "0");
          if (!first?.enumerable || !("value" in first)) return fail();
          const row = object(first.value, metadataKeys);
          const generation = parseRecipeReference(row.generationReference);
          const sequence = natural(row.sourceEventSequence);
          if (
            row.brandReference !== brand ||
            row.projectionVersion !== 1 ||
            row.checkpointVersion !== 1 ||
            sequence !== row.checkpointSequence ||
            BigInt(sequence) > 9223372036854775807n
          )
            return fail();
          return Object.freeze({
            brandReference: brand,
            generationReference: generation,
            projectionVersion: 1 as const,
            sourceEventSequence: sequence,
            builtAt: instant(row.builtAt),
            checkpointUpdatedAt: instant(row.checkpointUpdatedAt),
            item: row.item === null ? null : decodeItem(row.item, brand, generation, id),
          });
        });
      } catch {
        return fail();
      }
    },
  });
}
