import {
  createRecipeSnapshot,
  parseRecipeReference,
  RecipeError,
  type RecipeSnapshot,
} from "./recipe.js";
import type { RecipeModifierRule } from "./recipe-modifier.js";
import {
  parseRecipePublicationEvidence,
  type RecipePublicationReview,
} from "./publication-review.js";
import {
  parseRecipePreparationContent,
  createRecipePreparationContentBinding,
  parseRecipePreparationModifierContent,
  createRecipePreparationModifierContentBinding,
  type RecipePreparationContent,
  type RecipePreparationModifierContent,
} from "./recipe-preparation-content.js";

export interface RecipePreparationPublicationHeader {
  readonly operationReference: string;
  readonly actorReference: string;
  readonly brandReference: string;
  readonly recipeReference: string;
  readonly recipeVersionReference: string;
  readonly modifierRuleVersionReference: string | null;
  readonly authoredByReference: string;
  readonly authoredAt: string;
  readonly publishedAt: string;
  readonly content: unknown;
  readonly reviewEvidence: unknown;
}
export interface RecipePreparationReviewEvidence {
  readonly contentReference: string;
  readonly contentDigest: string;
  readonly draftAuthorActorReference: string;
  readonly reviews: readonly RecipePublicationReview[];
}
export interface RecipePreparationPublicationRecord extends RecipePreparationPublicationHeader {
  readonly content: RecipePreparationContent | RecipePreparationModifierContent;
  readonly reviewEvidence: RecipePreparationReviewEvidence;
}
function fail(): never {
  throw new RecipeError("RECIPE_INPUT_INVALID");
}
export function preparationObject(
  value: unknown,
  fields: readonly string[],
): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const d = Object.getOwnPropertyDescriptor(value, field);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[field] = d.value;
  }
  return result;
}
export function preparationInstant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
export function parseRecipePreparationPublicationHeader(
  value: unknown,
): RecipePreparationPublicationHeader {
  const r = preparationObject(value, [
    "operationReference",
    "actorReference",
    "brandReference",
    "recipeReference",
    "recipeVersionReference",
    "modifierRuleVersionReference",
    "authoredByReference",
    "authoredAt",
    "publishedAt",
    "content",
    "reviewEvidence",
  ]);
  return Object.freeze({
    operationReference: parseRecipeReference(r.operationReference),
    actorReference: parseRecipeReference(r.actorReference),
    brandReference: parseRecipeReference(r.brandReference),
    recipeReference: parseRecipeReference(r.recipeReference),
    recipeVersionReference: parseRecipeReference(r.recipeVersionReference),
    modifierRuleVersionReference:
      r.modifierRuleVersionReference === null
        ? null
        : parseRecipeReference(r.modifierRuleVersionReference),
    authoredByReference: parseRecipeReference(r.authoredByReference),
    authoredAt: preparationInstant(r.authoredAt),
    publishedAt: preparationInstant(r.publishedAt),
    content: r.content,
    reviewEvidence: r.reviewEvidence,
  });
}
/** Structural review binding, not reviewer authentication or current publishing permission. */
export function parseRecipePreparationPublication(
  value: unknown,
  snapshotInput: RecipeSnapshot,
  rule: RecipeModifierRule | null,
  sha256: (value: string) => string,
): RecipePreparationPublicationRecord {
  try {
    const header = parseRecipePreparationPublicationHeader(value);
    const snapshot = createRecipeSnapshot(snapshotInput);
    if (
      header.brandReference !== snapshot.brandReference ||
      header.recipeReference !== snapshot.recipeReference ||
      header.recipeVersionReference !== snapshot.versionReference ||
      snapshot.lifecycle !== "Published" ||
      header.authoredAt < snapshot.createdAt ||
      header.authoredAt > header.publishedAt ||
      header.modifierRuleVersionReference !== (rule?.ruleVersionReference ?? null)
    )
      return fail();
    const content =
      rule === null
        ? parseRecipePreparationContent(header.content, snapshot)
        : parseRecipePreparationModifierContent(header.content, rule, snapshot);
    const binding =
      rule === null
        ? createRecipePreparationContentBinding(content, snapshot)
        : createRecipePreparationModifierContentBinding(content, rule, snapshot);
    if (sha256(binding) !== content.contentDigest) return fail();
    const review = preparationObject(header.reviewEvidence, [
      "contentReference",
      "contentDigest",
      "draftAuthorActorReference",
      "reviews",
    ]);
    if (
      review.contentReference !== content.contentReference ||
      review.contentDigest !== content.contentDigest ||
      review.draftAuthorActorReference !== header.authoredByReference
    )
      return fail();
    // Same independent reviewers as Recipe publication; the subject is explicitly this content revision.
    const validated = parseRecipePublicationEvidence(
      {
        recipeReference: snapshot.recipeReference,
        versionReference: content.contentReference,
        brandReference: snapshot.brandReference,
        snapshotDigest: content.contentDigest,
        draftAuthorActorReference: header.authoredByReference,
        reviews: review.reviews,
      },
      {
        recipeReference: snapshot.recipeReference,
        versionReference: parseRecipeReference(content.contentReference),
        brandReference: snapshot.brandReference,
        snapshotDigest: content.contentDigest as RecipeSnapshot["snapshotDigest"],
        createdAt: header.publishedAt,
      },
    );
    if (validated.reviews.some((r) => r.reviewedAt < header.authoredAt)) return fail();
    return Object.freeze({
      ...header,
      content,
      reviewEvidence: Object.freeze({
        contentReference: content.contentReference,
        contentDigest: content.contentDigest,
        draftAuthorActorReference: header.authoredByReference,
        reviews: Object.freeze(
          [...validated.reviews].sort((a, b) => (a.reviewKind < b.reviewKind ? -1 : 1)),
        ),
      }),
    });
  } catch {
    return fail();
  }
}
