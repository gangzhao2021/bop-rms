import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { RecipeError, parseRecipeReference } from "../domain/recipe.js";
import { requireRecipeMeasurementContentDigest } from "./recipe-measurement-content-digest.js";
import { calculateRecipeMeasurementDemand } from "./recipe-measurement-recursive-demand.js";
const fail = (): never => {
  throw new RecipeError("RECIPE_GRAPH_UNRESOLVED");
};
function list(value: unknown, max: number): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length === 0 ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}
/** Pure independent one-batch demands for exact selected Published roots.
 * Shared children remain separate consumption paths. No Product/SKU serving quantity is inferred. */
export function calculateRecipeMeasurementBatchDemands(
  rootVersions: unknown,
  contentInput: unknown,
  now: string,
  activationAt: string,
) {
  const roots = list(rootVersions, 256).map(parseRecipeReference).sort(),
    contents = list(contentInput, 256)
      .map(requireRecipeMeasurementContentDigest)
      .sort((a, b) => a.snapshot.versionReference.localeCompare(b.snapshot.versionReference));
  if (
    new Set(roots).size !== roots.length ||
    new Set(contents.map((c) => c.snapshot.versionReference)).size !== contents.length ||
    contents.some(
      (c) =>
        c.snapshot.lifecycle !== "Published" ||
        c.snapshot.brandReference !== contents[0]?.snapshot.brandReference,
    ) ||
    contents.reduce((n, c) => n + c.snapshot.ingredients.length, 0) > 4096
  )
    return fail();
  const versions = new Map(contents.map((c) => [c.snapshot.versionReference, c])),
    covered = new Set<string>();
  let paths = 0;
  const batches = roots.map((version) => {
    const root = versions.get(version);
    if (!root) return fail();
    const seen = new Set<string>([version]),
      pending = [root];
    while (pending.length) {
      const c = pending.pop();
      if (!c) return fail();
      covered.add(c.snapshot.versionReference);
      for (const i of c.snapshot.ingredients) {
        if (i.sourceKind !== "SubRecipe") continue;
        const child = versions.get(i.sourceVersionReference);
        if (!child || child.snapshot.recipeReference !== i.sourceReference) return fail();
        if (!seen.has(child.snapshot.versionReference)) {
          seen.add(child.snapshot.versionReference);
          pending.push(child);
        }
      }
    }
    const batch = calculateRecipeMeasurementDemand(
      root,
      contents.filter(
        (c) => c.snapshot.versionReference !== version && seen.has(c.snapshot.versionReference),
      ),
      root.snapshot.yieldQuantityMicrounits,
      now,
      activationAt,
    );
    paths += batch.demands.length;
    if (paths > 4096) return fail();
    return batch;
  });
  if (covered.size !== contents.length) return fail();
  const body = {
    profile: "RecipeMeasurementBatchDemandsV1" as const,
    contentGraphDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(contents)),
    rootVersionReferences: Object.freeze(roots),
    batches: Object.freeze(batches),
    quantityBasis: "OneIndependentRecipeBatchPerRoot" as const,
    assessedAt: now,
    activationAt,
    productQuantity: "NotEvaluated" as const,
    inventoryPrecision: "NotEvaluated" as const,
    sourceAuthority: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
