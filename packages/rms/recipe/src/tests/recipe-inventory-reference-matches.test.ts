import { describe, it, expect } from "vitest";
import { matchRecipeInventoryReferenceRoots as match } from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchDigest as digest,
} from "./recipe-catalog-reference-matches.fixture.js";
import {
  recipeInventoryMatchRaw as raw,
  recipeInventoryMatchSource as source,
  recipeInventoryItemId as item,
} from "./recipe-inventory-reference-matches.fixture.js";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(4),
  catalogIntentDigest: digest,
};
const run = (rootGroups: unknown = [[id(11)]], s: unknown = source(request), now = at) =>
  match({ request, rootGroups, source: s, now });
const unavailable = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
describe("Recipe stored Inventory reachability", () => {
  it("traverses base pinned SubRecipe versions without choosing current Recipe version", () => {
    const result = run()[0];
    expect(
      result?.reachableVersions.map((v) => [
        v.version.recipeVersionReference,
        v.conditional,
        v.isCurrentRecipeVersion,
      ]),
    ).toEqual([
      [id(11), false, true],
      [id(12), false, false],
      [id(11), true, true],
      [id(12), true, false],
    ]);
    expect(
      result?.requirements.find(
        (r) =>
          r.kind === "BaseIngredient" &&
          r.reference.sourceKind === "InventoryItem" &&
          !r.conditional,
      )?.reference,
    ).toMatchObject({ sourceReference: item(6), sourceVersionReference: item(7) });
  });
  it("keeps conditional Add/Replace and unresolved Remove rather than applying historical changes", () => {
    const result = run()[0];
    expect(result?.requirements.filter((r) => r.kind === "ModifierAdd")).toHaveLength(1);
    expect(result?.requirements.find((r) => r.kind === "ModifierReplace")).toMatchObject({
      conditional: true,
      modifier: { lifecycle: "Archived" },
      reference: { action: "Replace" },
    });
    expect(result?.requirements.find((r) => r.kind === "ModifierRemove")).toMatchObject({
      conditional: true,
      reference: { action: "Remove", requirementReference: id(50) },
    });
    expect(
      result?.requirements
        .filter((r) => r.kind === "BaseIngredient" && r.reference.sourceKind === "InventoryItem")
        .map((r) => r.conditional),
    ).toEqual([false, true]);
    expect(result?.removalResolution).toBe("Unavailable");
    expect(result?.conditionalApplicability).toBe("Unavailable");
    expect(result?.conditionalCycleResolution).toBe("Unavailable");
  });
  it("matches root groups independently, with complete empty target relations", () => {
    const results = run([[id(11)], [id(12)], []]);
    expect(results[1]?.requirements).toHaveLength(1);
    expect(results[2]?.requirements).toEqual([]);
    expect(results[2]?.reachableVersions).toEqual([]);
  });
  it("includes root identity for shared child dependencies", () => {
    const result = run([[id(11), id(12)]])[0];
    expect(
      result?.requirements
        .filter((r) => r.kind === "BaseIngredient" && r.reference.sourceKind === "InventoryItem")
        .map((r) => r.rootRecipeVersionReference),
    ).toEqual([id(11), id(11), id(12)]);
  });
  it("stable digest and iteration are independent of input and observation order", () => {
    const a = run([[id(12), id(11)]])[0],
      r = raw();
    r.ingredients.reverse();
    r.changes.reverse();
    r.modifiers.reverse();
    r.observedAt = "2026-09-29T12:00:01.000Z";
    expect(run([[id(11), id(12)]], source(request, r, r.observedAt), r.observedAt)[0]?.digest).toBe(
      a?.digest,
    );
  });
  it.each(
    [[], [[id(99)]], [[id(11), id(11)]], [["bad"]], Array(1002).fill([])].map((rootGroups) => ({
      rootGroups,
    })),
  )("refuses malformed root groups %#", ({ rootGroups }) =>
    expect(() => run(rootGroups)).toThrow(unavailable),
  );
  it("refuses root accessor and inherited array without evaluation", () => {
    let calls = 0;
    const roots = [id(11)];
    Object.defineProperty(roots, "0", {
      enumerable: true,
      get() {
        calls++;
        return id(11);
      },
    });
    expect(() => run([roots])).toThrow(unavailable);
    expect(calls).toBe(0);
    const inherited = [id(11)];
    Object.setPrototypeOf(inherited, null);
    expect(() => run([inherited])).toThrow(unavailable);
  });
  it("refuses stale, substituted and tampered source identity", () => {
    expect(() => run([[id(11)]], source(request), "2026-09-29T12:00:06.000Z")).toThrow(unavailable);
    expect(() => run([[id(11)]], source({ ...request, operationReference: id(99) }))).toThrow(
      unavailable,
    );
    expect(() => run([[id(11)]], { ...source(request), digest })).toThrow(unavailable);
  });
  it("bounds total output expansion across repeated rooted graphs", () =>
    expect(() => run(Array(1000).fill([id(11)]))).toThrow(unavailable));
  it("does not export rich Ingredient/health facts or claim Inventory resolution", () => {
    const result = run()[0];
    expect(result?.applicability).toBe("Unavailable");
    expect(JSON.stringify(result)).not.toMatch(
      /selectedQuantity|quantity|cost|allergen|snapshot_json|stock/,
    );
    expect(Object.isFrozen(result?.requirements)).toBe(true);
  });
});
