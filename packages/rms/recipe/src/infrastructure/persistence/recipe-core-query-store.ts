import { parseRecipeReference } from "../../domain/recipe.js";
import {
  decodeRecipeCoreGeneration,
  RecipeCoreQueryError,
  coreQueryRecord,
  coreQueryList,
  coreQueryInstant,
} from "../../application/recipe-core-query.js";
import {
  assertRecipeCoverageUnchanged,
  parseRecipeCoverageSnapshot,
  RecipeCoverageError,
} from "../../application/recipe-source-coverage.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";
export interface RecipeCoreQueryRequest {
  readonly actorReference: string;
  readonly purpose: "RecipeProjectionRead";
  readonly observedAtUtc: string;
}
export interface RecipeCoreQueryScopeRequest extends RecipeCoreQueryRequest {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly access: "ProjectionCore";
}
/** Hold actual read/field/scope/phase authority through callback/result COMMIT; no Build permission grant. */
export interface RecipeCoreQueryAuthorization {
  withAuthorizedCoreScope<T>(
    input: RecipeCoreQueryScopeRequest,
    work: () => Promise<T>,
  ): Promise<T>;
}
/** Public read-purpose capability. null means explicitly unconfirmed; failures are not empty facts. */
export interface RecipeCoreQueryCoverage {
  withCurrentCoverage<T>(
    input: RecipeCoreQueryScopeRequest,
    work: (current: unknown | null) => Promise<T>,
  ): Promise<T>;
}
const fail = (code: RecipeCoreQueryError["code"] = "RECIPE_CORE_QUERY_UNAVAILABLE"): never => {
  throw new RecipeCoreQueryError(code);
};
const select = `SELECT c.active_generation_id AS "generationReference",c.tenant_id AS "tenantReference",c.brand_id AS "brandReference",
  c.publication_revision::text AS revision,g.projection_version AS "projectionVersion",g.core_digest AS "coreDigest",
  g.row_count AS "rowCount",g.graph_json AS graph,s.record_json AS "sourceRecord",
  COALESCE((SELECT jsonb_agg(r.row_json ORDER BY r.recipe_id) FROM
    (SELECT recipe_id,row_json FROM rms_recipe.recipe_admin_core_row WHERE generation_id=c.active_generation_id AND tenant_id=c.tenant_id AND brand_id=c.brand_id ORDER BY recipe_id LIMIT 2049) r),'[]'::jsonb) AS rows
  FROM rms_recipe.recipe_admin_core_checkpoint c
  LEFT JOIN rms_recipe.recipe_admin_core_generation g ON g.generation_id=c.active_generation_id AND g.tenant_id=c.tenant_id AND g.brand_id=c.brand_id AND g.publication_revision=c.publication_revision
  LEFT JOIN rms_recipe.recipe_admin_source_generation s ON s.generation_id=g.generation_id AND s.tenant_id=g.tenant_id AND s.brand_id=g.brand_id AND s.publication_revision=g.publication_revision
  WHERE c.tenant_id=$1 AND c.brand_id=$2 AND c.active_generation_id IS NOT NULL`;
/** Internal configuration query. Output is not a Merchant DTO or current safety/effectiveness assertion. */
export function createPostgresRecipeCoreQueryStore(
  runner: RecipeTransactionRunner,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  ports: {
    readonly authorization: RecipeCoreQueryAuthorization;
    readonly coverage: RecipeCoreQueryCoverage;
  },
) {
  const tenant = parseRecipeReference(scope.tenantReference),
    brand = parseRecipeReference(scope.brandReference);
  return Object.freeze({
    async load(value: unknown) {
      let request: RecipeCoreQueryScopeRequest;
      try {
        const raw = coreQueryRecord(value, ["actorReference", "purpose", "observedAtUtc"]);
        if (raw.purpose !== "RecipeProjectionRead") return fail();
        request = Object.freeze({
          actorReference: parseRecipeReference(raw.actorReference),
          purpose: raw.purpose,
          observedAtUtc: coreQueryInstant(raw.observedAtUtc),
          tenantReference: tenant,
          brandReference: brand,
          access: "ProjectionCore",
        });
      } catch {
        return fail("RECIPE_CORE_QUERY_INPUT_INVALID");
      }
      let authorityCalls = 0,
        coverageCalls = 0,
        knownFailure: RecipeCoreQueryError | undefined;
      try {
        const result = await ports.authorization.withAuthorizedCoreScope(request, async () => {
          if (++authorityCalls !== 1) return fail();
          try {
            return await ports.coverage.withCurrentCoverage(request, async (current) => {
              if (++coverageCalls !== 1) return fail();
              try {
                const currentCoverage =
                  current === null ? null : parseRecipeCoverageSnapshot(current);
                if (
                  currentCoverage &&
                  (currentCoverage.tenantReference !== tenant ||
                    currentCoverage.brandReference !== brand)
                )
                  return fail();
                return await runner.run(async (tx) => {
                  await tx.query(
                    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
                    [tenant, brand],
                  );
                  const rawResult = await tx.query(select, [tenant, brand]);
                  if (rawResult === null || typeof rawResult !== "object") return fail();
                  const d = Object.getOwnPropertyDescriptor(rawResult, "rows");
                  if (!d || !("value" in d)) return fail();
                  const rows = coreQueryList(d.value, 1);
                  if (!rows.length) return null;
                  const generation = decodeRecipeCoreGeneration(rows[0], {
                    tenantReference: tenant,
                    brandReference: brand,
                  });
                  if (generation.builtAt > request.observedAtUtc) return fail();
                  let sourceCoverageStatus: "Current" | "Changed" | "Incomplete" | "Unconfirmed" =
                    currentCoverage ? "Current" : "Unconfirmed";
                  if (currentCoverage) {
                    // Incomplete status cannot conceal a known identity/digest contradiction.
                    for (const old of generation.coverage.sources) {
                      const next = currentCoverage.sources.find(
                        (source) => source.family === old.family,
                      );
                      if (!next) return fail();
                      if (
                        old.snapshotReference === next.snapshotReference &&
                        (old.digest !== next.digest ||
                          JSON.stringify(old.dependencies) !== JSON.stringify(next.dependencies))
                      )
                        return fail("RECIPE_CORE_QUERY_INTEGRITY_CONFLICT");
                      const versions = new Map(
                        next.dependencies.map((item) => [
                          `${item.objectReference}:${item.versionReference}`,
                          item.digest,
                        ]),
                      );
                      for (const item of old.dependencies) {
                        const digest = versions.get(
                          `${item.objectReference}:${item.versionReference}`,
                        );
                        if (digest !== undefined && digest !== item.digest)
                          return fail("RECIPE_CORE_QUERY_INTEGRITY_CONFLICT");
                      }
                    }
                    try {
                      assertRecipeCoverageUnchanged(generation.coverage, currentCoverage);
                    } catch (error) {
                      if (!(error instanceof RecipeCoverageError)) throw error;
                      if (error.code === "RECIPE_COVERAGE_INTEGRITY_CONFLICT")
                        return fail("RECIPE_CORE_QUERY_INTEGRITY_CONFLICT");
                      if (error.code === "RECIPE_COVERAGE_CHANGED")
                        sourceCoverageStatus = "Changed";
                      else if (error.code === "RECIPE_COVERAGE_INCOMPLETE")
                        sourceCoverageStatus = "Incomplete";
                      else return fail();
                    }
                  }
                  const freshness =
                    sourceCoverageStatus === "Current" &&
                    Date.parse(request.observedAtUtc) - Date.parse(generation.builtAt) <= 30000
                      ? "Fresh"
                      : "Stale";
                  return Object.freeze({
                    ...generation,
                    projectionVersion: 2 as const,
                    scope: Object.freeze({ tenantReference: tenant, brandReference: brand }),
                    asOfUtc: generation.builtAt,
                    observedAtUtc: request.observedAtUtc,
                    sourceCoverageStatus,
                    freshness,
                  });
                });
              } catch (error) {
                if (error instanceof RecipeCoreQueryError) knownFailure = error;
                throw error;
              }
            });
          } catch (error) {
            if (error instanceof RecipeCoreQueryError) knownFailure = error;
            throw error;
          }
        });
        if (authorityCalls !== 1 || coverageCalls !== 1) return fail();
        return result;
      } catch (error) {
        if (knownFailure) throw knownFailure;
        if (error instanceof RecipeCoreQueryError) throw error;
        return fail();
      }
    },
  });
}
