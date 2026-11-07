import { createRecipeSnapshot, type RecipeSnapshot } from "../domain/recipe.js";
import { parseRecipeSourceCoverage, type RecipeSourceCoverage } from "./recipe-source-coverage.js";
/** Private Application parsing support; no authorization or Merchant response contract. */
export interface ParsedRecipeProjectionFacts {
  readonly source: {
    readonly coverage: RecipeSourceCoverage;
    readonly capturedAtUtc: string;
    readonly asOfUtc: string;
  };
  readonly recipes: readonly RecipeSnapshot[];
  readonly currentRecipes: readonly RecipeSnapshot[];
}
import { RecipeProjectionGraphError } from "./recipe-projection-graph-error.js";
function fail(
  code: RecipeProjectionGraphError["code"] = "RECIPE_PROJECTION_GRAPH_INPUT_INVALID",
): never {
  throw new RecipeProjectionGraphError(code);
}
function record(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const d = Object.getOwnPropertyDescriptor(value, key);
    if (!d?.enumerable || !("value" in d)) return fail();
    result[key] = d.value;
  }
  return result;
}
function list(value: unknown, max = 2048): readonly unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return fail();
  const d = Object.getOwnPropertyDescriptor(value, "length");
  if (!d || !("value" in d) || d.value > max || Reflect.ownKeys(value).length !== d.value + 1)
    return fail();
  const result: unknown[] = [];
  for (let i = 0; i < d.value; i++) {
    const entry = Object.getOwnPropertyDescriptor(value, String(i));
    if (!entry?.enumerable || !("value" in entry)) return fail();
    result.push(entry.value);
  }
  return result;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    new Date(value).toISOString() !== value
  )
    return fail();
  return value;
}
export function parseRecipeProjectionFacts(value: unknown): ParsedRecipeProjectionFacts {
  const raw = record(value, ["source", "currentRecipes", "recipes"]),
    sourceRow = record(raw.source, ["coverage", "capturedAtUtc", "asOfUtc"]),
    coverage = parseRecipeSourceCoverage(sourceRow.coverage),
    capturedAtUtc = instant(sourceRow.capturedAtUtc),
    asOfUtc = instant(sourceRow.asOfUtc);
  if (coverage.family !== "Recipe" || capturedAtUtc > asOfUtc) return fail();
  if (!coverage.complete) return fail("RECIPE_PROJECTION_GRAPH_INCOMPLETE");
  let remaining = 2_000_000;
  // Guard descriptors before the existing Domain parser sees nested array indexes/values.
  function json(input: unknown, depth = 0): unknown {
    if (--remaining < 0 || depth > 16) return fail();
    if (input === null || typeof input === "boolean") return input;
    if (typeof input === "string") {
      if (input.length > 4096) return fail();
      return input;
    }
    if (typeof input === "number") {
      if (!Number.isFinite(input)) return fail();
      return input;
    }
    if (Array.isArray(input)) return list(input).map((item) => json(item, depth + 1));
    if (typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype)
      return fail();
    const keys = Reflect.ownKeys(input);
    if (
      keys.length > 2048 ||
      keys.some(
        (key) =>
          typeof key !== "string" ||
          key === "__proto__" ||
          key === "constructor" ||
          key === "prototype",
      )
    )
      return fail();
    const own = record(input, keys as string[]),
      result: Record<string, unknown> = {};
    for (const key of keys as string[]) result[key] = json(own[key], depth + 1);
    return result;
  }
  function snapshot(input: unknown): RecipeSnapshot {
    const parsed = createRecipeSnapshot(json(input) as RecipeSnapshot);
    if (parsed.brandReference !== coverage.brandReference || instant(parsed.createdAt) > asOfUtc)
      return fail();
    return parsed;
  }
  const recipes = list(raw.recipes).map(snapshot),
    roots = list(raw.currentRecipes).map(snapshot);
  return Object.freeze({
    source: Object.freeze({ coverage, capturedAtUtc, asOfUtc }),
    recipes: Object.freeze(recipes),
    currentRecipes: Object.freeze(roots),
  });
}
