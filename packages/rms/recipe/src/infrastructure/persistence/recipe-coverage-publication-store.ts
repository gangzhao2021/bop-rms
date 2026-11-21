import { parseRecipeReference } from "../../domain/recipe.js";
import {
  assertRecipeCoverageUnchanged,
  parseRecipeCoverageSnapshot,
  RecipeCoverageError,
  type RecipeCoverageSnapshot,
} from "../../application/recipe-source-coverage.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";
import {
  RecipeCoveragePublicationError,
  type RecipeCoveragePublicationErrorCode,
} from "../../application/recipe-coverage-publication-error.js";
export {
  RecipeCoveragePublicationError,
  type RecipeCoveragePublicationErrorCode,
} from "../../application/recipe-coverage-publication-error.js";
export interface RecipeCoveragePublicationInput {
  readonly generationReference: string;
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionBuild";
  readonly expectedRevision: string;
  readonly builtAt: string;
  readonly coverage: RecipeCoverageSnapshot;
}
export interface RecipeCoveragePublicationResult {
  readonly generationReference: string;
  readonly publicationRevision: string;
  readonly active: boolean;
  readonly replay: boolean;
}
/** Implementations authorize exact scope/Actor/purpose and hold source versions through work's COMMIT.
 * Uncoordinated queries or client-provided facts cannot implement this port. */
export interface RecipeCoveragePublicationFence {
  withAuthorizedCurrentCoverage<T>(
    input: RecipeCoveragePublicationInput,
    work: (current: unknown) => Promise<T>,
  ): Promise<T>;
}
function fail(code: RecipeCoveragePublicationErrorCode = "RECIPE_PUBLICATION_UNAVAILABLE"): never {
  throw new RecipeCoveragePublicationError(code);
}
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function revision(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^(?:0|[1-9][0-9]{0,18})$/u.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    return fail();
  return value;
}
function parseInput(value: unknown): RecipeCoveragePublicationInput {
  const row = object(value, [
    "generationReference",
    "actorReference",
    "purpose",
    "expectedRevision",
    "builtAt",
    "coverage",
  ]);
  if (
    row.purpose !== "RecipeProjectionBuild" ||
    typeof row.builtAt !== "string" ||
    new Date(row.builtAt).toISOString() !== row.builtAt
  )
    return fail();
  if (revision(row.expectedRevision) === "9223372036854775807") return fail();
  return Object.freeze({
    generationReference: parseRecipeReference(row.generationReference),
    actorReference: parseRecipeReference(row.actorReference),
    purpose: row.purpose,
    expectedRevision: revision(row.expectedRevision),
    builtAt: row.builtAt,
    coverage: parseRecipeCoverageSnapshot(row.coverage),
  });
}
function one(
  value: unknown,
  keys: readonly string[],
  nullable = false,
): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return fail();
  const descriptor = Object.getOwnPropertyDescriptor(value, "rows");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !Array.isArray(descriptor.value) ||
    Object.getPrototypeOf(descriptor.value) !== Array.prototype ||
    descriptor.value.length > 1
  )
    return fail();
  if (descriptor.value.length === 0) return nullable ? null : fail();
  const item = Object.getOwnPropertyDescriptor(descriptor.value, "0");
  if (!item?.enumerable || !("value" in item)) return fail();
  return object(item.value, keys);
}
const selectHead = `SELECT publication_revision::text AS revision,active_generation_id AS generation FROM rms_recipe.recipe_admin_source_checkpoint WHERE tenant_id=$1 AND brand_id=$2 FOR UPDATE`;
const selectGeneration = `SELECT publication_revision::text AS revision,record_json AS record FROM rms_recipe.recipe_admin_source_generation WHERE generation_id=$1 AND tenant_id=$2 AND brand_id=$3`;
/** Internal builder storage. The required fence is not a substitute for real owner-feed composition. */
export function createPostgresRecipeCoveragePublicationStore(
  runner: RecipeTransactionRunner,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  fence: RecipeCoveragePublicationFence,
) {
  const tenant = parseRecipeReference(scope.tenantReference);
  const brand = parseRecipeReference(scope.brandReference);
  return Object.freeze({
    async publish(value: unknown): Promise<RecipeCoveragePublicationResult> {
      let input: RecipeCoveragePublicationInput;
      try {
        input = parseInput(value);
        if (input.coverage.tenantReference !== tenant || input.coverage.brandReference !== brand)
          return fail();
      } catch {
        return fail("RECIPE_PUBLICATION_INPUT_INVALID");
      }
      try {
        return await fence.withAuthorizedCurrentCoverage(input, async (current) => {
          assertRecipeCoverageUnchanged(input.coverage, current);
          return runner.run(async (tx) => {
            await tx.query(
              "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true)",
              [tenant, brand],
            );
            await tx.query(
              `INSERT INTO rms_recipe.recipe_admin_source_checkpoint(tenant_id,brand_id,publication_revision,active_generation_id) VALUES($1,$2,0,NULL) ON CONFLICT(tenant_id,brand_id) DO NOTHING`,
              [tenant, brand],
            );
            const head = one(await tx.query(selectHead, [tenant, brand]), [
              "revision",
              "generation",
            ]);
            if (!head) return fail();
            const headRevision = revision(head.revision);
            const active = head.generation === null ? null : parseRecipeReference(head.generation);
            if ((headRevision === "0") !== (active === null)) return fail();
            const existing = one(
              await tx.query(selectGeneration, [input.generationReference, tenant, brand]),
              ["revision", "record"],
              true,
            );
            if (existing) {
              const stored = parseInput(existing.record);
              if (JSON.stringify(stored) !== JSON.stringify(input))
                return fail("RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT");
              const storedRevision = revision(existing.revision);
              if (
                BigInt(storedRevision) !== BigInt(stored.expectedRevision) + 1n ||
                BigInt(storedRevision) > BigInt(headRevision)
              )
                return fail();
              return Object.freeze({
                generationReference: input.generationReference,
                publicationRevision: storedRevision,
                active: active === input.generationReference,
                replay: true,
              });
            }
            if (headRevision !== input.expectedRevision)
              return fail("RECIPE_PUBLICATION_VERSION_CONFLICT");
            const nextRevision = (BigInt(headRevision) + 1n).toString();
            await tx.query(
              `INSERT INTO rms_recipe.recipe_admin_source_generation(generation_id,tenant_id,brand_id,publication_revision,built_at,builder_actor_id,record_json) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
              [
                input.generationReference,
                tenant,
                brand,
                nextRevision,
                input.builtAt,
                input.actorReference,
                JSON.stringify(input),
              ],
            );
            const bindings = input.coverage.sources.flatMap((source) => [
              {
                family: source.family,
                kind: "Snapshot",
                object_id: null,
                version_id: source.snapshotReference,
                record: {
                  digest: source.digest,
                  complete: source.complete,
                  dependencies: source.dependencies,
                },
              },
              ...source.dependencies.map((item) => ({
                family: source.family,
                kind: "ObjectVersion",
                object_id: item.objectReference,
                version_id: item.versionReference,
                record: { digest: item.digest },
              })),
            ]);
            const encoded = JSON.stringify(bindings);
            await tx.query(
              `INSERT INTO rms_recipe.recipe_admin_source_binding(tenant_id,brand_id,source_family,binding_kind,object_id,version_id,binding_json,first_generation_id,first_publication_revision)
              SELECT $1::uuid,$2::uuid,i.family,i.kind,i.object_id,i.version_id,i.record,$4::uuid,$5::bigint
              FROM jsonb_to_recordset($3::jsonb) AS i(family text,kind text,object_id uuid,version_id uuid,record jsonb)
              WHERE NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_admin_source_binding b
                WHERE b.tenant_id=$1 AND b.brand_id=$2 AND b.source_family=i.family AND b.binding_kind=i.kind
                  AND b.object_id IS NOT DISTINCT FROM i.object_id AND b.version_id=i.version_id)`,
              [tenant, brand, encoded, input.generationReference, nextRevision],
            );
            const conflicts = one(
              await tx.query(
                `SELECT count(*)::text AS conflicts
              FROM jsonb_to_recordset($3::jsonb) AS i(family text,kind text,object_id uuid,version_id uuid,record jsonb)
              LEFT JOIN rms_recipe.recipe_admin_source_binding b ON b.tenant_id=$1 AND b.brand_id=$2
                AND b.source_family=i.family AND b.binding_kind=i.kind AND b.object_id IS NOT DISTINCT FROM i.object_id AND b.version_id=i.version_id
              WHERE b.binding_json IS DISTINCT FROM i.record`,
                [tenant, brand, encoded],
              ),
              ["conflicts"],
            );
            if (
              !conflicts ||
              typeof conflicts.conflicts !== "string" ||
              !/^(?:0|[1-9][0-9]{0,4})$/u.test(conflicts.conflicts)
            )
              return fail();
            if (conflicts.conflicts !== "0")
              throw new RecipeCoverageError("RECIPE_COVERAGE_INTEGRITY_CONFLICT");
            const switched = one(
              await tx.query(
                `UPDATE rms_recipe.recipe_admin_source_checkpoint SET publication_revision=$3,active_generation_id=$4 WHERE tenant_id=$1 AND brand_id=$2 AND publication_revision=$5 RETURNING publication_revision::text AS revision,active_generation_id AS generation`,
                [tenant, brand, nextRevision, input.generationReference, headRevision],
              ),
              ["revision", "generation"],
            );
            if (
              !switched ||
              switched.revision !== nextRevision ||
              switched.generation !== input.generationReference
            )
              return fail();
            return Object.freeze({
              generationReference: input.generationReference,
              publicationRevision: nextRevision,
              active: true,
              replay: false,
            });
          });
        });
      } catch (error) {
        if (error instanceof RecipeCoveragePublicationError || error instanceof RecipeCoverageError)
          throw error;
        return fail();
      }
    },
  });
}
