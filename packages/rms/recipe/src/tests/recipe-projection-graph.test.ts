import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { buildRecipeProjectionGraph } from "../application/recipe-projection-graph.js";
import { preparationRecipeFixture } from "./recipe-preparation-content.fixture.js";
import { parseRecipeReference, parseRecipeDigest, type RecipeSnapshot } from "../domain/recipe.js";
const id = (n: number) =>
  parseRecipeReference(`01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`);
const scope = { tenantReference: id(9000), brandReference: id(9001) },
  at = "2026-09-28T00:00:00.000Z";
function recipe(n: number, version = 1, child?: RecipeSnapshot): RecipeSnapshot {
  return {
    ...preparationRecipeFixture(child ? { sub: child } : {}),
    recipeReference: id(n),
    versionReference: id(10000 + n * 20 + version),
    brandReference: scope.brandReference,
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: parseRecipeDigest(
      `sha256:${(n * 20 + version).toString(16).padStart(64, "0")}`,
    ),
  };
}
function facts(currentRecipes: readonly RecipeSnapshot[], recipes = currentRecipes) {
  const dependencies = recipes
    .map((item) => ({
      objectReference: item.recipeReference,
      versionReference: item.versionReference,
      digest: item.snapshotDigest,
    }))
    .sort(
      (a, b) =>
        a.objectReference.localeCompare(b.objectReference) ||
        a.versionReference.localeCompare(b.versionReference),
    );
  const roots = currentRecipes
    .map((item) => ({
      objectReference: item.recipeReference,
      versionReference: item.versionReference,
    }))
    .sort((a, b) => a.objectReference.localeCompare(b.objectReference));
  const coverage = {
    ...scope,
    family: "Recipe",
    snapshotReference: id(9999),
    digest: `sha256:${createHash("sha256")
      .update(canonicalizeRfc8785({ family: "Recipe", ...scope, dependencies, roots }))
      .digest("hex")}`,
    complete: true,
    dependencies,
  };
  return { source: { coverage, capturedAtUtc: at, asOfUtc: at }, currentRecipes, recipes };
}
function chain(length: number) {
  const result: RecipeSnapshot[] = [];
  let child: RecipeSnapshot | undefined;
  for (let n = length - 1; n >= 0; n--) {
    child = recipe(200 + n, 1, child);
    result.unshift(child);
  }
  return result;
}
describe("coverage-bound deterministic Recipe projection graph", () => {
  it("derives a complete empty owner graph without inventing nodes", () => {
    const graph = buildRecipeProjectionGraph(facts([]));
    expect(graph.currentRoots).toEqual([]);
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
    expect(graph.postorderVersions).toEqual([]);
  });
  it("retains current and pinned historical versions separately with deterministic replay", () => {
    const old = recipe(1),
      current = recipe(1, 2),
      parent = recipe(2, 1, old),
      input = facts([parent, current], [parent, current, old]);
    const graph = buildRecipeProjectionGraph(input);
    expect(graph.nodes).toHaveLength(3);
    expect(graph.currentRoots.map((item) => item.versionReference)).toEqual([
      current.versionReference,
      parent.versionReference,
    ]);
    expect(graph.edges[0]).toMatchObject({
      fromVersionReference: parent.versionReference,
      toVersionReference: old.versionReference,
      toRecipeReference: old.recipeReference,
    });
    expect(graph.postorderVersions).toEqual([
      current.versionReference,
      old.versionReference,
      parent.versionReference,
    ]);
    expect(
      buildRecipeProjectionGraph({
        ...input,
        currentRecipes: [current, parent],
        recipes: [old, parent, current],
      }),
    ).toEqual(graph);
  });
  it("binds root selection independently of an unchanged complete version set", () => {
    const old = recipe(1),
      current = recipe(1, 2),
      parent = recipe(2, 1, old),
      input = facts([current, parent], [old, current, parent]);
    expect(() => buildRecipeProjectionGraph({ ...input, currentRecipes: [old, parent] })).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INTEGRITY_CONFLICT" }),
    );
  });
  it.each(["duplicate", "foreign", "rootMismatch"])("rejects inconsistent facts: %s", (mode) => {
    const item = recipe(1),
      input = facts([item]);
    const changed =
      mode === "duplicate"
        ? { ...input, recipes: [item, item] }
        : mode === "foreign"
          ? { ...input, recipes: [{ ...item, brandReference: id(99) }] }
          : { ...input, currentRecipes: [{ ...item, displayNameCode: "CHANGED_NAME" }] };
    expect(() => buildRecipeProjectionGraph(changed)).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INPUT_INVALID" }),
    );
  });
  it("rejects missing or mismatched committed dependency content", () => {
    const item = recipe(1),
      input = facts([item]);
    expect(() => buildRecipeProjectionGraph({ ...input, recipes: [] })).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INPUT_INVALID" }),
    );
    expect(() =>
      buildRecipeProjectionGraph({
        ...input,
        source: { ...input.source, coverage: { ...input.source.coverage, dependencies: [] } },
      }),
    ).toThrow(expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INTEGRITY_CONFLICT" }));
  });
  it("rejects unresolved pinned targets and extra unreachable versions", () => {
    const child = recipe(1),
      parent = recipe(2, 1, child);
    expect(() => buildRecipeProjectionGraph(facts([parent]))).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_UNRESOLVED" }),
    );
    expect(() => buildRecipeProjectionGraph(facts([child], [child, recipe(3)]))).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_UNRESOLVED" }),
    );
  });
  it.each(["direct", "indirect"])("rejects graph cycles: %s", (mode) => {
    const leaf = recipe(1),
      parent = recipe(2, 1, leaf),
      cyclic = {
        ...leaf,
        ingredients: preparationRecipeFixture({ sub: mode === "direct" ? leaf : parent })
          .ingredients,
      };
    expect(() =>
      buildRecipeProjectionGraph(facts([cyclic], mode === "direct" ? [cyclic] : [cyclic, parent])),
    ).toThrow(expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_CYCLE" }));
  });
  it("accepts sixteen edges but rejects a seventeenth", () => {
    const valid = chain(17),
      deep = chain(18),
      root = valid[0],
      deepRoot = deep[0];
    if (!root || !deepRoot) throw Error();
    expect(buildRecipeProjectionGraph(facts([root], valid)).nodes).toHaveLength(17);
    expect(() => buildRecipeProjectionGraph(facts([deepRoot], deep))).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_UNRESOLVED" }),
    );
  });
  it("checks total path depth when a shared suffix was visited from a shorter root", () => {
    const deep = chain(18),
      long = deep[0],
      suffix = deep[16];
    if (!long || !suffix) throw Error();
    const short = recipe(1, 1, suffix);
    expect(() => buildRecipeProjectionGraph(facts([short, long], [...deep, short]))).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_UNRESOLVED" }),
    );
  });
  it("keeps returned metadata immutable and excludes cost/allergen payload fields", () => {
    const item = recipe(1),
      input = facts([item]),
      graph = buildRecipeProjectionGraph(input);
    expect(Object.isFrozen(graph)).toBe(true);
    expect(Object.isFrozen(graph.nodes)).toBe(true);
    expect(Object.keys(graph.nodes[0] ?? {})).toEqual([
      "recipeReference",
      "versionReference",
      "snapshotDigest",
    ]);
    input.source.coverage.dependencies.length = 0;
    expect(graph.source.coverage.dependencies).toHaveLength(1);
  });
  it("rejects nested/index getters without invoking them and never truncates excess facts", () => {
    const item = recipe(1),
      getter = vi.fn(() => {
        throw Error();
      }),
      values: unknown[] = [];
    Object.defineProperty(values, "0", { get: getter, enumerable: true });
    expect(() => buildRecipeProjectionGraph({ ...facts([]), recipes: values })).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INPUT_INVALID" }),
    );
    const nested = { ...item, ingredients: [{ ...item.ingredients[0] }] };
    Object.defineProperty(nested.ingredients[0], "quantityMicrounits", {
      get: getter,
      enumerable: true,
    });
    expect(() => buildRecipeProjectionGraph({ ...facts([item]), recipes: [nested] })).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INPUT_INVALID" }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      buildRecipeProjectionGraph({
        ...facts([]),
        recipes: Array.from({ length: 2049 }, () => item),
      }),
    ).toThrow(expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INPUT_INVALID" }));
  });
  it("rejects incomplete owner coverage and future payload observations", () => {
    const item = recipe(1),
      input = facts([item]);
    expect(() =>
      buildRecipeProjectionGraph({
        ...input,
        source: { ...input.source, coverage: { ...input.source.coverage, complete: false } },
      }),
    ).toThrow(expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INCOMPLETE" }));
    expect(() =>
      buildRecipeProjectionGraph({
        ...input,
        source: { ...input.source, capturedAtUtc: "2026-09-29T00:00:00.000Z" },
      }),
    ).toThrow(expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INPUT_INVALID" }));
  });
});
