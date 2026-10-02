import { parseRecipeDigest, parseRecipeReference } from "../domain/recipe.js";

export const recipeSourceFamilies = [
  "Recipe",
  "Inventory",
  "Supplier",
  "Allergen",
  "Preparation",
  "Substitution",
  "Usage",
] as const;
export type RecipeSourceFamily = (typeof recipeSourceFamilies)[number];
export type RecipeCoverageErrorCode =
  | "RECIPE_COVERAGE_INPUT_INVALID"
  | "RECIPE_COVERAGE_INCOMPLETE"
  | "RECIPE_COVERAGE_CHANGED"
  | "RECIPE_COVERAGE_INTEGRITY_CONFLICT";
export class RecipeCoverageError extends Error {
  constructor(readonly code: RecipeCoverageErrorCode) {
    super("Recipe source coverage is unavailable");
    this.name = "RecipeCoverageError";
  }
}
export interface RecipeSourceDependency {
  readonly objectReference: string;
  readonly versionReference: string;
  readonly digest: string;
}
export interface RecipeSourceCoverage {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly family: RecipeSourceFamily;
  readonly snapshotReference: string;
  readonly digest: string;
  readonly complete: boolean;
  readonly dependencies: readonly RecipeSourceDependency[];
}
export interface RecipeCoverageSnapshot {
  readonly tenantReference: string;
  readonly brandReference: string;
  readonly sources: readonly RecipeSourceCoverage[];
}
function fail(code: RecipeCoverageErrorCode = "RECIPE_COVERAGE_INPUT_INVALID"): never {
  throw new RecipeCoverageError(code);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return fail();
  const actual = Reflect.ownKeys(value);
  if (actual.length !== keys.length) return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown, maximum: number): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const length = Object.getOwnPropertyDescriptor(value, "length");
  if (!length || !("value" in length) || length.value > maximum) return fail();
  if (Reflect.ownKeys(value).length !== length.value + 1) return fail();
  const result: unknown[] = [];
  for (let i = 0; i < length.value; i += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result.push(descriptor.value);
  }
  return result;
}
/** One owner feed; this does not establish coverage of the other mandatory families. */
export function parseRecipeSourceCoverage(value: unknown): RecipeSourceCoverage {
  try {
    const source = record(value, [
      "family",
      "tenantReference",
      "brandReference",
      "snapshotReference",
      "digest",
      "complete",
      "dependencies",
    ]);
    if (
      typeof source.family !== "string" ||
      !recipeSourceFamilies.includes(source.family as RecipeSourceFamily) ||
      typeof source.complete !== "boolean"
    )
      return fail();
    const objects = new Set<string>();
    const dependencies = list(source.dependencies, 2048)
      .map((value) => {
        const dependency = record(value, ["objectReference", "versionReference", "digest"]);
        const objectReference = parseRecipeReference(dependency.objectReference);
        const versionReference = parseRecipeReference(dependency.versionReference);
        const identity = `${objectReference}:${versionReference}`;
        if (objects.has(identity)) return fail();
        objects.add(identity);
        return Object.freeze({
          objectReference,
          versionReference,
          digest: parseRecipeDigest(dependency.digest),
        });
      })
      .sort(
        (a, b) =>
          a.objectReference.localeCompare(b.objectReference) ||
          a.versionReference.localeCompare(b.versionReference),
      );
    return Object.freeze({
      family: source.family as RecipeSourceFamily,
      tenantReference: parseRecipeReference(source.tenantReference),
      brandReference: parseRecipeReference(source.brandReference),
      snapshotReference: parseRecipeReference(source.snapshotReference),
      digest: parseRecipeDigest(source.digest),
      complete: source.complete,
      dependencies: Object.freeze(dependencies),
    });
  } catch (error) {
    if (error instanceof RecipeCoverageError) throw error;
    return fail();
  }
}
/** Internal owner contract. Input must come from authorized coherent source snapshots. */
export function parseRecipeCoverageSnapshot(value: unknown): RecipeCoverageSnapshot {
  try {
    const root = record(value, ["tenantReference", "brandReference", "sources"]);
    const tenantReference = parseRecipeReference(root.tenantReference);
    const brandReference = parseRecipeReference(root.brandReference);
    const seen = new Set<string>();
    const sources = list(root.sources, recipeSourceFamilies.length)
      .map((value) => {
        const source = parseRecipeSourceCoverage(value);
        if (
          source.tenantReference !== tenantReference ||
          source.brandReference !== brandReference ||
          seen.has(source.family)
        )
          return fail();
        seen.add(source.family);
        return source;
      })
      .sort((a, b) => a.family.localeCompare(b.family));
    if (seen.size !== recipeSourceFamilies.length) return fail();
    return Object.freeze({ tenantReference, brandReference, sources: Object.freeze(sources) });
  } catch (error) {
    if (error instanceof RecipeCoverageError) throw error;
    return fail();
  }
}
/** Equality fence only; does not order source versions or prove transaction atomicity. */
export function assertRecipeCoverageUnchanged(
  captured: unknown,
  current: unknown,
): RecipeCoverageSnapshot {
  const before = parseRecipeCoverageSnapshot(captured);
  const after = parseRecipeCoverageSnapshot(current);
  if (
    before.tenantReference !== after.tenantReference ||
    before.brandReference !== after.brandReference
  )
    return fail("RECIPE_COVERAGE_CHANGED");
  if (
    before.sources.some((source) => !source.complete) ||
    after.sources.some((source) => !source.complete)
  )
    return fail("RECIPE_COVERAGE_INCOMPLETE");
  const sources = new Map(after.sources.map((source) => [source.family, source]));
  let changed = false;
  for (const old of before.sources) {
    const next = sources.get(old.family);
    if (!next) return fail();
    const sameSnapshot = old.snapshotReference === next.snapshotReference;
    const sameDependencies = JSON.stringify(old.dependencies) === JSON.stringify(next.dependencies);
    if (sameSnapshot && (old.digest !== next.digest || !sameDependencies))
      return fail("RECIPE_COVERAGE_INTEGRITY_CONFLICT");
    const dependencies = new Map(
      next.dependencies.map((item) => [`${item.objectReference}:${item.versionReference}`, item]),
    );
    for (const item of old.dependencies) {
      const newer = dependencies.get(`${item.objectReference}:${item.versionReference}`);
      if (newer?.versionReference === item.versionReference && newer.digest !== item.digest)
        return fail("RECIPE_COVERAGE_INTEGRITY_CONFLICT");
    }
    if (!sameSnapshot || old.digest !== next.digest || !sameDependencies) changed = true;
  }
  if (changed) return fail("RECIPE_COVERAGE_CHANGED");
  return before;
}
