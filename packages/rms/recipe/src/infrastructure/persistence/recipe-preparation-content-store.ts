import { appendAuditRecordInTransaction, validateAuditRecord } from "@bop/audit";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import { parseRecipeModifierRule, type RecipeModifierRule } from "../../domain/recipe-modifier.js";
import {
  parseRecipePublicationEvidence,
  parseRecipeModifierPublicationEvidence,
} from "../../domain/publication-review.js";
import {
  parseRecipePreparationPublicationHeader,
  parseRecipePreparationPublication,
  preparationObject,
  preparationInstant,
  type RecipePreparationPublicationHeader,
  type RecipePreparationPublicationRecord,
} from "../../domain/recipe-preparation-publication.js";
import { RecipeWorkflowError } from "../../application/recipe-service.js";

type SourceIdentity = Pick<
  RecipePreparationPublicationHeader,
  "brandReference" | "recipeReference" | "recipeVersionReference" | "modifierRuleVersionReference"
>;
export interface ResolveRecipePreparationContentInput extends SourceIdentity {
  readonly actorType: "System";
  readonly actorReference: null;
  readonly action: "ResolveRecipePreparationContent";
  readonly purpose: "CreateKitchenWork";
  readonly storeReference: string;
  readonly effectiveAt: string;
}
function fail(conflict = false): never {
  throw new RecipeWorkflowError(
    conflict ? "RECIPE_IDEMPOTENCY_CONFLICT" : "RECIPE_EVIDENCE_INCOMPLETE",
  );
}
export function createPostgresRecipePreparationContentStore(options: {
  readonly brandReference: string;
  readonly sha256: (value: string) => string;
  readonly authorizeRead: (
    tx: ConsumerTransaction,
    input: ResolveRecipePreparationContentInput,
  ) => Promise<boolean>;
  readonly authorizeWrite: (
    tx: ConsumerTransaction,
    header: RecipePreparationPublicationHeader,
  ) => Promise<boolean>;
  readonly validatePublication: (
    tx: ConsumerTransaction,
    record: RecipePreparationPublicationRecord,
  ) => Promise<boolean>;
  readonly audit: (record: RecipePreparationPublicationRecord) => Promise<unknown>;
}) {
  const brand = parseRecipeReference(options.brandReference);
  async function scope(tx: ConsumerTransaction, store: string | null) {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      brand,
      store ?? "",
    ]);
  }
  async function lock(tx: ConsumerTransaction, key: string) {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [key]);
  }
  async function sources(
    tx: ConsumerTransaction,
    identity: SourceIdentity,
    at: string,
    current: boolean,
  ) {
    if (identity.brandReference !== brand) return fail();
    if (current)
      await tx.query(
        "LOCK TABLE rms_recipe.recipe,rms_recipe.recipe_modifier_version IN SHARE MODE",
        [],
      );
    const rows = (
      await tx.query(
        "SELECT v.snapshot_json AS snapshot,c.lifecycle AS current_lifecycle,p.record_json->'publicationEvidence' AS publication " +
          "FROM rms_recipe.recipe_version v JOIN rms_recipe.recipe r ON r.recipe_id=v.recipe_id AND r.brand_id=v.brand_id " +
          "LEFT JOIN rms_recipe.recipe_version c ON c.recipe_version_id=r.current_version_id AND c.recipe_id=r.recipe_id AND c.brand_id=r.brand_id " +
          "LEFT JOIN rms_recipe.recipe_operation_record p ON p.brand_id=v.brand_id AND p.recipe_id=v.recipe_id " +
          "AND p.result_version_id=v.recipe_version_id AND p.action_code='Publish' " +
          "WHERE v.brand_id=$1 AND v.recipe_id=$2 AND v.recipe_version_id=$3 LIMIT 2",
        [brand, identity.recipeReference, identity.recipeVersionReference],
      )
    ).rows;
    const row = rows[0];
    if (rows.length !== 1 || !row || (current && row.current_lifecycle !== "Published"))
      return fail();
    const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
    if (
      snapshot.brandReference !== brand ||
      snapshot.recipeReference !== identity.recipeReference ||
      snapshot.versionReference !== identity.recipeVersionReference ||
      snapshot.lifecycle !== "Published" ||
      snapshot.createdAt > at ||
      (current &&
        (snapshot.effectivePeriod.effectiveFrom.instant > at ||
          (snapshot.effectivePeriod.effectiveUntil !== null &&
            snapshot.effectivePeriod.effectiveUntil.instant <= at)))
    )
      return fail();
    parseRecipePublicationEvidence(row.publication, snapshot);
    let rule: RecipeModifierRule | null = null;
    if (identity.modifierRuleVersionReference !== null) {
      const found = (
        await tx.query(
          "SELECT v.rule_json AS rule,v.review_evidence_json AS publication,v.lifecycle,v.occurred_at,v.effective_from,v.effective_until," +
            "(SELECT c.lifecycle FROM rms_recipe.recipe_modifier_version c WHERE c.brand_id=v.brand_id AND c.rule_id=v.rule_id " +
            "AND c.lifecycle<>'Draft' ORDER BY c.version DESC LIMIT 1) AS current_lifecycle " +
            "FROM rms_recipe.recipe_modifier_version v WHERE v.brand_id=$1 AND v.recipe_version_id=$2 AND v.rule_version_id=$3",
          [brand, snapshot.versionReference, identity.modifierRuleVersionReference],
        )
      ).rows;
      const selected = found[0];
      const instant = (value: unknown) =>
        value instanceof Date ? value.toISOString() : preparationInstant(value);
      if (
        found.length !== 1 ||
        !selected ||
        selected.lifecycle !== "Published" ||
        (current && selected.current_lifecycle !== "Published") ||
        instant(selected.occurred_at) > at ||
        (current &&
          (instant(selected.effective_from) > at ||
            (selected.effective_until !== null && instant(selected.effective_until) <= at)))
      )
        return fail();
      rule = parseRecipeModifierRule(selected.rule, snapshot);
      if (rule.ruleVersionReference !== identity.modifierRuleVersionReference) return fail();
      parseRecipeModifierPublicationEvidence(
        selected.publication,
        rule,
        instant(selected.occurred_at),
      );
    }
    return { snapshot, rule };
  }
  async function readOperation(tx: ConsumerTransaction, operation: string) {
    const result = await tx.query(
      "SELECT record_json AS record FROM rms_recipe.recipe_preparation_content WHERE brand_id=$1 AND operation_id=$2",
      [brand, operation],
    );
    if (result.rows.length > 1) return fail();
    return result.rows[0]?.record;
  }
  return Object.freeze({
    async commit(input: { readonly transaction: ConsumerTransaction; readonly record: unknown }) {
      try {
        const header = parseRecipePreparationPublicationHeader(input.record);
        if (header.brandReference !== brand) return fail();
        const tx = input.transaction;
        await scope(tx, null);
        if ((await options.authorizeWrite(tx, header)) !== true) return fail();
        await lock(tx, "RecipePreparationOperation:" + brand + ":" + header.operationReference);
        const original = await readOperation(tx, header.operationReference);
        if (original !== undefined) {
          const originalHeader = parseRecipePreparationPublicationHeader(original);
          const history = await sources(tx, originalHeader, originalHeader.publishedAt, false);
          const record = parseRecipePreparationPublication(
            original,
            history.snapshot,
            history.rule,
            options.sha256,
          );
          const attempted = parseRecipePreparationPublication(
            header,
            history.snapshot,
            history.rule,
            options.sha256,
          );
          if (JSON.stringify(record) !== JSON.stringify(attempted)) return fail(true);
          return { status: "AlreadyCommitted" as const, record };
        }
        const source = await sources(tx, header, header.publishedAt, true);
        const record = parseRecipePreparationPublication(
          header,
          source.snapshot,
          source.rule,
          options.sha256,
        );
        await lock(
          tx,
          "RecipePreparationContent:" +
            brand +
            ":" +
            header.recipeVersionReference +
            ":" +
            (header.modifierRuleVersionReference ?? "Base"),
        );
        const existing = await tx.query(
          "SELECT content_id FROM rms_recipe.recipe_preparation_content WHERE brand_id=$1 AND recipe_version_id=$2 " +
            "AND modifier_rule_version_id IS NOT DISTINCT FROM $3::uuid",
          [brand, header.recipeVersionReference, header.modifierRuleVersionReference],
        );
        if (existing.rows.length !== 0) return fail(true);
        if ((await options.validatePublication(tx, record)) !== true) return fail();
        const audit = validateAuditRecord(await options.audit(record));
        if (
          audit.brandId !== brand ||
          audit.storeId !== undefined ||
          audit.actor.type !== "User" ||
          audit.actor.reference !== record.actorReference ||
          audit.actionCode !== "RECIPE_PREPARATION_PUBLISHED" ||
          audit.targetType !== "RecipePreparationContent" ||
          audit.targetId !== record.content.contentReference ||
          audit.correlationId !== record.operationReference ||
          audit.occurredAt !== record.publishedAt ||
          audit.beforeSummary !== undefined ||
          audit.dataClassification !== "Restricted" ||
          JSON.stringify(audit.afterSummary) !==
            JSON.stringify({
              contentKind: record.modifierRuleVersionReference === null ? "Base" : "Modifier",
            })
        )
          return fail();
        await appendAuditRecordInTransaction(tx, audit);
        const saved = await tx.query(
          "INSERT INTO rms_recipe.recipe_preparation_content (content_id,brand_id,recipe_id,recipe_version_id," +
            "modifier_rule_version_id,operation_id,actor_id,audit_id,content_digest,published_at,record_json) " +
            "VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [
            record.content.contentReference,
            brand,
            record.recipeReference,
            record.recipeVersionReference,
            record.modifierRuleVersionReference,
            record.operationReference,
            record.actorReference,
            audit.auditId,
            record.content.contentDigest,
            record.publishedAt,
            JSON.stringify(record),
          ],
        );
        if (saved.rowCount !== 1) return fail();
        return { status: "Committed" as const, record };
      } catch (error) {
        if (error instanceof RecipeWorkflowError) throw error;
        return fail();
      }
    },
    async resolve(input: { readonly transaction: ConsumerTransaction; readonly query: unknown }) {
      try {
        const r = preparationObject(input.query, [
          "actorType",
          "actorReference",
          "action",
          "purpose",
          "brandReference",
          "storeReference",
          "recipeReference",
          "recipeVersionReference",
          "modifierRuleVersionReference",
          "effectiveAt",
        ]);
        if (
          r.actorType !== "System" ||
          r.actorReference !== null ||
          r.action !== "ResolveRecipePreparationContent" ||
          r.purpose !== "CreateKitchenWork" ||
          r.brandReference !== brand
        )
          return fail();
        const query: ResolveRecipePreparationContentInput = {
          actorType: "System",
          actorReference: null,
          action: "ResolveRecipePreparationContent",
          purpose: "CreateKitchenWork",
          brandReference: brand,
          storeReference: parseRecipeReference(r.storeReference),
          recipeReference: parseRecipeReference(r.recipeReference),
          recipeVersionReference: parseRecipeReference(r.recipeVersionReference),
          modifierRuleVersionReference:
            r.modifierRuleVersionReference === null
              ? null
              : parseRecipeReference(r.modifierRuleVersionReference),
          effectiveAt: preparationInstant(r.effectiveAt),
        };
        const tx = input.transaction;
        await scope(tx, query.storeReference);
        if ((await options.authorizeRead(tx, query)) !== true) return fail();
        const source = await sources(tx, query, query.effectiveAt, true);
        await lock(
          tx,
          "RecipePreparationContent:" +
            brand +
            ":" +
            query.recipeVersionReference +
            ":" +
            (query.modifierRuleVersionReference ?? "Base"),
        );
        const rows = (
          await tx.query(
            "SELECT record_json AS record FROM rms_recipe.recipe_preparation_content WHERE brand_id=$1 AND recipe_version_id=$2 " +
              "AND modifier_rule_version_id IS NOT DISTINCT FROM $3::uuid AND published_at<=$4::timestamptz",
            [
              brand,
              query.recipeVersionReference,
              query.modifierRuleVersionReference,
              query.effectiveAt,
            ],
          )
        ).rows;
        if (!rows[0]) return null;
        if (rows.length !== 1) return fail();
        const record = parseRecipePreparationPublication(
          rows[0].record,
          source.snapshot,
          source.rule,
          options.sha256,
        );
        if (record.publishedAt > query.effectiveAt) return fail();
        return Object.freeze({
          content: record.content,
          publicationReference: record.operationReference,
          publishedAt: record.publishedAt,
        });
      } catch {
        return fail();
      }
    },
  });
}
