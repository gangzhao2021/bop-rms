import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import type { RecipeDigest, RecipeSnapshot } from "../domain/recipe.js";
import type { RecipePresentation } from "../domain/recipe-authoring.js";

/** WP-2423 / DEC-RECIPE-AUTHORING: canonical SHA-256 digests of recipe versions and reviews. */
export function recipeSnapshotDigest(
  snapshot: Omit<RecipeSnapshot, "snapshotDigest">,
): RecipeDigest {
  const { snapshotDigest: _ignored, ...core } = snapshot as RecipeSnapshot;
  void _ignored;
  return ("sha256:" + sha256Hex(canonicalizeRfc8785(core))) as RecipeDigest;
}
/** What a reviewer approves: the exact version content plus its names, texts and stations. */
export function recipeReviewDigest(
  snapshot: RecipeSnapshot,
  displayName: string,
  presentation: RecipePresentation,
) {
  return "sha256:" + sha256Hex(canonicalizeRfc8785({ snapshot, displayName, presentation }));
}
