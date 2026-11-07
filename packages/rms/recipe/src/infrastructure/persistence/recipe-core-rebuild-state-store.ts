import { parseRecipeReference } from "../../domain/recipe.js";
import {
  coreQueryRecord,
  coreQueryList,
  coreQueryRevision,
  decodeRecipeCoreGeneration,
} from "../../application/recipe-core-query.js";
import {
  parseRecipeCoreRebuildRequest,
  parseRecipeCoreRebuildIntent,
  RecipeCoreRebuildError,
  type RecipeCoreRebuildRequest,
  type RecipeCoreRebuildState,
} from "../../application/recipe-core-rebuild.js";
import { RecipeCoveragePublicationError } from "../../application/recipe-coverage-publication-error.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";
export interface RecipeCoreRebuildStateAuthorization {
  withAuthorizedRebuildScope<T>(
    input: RecipeCoreRebuildRequest & {
      readonly tenantReference: string;
      readonly brandReference: string;
      readonly access: "ProjectionRebuildState";
    },
    work: () => Promise<T>,
  ): Promise<T>;
}
const fail = (): never => {
  throw new RecipeCoreRebuildError("RECIPE_REBUILD_UNAVAILABLE");
};
const select = `SELECT $1::uuid AS "tenantReference",$2::uuid AS "brandReference",
 COALESCE(s.publication_revision,0)::text AS "sourceRevision",s.active_generation_id AS "sourceGenerationReference",
 COALESCE(c.publication_revision,0)::text AS "coreRevision",c.active_generation_id AS "coreGenerationReference",
 CASE WHEN sg.generation_id IS NULL THEN NULL ELSE jsonb_build_object(
 'generationReference',sg.generation_id,'tenantReference',sg.tenant_id,'brandReference',sg.brand_id,
 'revision',sg.publication_revision::text,'projectionVersion',cg.projection_version,'coreDigest',cg.core_digest,
 'rowCount',cg.row_count,'graph',cg.graph_json,'sourceRecord',sg.record_json,
 'rows',COALESCE((SELECT jsonb_agg(r.row_json ORDER BY r.recipe_id) FROM
 (SELECT recipe_id,row_json FROM rms_recipe.recipe_admin_core_row WHERE generation_id=sg.generation_id AND tenant_id=$1 AND brand_id=$2 ORDER BY recipe_id LIMIT 2049) r),'[]'::jsonb)) END AS operation
 FROM (VALUES(1)) anchor(value)
 LEFT JOIN rms_recipe.recipe_admin_source_checkpoint s ON s.tenant_id=$1 AND s.brand_id=$2
 LEFT JOIN rms_recipe.recipe_admin_core_checkpoint c ON c.tenant_id=$1 AND c.brand_id=$2
 LEFT JOIN rms_recipe.recipe_admin_source_generation sg ON sg.generation_id=$3 AND sg.tenant_id=$1 AND sg.brand_id=$2
 LEFT JOIN rms_recipe.recipe_admin_core_generation cg ON cg.generation_id=sg.generation_id AND cg.tenant_id=sg.tenant_id AND cg.brand_id=sg.brand_id AND cg.publication_revision=sg.publication_revision`;
/** Build-purpose saved receipt lookup. It exposes no configuration rows or current freshness claim. */
export function createPostgresRecipeCoreRebuildStateStore(
  runner: RecipeTransactionRunner,
  scope: { readonly tenantReference: string; readonly brandReference: string },
  authorization: RecipeCoreRebuildStateAuthorization,
) {
  const tenant = parseRecipeReference(scope.tenantReference),
    brand = parseRecipeReference(scope.brandReference);
  return Object.freeze({
    async load(value: unknown): Promise<RecipeCoreRebuildState> {
      const request = parseRecipeCoreRebuildRequest(value);
      let calls = 0,
        knownFailure: RecipeCoreRebuildError | RecipeCoveragePublicationError | undefined;
      try {
        const result = await authorization.withAuthorizedRebuildScope(
          Object.freeze({
            ...request,
            tenantReference: tenant,
            brandReference: brand,
            access: "ProjectionRebuildState",
          }),
          async () => {
            if (++calls !== 1) return fail();
            try {
              return await runner.run(async (tx) => {
                await tx.query(
                  "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true),set_config('lock_timeout','5000',true),set_config('statement_timeout','60000',true)",
                  [tenant, brand],
                );
                const rawResult = await tx.query(select, [
                  tenant,
                  brand,
                  request.generationReference,
                ]);
                if (rawResult === null || typeof rawResult !== "object") return fail();
                const d = Object.getOwnPropertyDescriptor(rawResult, "rows");
                if (!d || !("value" in d)) return fail();
                const found = coreQueryList(d.value, 1);
                if (found.length !== 1) return fail();
                const raw = coreQueryRecord(found[0], [
                  "tenantReference",
                  "brandReference",
                  "sourceRevision",
                  "sourceGenerationReference",
                  "coreRevision",
                  "coreGenerationReference",
                  "operation",
                ]);
                if (raw.tenantReference !== tenant || raw.brandReference !== brand) return fail();
                const sourceRevision = coreQueryRevision(raw.sourceRevision),
                  coreRevision = coreQueryRevision(raw.coreRevision),
                  sourceGenerationReference =
                    raw.sourceGenerationReference === null
                      ? null
                      : parseRecipeReference(raw.sourceGenerationReference),
                  coreGenerationReference =
                    raw.coreGenerationReference === null
                      ? null
                      : parseRecipeReference(raw.coreGenerationReference);
                if (
                  (sourceRevision === "0") !== (sourceGenerationReference === null) ||
                  (coreRevision === "0") !== (coreGenerationReference === null) ||
                  BigInt(coreRevision) > BigInt(sourceRevision)
                )
                  return fail();
                let operation: RecipeCoreRebuildState["operation"] = null;
                if (raw.operation !== null) {
                  const op = coreQueryRecord(raw.operation, [
                      "generationReference",
                      "tenantReference",
                      "brandReference",
                      "revision",
                      "projectionVersion",
                      "coreDigest",
                      "rowCount",
                      "graph",
                      "sourceRecord",
                      "rows",
                    ]),
                    intent = parseRecipeCoreRebuildIntent(op.sourceRecord),
                    operationRevision = coreQueryRevision(op.revision);
                  if (
                    op.generationReference !== request.generationReference ||
                    op.tenantReference !== tenant ||
                    op.brandReference !== brand ||
                    intent.generationReference !== request.generationReference ||
                    intent.coverage.tenantReference !== tenant ||
                    intent.coverage.brandReference !== brand ||
                    intent.builtAt > request.observedAtUtc ||
                    BigInt(intent.expectedRevision) + 1n !== BigInt(operationRevision) ||
                    BigInt(operationRevision) > BigInt(sourceRevision)
                  )
                    return fail();
                  if (intent.actorReference !== request.actorReference)
                    throw new RecipeCoveragePublicationError(
                      "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
                    );
                  if (op.projectionVersion === null) {
                    if (
                      op.coreDigest !== null ||
                      op.rowCount !== null ||
                      op.graph !== null ||
                      coreQueryList(op.rows).length
                    )
                      return fail();
                    operation = Object.freeze({ intent, result: null });
                  } else {
                    const core = decodeRecipeCoreGeneration(op, {
                      tenantReference: tenant,
                      brandReference: brand,
                    });
                    if (
                      BigInt(core.publicationRevision) > BigInt(coreRevision) ||
                      (coreGenerationReference === core.generationReference &&
                        core.publicationRevision !== coreRevision)
                    )
                      return fail();
                    operation = Object.freeze({
                      intent,
                      result: Object.freeze({
                        generationReference: core.generationReference,
                        publicationRevision: core.publicationRevision,
                        projectionVersion: 2,
                        coreDigest: core.coreDigest,
                        rowCount: core.core.rows.length,
                        active: coreGenerationReference === core.generationReference,
                        replay: true,
                      }),
                    });
                  }
                }
                return Object.freeze({
                  tenantReference: tenant,
                  brandReference: brand,
                  sourceRevision,
                  sourceGenerationReference,
                  coreRevision,
                  coreGenerationReference,
                  operation,
                });
              });
            } catch (error) {
              if (
                error instanceof RecipeCoreRebuildError ||
                error instanceof RecipeCoveragePublicationError
              )
                knownFailure = error;
              throw error;
            }
          },
        );
        if (calls !== 1) return fail();
        return result;
      } catch (error) {
        if (knownFailure) throw knownFailure;
        if (
          error instanceof RecipeCoreRebuildError ||
          error instanceof RecipeCoveragePublicationError
        )
          throw error;
        return fail();
      }
    },
  });
}
