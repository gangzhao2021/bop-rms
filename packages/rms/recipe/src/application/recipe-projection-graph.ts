import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import type { RecipeSnapshot } from "../domain/recipe.js";
import type { RecipeSourceCoverage } from "./recipe-source-coverage.js";
import { parseRecipeProjectionFacts } from "./recipe-projection-facts.js";
import { RecipeProjectionGraphError } from "./recipe-projection-graph-error.js";
export { RecipeProjectionGraphError } from "./recipe-projection-graph-error.js";
export interface RecipeProjectionGraphNode {
  readonly recipeReference: string;
  readonly versionReference: string;
  readonly snapshotDigest: string;
}
export interface RecipeProjectionGraphEdge {
  readonly requirementReference: string;
  readonly fromRecipeReference: string;
  readonly fromVersionReference: string;
  readonly toRecipeReference: string;
  readonly toVersionReference: string;
}
export interface RecipeProjectionGraph {
  readonly source: {
    readonly coverage: RecipeSourceCoverage;
    readonly capturedAtUtc: string;
    readonly asOfUtc: string;
  };
  readonly currentRoots: readonly RecipeProjectionGraphNode[];
  readonly nodes: readonly RecipeProjectionGraphNode[];
  readonly edges: readonly RecipeProjectionGraphEdge[];
  readonly postorderVersions: readonly string[];
}
const fail = (
  code: RecipeProjectionGraphError["code"] = "RECIPE_PROJECTION_GRAPH_INPUT_INVALID",
): never => {
  throw new RecipeProjectionGraphError(code);
};
/** Restricted owner payload only. This validates graph coverage, never field permission or safety. */
export function buildRecipeProjectionGraph(value: unknown): RecipeProjectionGraph {
  try {
    const facts = parseRecipeProjectionFacts(value),
      { coverage, capturedAtUtc, asOfUtc } = facts.source,
      recipes = facts.recipes,
      roots = facts.currentRecipes;
    const byVersion = new Map<string, RecipeSnapshot>();
    for (const item of recipes) {
      if (byVersion.has(item.versionReference)) return fail();
      byVersion.set(item.versionReference, item);
    }
    const rootObjects = new Set<string>();
    for (const root of roots) {
      const node = byVersion.get(root.versionReference);
      if (
        rootObjects.has(root.recipeReference) ||
        !node ||
        canonicalizeRfc8785(node) !== canonicalizeRfc8785(root)
      )
        return fail();
      rootObjects.add(root.recipeReference);
    }
    const compare = (a: RecipeProjectionGraphNode, b: RecipeProjectionGraphNode) =>
      a.recipeReference.localeCompare(b.recipeReference) ||
      a.versionReference.localeCompare(b.versionReference);
    const node = (item: RecipeSnapshot): RecipeProjectionGraphNode =>
      Object.freeze({
        recipeReference: item.recipeReference,
        versionReference: item.versionReference,
        snapshotDigest: item.snapshotDigest,
      });
    const nodes = recipes.map(node).sort(compare),
      currentRoots = roots.map(node).sort(compare);
    const dependencies = nodes.map((item) => ({
      objectReference: item.recipeReference,
      versionReference: item.versionReference,
      digest: item.snapshotDigest,
    }));
    if (canonicalizeRfc8785(dependencies) !== canonicalizeRfc8785(coverage.dependencies))
      return fail("RECIPE_PROJECTION_GRAPH_INTEGRITY_CONFLICT");
    const digest = `sha256:${createHash("sha256")
      .update(
        canonicalizeRfc8785({
          family: "Recipe",
          tenantReference: coverage.tenantReference,
          brandReference: coverage.brandReference,
          dependencies,
          roots: currentRoots.map((item) => ({
            objectReference: item.recipeReference,
            versionReference: item.versionReference,
          })),
        }),
      )
      .digest("hex")}`;
    if (digest !== coverage.digest) return fail("RECIPE_PROJECTION_GRAPH_INTEGRITY_CONFLICT");
    const edges: RecipeProjectionGraphEdge[] = [],
      children = new Map<string, readonly string[]>();
    for (const item of recipes) {
      const targets: string[] = [];
      for (const requirement of item.ingredients) {
        if (requirement.sourceKind !== "SubRecipe") continue;
        const child = byVersion.get(requirement.sourceVersionReference);
        if (!child || child.recipeReference !== requirement.sourceReference)
          return fail("RECIPE_PROJECTION_GRAPH_UNRESOLVED");
        targets.push(child.versionReference);
        edges.push(
          Object.freeze({
            requirementReference: requirement.requirementReference,
            fromRecipeReference: item.recipeReference,
            fromVersionReference: item.versionReference,
            toRecipeReference: child.recipeReference,
            toVersionReference: child.versionReference,
          }),
        );
      }
      children.set(item.versionReference, Object.freeze([...new Set(targets)].sort()));
    }
    const heights = new Map<string, number>(),
      visiting = new Set<string>(),
      postorder: string[] = [];
    function visit(version: string, depth: number): number {
      if (depth > 16) return fail("RECIPE_PROJECTION_GRAPH_UNRESOLVED");
      if (visiting.has(version)) return fail("RECIPE_PROJECTION_GRAPH_CYCLE");
      const known = heights.get(version);
      if (known !== undefined) {
        if (depth + known > 16) return fail("RECIPE_PROJECTION_GRAPH_UNRESOLVED");
        return known;
      }
      visiting.add(version);
      let height = 0;
      for (const child of children.get(version) ?? [])
        height = Math.max(height, 1 + visit(child, depth + 1));
      visiting.delete(version);
      heights.set(version, height);
      postorder.push(version);
      return height;
    }
    for (const root of currentRoots) visit(root.versionReference, 0);
    if (heights.size !== nodes.length) return fail("RECIPE_PROJECTION_GRAPH_UNRESOLVED");
    edges.sort(
      (a, b) =>
        a.fromRecipeReference.localeCompare(b.fromRecipeReference) ||
        a.fromVersionReference.localeCompare(b.fromVersionReference) ||
        a.requirementReference.localeCompare(b.requirementReference),
    );
    return Object.freeze({
      source: Object.freeze({ coverage, capturedAtUtc, asOfUtc }),
      currentRoots: Object.freeze(currentRoots),
      nodes: Object.freeze(nodes),
      edges: Object.freeze(edges),
      postorderVersions: Object.freeze(postorder),
    });
  } catch (error) {
    if (error instanceof RecipeProjectionGraphError) throw error;
    return fail();
  }
}
