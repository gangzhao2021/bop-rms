import {
  appendAuditRecordInTransaction,
  canonicalizeRfc8785,
  sha256Hex,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { RecipeWorkflowError } from "../../application/recipe-service.js";
import { recipeReviewDigest, recipeSnapshotDigest } from "../recipe-digests.js";
import type { RecipeAction, RecipeOperationRecord } from "../../application/ports/recipe-ports.js";
import {
  buildRecipeDraftVersion,
  recipeDraftOf,
  recipeStandardCostCents,
  RecipeAuthoringError,
  type RecipeDraft,
  type RecipeDraftFacts,
  type RecipePresentation,
} from "../../domain/recipe-authoring.js";
import {
  createRecipePreparationContentBinding,
  type RecipePreparationContent,
} from "../../domain/recipe-preparation-content.js";
import {
  createRecipeSnapshot,
  parseRecipeReference,
  type RecipeDigest,
  type RecipeReference,
  type RecipeSnapshot,
} from "../../domain/recipe.js";
import { createPostgresRecipePreparationContentStore } from "./recipe-preparation-content-store.js";
import { createPostgresRecipeQueryStore } from "./recipe-query-store.js";
import { createPostgresRecipeStore } from "./recipe-store.js";

/**
 * WP-2423 / DEC-RECIPE-AUTHORING: Merchant recipe authoring over the owning Recipe repository.
 * Authorization is the caller's (Brand-scoped recipe.read/update/approve/publish); this store
 * enforces the facts: lifecycle, versions, independent reviews bound to the exact content,
 * kitchen instruction publication and SKU bindings that end when superseded. Caller owns the
 * transaction.
 */
export interface RecipeAuthoringTransaction {
  query(
    sql: string,
    values: readonly unknown[],
  ): Promise<{
    readonly rows: readonly Record<string, unknown>[];
    readonly rowCount?: number | null;
  }>;
}
export interface RecipeAuthoringScope {
  readonly brandReference: string;
  /** Selected Store: its own SKU bindings are visible beside the Brand-wide ones. */
  readonly storeReference: string;
}
const fail = (code: RecipeAuthoringError["code"], line: number | null = null): never => {
  throw new RecipeAuthoringError(code, line);
};
const sha256 = (value: string) => "sha256:" + sha256Hex(value);
const iso = (value: unknown) =>
  value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
const scopeSql = "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)";
const decimal = (micro: string, scale: number) => {
  const digits = micro.padStart(scale + 1, "0");
  const whole = digits.slice(0, -scale),
    fraction = digits.slice(-scale).replace(/0+$/u, "");
  return fraction ? whole + "." + fraction : whole;
};

export interface RecipeBindingView {
  readonly bindingReference: string;
  readonly recipeVersionReference: string;
  readonly skuReference: string;
  readonly storeReference: string | null;
  readonly since: string;
}
export interface RecipeSummaryView {
  readonly recipeReference: string;
  readonly familyReference: string;
  readonly familyRevision: number;
  readonly name: string;
  readonly code: string;
  readonly lifecycle: "Draft" | "Published" | "Invalidated" | "Archived";
  readonly versionReference: string;
  readonly aggregateVersion: number;
  readonly yieldQuantity: string;
  readonly yieldUnit: string;
  readonly ingredientCount: number;
  readonly standardCostCents: string;
  readonly kitchenInstructions: "NotPublished" | "Published";
  readonly bindings: readonly RecipeBindingView[];
  readonly updatedAt: string;
}
export interface RecipeReviewView {
  readonly reviewReference: string;
  readonly subject: "Recipe" | "Preparation";
  readonly kind: "Cost" | "FoodSafety";
  readonly decision: "Approved" | "Rejected";
  readonly reviewerReference: string;
  readonly comment: string | null;
  readonly reviewedAt: string;
  /** False when the content changed after the review (never for an immutable version). */
  readonly current: boolean;
}
export interface RecipeDetailView extends RecipeSummaryView {
  readonly snapshot: RecipeSnapshot;
  readonly presentation: RecipePresentation;
  readonly draft: RecipeDraft;
  readonly authorReference: string;
  readonly reviewDigest: string;
  readonly preparationDigest: string | null;
  readonly reviews: readonly RecipeReviewView[];
  readonly family: readonly {
    readonly recipeReference: string;
    readonly revision: number;
    readonly lifecycle: string;
  }[];
}

interface CurrentRow {
  readonly snapshot: RecipeSnapshot;
  readonly name: string;
  readonly presentation: RecipePresentation & { readonly preparationContentReference?: string };
  readonly family: string;
  readonly revision: number;
  readonly author: string;
  readonly updatedAt: string;
}
function presentationOf(value: unknown): CurrentRow["presentation"] {
  const p = value as CurrentRow["presentation"] | null;
  if (!p || p.profile !== "RecipePresentationV1" || !Array.isArray(p.steps))
    return fail("RECIPE_AUTHORING_CONFLICT");
  return p;
}
const currentSql = `SELECT v.snapshot_json snapshot,p.display_name,p.presentation_json,p.family_id::text family,p.family_revision,
   p.author_actor_id::text author,r.updated_at
 FROM rms_recipe.recipe r
 JOIN rms_recipe.recipe_version v ON v.recipe_version_id=r.current_version_id AND v.recipe_id=r.recipe_id AND v.brand_id=r.brand_id
 JOIN rms_recipe.recipe_version_presentation p ON p.recipe_version_id=v.recipe_version_id AND p.brand_id=v.brand_id`;
async function currentOf(
  tx: RecipeAuthoringTransaction,
  brand: string,
  recipe: string,
): Promise<CurrentRow | null> {
  const row = (
    await tx.query(currentSql + " WHERE r.brand_id=$1 AND r.recipe_id=$2", [brand, recipe])
  ).rows[0];
  if (row === undefined) return null;
  return {
    snapshot: createRecipeSnapshot(row.snapshot as RecipeSnapshot),
    name: String(row.display_name),
    presentation: presentationOf(row.presentation_json),
    family: String(row.family),
    revision: Number(row.family_revision),
    author: String(row.author),
    updatedAt: iso(row.updated_at),
  };
}
async function activeBindings(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  at: string,
  filter: { readonly recipeReference?: string; readonly skuReference?: string } = {},
): Promise<(RecipeBindingView & { readonly recipeReference: string })[]> {
  // Brand-wide bindings and those of the selected Store.
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const brand = scope.brandReference;
  const rows = (
    await tx.query(
      `SELECT b.recipe_scope_binding_id::text binding,b.recipe_id::text recipe,b.recipe_version_id::text version,b.sku_id::text sku,
         b.store_id::text store,b.effective_from
       FROM rms_recipe.recipe_scope_binding b
       WHERE b.brand_id=$1 AND b.option_binding_id IS NULL AND b.effective_from<=$2::timestamptz
         AND (b.effective_until IS NULL OR b.effective_until>$2::timestamptz)
         AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_scope_binding_end e
           WHERE e.recipe_scope_binding_id=b.recipe_scope_binding_id AND e.ended_at<=$2::timestamptz)
         AND ($3::uuid IS NULL OR b.recipe_id=$3::uuid) AND ($4::uuid IS NULL OR b.sku_id=$4::uuid)
       ORDER BY b.effective_from,b.recipe_scope_binding_id LIMIT 2000`,
      [brand, at, filter.recipeReference ?? null, filter.skuReference ?? null],
    )
  ).rows;
  return rows.map((row) => ({
    bindingReference: String(row.binding),
    recipeReference: String(row.recipe),
    recipeVersionReference: String(row.version),
    skuReference: String(row.sku),
    storeReference: row.store === null ? null : String(row.store),
    since: iso(row.effective_from),
  }));
}
async function preparationPublished(
  tx: RecipeAuthoringTransaction,
  brand: string,
  version: string,
) {
  return (
    (
      await tx.query(
        "SELECT 1 FROM rms_recipe.recipe_preparation_content WHERE brand_id=$1 AND recipe_version_id=$2 AND modifier_rule_version_id IS NULL",
        [brand, version],
      )
    ).rows.length === 1
  );
}
function summaryOf(
  current: CurrentRow,
  preparation: boolean,
  bindings: readonly RecipeBindingView[],
): RecipeSummaryView {
  const s = current.snapshot;
  return {
    recipeReference: s.recipeReference,
    familyReference: current.family,
    familyRevision: current.revision,
    name: current.name,
    code: s.stableCode,
    lifecycle: s.lifecycle,
    versionReference: s.versionReference,
    aggregateVersion: s.aggregateVersion,
    yieldQuantity: decimal(s.yieldQuantityMicrounits, 6),
    yieldUnit: s.yieldUnitCode,
    ingredientCount: s.ingredients.length,
    standardCostCents: recipeStandardCostCents(s),
    kitchenInstructions: preparation ? "Published" : "NotPublished",
    bindings,
    updatedAt: current.updatedAt,
  };
}

export async function listRecipes(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  at: string,
): Promise<readonly RecipeSummaryView[]> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const rows = (
    await tx.query(
      currentSql + ` WHERE r.brand_id=$1 ORDER BY p.display_name,p.family_revision LIMIT 1000`,
      [scope.brandReference],
    )
  ).rows;
  const bindings = await activeBindings(tx, scope, at);
  const published = new Set(
    (
      await tx.query(
        "SELECT recipe_version_id::text v FROM rms_recipe.recipe_preparation_content WHERE brand_id=$1 AND modifier_rule_version_id IS NULL",
        [scope.brandReference],
      )
    ).rows.map((row) => String(row.v)),
  );
  return rows.map((row) => {
    const current: CurrentRow = {
      snapshot: createRecipeSnapshot(row.snapshot as RecipeSnapshot),
      name: String(row.display_name),
      presentation: presentationOf(row.presentation_json),
      family: String(row.family),
      revision: Number(row.family_revision),
      author: String(row.author),
      updatedAt: iso(row.updated_at),
    };
    return summaryOf(
      current,
      published.has(current.snapshot.versionReference),
      bindings.filter((item) => item.recipeReference === current.snapshot.recipeReference),
    );
  });
}

function preparationContentOf(
  snapshot: RecipeSnapshot,
  presentation: CurrentRow["presentation"],
): RecipePreparationContent | null {
  if (snapshot.lifecycle !== "Published" || !presentation.preparationContentReference) return null;
  const content = {
    contentReference: presentation.preparationContentReference,
    brandReference: snapshot.brandReference,
    recipeVersionReference: snapshot.versionReference,
    preparationVersionReference: snapshot.preparationVersionReference,
    recipeSnapshotDigest: snapshot.snapshotDigest,
    contentDigest: "sha256:" + "0".repeat(64),
    steps: snapshot.steps.map((step, index) => ({
      stepReference: step.stepReference,
      sequenceGroup: step.sequenceGroup,
      instructionCode: step.instructionCode,
      instructionText: presentation.steps[index]?.instruction ?? fail("RECIPE_AUTHORING_CONFLICT"),
      durationSeconds: step.durationSeconds,
      capabilityCode: step.capabilityCode,
      capabilityReference:
        presentation.steps[index]?.capabilityReference ?? fail("RECIPE_AUTHORING_CONFLICT"),
    })),
  };
  return {
    ...content,
    contentDigest: sha256(createRecipePreparationContentBinding(content, snapshot)),
  } as RecipePreparationContent;
}

async function reviewsOf(
  tx: RecipeAuthoringTransaction,
  brand: string,
  version: string,
): Promise<(RecipeReviewView & { readonly digest: string })[]> {
  return (
    await tx.query(
      `SELECT review_id::text id,subject,review_kind,decision,reviewer_actor_id::text reviewer,comment,reviewed_at,subject_digest
       FROM rms_recipe.recipe_authoring_review WHERE brand_id=$1 AND recipe_version_id=$2 ORDER BY reviewed_at`,
      [brand, version],
    )
  ).rows.map((row) => ({
    reviewReference: String(row.id),
    subject: row.subject as "Recipe" | "Preparation",
    kind: row.review_kind as "Cost" | "FoodSafety",
    decision: row.decision as "Approved" | "Rejected",
    reviewerReference: String(row.reviewer),
    comment: row.comment === null ? null : String(row.comment),
    reviewedAt: iso(row.reviewed_at),
    digest: String(row.subject_digest),
    current: true,
  }));
}

export async function loadRecipe(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  recipeReference: string,
  at: string,
): Promise<RecipeDetailView | null> {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const current = await currentOf(tx, scope.brandReference, recipeReference);
  if (current === null) return null;
  const s = current.snapshot;
  const preparation = preparationContentOf(s, current.presentation);
  const reviewDigest = recipeReviewDigest(s, current.name, stripped(current.presentation));
  const reviews = (await reviewsOf(tx, scope.brandReference, s.versionReference)).map(
    ({ digest, ...review }) => ({
      ...review,
      current: digest === (review.subject === "Recipe" ? reviewDigest : preparation?.contentDigest),
    }),
  );
  const family = (
    await tx.query(
      `SELECT p.recipe_id::text recipe,p.family_revision,c.lifecycle FROM rms_recipe.recipe_version_presentation p
       JOIN rms_recipe.recipe r ON r.recipe_id=p.recipe_id AND r.brand_id=p.brand_id AND r.current_version_id=p.recipe_version_id
       JOIN rms_recipe.recipe_version c ON c.recipe_version_id=r.current_version_id
       WHERE p.brand_id=$1 AND p.family_id=$2 ORDER BY p.family_revision`,
      [scope.brandReference, current.family],
    )
  ).rows.map((row) => ({
    recipeReference: String(row.recipe),
    revision: Number(row.family_revision),
    lifecycle: String(row.lifecycle),
  }));
  return {
    ...summaryOf(
      current,
      await preparationPublished(tx, scope.brandReference, s.versionReference),
      await activeBindings(tx, scope, at, { recipeReference }),
    ),
    snapshot: s,
    presentation: current.presentation,
    draft: recipeDraftOf(s, current.name, current.presentation),
    authorReference: current.author,
    reviewDigest,
    preparationDigest: preparation?.contentDigest ?? null,
    reviews,
    family,
  };
}
/** The presentation a reviewer approves, without the publication-time content reference. */
function stripped(presentation: CurrentRow["presentation"]): RecipePresentation {
  return {
    profile: presentation.profile,
    steps: presentation.steps,
    ingredientCosts: presentation.ingredientCosts,
  };
}

interface Writer {
  readonly actorReference: string;
  readonly at: string;
  readonly nextReference: () => string;
}
const eventTypes: Record<RecipeAction, RecipeOperationRecord["event"]["eventType"]> = {
  CreateDraft: "RecipeDraftCreated",
  ReplaceDraft: "RecipeDraftReplaced",
  Publish: "RecipePublished",
  Invalidate: "RecipeInvalidated",
  Archive: "RecipeArchived",
};
function auditInput(input: {
  readonly brand: string;
  readonly actor: string;
  readonly actionCode: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly at: string;
  readonly auditReference: string;
  readonly reasonCode: string;
  readonly afterSummary?: Record<string, string | number | boolean | null>;
  readonly dataClassification?: "Internal" | "Restricted";
}): AppendAuditRecordInput {
  return {
    auditId: input.auditReference,
    brandId: input.brand,
    actor: { type: "User", reference: input.actor },
    actionCode: input.actionCode,
    targetType: input.targetType,
    targetId: input.targetId,
    correlationId: input.correlationId,
    reasonCode: input.reasonCode,
    occurredAt: input.at,
    sourceChannel: "MERCHANT_WEB",
    dataClassification: input.dataClassification ?? "Internal",
    retentionPolicyCode: "AUDIT_SECURITY",
    retentionPolicyVersion: 1,
    ...(input.afterSummary === undefined ? {} : { afterSummary: input.afterSummary }),
  } as AppendAuditRecordInput;
}
/** Native repository write: version, event, operation record and audit in the caller's transaction. */
async function commitVersion(
  tx: RecipeAuthoringTransaction,
  brand: string,
  input: {
    readonly action: RecipeAction;
    readonly operationReference: string;
    readonly intent: string;
    readonly snapshot: RecipeSnapshot;
    readonly expected: number | null;
    readonly publicationEvidence: RecipeOperationRecord["publicationEvidence"];
    readonly writer: Writer;
    readonly auditReference: string;
  },
) {
  const s = input.snapshot;
  await tx.query(scopeSql, [brand, ""]);
  const repository = createPostgresRecipeStore(
    { run: (work) => work(tx as never) },
    brand,
    input.writer.nextReference,
  );
  const record: RecipeOperationRecord = {
    action: input.action,
    operationReference: parseRecipeReference(input.operationReference),
    operationIntentHash: input.intent as RecipeDigest,
    actorReference: parseRecipeReference(input.writer.actorReference),
    publicationEvidence: input.publicationEvidence,
    aggregate: s,
    event: {
      eventType: eventTypes[input.action],
      recipeReference: s.recipeReference,
      versionReference: s.versionReference,
      brandReference: s.brandReference,
      aggregateVersion: s.aggregateVersion,
      lifecycle: s.lifecycle,
      snapshotDigest: s.snapshotDigest,
      occurredAt: s.createdAt,
    },
  };
  const audit = auditInput({
    brand,
    actor: input.writer.actorReference,
    actionCode: "RECIPE_" + input.action.toUpperCase(),
    targetType: "Recipe",
    targetId: s.recipeReference,
    correlationId: input.operationReference,
    at: s.createdAt,
    auditReference: input.auditReference,
    reasonCode: "RECIPE_AUTHORING",
  });
  try {
    return input.expected === null
      ? await repository.create({ record, audit })
      : await repository.commit({ record, expectedAggregateVersion: input.expected, audit });
  } catch (error) {
    if (error instanceof RecipeWorkflowError && error.code === "RECIPE_CODE_CONFLICT")
      return fail("RECIPE_AUTHORING_CODE_TAKEN");
    if (error instanceof RecipeWorkflowError && error.code === "RECIPE_VERSION_CONFLICT")
      return fail("RECIPE_AUTHORING_CONFLICT");
    throw error;
  }
}
async function insertPresentation(
  tx: RecipeAuthoringTransaction,
  snapshot: RecipeSnapshot,
  input: {
    readonly family: string;
    readonly revision: number;
    readonly name: string;
    readonly presentation: CurrentRow["presentation"];
    readonly author: string;
  },
) {
  await tx.query(
    `INSERT INTO rms_recipe.recipe_version_presentation(recipe_version_id,recipe_id,brand_id,family_id,family_revision,display_name,
       presentation_json,author_actor_id,recorded_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [
      snapshot.versionReference,
      snapshot.recipeReference,
      snapshot.brandReference,
      input.family,
      input.revision,
      input.name,
      JSON.stringify(input.presentation),
      input.author,
      snapshot.createdAt,
    ],
  );
}
/** Replays of the same operation report the original result; a different intent conflicts. */
async function replay(
  tx: RecipeAuthoringTransaction,
  brand: string,
  operationReference: string,
  intent: string,
  actor: string,
) {
  const prior = await createPostgresRecipeQueryStore(
    { run: (work) => work(tx as never) },
    brand,
  ).resolveOperation(parseRecipeReference(operationReference));
  if (prior === null) return null;
  if (prior.operationIntentHash !== intent || prior.actorReference !== actor)
    return fail("RECIPE_AUTHORING_CONFLICT");
  return {
    status: "AlreadyApplied" as const,
    recipeReference: prior.aggregate.recipeReference,
    aggregateVersion: prior.aggregate.aggregateVersion,
  };
}
/** Brand-level audit records are written outside any Store scope. */
async function appendBrandAudit(tx: RecipeAuthoringTransaction, record: AppendAuditRecordInput) {
  await tx.query(scopeSql, [record.brandId, ""]);
  await appendAuditRecordInTransaction(tx, record);
}
const intentOf = (value: unknown) => sha256(canonicalizeRfc8785(value));

/** Creates a recipe (or a revision of a published one) or replaces the current draft. */
export async function saveRecipeDraft(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly operationReference: string;
    readonly recipeReference: string;
    readonly expectedAggregateVersion: number | null;
    readonly revisionOf: string | null;
    readonly draft: RecipeDraft;
    readonly facts: RecipeDraftFacts;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, ""]);
  const brand = scope.brandReference;
  const action = input.expectedAggregateVersion === null ? "CreateDraft" : "ReplaceDraft";
  const intent = intentOf({
    action,
    recipeReference: input.recipeReference,
    expected: input.expectedAggregateVersion,
    revisionOf: input.revisionOf,
    draft: input.draft,
  });
  const prior = await replay(tx, brand, input.operationReference, intent, input.actorReference);
  if (prior) return prior;
  let family = input.recipeReference,
    revision = 1,
    versionNumber = 1;
  if (input.expectedAggregateVersion === null) {
    if (input.revisionOf !== null) {
      const base = await currentOf(tx, brand, input.revisionOf);
      if (base === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
      if (base.snapshot.lifecycle !== "Published") return fail("RECIPE_AUTHORING_LIFECYCLE");
      family = base.family;
      revision =
        Number(
          (
            await tx.query(
              "SELECT max(family_revision)::int n FROM rms_recipe.recipe_version_presentation WHERE brand_id=$1 AND family_id=$2",
              [brand, family],
            )
          ).rows[0]?.n ?? 0,
        ) + 1;
      const open = await tx.query(
        `SELECT 1 FROM rms_recipe.recipe_version_presentation p JOIN rms_recipe.recipe r ON r.recipe_id=p.recipe_id
           AND r.brand_id=p.brand_id AND r.current_version_id=p.recipe_version_id
         JOIN rms_recipe.recipe_version v ON v.recipe_version_id=r.current_version_id
         WHERE p.brand_id=$1 AND p.family_id=$2 AND v.lifecycle='Draft'`,
        [brand, family],
      );
      // One open revision per recipe family.
      if (open.rows.length > 0) return fail("RECIPE_AUTHORING_CONFLICT");
    }
  } else {
    const current = await currentOf(tx, brand, input.recipeReference);
    if (current === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
    if (current.snapshot.aggregateVersion !== input.expectedAggregateVersion)
      return fail("RECIPE_AUTHORING_CONFLICT");
    if (current.snapshot.lifecycle !== "Draft") return fail("RECIPE_AUTHORING_LIFECYCLE");
    if (current.snapshot.stableCode !== input.draft.code) return fail("RECIPE_AUTHORING_INVALID");
    family = current.family;
    revision = current.revision;
    versionNumber = current.snapshot.versionNumber + 1;
  }
  const { snapshot, presentation } = buildRecipeDraftVersion({
    draft: input.draft,
    facts: input.facts,
    recipeReference: input.recipeReference,
    brandReference: brand,
    stableCode: input.draft.code,
    aggregateVersion: (input.expectedAggregateVersion ?? 0) + 1,
    versionNumber,
    lifecycle: "Draft",
    at: input.at,
    nextReference: input.nextReference,
    snapshotDigest: recipeSnapshotDigest,
  });
  await commitVersion(tx, brand, {
    action,
    operationReference: input.operationReference,
    intent,
    snapshot,
    expected: input.expectedAggregateVersion,
    publicationEvidence: null,
    writer: input,
    auditReference: input.auditReference,
  });
  await insertPresentation(tx, snapshot, {
    family,
    revision,
    name: input.draft.name,
    presentation,
    author: input.actorReference,
  });
  return {
    status: "Applied" as const,
    recipeReference: snapshot.recipeReference,
    aggregateVersion: snapshot.aggregateVersion,
  };
}

/**
 * Records a Cost or FoodSafety decision on exactly the current draft (subject Recipe) or on the
 * kitchen instructions of the current published version (subject Preparation). The reviewer is never
 * the author and never the reviewer of the other kind for the same subject.
 */
export async function recordRecipeReview(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly reviewReference: string;
    readonly recipeReference: string;
    readonly versionReference: string;
    readonly subject: "Recipe" | "Preparation";
    readonly kind: "Cost" | "FoodSafety";
    readonly decision: "Approved" | "Rejected";
    readonly comment: string | null;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, ""]);
  const brand = scope.brandReference;
  const prior = (
    await tx.query(
      "SELECT recipe_version_id::text v,subject,review_kind,decision,reviewer_actor_id::text r FROM rms_recipe.recipe_authoring_review WHERE review_id=$1",
      [input.reviewReference],
    )
  ).rows[0];
  if (prior !== undefined) {
    if (
      prior.v !== input.versionReference ||
      prior.subject !== input.subject ||
      prior.review_kind !== input.kind ||
      prior.decision !== input.decision ||
      prior.r !== input.actorReference
    )
      return fail("RECIPE_AUTHORING_CONFLICT");
    return { status: "AlreadyApplied" as const };
  }
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "RecipeAuthoringReview:" + brand + ":" + input.recipeReference,
  ]);
  const current = await currentOf(tx, brand, input.recipeReference);
  if (current === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
  const s = current.snapshot;
  if (s.versionReference !== input.versionReference) return fail("RECIPE_AUTHORING_CONFLICT");
  let digest: string;
  if (input.subject === "Recipe") {
    if (s.lifecycle !== "Draft") return fail("RECIPE_AUTHORING_LIFECYCLE");
    digest = recipeReviewDigest(s, current.name, stripped(current.presentation));
  } else {
    const content = preparationContentOf(s, current.presentation);
    if (content === null || (await preparationPublished(tx, brand, s.versionReference)))
      return fail("RECIPE_AUTHORING_LIFECYCLE");
    digest = content.contentDigest;
  }
  if (input.actorReference === current.author)
    return fail("RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT");
  const existing = await reviewsOf(tx, brand, s.versionReference);
  if (
    existing.some(
      (review) =>
        review.subject === input.subject &&
        (review.kind === input.kind || review.reviewerReference === input.actorReference),
    )
  )
    return fail(
      existing.some((review) => review.subject === input.subject && review.kind === input.kind)
        ? "RECIPE_AUTHORING_CONFLICT"
        : "RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT",
    );
  await tx.query(
    `INSERT INTO rms_recipe.recipe_authoring_review(review_id,recipe_version_id,recipe_id,brand_id,subject,subject_digest,review_kind,
       decision,reviewer_actor_id,author_actor_id,comment,reviewed_at,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [
      input.reviewReference,
      s.versionReference,
      s.recipeReference,
      brand,
      input.subject,
      digest,
      input.kind,
      input.decision,
      input.actorReference,
      current.author,
      input.comment,
      input.at,
      input.auditReference,
    ],
  );
  await appendBrandAudit(
    tx,
    auditInput({
      brand,
      actor: input.actorReference,
      actionCode: "RECIPE_REVIEW_RECORDED",
      targetType: "Recipe",
      targetId: s.recipeReference,
      correlationId: input.reviewReference,
      at: input.at,
      auditReference: input.auditReference,
      reasonCode: "RECIPE_REVIEW",
      afterSummary: {
        subject: input.subject,
        reviewKind: input.kind,
        decision: input.decision,
        version: s.versionNumber,
      },
    }),
  );
  return { status: "Applied" as const };
}

/** Approved, current, independent Cost and FoodSafety reviews of one subject, or a refusal. */
async function approvedReviews(
  tx: RecipeAuthoringTransaction,
  brand: string,
  version: string,
  subject: "Recipe" | "Preparation",
  digest: string,
  author: string,
  reviewersAuthorized: (actors: readonly string[]) => Promise<boolean>,
) {
  const reviews = (await reviewsOf(tx, brand, version)).filter(
    (review) => review.subject === subject,
  );
  const cost = reviews.find((review) => review.kind === "Cost"),
    safety = reviews.find((review) => review.kind === "FoodSafety");
  if (
    !cost ||
    !safety ||
    cost.decision !== "Approved" ||
    safety.decision !== "Approved" ||
    cost.digest !== digest ||
    safety.digest !== digest ||
    cost.reviewerReference === safety.reviewerReference ||
    [cost, safety].some((review) => review.reviewerReference === author) ||
    !(await reviewersAuthorized([cost.reviewerReference, safety.reviewerReference]))
  )
    return fail("RECIPE_AUTHORING_REVIEW_REQUIRED");
  return [cost, safety];
}
/** A copy of a version with fresh row references, as the next lifecycle state. */
function nextVersion(
  s: RecipeSnapshot,
  lifecycle: "Published" | "Archived",
  at: string,
  nextReference: () => string,
) {
  const core = {
    ...s,
    versionReference: parseRecipeReference(nextReference()),
    aggregateVersion: s.aggregateVersion + 1,
    versionNumber: s.versionNumber + 1,
    lifecycle,
    ingredients: s.ingredients.map((item) => ({
      ...item,
      requirementReference: parseRecipeReference(nextReference()),
      allergens: [...item.allergens],
    })),
    steps: s.steps.map((step) => ({
      ...step,
      stepReference: parseRecipeReference(nextReference()),
    })),
    preparationVersionReference: parseRecipeReference(nextReference()),
    effectivePeriod:
      lifecycle === "Published"
        ? {
            timeZone: "UTC",
            effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
            effectiveUntil: null,
          }
        : s.effectivePeriod,
    createdAt: at,
  };
  const { snapshotDigest: _old, ...withoutDigest } = core;
  void _old;
  return createRecipeSnapshot({
    ...withoutDigest,
    snapshotDigest: recipeSnapshotDigest(withoutDigest as never),
  } as never);
}
function carriedPresentation(
  from: RecipeSnapshot,
  to: RecipeSnapshot,
  presentation: CurrentRow["presentation"],
  preparationContentReference: string | null,
): CurrentRow["presentation"] {
  // nextVersion keeps step and ingredient order, so positions correspond.
  if (from.steps.length !== to.steps.length) return fail("RECIPE_AUTHORING_CONFLICT");
  return {
    profile: "RecipePresentationV1",
    steps: to.steps.map((step, index) => {
      const original = presentation.steps[index];
      if (!original) return fail("RECIPE_AUTHORING_CONFLICT");
      return { ...original, stepReference: step.stepReference };
    }),
    ingredientCosts: to.ingredients.map((requirement, index) => ({
      requirementReference: requirement.requirementReference,
      unitCostCents: presentation.ingredientCosts[index]?.unitCostCents ?? null,
    })),
    ...(preparationContentReference === null ? {} : { preparationContentReference }),
  };
}

/**
 * Publishes the current draft after independent Cost and FoodSafety approval of exactly that draft.
 * Referenced Inventory Items must still be Active and sub-recipes still current and published.
 */
export async function publishRecipe(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly operationReference: string;
    readonly recipeReference: string;
    readonly expectedAggregateVersion: number;
    readonly facts: RecipeDraftFacts;
    readonly reviewersAuthorized: (actors: readonly string[]) => Promise<boolean>;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, ""]);
  const brand = scope.brandReference;
  const intent = intentOf({
    action: "Publish",
    recipeReference: input.recipeReference,
    expected: input.expectedAggregateVersion,
  });
  const prior = await replay(tx, brand, input.operationReference, intent, input.actorReference);
  if (prior) return prior;
  const current = await currentOf(tx, brand, input.recipeReference);
  if (current === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
  const s = current.snapshot;
  if (s.aggregateVersion !== input.expectedAggregateVersion)
    return fail("RECIPE_AUTHORING_CONFLICT");
  if (s.lifecycle !== "Draft") return fail("RECIPE_AUTHORING_LIFECYCLE");
  s.ingredients.forEach((requirement, index) => {
    const ok =
      requirement.sourceKind === "InventoryItem"
        ? input.facts.items.get(requirement.sourceReference)?.active === true
        : input.facts.subRecipes.get(requirement.sourceReference)?.versionReference ===
          requirement.sourceVersionReference;
    if (!ok) fail("RECIPE_AUTHORING_LINE_INVALID", index + 1);
  });
  const reviews = await approvedReviews(
    tx,
    brand,
    s.versionReference,
    "Recipe",
    recipeReviewDigest(s, current.name, stripped(current.presentation)),
    current.author,
    input.reviewersAuthorized,
  );
  const published = nextVersion(s, "Published", input.at, input.nextReference);
  await commitVersion(tx, brand, {
    action: "Publish",
    operationReference: input.operationReference,
    intent,
    snapshot: published,
    expected: s.aggregateVersion,
    publicationEvidence: {
      recipeReference: published.recipeReference,
      versionReference: published.versionReference,
      brandReference: published.brandReference,
      snapshotDigest: published.snapshotDigest,
      draftAuthorActorReference: current.author,
      reviews: reviews.map((review) => ({
        reviewReference: input.nextReference(),
        reviewKind: review.kind,
        reviewerActorReference: review.reviewerReference,
        evidenceDigest: review.digest,
        reviewedAt: review.reviewedAt,
        decision: "Approved" as const,
      })),
    },
    writer: input,
    auditReference: input.auditReference,
  });
  await insertPresentation(tx, published, {
    family: current.family,
    revision: current.revision,
    name: current.name,
    presentation: carriedPresentation(s, published, current.presentation, input.nextReference()),
    author: current.author,
  });
  return {
    status: "Applied" as const,
    recipeReference: published.recipeReference,
    aggregateVersion: published.aggregateVersion,
  };
}

/** Publishes the kitchen instructions of the current published version after their own reviews. */
export async function publishRecipePreparation(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly operationReference: string;
    readonly recipeReference: string;
    readonly reviewersAuthorized: (actors: readonly string[]) => Promise<boolean>;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, ""]);
  const brand = scope.brandReference;
  const current = await currentOf(tx, brand, input.recipeReference);
  if (current === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
  const s = current.snapshot;
  const content = preparationContentOf(s, current.presentation);
  if (content === null) return fail("RECIPE_AUTHORING_LIFECYCLE");
  const existing = (
    await tx.query(
      "SELECT operation_id::text op FROM rms_recipe.recipe_preparation_content WHERE brand_id=$1 AND recipe_version_id=$2 AND modifier_rule_version_id IS NULL",
      [brand, s.versionReference],
    )
  ).rows[0];
  if (existing !== undefined) {
    if (existing.op !== input.operationReference) return fail("RECIPE_AUTHORING_LIFECYCLE");
    return { status: "AlreadyApplied" as const };
  }
  const reviews = await approvedReviews(
    tx,
    brand,
    s.versionReference,
    "Preparation",
    content.contentDigest,
    current.author,
    input.reviewersAuthorized,
  );
  const record = {
    operationReference: input.operationReference,
    actorReference: input.actorReference,
    brandReference: brand,
    recipeReference: s.recipeReference,
    recipeVersionReference: s.versionReference,
    modifierRuleVersionReference: null,
    authoredByReference: current.author,
    authoredAt: s.createdAt,
    publishedAt: input.at,
    content,
    reviewEvidence: {
      contentReference: content.contentReference,
      contentDigest: content.contentDigest,
      draftAuthorActorReference: current.author,
      reviews: reviews.map((review) => ({
        reviewReference: review.reviewReference,
        reviewKind: review.kind,
        reviewerActorReference: review.reviewerReference,
        evidenceDigest: review.digest,
        reviewedAt: review.reviewedAt,
        decision: "Approved",
      })),
    },
  };
  const store = createPostgresRecipePreparationContentStore({
    brandReference: brand,
    sha256,
    authorizeRead: async () => false,
    authorizeWrite: async () => true,
    validatePublication: async () => true,
    audit: async (published) =>
      auditInput({
        brand,
        actor: input.actorReference,
        actionCode: "RECIPE_PREPARATION_PUBLISHED",
        targetType: "RecipePreparationContent",
        targetId: published.content.contentReference,
        correlationId: published.operationReference,
        at: published.publishedAt,
        auditReference: input.auditReference,
        reasonCode: "RECIPE_AUTHORING",
        dataClassification: "Restricted",
        afterSummary: { contentKind: "Base" },
      }),
  });
  try {
    await store.commit({ transaction: tx as never, record });
  } catch {
    return fail("RECIPE_AUTHORING_CONFLICT");
  }
  return { status: "Applied" as const };
}

/**
 * Makes a published recipe (with published kitchen instructions) the recipe of a SKU, for the whole
 * Brand or one Store. The SKU's previous binding in the same scope ends at the same instant.
 */
export async function bindRecipeToSku(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly operationReference: string;
    readonly recipeReference: string;
    readonly skuReference: string;
    readonly storeReference: string | null;
    /** The SKU's unit of sale; a Count recipe must yield exactly this unit. */
    readonly skuUnitOfSale: string;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const brand = scope.brandReference;
  if (input.storeReference !== null && input.storeReference !== scope.storeReference)
    return fail("RECIPE_AUTHORING_INVALID");
  const done = (
    await tx.query(
      "SELECT recipe_id::text recipe,sku_id::text sku FROM rms_recipe.recipe_scope_binding WHERE recipe_scope_binding_id=$1",
      [input.operationReference],
    )
  ).rows[0];
  if (done !== undefined) {
    if (done.recipe !== input.recipeReference || done.sku !== input.skuReference)
      return fail("RECIPE_AUTHORING_CONFLICT");
    return { status: "AlreadyApplied" as const };
  }
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "RecipeSkuBinding:" + brand + ":" + input.skuReference,
  ]);
  const current = await currentOf(tx, brand, input.recipeReference);
  if (current === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
  const s = current.snapshot;
  if (s.lifecycle !== "Published" || !(await preparationPublished(tx, brand, s.versionReference)))
    return fail("RECIPE_AUTHORING_LIFECYCLE");
  if (s.yieldDimension !== "Count" || s.yieldUnitCode !== input.skuUnitOfSale)
    return fail("RECIPE_AUTHORING_INVALID");
  const same = (
    await activeBindings(tx, scope, input.at, { skuReference: input.skuReference })
  ).filter((binding) => binding.storeReference === input.storeReference);
  if (same.some((binding) => binding.recipeVersionReference === s.versionReference))
    return { status: "AlreadyApplied" as const };
  for (const binding of same)
    await tx.query(
      `INSERT INTO rms_recipe.recipe_scope_binding_end(recipe_scope_binding_id,brand_id,store_id,ended_at,reason_code,operation_id,actor_id,audit_id)
       VALUES($1,$2,$3,$4,'SUPERSEDED',$5,$6,$7)`,
      [
        binding.bindingReference,
        brand,
        binding.storeReference,
        input.at,
        input.operationReference,
        input.actorReference,
        input.auditReference,
      ],
    );
  await tx.query(
    `INSERT INTO rms_recipe.recipe_scope_binding(recipe_scope_binding_id,recipe_version_id,recipe_id,brand_id,sku_id,store_id,option_binding_id,effective_from,effective_until)
     VALUES($1,$2,$3,$4,$5,$6,NULL,$7,NULL)`,
    [
      input.operationReference,
      s.versionReference,
      s.recipeReference,
      brand,
      input.skuReference,
      input.storeReference,
      input.at,
    ],
  );
  await appendBrandAudit(
    tx,
    auditInput({
      brand,
      actor: input.actorReference,
      actionCode: "RECIPE_SKU_BOUND",
      targetType: "Recipe",
      targetId: s.recipeReference,
      correlationId: input.operationReference,
      at: input.at,
      auditReference: input.auditReference,
      reasonCode: "RECIPE_AUTHORING",
      afterSummary: {
        sku: input.skuReference,
        storeScoped: input.storeReference !== null,
        superseded: same.length,
      },
    }),
  );
  return { status: "Applied" as const };
}

/** Ends a Store-specific binding; the Store then uses the Brand-wide recipe of the SKU again. */
export async function endStoreRecipeBinding(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly operationReference: string;
    readonly bindingReference: string;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, scope.storeReference]);
  const brand = scope.brandReference;
  const ended = (
    await tx.query(
      "SELECT operation_id::text op FROM rms_recipe.recipe_scope_binding_end WHERE recipe_scope_binding_id=$1",
      [input.bindingReference],
    )
  ).rows[0];
  if (ended !== undefined) {
    if (ended.op !== input.operationReference) return fail("RECIPE_AUTHORING_CONFLICT");
    return { status: "AlreadyApplied" as const };
  }
  const binding = (await activeBindings(tx, scope, input.at)).find(
    (item) => item.bindingReference === input.bindingReference,
  );
  if (binding === undefined) return fail("RECIPE_AUTHORING_NOT_FOUND");
  if (binding.storeReference !== scope.storeReference) return fail("RECIPE_AUTHORING_IN_USE");
  await tx.query(
    `INSERT INTO rms_recipe.recipe_scope_binding_end(recipe_scope_binding_id,brand_id,store_id,ended_at,reason_code,operation_id,actor_id,audit_id)
     VALUES($1,$2,$3,$4,'REMOVED',$5,$6,$7)`,
    [
      binding.bindingReference,
      brand,
      binding.storeReference,
      input.at,
      input.operationReference,
      input.actorReference,
      input.auditReference,
    ],
  );
  await appendBrandAudit(
    tx,
    auditInput({
      brand,
      actor: input.actorReference,
      actionCode: "RECIPE_SKU_UNBOUND",
      targetType: "Recipe",
      targetId: binding.recipeReference,
      correlationId: input.operationReference,
      at: input.at,
      auditReference: input.auditReference,
      reasonCode: "RECIPE_AUTHORING",
      afterSummary: { sku: binding.skuReference, storeScoped: true },
    }),
  );
  return { status: "Applied" as const };
}

/** Archives a recipe that no SKU uses and no current recipe uses as a sub-recipe. */
export async function archiveRecipe(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
  input: Writer & {
    readonly operationReference: string;
    readonly recipeReference: string;
    readonly expectedAggregateVersion: number;
    readonly auditReference: string;
  },
) {
  await tx.query(scopeSql, [scope.brandReference, ""]);
  const brand = scope.brandReference;
  const intent = intentOf({
    action: "Archive",
    recipeReference: input.recipeReference,
    expected: input.expectedAggregateVersion,
  });
  const prior = await replay(tx, brand, input.operationReference, intent, input.actorReference);
  if (prior) return prior;
  await tx.query("LOCK TABLE rms_recipe.recipe_scope_binding IN SHARE MODE", []);
  const current = await currentOf(tx, brand, input.recipeReference);
  if (current === null) return fail("RECIPE_AUTHORING_NOT_FOUND");
  const s = current.snapshot;
  if (s.aggregateVersion !== input.expectedAggregateVersion)
    return fail("RECIPE_AUTHORING_CONFLICT");
  if (s.lifecycle === "Archived") return fail("RECIPE_AUTHORING_LIFECYCLE");
  // Store-specific bindings of every Store, through the Brand-wide reference projection.
  await tx.query("SELECT set_config('bop.store_id','',true)", []);
  const bound = await tx.query(
    `SELECT 1 FROM rms_recipe.recipe_reference_binding b WHERE b.brand_id=$1 AND b.recipe_id=$2
       AND NOT EXISTS (SELECT 1 FROM rms_recipe.recipe_scope_binding_end e WHERE e.recipe_scope_binding_id=b.recipe_scope_binding_id)
     LIMIT 1`,
    [brand, input.recipeReference],
  );
  await tx.query(scopeSql, [scope.brandReference, ""]);
  const used = await tx.query(
    `SELECT 1 FROM rms_recipe.recipe_ingredient_requirement q JOIN rms_recipe.recipe r ON r.current_version_id=q.recipe_version_id
       AND r.brand_id=q.brand_id
     JOIN rms_recipe.recipe_version v ON v.recipe_version_id=r.current_version_id
     WHERE q.brand_id=$1 AND q.source_kind='SubRecipe' AND q.source_id=$2 AND v.lifecycle IN ('Draft','Published') LIMIT 1`,
    [brand, input.recipeReference],
  );
  if (bound.rows.length > 0 || used.rows.length > 0) return fail("RECIPE_AUTHORING_IN_USE");
  const archived = nextVersion(s, "Archived", input.at, input.nextReference);
  await commitVersion(tx, brand, {
    action: "Archive",
    operationReference: input.operationReference,
    intent,
    snapshot: archived,
    expected: s.aggregateVersion,
    publicationEvidence: null,
    writer: input,
    auditReference: input.auditReference,
  });
  await insertPresentation(tx, archived, {
    family: current.family,
    revision: current.revision,
    name: current.name,
    presentation: carriedPresentation(s, archived, current.presentation, null),
    author: current.author,
  });
  return {
    status: "Applied" as const,
    recipeReference: archived.recipeReference,
    aggregateVersion: archived.aggregateVersion,
  };
}

/** Current published recipes usable as sub-recipes, with their pinned version and yield. */
export async function listPublishedSubRecipes(
  tx: RecipeAuthoringTransaction,
  scope: RecipeAuthoringScope,
): Promise<
  readonly {
    readonly recipeReference: RecipeReference;
    readonly versionReference: RecipeReference;
    readonly name: string;
    readonly yieldDimension: RecipeSnapshot["yieldDimension"];
    readonly yieldUnitCode: string;
  }[]
> {
  await tx.query(scopeSql, [scope.brandReference, ""]);
  return (
    await tx.query(currentSql + " WHERE r.brand_id=$1 AND v.lifecycle='Published' LIMIT 1000", [
      scope.brandReference,
    ])
  ).rows.map((row) => {
    const snapshot = createRecipeSnapshot(row.snapshot as RecipeSnapshot);
    return {
      recipeReference: snapshot.recipeReference,
      versionReference: snapshot.versionReference,
      name: String(row.display_name),
      yieldDimension: snapshot.yieldDimension,
      yieldUnitCode: snapshot.yieldUnitCode,
    };
  });
}
