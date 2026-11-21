import { describe, it, expect } from "vitest";
import {
  assessCurrentRecipeCatalogBindingScope,
  buildRecipeReferenceSourceSnapshot,
} from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRequest as request,
  recipeMatchTarget as target,
  recipeMatchRaw as raw,
} from "./recipe-catalog-reference-matches.fixture.js";
function first<T>(values: readonly T[]): T {
  const result = values[0];
  if (result === undefined) throw new Error("missing synthetic fixture");
  return result;
}
function fixture() {
  const r = raw();
  r.bindings = r.bindings.slice(0, 1);
  first(r.bindings).storeReference = null;
  first(r.bindings).optionBindingReference = id(20);
  r.modifiers = r.modifiers.slice(0, 1);
  for (const v of r.versions) {
    v.lifecycle = "Published";
    v.effectiveFrom = "2026-08-01T00:00:00.000Z";
  }
  for (const b of r.bindings) b.effectiveFrom = "2026-08-01T00:00:00.000Z";
  for (const m of r.modifiers) {
    m.lifecycle = "Published";
    m.effectiveFrom = "2026-08-01T00:00:00.000Z";
  }
  r.bindingCount = "1";
  r.counts.bindings = "1";
  r.counts.modifiers = "1";
  return r;
}
function assess(r = fixture(), t = target(), activationAt = "2026-09-30T00:00:00.000Z") {
  return assessCurrentRecipeCatalogBindingScope({
    request,
    target: t,
    source: buildRecipeReferenceSourceSnapshot(r, request, at),
    now: at,
    activationAt,
  });
}
describe("current Recipe stored Binding/SKU membership and periods", () => {
  it("checks current Published metadata and exact Draft SKU/Option membership without inventing Store resolution", () => {
    const r = assess();
    expect(r.decision).toBe("PassForStoredMembershipAndPeriods");
    expect(r.bindingChecks[0]?.status).toBe("CurrentStoredMembershipAndPeriods");
    expect(r.modifierChecks[0]?.status).toBe("CurrentStoredMembershipAndPeriods");
    expect(r.storeTopology).toBe("NotEvaluated");
    expect(r.uniqueRecipeResolution).toBe("NotEvaluated");
    expect(r.eligibility).toBe("NotEvaluated");
    expect(Object.isFrozen(r.bindingChecks)).toBe(true);
  });
  it.each([
    "stale",
    "unpublished",
    "recipeObserved",
    "recipeActivation",
    "bindingObserved",
    "bindingActivation",
    "modifierObserved",
    "modifierActivation",
    "modifierUnpublished",
  ])("retains %s as explicit current-period review", (kind) => {
    const r = fixture();
    if (kind === "stale") first(r.recipes).currentVersionReference = id(12);
    if (kind === "unpublished") first(r.versions).lifecycle = "Draft";
    if (kind === "recipeObserved") first(r.versions).effectiveFrom = "2026-09-30T00:00:00.000Z";
    if (kind === "recipeActivation") first(r.versions).effectiveUntil = "2026-09-30T00:00:00.000Z";
    if (kind === "bindingObserved") first(r.bindings).effectiveFrom = "2026-09-30T00:00:00.000Z";
    if (kind === "bindingActivation") first(r.bindings).effectiveUntil = "2026-09-30T00:00:00.000Z";
    if (kind === "modifierObserved") first(r.modifiers).effectiveFrom = "2026-09-30T00:00:00.000Z";
    if (kind === "modifierActivation")
      first(r.modifiers).effectiveUntil = "2026-09-30T00:00:00.000Z";
    if (kind === "modifierUnpublished") first(r.modifiers).lifecycle = "Archived";
    expect(assess(r).decision).toBe("RequiresReview");
  });
  it("does not resolve a Store override merely from a stored ID", () => {
    const r = fixture();
    first(r.bindings).storeReference = id(99);
    const a = assess(r);
    expect(a.bindingChecks[0]?.storeReference).toBe(id(99));
    expect(a.bindingChecks[0]?.storeApplicability).toBe("NotEvaluated");
  });
  it.each(["missingBinding", "optionDisabled", "excludedSku", "missingSku"])(
    "refuses membership qualification for %s",
    (kind) => {
      const t = { ...target() };
      if (kind === "missingBinding") t.bindings = [];
      if (kind === "optionDisabled")
        t.bindings = [{ ...first(t.bindings), enabledOptionReferences: [] }];
      if (kind === "excludedSku")
        t.bindings = [
          { ...first(t.bindings), includedSkuReferences: [], excludedSkuReferences: [id(6)] },
        ];
      if (kind === "missingSku") t.skuReference = id(7);
      expect(assess(fixture(), t).decision).toBe("HardError");
    },
  );
  it("examines latest rule history rather than accepting an old Published revision", () => {
    const r = fixture(),
      next = {
        ...first(r.modifiers),
        ruleVersionReference: id(42),
        version: 2,
        lifecycle: "Archived",
      };
    r.modifiers.push(next);
    r.counts.modifiers = "2";
    const a = assess(r);
    expect(a.modifierChecks).toHaveLength(1);
    expect(a.modifierChecks[0]?.ruleVersionReference).toBe(id(42));
    expect(a.decision).toBe("RequiresReview");
  });
  it("does not treat empty source as an executable Recipe or selling entitlement", () => {
    const r = fixture();
    r.bindings = [];
    r.modifiers = [];
    r.bindingCount = "0";
    r.counts.bindings = "0";
    r.counts.modifiers = "0";
    const a = assess(r);
    expect(a.bindingChecks).toEqual([]);
    expect(a.uniqueRecipeResolution).toBe("NotEvaluated");
  });
  it("rejects activation before current assessment", () =>
    expect(() => assess(fixture(), target(), "2026-09-28T00:00:00.000Z")).toThrow(
      expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" }),
    ));
  it("digest changes when current graph or intended activation changes", () => {
    expect(assess().digest).not.toBe(
      assess(fixture(), target(), "2026-09-30T00:00:00.001Z").digest,
    );
  });
});
