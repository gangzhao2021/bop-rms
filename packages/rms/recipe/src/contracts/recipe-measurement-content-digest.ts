import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createRecipeMeasurementContentV2,
  type RecipeMeasurementContentV2,
} from "../domain/recipe-measurement-content.js";
import { parseRecipeDigest, RecipeError } from "../domain/recipe.js";
import { parseRecipePublicationEvidence } from "../domain/publication-review.js";
/** Stable complete content digest. Core digest is excluded to avoid self-reference. */
export function digestRecipeMeasurementContentV2(value: unknown) {
  const content = createRecipeMeasurementContentV2(value),
    { snapshotDigest: _digest, ...core } = content.snapshot;
  void _digest;
  return parseRecipeDigest(
    "sha256:" +
      sha256Hex(
        canonicalizeRfc8785({
          profile: content.profile,
          snapshot: core,
          measurements: content.measurements,
        }),
      ),
  );
}
export function requireRecipeMeasurementContentDigest(value: unknown): RecipeMeasurementContentV2 {
  const content = createRecipeMeasurementContentV2(value);
  if (content.snapshot.snapshotDigest !== digestRecipeMeasurementContentV2(content))
    throw new RecipeError("RECIPE_INPUT_INVALID");
  return content;
}
/** Evidence grammar binds the complete content; physical review/current sources remain separate. */
export function parseRecipeMeasurementPublicationEvidence(value: unknown, contentInput: unknown) {
  const content = requireRecipeMeasurementContentDigest(contentInput);
  if (content.snapshot.lifecycle !== "Published") throw new RecipeError("RECIPE_INPUT_INVALID");
  return parseRecipePublicationEvidence(value, content.snapshot);
}
