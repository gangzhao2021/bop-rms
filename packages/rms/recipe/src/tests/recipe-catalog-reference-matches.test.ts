import { describe, it, expect } from "vitest";
import { matchRecipeCatalogReferences, matchRecipeCatalogReferenceGraphs } from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRequest as request,
  recipeMatchTarget as target,
  recipeMatchSource as source,
  recipeMatchRaw as raw,
} from "./recipe-catalog-reference-matches.fixture.js";
const input = () => ({ request, target: target(), source: source(), now: at });
const denied = expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
describe("owning minimal Recipe SKU/Option reference matching", () => {
  it("retains all lifecycle history, original parents and Store/future metadata without eligibility", () => {
    const r = matchRecipeCatalogReferences(input());
    expect(r.references).toHaveLength(1);
    expect(r.references[0]?.bindings[0]?.storeReference).toBe(id(99));
    expect(r.references[0]?.modifiers.map((m) => m.reference.lifecycle)).toEqual([
      "Draft",
      "Archived",
    ]);
    expect(r.references[0]?.isCurrentRecipeVersion).toBe(true);
    expect(r.references[0]?.version.effectiveFrom).toBe("2027-01-01T00:00:00.000Z");
    expect(r.applicability).toBe("Unavailable");
    expect(r.recipeResolution).toBe("Unavailable");
  });
  it("keeps unknown binding/Option/SKU references explicitly unresolved", () => {
    const r = matchRecipeCatalogReferences(input());
    const reasons = r.unresolved.flatMap((g) => [
      ...g.bindings.map((b) => b.reason),
      ...g.modifiers.map((m) => m.reason),
    ]);
    expect(reasons).toContain("BindingNotInConfiguration");
    expect(reasons).toContain("OptionNotEnabledInConfiguration");
    expect(reasons).toContain("SkuNotInConfiguration");
    expect(
      r.unresolved.flatMap((g) => g.modifiers.map((m) => m.reference.ruleVersionReference)),
    ).toContain(id(49));
  });
  it("matches each graph independently instead of unioning SKU and Option", () => {
    const graphs = matchRecipeCatalogReferenceGraphs({
      request,
      targets: [target(), target(7, 81)],
      source: source(),
      now: at,
    });
    expect(graphs[0]?.references[0]?.modifiers.map((m) => m.reference.optionReference)).toEqual([
      id(80),
      id(80),
    ]);
    expect(graphs[1]?.references[0]?.version.recipeVersionReference).toBe(id(12));
    expect(graphs[1]?.references[0]?.modifiers.map((m) => m.reference.optionReference)).toEqual([
      id(81),
    ]);
    expect(graphs[1]?.references[0]?.isCurrentRecipeVersion).toBe(false);
  });
  it("returns explicit empty refs when selected SKU is absent from graph", () => {
    const r = matchRecipeCatalogReferences({
      ...input(),
      target: { ...target(7, 81), skuReference: id(6) },
    });
    expect(r.targetMembership).toBe("Absent");
    expect(r.references).toEqual([]);
    expect(r.unresolved).toEqual([]);
    expect(r.expandedRows).toBe(0);
  });
  it("honors included/excluded SKU scopes without selecting unknown Options", () => {
    const t = target();
    const b = t.bindings[0];
    if (!b) throw new Error("fixture");
    const r = matchRecipeCatalogReferences({
      ...input(),
      target: {
        ...t,
        bindings: [{ ...b, includedSkuReferences: [], excludedSkuReferences: [id(6)] }],
      },
    });
    expect(r.references.flatMap((g) => g.modifiers)).toEqual([]);
    expect(r.unresolved.flatMap((g) => g.modifiers.map((m) => m.reason))).toContain(
      "NoSelectedSkuInBindingScope",
    );
  });
  it.each([
    "duplicateSku",
    "unknownScopeSku",
    "overlap",
    "duplicateBinding",
    "unknownField",
    "sourceIntent",
    "sourceDigest",
    "stale",
  ])("refuses %s", (kind) => {
    const t = target(),
      b = t.bindings[0],
      v = input();
    if (!b) throw new Error("fixture");
    let selected: unknown = t;
    if (kind === "duplicateSku") selected = { ...t, skuReferences: [id(6), id(6)] };
    if (kind === "unknownScopeSku")
      selected = { ...t, bindings: [{ ...b, includedSkuReferences: [id(99)] }] };
    if (kind === "overlap")
      selected = { ...t, bindings: [{ ...b, excludedSkuReferences: [id(6)] }] };
    if (kind === "duplicateBinding") selected = { ...t, bindings: [b, b] };
    if (kind === "unknownField") selected = { ...t, cost: "1" };
    if (kind === "sourceIntent") v.request = { ...request, operationReference: id(9) };
    if (kind === "sourceDigest") v.source = { ...v.source, digest: "sha256:" + "b".repeat(64) };
    if (kind === "stale") v.now = "2026-09-29T12:00:05.001Z";
    expect(() => matchRecipeCatalogReferences({ ...v, target: selected })).toThrow(denied);
  });
  it("refuses getters without invocation", () => {
    let calls = 0;
    const t = target();
    Object.defineProperty(t, "skuReferences", {
      enumerable: true,
      get() {
        calls++;
        return [id(6)];
      },
    });
    expect(() => matchRecipeCatalogReferences({ ...input(), target: t })).toThrow(denied);
    expect(calls).toBe(0);
  });
  it("keeps data digest stable across observations", () => {
    const r = input(),
      a = matchRecipeCatalogReferences(r),
      later = "2026-09-29T12:00:01.000Z",
      s = raw();
    s.observedAt = later;
    expect(
      matchRecipeCatalogReferences({ ...r, source: source(request, s, later), now: later }).digest,
    ).toBe(a.digest);
  });
  it("bounds expanded metadata across every graph", () => {
    expect(() =>
      matchRecipeCatalogReferenceGraphs({
        request,
        targets: Array.from({ length: 1001 }, () => target()),
        source: source(),
        now: at,
      }),
    ).toThrow(denied);
  });
});
