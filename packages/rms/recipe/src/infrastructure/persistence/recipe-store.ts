import {
  appendAuditRecordInTransaction,
  validateAuditRecord,
  canonicalizeRfc8785,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import { createRecipeSnapshot, parseRecipeReference } from "../../domain/recipe.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import type { RecipePorts } from "../../application/ports/recipe-ports.js";
import {
  createPostgresRecipeQueryStore,
  type RecipeTransactionRunner,
} from "./recipe-query-store.js";
import { insertRecipeVersion } from "./recipe-version-write.js";
function fail(code: RecipeWorkflowError["code"] = "RECIPE_DEPENDENCY_UNAVAILABLE"): never {
  throw new RecipeWorkflowError(code);
}
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (result === null || typeof result !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value)) return fail();
  return d.value;
}
export function createPostgresRecipeStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
  generateReference: () => string,
): RecipePorts["repository"] {
  const brand = parseRecipeReference(brandInput);
  const query = createPostgresRecipeQueryStore(runner, brand);
  async function write(
    input: Parameters<RecipePorts["repository"]["create"]>[0],
    expected: number | null,
  ) {
    try {
      return await runner.run(async (tx) => {
        await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brand]);
        const record = input.record,
          s = createRecipeSnapshot(record.aggregate);
        const audit = validateAuditRecord(input.audit, Date.parse(s.createdAt));
        if (
          s.brandReference !== brand ||
          audit.brandId !== brand ||
          audit.storeId !== undefined ||
          audit.actor.type === "System" ||
          audit.actor.reference !== record.actorReference ||
          audit.targetType !== "Recipe" ||
          audit.targetId !== s.recipeReference ||
          audit.actionCode !== "RECIPE_" + record.action.toUpperCase() ||
          audit.occurredAt !== s.createdAt
        )
          return fail();
        // Decode the complete candidate using the same record contract as durable recovery.
        const decoded = await createPostgresRecipeQueryStore(
          {
            run: async (work) =>
              work({
                query: async (sql) =>
                  sql.startsWith("SELECT set_config") ? { rows: [] } : { rows: [{ record }] },
              }),
          },
          brand,
        ).resolveOperation(record.operationReference);
        if (decoded === null) return fail();
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
          "RecipeOperation:" + brand + ":" + record.operationReference,
        ]);
        const bound = createPostgresRecipeQueryStore({ run: async (work) => work(tx) }, brand);
        const prior = await bound.resolveOperation(record.operationReference);
        if (prior !== null) {
          if (
            prior.operationIntentHash !== record.operationIntentHash ||
            canonicalizeRfc8785(prior) !== canonicalizeRfc8785(decoded)
          )
            return fail("RECIPE_IDEMPOTENCY_CONFLICT");
          return prior;
        }
        if (expected === null) {
          if (
            record.action !== "CreateDraft" ||
            s.lifecycle !== "Draft" ||
            s.aggregateVersion !== 1 ||
            s.versionNumber !== 1
          )
            return fail();
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "RecipeCode:" + brand + ":" + s.stableCode,
          ]);
          if (
            !(await bound.codeAvailable({
              brandReference: s.brandReference,
              stableCode: s.stableCode,
              excludingRecipeReference: null,
            }))
          )
            return fail("RECIPE_CODE_CONFLICT");
          await tx.query(
            "INSERT INTO rms_recipe.recipe (recipe_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,$3,1,$4,$5,$4)",
            [s.recipeReference, brand, s.stableCode, s.createdAt, audit.actor.reference],
          );
        } else {
          const locked = rows(
            await tx.query(
              "SELECT aggregate_version FROM rms_recipe.recipe WHERE brand_id=$1 AND recipe_id=$2 FOR UPDATE",
              [brand, s.recipeReference],
            ),
          );
          if (locked.length !== 1 || locked[0]?.aggregate_version !== expected)
            return fail("RECIPE_VERSION_CONFLICT");
          const current = await bound.load(s.recipeReference);
          if (
            current === null ||
            s.aggregateVersion !== expected + 1 ||
            s.versionNumber !== current.versionNumber + 1 ||
            s.stableCode !== current.stableCode ||
            s.createdAt < current.createdAt
          )
            return fail("RECIPE_VERSION_CONFLICT");
          const targets = {
            ReplaceDraft: "Draft",
            Publish: "Published",
            Invalidate: "Invalidated",
            Archive: "Archived",
          } as const;
          if (
            record.action === "CreateDraft" ||
            s.lifecycle !== targets[record.action] ||
            (["ReplaceDraft", "Publish"].includes(record.action) &&
              current.lifecycle !== "Draft") ||
            (record.action === "Invalidate" && current.lifecycle !== "Published") ||
            (record.action === "Archive" && current.lifecycle === "Archived")
          )
            return fail("RECIPE_LIFECYCLE_CONFLICT");
        }
        await insertRecipeVersion(tx, s, () => parseRecipeReference(generateReference()));
        for (const review of decoded.publicationEvidence?.reviews ?? []) {
          await tx.query(
            "INSERT INTO rms_recipe.recipe_review_record (review_id,recipe_version_id,recipe_id,brand_id,review_kind,reviewer_actor_id,evidence_digest,decision,reviewed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)",
            [
              review.reviewReference,
              s.versionReference,
              s.recipeReference,
              brand,
              review.reviewKind,
              review.reviewerActorReference,
              review.evidenceDigest,
              review.decision,
              review.reviewedAt,
            ],
          );
        }
        await tx.query(
          "UPDATE rms_recipe.recipe SET current_version_id=$1,aggregate_version=$2,updated_at=$3 WHERE brand_id=$4 AND recipe_id=$5",
          [s.versionReference, s.aggregateVersion, s.createdAt, brand, s.recipeReference],
        );
        await appendAuditRecordInTransaction(tx, audit);
        const eventId = parseRecipeReference(generateReference());
        await appendEventInTransaction(
          {
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (result === null || typeof result !== "object") return fail();
              const d = Object.getOwnPropertyDescriptor(result, "rowCount");
              if (!d || !("value" in d) || d.value !== 1) return fail();
              return { rowCount: 1 };
            },
          },
          {
            eventId,
            eventType: record.event.eventType,
            schemaVersion: 1,
            occurredAt: s.createdAt,
            producerModule: "@rms/recipe",
            tenantId: brand,
            aggregateType: "Recipe",
            aggregateId: s.recipeReference,
            aggregateVersion: BigInt(s.aggregateVersion),
            correlationId: audit.correlationId,
            causationId: record.operationReference,
            actor: { type: "Actor", actorId: audit.actor.reference },
            payload: { ...record.event },
            redactionClassification: "indirect_identifier",
            replayMetadata: { operationReference: record.operationReference },
          },
        );
        await tx.query(
          "INSERT INTO rms_recipe.recipe_operation_record (operation_id,recipe_id,brand_id,action_code,intent_digest,result_aggregate_version,result_version_id,outbox_event_id,occurred_at,record_json) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
          [
            record.operationReference,
            s.recipeReference,
            brand,
            record.action,
            record.operationIntentHash,
            s.aggregateVersion,
            s.versionReference,
            eventId,
            s.createdAt,
            JSON.stringify(decoded),
          ],
        );
        return decoded;
      });
    } catch (error) {
      if (error instanceof RecipeWorkflowError) throw error;
      return fail();
    }
  }
  return Object.freeze({
    ...query,
    create: (input) => write(input, null),
    commit: (input) => write(input, input.expectedAggregateVersion),
  });
}
