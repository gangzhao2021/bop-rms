import type { RecipeModifierWrite } from "../../application/ports/recipe-modifier-ports.js";
import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  validateAuditRecord,
} from "@bop/audit";
import { createRecipeSnapshot, parseRecipeReference } from "../../domain/recipe.js";
import { parseRecipeModifierRule } from "../../domain/recipe-modifier.js";
import { parseRecipeModifierPublicationEvidence } from "../../domain/publication-review.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import type { RecipeTransactionRunner } from "./recipe-query-store.js";

function fail(code: RecipeWorkflowError["code"] = "RECIPE_DEPENDENCY_UNAVAILABLE"): never {
  throw new RecipeWorkflowError(code);
}
function rows(result: unknown): readonly Record<string, unknown>[] {
  if (result === null || typeof result !== "object") return fail();
  const d = Object.getOwnPropertyDescriptor(result, "rows");
  if (!d || !("value" in d) || !Array.isArray(d.value)) return fail();
  return d.value;
}
function instant(value: string): string {
  if (!Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) return fail();
  return value;
}
/** Persistence only: caller must establish current command authorization and public source facts. */
export function createPostgresRecipeModifierWriteStore(
  runner: RecipeTransactionRunner,
  brandInput: string,
) {
  const brand = parseRecipeReference(brandInput);
  return Object.freeze({
    async append(
      input: RecipeModifierWrite,
      validateNewWrite: () => Promise<void> = async () => undefined,
    ) {
      try {
        const base = createRecipeSnapshot(input.base);
        const rule = parseRecipeModifierRule(input.rule, base);
        const actor = parseRecipeReference(input.actorReference);
        const operation = parseRecipeReference(input.operationReference);
        const occurredAt = instant(input.occurredAt),
          from = instant(input.effectiveFrom);
        const until = input.effectiveUntil === null ? null : instant(input.effectiveUntil);
        const audit = validateAuditRecord(input.audit, Date.parse(occurredAt));
        if (
          base.brandReference !== brand ||
          !Number.isSafeInteger(input.version) ||
          input.version < 1 ||
          !["Draft", "Published", "Invalidated", "Archived"].includes(input.lifecycle) ||
          (until !== null && until <= from) ||
          audit.brandId !== brand ||
          audit.storeId !== undefined ||
          audit.actor.type === "System" ||
          audit.actor.reference !== actor ||
          audit.targetType !== "RecipeModifier" ||
          audit.targetId !== rule.ruleReference ||
          audit.actionCode !== "RECIPE_MODIFIER_" + input.lifecycle.toUpperCase() ||
          audit.occurredAt !== occurredAt
        )
          return fail();
        const evidence =
          input.lifecycle === "Published"
            ? parseRecipeModifierPublicationEvidence(input.publicationEvidence, rule, occurredAt)
            : null;
        if (input.lifecycle !== "Published" && input.publicationEvidence !== null) return fail();
        const candidate = {
          rule,
          version: input.version,
          lifecycle: input.lifecycle,
          actor,
          occurredAt,
          effectiveFrom: from,
          effectiveUntil: until,
          publicationEvidence: evidence,
        };
        return await runner.run(async (tx) => {
          await tx.query("SELECT set_config('bop.brand_id',$1,true)", [brand]);
          await tx.query("SELECT set_config('bop.store_id','',true)", []);
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "RecipeModifierOperation:" + brand + ":" + operation,
          ]);
          const prior = rows(
            await tx.query(
              `SELECT rule_json AS rule,version,lifecycle,actor_id::text AS actor,to_char(occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "occurredAt",to_char(effective_from AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveFrom",to_char(effective_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "effectiveUntil",review_evidence_json AS "publicationEvidence",audit_id::text AS "auditReference" FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND operation_id=$2`,
              [brand, operation],
            ),
          );
          if (prior.length > 1) return fail();
          if (prior[0]) {
            const { auditReference, ...stored } = prior[0];
            if (canonicalizeRfc8785(stored) !== canonicalizeRfc8785(candidate))
              return fail("RECIPE_IDEMPOTENCY_CONFLICT");
            return Object.freeze({
              status: "AlreadyApplied" as const,
              rule,
              version: input.version,
              auditReference: parseRecipeReference(auditReference),
            });
          }
          await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
            "RecipeModifier:" + brand + ":" + rule.ruleReference,
          ]);
          const current = rows(
            await tx.query(
              "SELECT version,lifecycle,rule_json AS rule,actor_id::text AS actor FROM rms_recipe.recipe_modifier_version WHERE brand_id=$1 AND rule_id=$2 ORDER BY version DESC LIMIT 1",
              [brand, rule.ruleReference],
            ),
          );
          const previous = current[0];
          if ((previous ? previous.version : 0) !== input.version - 1)
            return fail("RECIPE_VERSION_CONFLICT");
          if (!previous && input.lifecycle !== "Draft") return fail("RECIPE_LIFECYCLE_CONFLICT");
          if (previous?.lifecycle === "Archived") return fail("RECIPE_LIFECYCLE_CONFLICT");
          if (input.lifecycle === "Published") {
            if (
              previous?.lifecycle !== "Draft" ||
              previous.actor !== evidence?.draftAuthorActorReference
            )
              return fail("RECIPE_LIFECYCLE_CONFLICT");
            const priorRule = parseRecipeModifierRule(previous.rule, base);
            if (
              canonicalizeRfc8785({
                ...priorRule,
                ruleVersionReference: rule.ruleVersionReference,
              }) !== canonicalizeRfc8785(rule)
            )
              return fail("RECIPE_EVIDENCE_INCOMPLETE");
          }
          if (input.lifecycle === "Invalidated" && previous?.lifecycle !== "Published")
            return fail("RECIPE_LIFECYCLE_CONFLICT");
          if (input.lifecycle === "Draft" || input.lifecycle === "Published") {
            const persisted = rows(
              await tx.query(
                "SELECT v.snapshot_json AS snapshot,c.lifecycle AS current_lifecycle FROM rms_recipe.recipe r JOIN rms_recipe.recipe_version v ON v.recipe_id=r.recipe_id AND v.brand_id=r.brand_id LEFT JOIN rms_recipe.recipe_version c ON c.recipe_version_id=r.current_version_id AND c.recipe_id=r.recipe_id AND c.brand_id=r.brand_id WHERE r.brand_id=$1 AND r.recipe_id=$2 AND v.recipe_version_id=$3 FOR SHARE OF r",
                [brand, base.recipeReference, base.versionReference],
              ),
            );
            const pinned = persisted[0];
            if (
              persisted.length !== 1 ||
              !pinned ||
              !["Draft", "Published"].includes(String(pinned.current_lifecycle)) ||
              canonicalizeRfc8785(pinned.snapshot) !== canonicalizeRfc8785(base) ||
              base.createdAt > occurredAt ||
              (input.lifecycle === "Published" && base.lifecycle !== "Published")
            )
              return fail("RECIPE_EVIDENCE_INCOMPLETE");
          }
          await validateNewWrite();
          await tx.query(
            "INSERT INTO rms_recipe.recipe_modifier_version (rule_version_id,rule_id,brand_id,version,recipe_id,recipe_version_id,binding_id,option_id,selected_quantity,lifecycle,rule_digest,rule_json,review_evidence_json,effective_from,effective_until,operation_id,actor_id,audit_id,occurred_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)",
            [
              rule.ruleVersionReference,
              rule.ruleReference,
              brand,
              input.version,
              base.recipeReference,
              base.versionReference,
              rule.selection.bindingReference,
              rule.selection.optionReference,
              rule.selection.quantity,
              input.lifecycle,
              rule.ruleDigest,
              rule,
              evidence,
              from,
              until,
              operation,
              actor,
              audit.auditId,
              occurredAt,
            ],
          );
          await appendAuditRecordInTransaction(tx, audit);
          return Object.freeze({
            status: "Applied" as const,
            rule,
            version: input.version,
            auditReference: audit.auditId,
          });
        });
      } catch (error) {
        if (error instanceof RecipeWorkflowError) throw error;
        return fail();
      }
    },
  });
}
