import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { buildRecipeProjectionCore } from "../application/recipe-projection-core.js";
import { RecipeProjectionGraphError } from "../application/recipe-projection-graph.js";
import { preparationRecipeFixture } from "./recipe-preparation-content.fixture.js";
import { parseRecipeDigest, parseRecipeReference, type RecipeSnapshot } from "../domain/recipe.js";
const id = (n: number) =>
  parseRecipeReference(`01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`);
const scope = { tenantReference: id(9000), brandReference: id(9001) },
  at = "2026-09-28T00:00:00.000Z";
function recipe(n: number, version = 1, child?: RecipeSnapshot): RecipeSnapshot {
  const fixture = preparationRecipeFixture(child ? { sub: child } : {});
  return {
    ...fixture,
    recipeReference: id(n),
    versionReference: id(10000 + n * 20 + version),
    brandReference: scope.brandReference,
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: parseRecipeDigest(
      `sha256:${(n * 20 + version).toString(16).padStart(64, "0")}`,
    ),
    ingredients: fixture.ingredients.map((item) => ({
      ...item,
      unitDimension: child?.yieldDimension ?? item.unitDimension,
    })),
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
  return {
    source: {
      coverage: {
        ...scope,
        family: "Recipe",
        snapshotReference: id(9999),
        digest: `sha256:${createHash("sha256")
          .update(canonicalizeRfc8785({ family: "Recipe", ...scope, dependencies, roots }))
          .digest("hex")}`,
        complete: true,
        dependencies,
      },
      capturedAtUtc: at,
      asOfUtc: at,
    },
    currentRecipes,
    recipes,
  };
}
describe("Recipe owner source-backed projection core", () => {
  it("preserves complete empty source without fabricating rows", () => {
    expect(buildRecipeProjectionCore(facts([])).rows).toEqual([]);
  });
  it("keeps current rows separate from historical pins and replays in deterministic order", () => {
    const old = recipe(1),
      current = recipe(1, 2),
      parent = recipe(2, 1, old);
    const input = facts([parent, current], [parent, old, current]),
      core = buildRecipeProjectionCore(input);
    expect(core.rows.map((row) => row.versionReference)).toEqual([
      current.versionReference,
      parent.versionReference,
    ]);
    expect(core.rows[1]?.ingredients[0]?.sourceVersionReference).toBe(old.versionReference);
    expect(core.graph.nodes).toHaveLength(3);
    expect(
      buildRecipeProjectionCore({
        ...input,
        currentRecipes: [current, parent],
        recipes: [current, old, parent],
      }),
    ).toEqual(core);
  });
  it("copies actual configuration codes and exact quantities without converting them into presentation claims", () => {
    const item = recipe(1),
      row = buildRecipeProjectionCore(facts([item])).rows[0];
    expect(row).toMatchObject({
      displayNameCode: "SYNTHETIC_NAME",
      lifecycle: "Draft",
      yieldQuantityMicrounits: "1000000",
      yieldDimension: "Count",
      yieldUnitCode: "PORTION",
      effectivePeriod: item.effectivePeriod,
      preparationVersionReference: item.preparationVersionReference,
      steps: item.steps,
      ingredients: [
        {
          quantityMicrounits: "1000000",
          conversionNumerator: "2",
          conversionDenominator: "1",
          lossBasisPoints: 1000,
        },
      ],
    });
    expect(row).not.toHaveProperty("name");
    expect(row).not.toHaveProperty("currencyCode");
    expect(row).not.toHaveProperty("costMinor");
    expect(row).not.toHaveProperty("allergenStatus");
    expect(row).not.toHaveProperty("mappingMissing");
    expect(row).not.toHaveProperty("usageSummary");
    expect(row?.ingredients[0]).not.toHaveProperty("unitCostMinorNumerator");
    expect(row?.ingredients[0]).not.toHaveProperty("unitCostDenominator");
    expect(row?.ingredients[0]).not.toHaveProperty("allergens");
  });
  it.each(["Draft", "Published"] as const)(
    "rejects incompatible pinned child yield dimension in %s configuration",
    (lifecycle) => {
      const child = { ...recipe(1), lifecycle },
        parent = { ...recipe(2, 1, child), lifecycle };
      const bad = {
        ...parent,
        ingredients: parent.ingredients.map((item) => ({
          ...item,
          unitDimension: "Mass" as const,
        })),
      };
      expect(() => buildRecipeProjectionCore(facts([bad, child]))).toThrow(
        expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_UNRESOLVED" }),
      );
    },
  );
  it("checks dimensions in a reachable historical child even when its current version is valid", () => {
    const leaf = recipe(1),
      old = recipe(2, 1, leaf),
      current = recipe(2, 2),
      parent = recipe(3, 1, old);
    const badOld = {
      ...old,
      ingredients: old.ingredients.map((item) => ({ ...item, unitDimension: "Volume" as const })),
    };
    expect(() =>
      buildRecipeProjectionCore(facts([leaf, current, parent], [leaf, badOld, current, parent])),
    ).toThrow(expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_UNRESOLVED" }));
  });
  it("derives immutable independent rows and nested configuration without retaining caller aliases", () => {
    const item = recipe(1),
      input = facts([item]),
      core = buildRecipeProjectionCore(input),
      row = core.rows[0];
    const ingredient = item.ingredients[0];
    if (!ingredient) throw new Error("missing fixture ingredient");
    Object.assign(ingredient, { quantityMicrounits: "7" });
    expect(row?.ingredients[0]?.quantityMicrounits).toBe("1000000");
    for (const value of [
      core,
      core.rows,
      row,
      row?.ingredients,
      row?.ingredients[0],
      row?.steps,
      row?.steps[0],
      row?.effectivePeriod,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });
  it("retains existing integrity failures and compatible controlled error class", () => {
    const item = recipe(1),
      input = facts([item]);
    const work = () =>
      buildRecipeProjectionCore({
        ...input,
        source: {
          ...input.source,
          coverage: { ...input.source.coverage, digest: `sha256:${"0".repeat(64)}` },
        },
      });
    expect(work).toThrow(RecipeProjectionGraphError);
    expect(work).toThrow(
      expect.objectContaining({ code: "RECIPE_PROJECTION_GRAPH_INTEGRITY_CONFLICT" }),
    );
  });
  it("rejects raw hostile errors and nested getters without exposing or invoking them", () => {
    const item = recipe(1),
      getter = vi.fn(() => "private raw cost");
    Object.defineProperty(item.ingredients[0], "unitCostMinorNumerator", {
      enumerable: true,
      get: getter,
    });
    expect(() => buildRecipeProjectionCore(facts([item]))).toThrow(
      "Recipe projection graph is unavailable",
    );
    expect(getter).not.toHaveBeenCalled();
    const hostile = new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("private secret raw SQL");
        },
      },
    );
    expect(() => buildRecipeProjectionCore(hostile)).toThrow(
      "Recipe projection graph is unavailable",
    );
  });
});
