import { createHash } from "node:crypto";
import { preparationRecipeFixture } from "./recipe-preparation-content.fixture.js";
import type { RecipeSnapshot } from "../domain/recipe.js";
import type { RecipeModifierRule } from "../domain/recipe-modifier.js";
import {
  createRecipePreparationContentBinding,
  createRecipePreparationModifierContentBinding,
} from "../domain/recipe-preparation-content.js";
import { parseRecipePreparationPublication } from "../domain/recipe-preparation-publication.js";
export const preparationTestHash = (value: string) =>
  "sha256:" + createHash("sha256").update(value).digest("hex");
const id = (n: number) => "0190cccc-0000-7000-8000-" + n.toString(16).padStart(12, "0");

/** Explicit synthetic content/reviews; never actual Store approval. */
export function preparationPublicationFixture(
  snapshot: RecipeSnapshot = preparationRecipeFixture({ lifecycle: "Published" }),
  rule: RecipeModifierRule | null = null,
) {
  const offset = rule === null ? 100 : 200;
  const steps = snapshot.steps.map((s) => ({
    ...s,
    instructionText: "Synthetic reviewed preparation instruction.",
    capabilityReference: id(1),
  }));
  const common = {
    contentReference: id(offset),
    brandReference: snapshot.brandReference,
    recipeVersionReference: snapshot.versionReference,
    contentDigest: preparationTestHash("placeholder"),
  };
  let content;
  if (rule === null) {
    const candidate = {
      ...common,
      preparationVersionReference: snapshot.preparationVersionReference,
      recipeSnapshotDigest: snapshot.snapshotDigest,
      steps,
    };
    content = {
      ...candidate,
      contentDigest: preparationTestHash(
        createRecipePreparationContentBinding(candidate, snapshot),
      ),
    };
  } else {
    const first = steps[0];
    if (!first) throw new Error("fixture preparation missing");
    const candidate = {
      ...common,
      ruleReference: rule.ruleReference,
      ruleVersionReference: rule.ruleVersionReference,
      ruleDigest: rule.ruleDigest,
      selection: rule.selection,
      changes: [{ action: "Replace", step: { ...first, durationSeconds: 90 } }],
    };
    content = {
      ...candidate,
      contentDigest: preparationTestHash(
        createRecipePreparationModifierContentBinding(candidate, rule, snapshot),
      ),
    };
  }
  const record = {
    operationReference: id(offset + 1),
    actorReference: id(2),
    brandReference: snapshot.brandReference,
    recipeReference: snapshot.recipeReference,
    recipeVersionReference: snapshot.versionReference,
    modifierRuleVersionReference: rule?.ruleVersionReference ?? null,
    authoredByReference: id(3),
    authoredAt: snapshot.createdAt,
    publishedAt: snapshot.createdAt,
    content,
    reviewEvidence: {
      contentReference: content.contentReference,
      contentDigest: content.contentDigest,
      draftAuthorActorReference: id(3),
      reviews: [
        {
          reviewReference: id(offset + 2),
          reviewKind: "Cost",
          reviewerActorReference: id(4),
          evidenceDigest: preparationTestHash("synthetic-cost-review"),
          reviewedAt: snapshot.createdAt,
          decision: "Approved",
        },
        {
          reviewReference: id(offset + 3),
          reviewKind: "FoodSafety",
          reviewerActorReference: id(5),
          evidenceDigest: preparationTestHash("synthetic-safety-review"),
          reviewedAt: snapshot.createdAt,
          decision: "Approved",
        },
      ],
    },
  };
  return {
    snapshot,
    rule,
    record: parseRecipePreparationPublication(record, snapshot, rule, preparationTestHash),
  };
}
