import type { RecipeModifierRule } from "./recipe-modifier.js";
import {
  parseRecipeReference,
  parseRecipeDigest,
  RecipeError,
  type RecipeSnapshot,
} from "./recipe.js";
export interface RecipePublicationReview {
  readonly reviewReference: string;
  readonly reviewKind: "Cost" | "FoodSafety";
  readonly reviewerActorReference: string;
  readonly evidenceDigest: string;
  readonly reviewedAt: string;
  readonly decision: "Approved";
}
export interface RecipePublicationEvidence {
  readonly recipeReference: string;
  readonly versionReference: string;
  readonly brandReference: string;
  readonly snapshotDigest: string;
  readonly draftAuthorActorReference: string;
  readonly reviews: readonly RecipePublicationReview[];
}
function fail(): never {
  throw new RecipeError("RECIPE_INPUT_INVALID");
}
function closed(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const parsed: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    parsed[key] = d.value;
  }
  return parsed;
}
/** Explicit approved evidence; reviewer permission booleans alone are not review history. */
export function parseRecipePublicationEvidence(
  value: unknown,
  snapshot: Pick<
    RecipeSnapshot,
    "recipeReference" | "versionReference" | "brandReference" | "snapshotDigest" | "createdAt"
  >,
): RecipePublicationEvidence {
  const raw = closed(value, [
    "recipeReference",
    "versionReference",
    "brandReference",
    "snapshotDigest",
    "draftAuthorActorReference",
    "reviews",
  ]);
  if (
    raw.recipeReference !== snapshot.recipeReference ||
    raw.versionReference !== snapshot.versionReference ||
    raw.brandReference !== snapshot.brandReference ||
    raw.snapshotDigest !== snapshot.snapshotDigest ||
    !Array.isArray(raw.reviews) ||
    raw.reviews.length !== 2 ||
    Reflect.ownKeys(raw.reviews).length !== 3
  )
    return fail();
  const author = parseRecipeReference(raw.draftAuthorActorReference);
  const reviews: RecipePublicationReview[] = [];
  for (let i = 0; i < 2; i++) {
    const entry = Object.getOwnPropertyDescriptor(raw.reviews, String(i));
    if (!entry?.enumerable || !("value" in entry)) return fail();
    const review = closed(entry.value, [
      "reviewReference",
      "reviewKind",
      "reviewerActorReference",
      "evidenceDigest",
      "reviewedAt",
      "decision",
    ]);
    if (
      (review.reviewKind !== "Cost" && review.reviewKind !== "FoodSafety") ||
      review.decision !== "Approved" ||
      typeof review.reviewedAt !== "string" ||
      !Number.isFinite(Date.parse(review.reviewedAt)) ||
      new Date(review.reviewedAt).toISOString() !== review.reviewedAt ||
      review.reviewedAt > snapshot.createdAt
    )
      return fail();
    const actor = parseRecipeReference(review.reviewerActorReference);
    if (actor === author) return fail();
    reviews.push(
      Object.freeze({
        reviewReference: parseRecipeReference(review.reviewReference),
        reviewKind: review.reviewKind,
        reviewerActorReference: actor,
        evidenceDigest: parseRecipeDigest(review.evidenceDigest),
        reviewedAt: review.reviewedAt,
        decision: "Approved",
      }),
    );
  }
  if (
    new Set(reviews.map((r) => r.reviewKind)).size !== 2 ||
    new Set(reviews.map((r) => r.reviewerActorReference)).size !== 2 ||
    new Set(reviews.map((r) => r.reviewReference)).size !== 2
  )
    return fail();
  return Object.freeze({
    recipeReference: snapshot.recipeReference,
    versionReference: snapshot.versionReference,
    brandReference: snapshot.brandReference,
    snapshotDigest: snapshot.snapshotDigest,
    draftAuthorActorReference: author,
    reviews: Object.freeze(reviews),
  });
}

export interface RecipeModifierPublicationEvidence {
  readonly ruleReference: string;
  readonly ruleVersionReference: string;
  readonly brandReference: string;
  readonly recipeVersionReference: string;
  readonly ruleDigest: string;
  readonly draftAuthorActorReference: string;
  readonly reviews: readonly RecipePublicationReview[];
}
/** Reuses reviewer independence validation, with the reviewed subject explicitly being the rule. */
export function parseRecipeModifierPublicationEvidence(
  value: unknown,
  rule: RecipeModifierRule,
  publishedAt: string,
): RecipeModifierPublicationEvidence {
  const raw = closed(value, [
    "ruleReference",
    "ruleVersionReference",
    "brandReference",
    "recipeVersionReference",
    "ruleDigest",
    "draftAuthorActorReference",
    "reviews",
  ]);
  if (
    raw.ruleReference !== rule.ruleReference ||
    raw.ruleVersionReference !== rule.ruleVersionReference ||
    raw.brandReference !== rule.brandReference ||
    raw.recipeVersionReference !== rule.recipeVersionReference ||
    raw.ruleDigest !== rule.ruleDigest ||
    !Number.isFinite(Date.parse(publishedAt)) ||
    new Date(publishedAt).toISOString() !== publishedAt
  )
    return fail();
  const subject = {
    recipeReference: parseRecipeReference(rule.ruleReference),
    versionReference: parseRecipeReference(rule.ruleVersionReference),
    brandReference: parseRecipeReference(rule.brandReference),
    snapshotDigest: parseRecipeDigest(rule.ruleDigest),
    createdAt: publishedAt,
  };
  const validated = parseRecipePublicationEvidence(
    {
      recipeReference: rule.ruleReference,
      versionReference: rule.ruleVersionReference,
      brandReference: rule.brandReference,
      snapshotDigest: rule.ruleDigest,
      draftAuthorActorReference: raw.draftAuthorActorReference,
      reviews: raw.reviews,
    },
    subject,
  );
  return Object.freeze({
    ruleReference: rule.ruleReference,
    ruleVersionReference: rule.ruleVersionReference,
    brandReference: rule.brandReference,
    recipeVersionReference: rule.recipeVersionReference,
    ruleDigest: rule.ruleDigest,
    draftAuthorActorReference: validated.draftAuthorActorReference,
    reviews: validated.reviews,
  });
}
