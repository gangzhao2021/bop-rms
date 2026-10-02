import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { parseRecipeReference } from "../../domain/recipe.js";
import { buildRecipeProjectionCore } from "../../application/recipe-projection-core.js";
import { RecipeProjectionGraphError } from "../../application/recipe-projection-graph-error.js";
import {
  assertRecipeCoverageUnchanged,
  parseRecipeCoverageSnapshot,
  RecipeCoverageError,
} from "../../application/recipe-source-coverage.js";
import { RecipeCoveragePublicationError } from "../../application/recipe-coverage-publication-error.js";
import {
  createPostgresRecipeCoveragePublicationStore,
  type RecipeCoveragePublicationInput,
  type RecipeCoveragePublicationFence,
} from "./recipe-coverage-publication-store.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";
import type {
  RecipeProjectionGraphFacts,
  RecipeOwnerCoverageRead,
} from "./recipe-owner-coverage-source.js";
export interface RecipeCorePublicationFactsSource {
  capture(request: unknown): Promise<RecipeOwnerCoverageRead>;
  /** Must hold restricted source facts through callback/COMMIT, under the separate field lease. */
  withCurrentFacts<T>(
    request: unknown,
    captured: unknown,
    work: (facts: RecipeProjectionGraphFacts) => Promise<T>,
  ): Promise<T>;
}
/** Mandatory public capability: hold actual field-purpose authority through publication COMMIT. */
export interface RecipeCorePublicationAuthorization {
  withAuthorizedFactsScope<T>(
    input: {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly actorReference: string;
      readonly purpose: "RecipeProjectionBuild";
      readonly access: "ProjectionFacts";
    },
    work: () => Promise<T>,
  ): Promise<T>;
}
export interface RecipeCorePublicationResult {
  readonly generationReference: string;
  readonly publicationRevision: string;
  readonly projectionVersion: 2;
  readonly coreDigest: string;
  readonly rowCount: number;
  readonly active: boolean;
  readonly replay: boolean;
}
const fail = (
  code: RecipeCoveragePublicationError["code"] = "RECIPE_PUBLICATION_UNAVAILABLE",
): never => {
  throw new RecipeCoveragePublicationError(code);
};
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
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function rows(value: unknown, max: number): readonly unknown[] {
  if (value === null || typeof value !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(value, "rows"),
    items = d && "value" in d ? d.value : undefined;
  if (
    !Array.isArray(items) ||
    Object.getPrototypeOf(items) !== Array.prototype ||
    items.length > max ||
    Reflect.ownKeys(items).length !== items.length + 1
  )
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = Object.getOwnPropertyDescriptor(items, String(i));
    if (!entry?.enumerable || !("value" in entry)) return fail();
    result.push(entry.value);
  }
  return result;
}
/** Guard driver JSON descriptors before canonical serialization reads nested array indexes. */
function storedJson(value: unknown): unknown {
  let remaining = 8_000_000;
  function copy(item: unknown, depth = 0): unknown {
    if (--remaining < 0 || depth > 32) return fail();
    if (item === null || typeof item === "boolean") return item;
    if (typeof item === "string") {
      if (item.length > 4096) return fail();
      return item;
    }
    if (typeof item === "number") {
      if (!Number.isFinite(item)) return fail();
      return item;
    }
    if (Array.isArray(item))
      return rows({ rows: item }, 524288).map((child) => copy(child, depth + 1));
    if (typeof item !== "object" || Object.getPrototypeOf(item) !== Object.prototype) return fail();
    const keys = Reflect.ownKeys(item);
    if (
      keys.length > 2048 ||
      keys.some(
        (key) => typeof key !== "string" || ["__proto__", "prototype", "constructor"].includes(key),
      )
    )
      return fail();
    const raw = object(item, keys as string[]),
      result: Record<string, unknown> = {};
    for (const key of keys as string[]) result[key] = copy(raw[key], depth + 1);
    return result;
  }
  return copy(value);
}
function one(
  value: unknown,
  keys: readonly string[],
  nullable = false,
): Record<string, unknown> | null {
  const items = rows(value, 1);
  if (!items.length) return nullable ? null : fail();
  return object(items[0], keys);
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
function input(value: unknown, tenant: string, brand: string): RecipeCoveragePublicationInput {
  try {
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
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(row.builtAt) ||
      new Date(row.builtAt).toISOString() !== row.builtAt
    )
      return fail();
    const expectedRevision = revision(row.expectedRevision),
      coverage = parseRecipeCoverageSnapshot(row.coverage);
    if (
      expectedRevision === "9223372036854775807" ||
      coverage.tenantReference !== tenant ||
      coverage.brandReference !== brand
    )
      return fail();
    return Object.freeze({
      generationReference: parseRecipeReference(row.generationReference),
      actorReference: parseRecipeReference(row.actorReference),
      purpose: row.purpose,
      expectedRevision,
      builtAt: row.builtAt,
      coverage,
    });
  } catch {
    return fail("RECIPE_PUBLICATION_INPUT_INVALID");
  }
}
/** Publishes internal configuration rows only. Current presentation/safety and Merchant authorization
 * are separate query contracts. This never consumes client-provided core rows. */
export function createPostgresRecipeCorePublicationStore(
  runner: RecipeTransactionRunner,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  ports: {
    readonly coverage: RecipeCoveragePublicationFence;
    readonly facts: RecipeCorePublicationFactsSource;
    readonly authorization: RecipeCorePublicationAuthorization;
  },
) {
  const tenant = parseRecipeReference(scope.tenantReference),
    brand = parseRecipeReference(scope.brandReference);
  return Object.freeze({
    async publish(value: unknown): Promise<RecipeCorePublicationResult> {
      const parsed = input(value, tenant, brand),
        request = Object.freeze({
          actorReference: parsed.actorReference,
          purpose: parsed.purpose,
          observedAtUtc: parsed.builtAt,
        });
      let knownFailure:
        | RecipeCoveragePublicationError
        | RecipeCoverageError
        | RecipeProjectionGraphError
        | undefined;
      const preserve = (error: unknown) => {
        if (
          error instanceof RecipeCoveragePublicationError ||
          error instanceof RecipeCoverageError ||
          error instanceof RecipeProjectionGraphError
        )
          knownFailure = error;
      };
      let coverageCalls = 0,
        authorityCalls = 0,
        factsCalls = 0;
      try {
        const result = await ports.coverage.withAuthorizedCurrentCoverage(
          parsed,
          async (current) => {
            if (++coverageCalls !== 1) return fail();
            try {
              assertRecipeCoverageUnchanged(parsed.coverage, current);
              return await ports.authorization.withAuthorizedFactsScope(
                Object.freeze({
                  tenantReference: tenant,
                  brandReference: brand,
                  actorReference: parsed.actorReference,
                  purpose: parsed.purpose,
                  access: "ProjectionFacts",
                }),
                async () => {
                  if (++authorityCalls !== 1) return fail();
                  try {
                    const captured = await ports.facts.capture(request);
                    return await ports.facts.withCurrentFacts(request, captured, async (facts) => {
                      if (++factsCalls !== 1) return fail();
                      try {
                        const core = buildRecipeProjectionCore(facts),
                          recipeSource = core.graph.source;
                        if (recipeSource.asOfUtc !== parsed.builtAt) return fail();
                        assertRecipeCoverageUnchanged(parsed.coverage, {
                          ...parsed.coverage,
                          sources: parsed.coverage.sources.map((source) =>
                            source.family === "Recipe" ? recipeSource.coverage : source,
                          ),
                        });
                        const coreDigest = `sha256:${createHash("sha256").update(canonicalizeRfc8785(core)).digest("hex")}`;
                        return await runner.run(async (tx) => {
                          await tx.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED", []);
                          await tx.query(
                            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
                            [tenant, brand],
                          );
                          await tx.query(
                            "INSERT INTO rms_recipe.recipe_admin_core_checkpoint(tenant_id,brand_id,publication_revision,active_generation_id) VALUES($1,$2,0,NULL) ON CONFLICT(tenant_id,brand_id) DO NOTHING",
                            [tenant, brand],
                          );
                          const head = one(
                            await tx.query(
                              "SELECT publication_revision::text AS revision,active_generation_id AS generation FROM rms_recipe.recipe_admin_core_checkpoint WHERE tenant_id=$1 AND brand_id=$2 FOR UPDATE",
                              [tenant, brand],
                            ),
                            ["revision", "generation"],
                          );
                          if (!head) return fail();
                          const headRevision = revision(head.revision),
                            active =
                              head.generation === null
                                ? null
                                : parseRecipeReference(head.generation);
                          if ((headRevision === "0") !== (active === null)) return fail();
                          const existing = one(
                            await tx.query(
                              "SELECT publication_revision::text AS revision,core_digest AS digest,row_count AS count,graph_json AS graph FROM rms_recipe.recipe_admin_core_generation WHERE generation_id=$1 AND tenant_id=$2 AND brand_id=$3",
                              [parsed.generationReference, tenant, brand],
                            ),
                            ["revision", "digest", "count", "graph"],
                            true,
                          );
                          // Same transaction; the outer source/field leases already hold current through COMMIT.
                          const publisher = createPostgresRecipeCoveragePublicationStore(
                            { run: async (work) => work(tx) },
                            { tenantReference: tenant, brandReference: brand },
                            {
                              withAuthorizedCurrentCoverage: async (_input, work) => work(current),
                            },
                          );
                          const published = await publisher.publish(parsed);
                          if (existing) {
                            if (
                              !published.replay ||
                              existing.revision !== published.publicationRevision ||
                              BigInt(revision(existing.revision)) > BigInt(headRevision) ||
                              existing.digest !== coreDigest ||
                              existing.count !== core.rows.length ||
                              canonicalizeRfc8785(storedJson(existing.graph)) !==
                                canonicalizeRfc8785(core.graph)
                            )
                              return fail("RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT");
                          } else {
                            if (published.replay)
                              return fail("RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT");
                            if (BigInt(headRevision) > BigInt(parsed.expectedRevision))
                              return fail("RECIPE_PUBLICATION_VERSION_CONFLICT");
                            await tx.query(
                              "INSERT INTO rms_recipe.recipe_admin_core_generation(generation_id,tenant_id,brand_id,publication_revision,projection_version,core_digest,row_count,graph_json) VALUES($1,$2,$3,$4,2,$5,$6,$7::jsonb)",
                              [
                                parsed.generationReference,
                                tenant,
                                brand,
                                published.publicationRevision,
                                coreDigest,
                                core.rows.length,
                                JSON.stringify(core.graph),
                              ],
                            );
                            await tx.query(
                              `INSERT INTO rms_recipe.recipe_admin_core_row(generation_id,tenant_id,brand_id,publication_revision,recipe_id,recipe_version_id,snapshot_digest,row_json)
                          SELECT $1,$2,$3,$4,(r->>'recipeReference')::uuid,(r->>'versionReference')::uuid,r->>'snapshotDigest',r FROM jsonb_array_elements($5::jsonb) r`,
                              [
                                parsed.generationReference,
                                tenant,
                                brand,
                                published.publicationRevision,
                                JSON.stringify(core.rows),
                              ],
                            );
                          }
                          const persistedRows = rows(
                            await tx.query(
                              "SELECT row_json AS record FROM rms_recipe.recipe_admin_core_row WHERE generation_id=$1 AND tenant_id=$2 AND brand_id=$3 ORDER BY recipe_id",
                              [parsed.generationReference, tenant, brand],
                            ),
                            2048,
                          ).map((item) => object(item, ["record"]).record);
                          if (
                            canonicalizeRfc8785(storedJson(persistedRows)) !==
                            canonicalizeRfc8785(core.rows)
                          )
                            return fail("RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT");
                          if (!existing) {
                            const switched = one(
                              await tx.query(
                                "UPDATE rms_recipe.recipe_admin_core_checkpoint SET publication_revision=$3,active_generation_id=$4 WHERE tenant_id=$1 AND brand_id=$2 AND publication_revision=$5 RETURNING publication_revision::text AS revision,active_generation_id AS generation",
                                [
                                  tenant,
                                  brand,
                                  published.publicationRevision,
                                  parsed.generationReference,
                                  headRevision,
                                ],
                              ),
                              ["revision", "generation"],
                            );
                            if (
                              !switched ||
                              switched.revision !== published.publicationRevision ||
                              switched.generation !== parsed.generationReference
                            )
                              return fail();
                          }
                          return Object.freeze({
                            generationReference: parsed.generationReference,
                            publicationRevision: published.publicationRevision,
                            projectionVersion: 2 as const,
                            coreDigest,
                            rowCount: core.rows.length,
                            active: existing ? active === parsed.generationReference : true,
                            replay: published.replay,
                          });
                        });
                      } catch (error) {
                        preserve(error);
                        throw error;
                      }
                    });
                  } catch (error) {
                    preserve(error);
                    throw error;
                  }
                },
              );
            } catch (error) {
              preserve(error);
              throw error;
            }
          },
        );
        if (coverageCalls !== 1 || authorityCalls !== 1 || factsCalls !== 1) return fail();
        return result;
      } catch (error) {
        if (knownFailure) throw knownFailure;
        if (
          error instanceof RecipeCoveragePublicationError ||
          error instanceof RecipeCoverageError ||
          error instanceof RecipeProjectionGraphError
        )
          throw error;
        return fail();
      }
    },
  });
}
