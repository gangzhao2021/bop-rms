import { describe, it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { resolveCurrentStoreRecipeVersions, buildRecipeReferenceSourceSnapshot } from "../index.js";
import {
  recipeMatchId as id,
  recipeMatchAt as at,
  recipeMatchRequest as request,
  recipeMatchTarget as target,
  recipeMatchRaw as raw,
} from "./recipe-catalog-reference-matches.fixture.js";
function first<T>(values: readonly T[]): T {
  const v = values[0];
  if (v === undefined) throw new Error("missing synthetic fixture");
  return v;
}
function fixture() {
  const r = raw();
  r.bindings = r.bindings.slice(0, 1);
  first(r.bindings).storeReference = null;
  r.modifiers = [];
  r.counts.modifiers = "0";
  r.counts.bindings = r.bindingCount = "1";
  for (const v of r.versions) {
    v.lifecycle = "Published";
    v.effectiveFrom = "2026-08-01T00:00:00.000Z";
  }
  first(r.bindings).effectiveFrom = "2026-08-01T00:00:00.000Z";
  return r;
}
function stores() {
  return {
    profile: "TenantStoreReferenceV1",
    brandReference: id(1),
    brandLifecycle: "Active",
    brandVersion: "1",
    generation: "7",
    referenceCount: "1",
    originalIntentDigest: request.catalogIntentDigest,
    observedAt: at,
    references: [
      { storeReference: id(99), lifecycle: "Active", version: "1", createdAt: at, updatedAt: at },
    ],
  };
}
function policy() {
  return {
    profile: "CurrentRecipeStoreOverridePolicyV1",
    brandReference: id(1),
    configurationVersionReference: id(100),
    currentPublicationReference: id(101),
    contentDigest: request.catalogIntentDigest,
    originalIntentDigest: request.catalogIntentDigest,
    observedAt: at,
    validUntil: "2026-09-29T12:00:05.000Z",
    effectiveFrom: "2026-08-01T00:00:00.000Z",
    effectiveUntil: null,
    storeRecipeOverrideAllowed: true,
  };
}
function resolve(
  r = fixture(),
  registered = stores(),
  overridePolicy: unknown = "Unavailable",
  activationAt = "2026-09-30T00:00:00.000Z",
  t = target(),
) {
  return resolveCurrentStoreRecipeVersions({
    request,
    target: t,
    source: buildRecipeReferenceSourceSnapshot(r, request, at),
    stores: registered,
    storeReference: id(99),
    overridePolicy,
    now: at,
    activationAt,
  });
}
function override(r = fixture()) {
  r.bindings.push({ ...first(r.bindings), bindingReference: id(65), storeReference: id(99) });
  r.counts.bindings = r.bindingCount = String(r.bindings.length);
  return r;
}
describe("current Store/SKU whole Recipe version resolution", () => {
  it("resolves one Brand default from current owning identities without selling qualification", () => {
    const a = resolve();
    expect(a.decision).toBe("PassForDirectBrandAndStoreBindings");
    expect(a.resolutions[0]?.recipeVersionReference).toBe(id(11));
    expect(a.resolutions[0]?.source).toBe("BrandDefault");
    expect(a.storeGroupResolution).toBe("NotSupportedBySource");
    expect(a.eligibility).toBe("NotEvaluated");
    expect(Object.isFrozen(a.resolutions)).toBe(true);
    const { digest, ...body } = a;
    expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
  });
  it("applies an expressly permitted Store whole-version override before Brand default (synthetic policy)", () => {
    const a = resolve(override(), stores(), policy());
    expect(a.resolutions[0]?.selectedBindingReference).toBe(id(65));
    expect(a.resolutions[0]?.source).toBe("StoreOverride");
  });
  it.each(["unknown", "inactive", "brand"])("refuses %s topology", (kind) => {
    const s = stores();
    if (kind === "unknown") {
      s.references = [];
      s.referenceCount = "0";
    }
    if (kind === "inactive") first(s.references).lifecycle = "Suspended";
    if (kind === "brand") s.brandLifecycle = "Archived";
    expect(resolve(fixture(), s).decision).toBe("HardError");
    expect(resolve(fixture(), s).resolutions[0]?.recipeVersionReference).toBe(null);
  });
  it.each(["unavailable", "denied"])(
    "does not fall back to Brand for %s override policy",
    (kind) => {
      const a = resolve(
        override(),
        stores(),
        kind === "unavailable" ? "Unavailable" : { ...policy(), storeRecipeOverrideAllowed: false },
      );
      expect(a.decision).toBe("HardError");
      expect(a.resolutions[0]?.status).toBe(
        kind === "unavailable" ? "OverridePolicyUnavailable" : "StoreOverrideDenied",
      );
    },
  );
  it.each(["missing", "ambiguous", "stale", "unpublished", "inactiveVersion", "optionBase"])(
    "refuses %s Recipe selection",
    (kind) => {
      const r = fixture();
      if (kind === "missing") {
        r.bindings = [];
        r.counts.bindings = r.bindingCount = "0";
      }
      if (kind === "ambiguous") {
        r.bindings.push({ ...first(r.bindings), bindingReference: id(66) });
        r.counts.bindings = r.bindingCount = "2";
      }
      if (kind === "stale") first(r.recipes).currentVersionReference = id(12);
      if (kind === "unpublished") first(r.versions).lifecycle = "Draft";
      if (kind === "inactiveVersion") first(r.versions).effectiveUntil = "2026-09-30T00:00:00.000Z";
      if (kind === "optionBase") first(r.bindings).optionBindingReference = id(20);
      expect(resolve(r).decision).toBe("HardError");
      expect(resolve(r).resolutions[0]?.recipeVersionReference).toBe(null);
    },
  );
  it("cannot discard a bad applicable override to use the Brand default", () => {
    const r = override();
    first(r.bindings.slice(1)).recipeVersionReference = id(12);
    expect(resolve(r, stores(), policy()).resolutions[0]?.status).toBe("StaleRecipeVersion");
  });
  it("ignores another Store's binding and only considers half-open activation periods", () => {
    const r = override();
    first(r.bindings.slice(1)).storeReference = id(98);
    expect(resolve(r).resolutions[0]?.source).toBe("BrandDefault");
    first(r.bindings.slice(1)).storeReference = id(99);
    first(r.bindings.slice(1)).effectiveUntil = "2026-09-30T00:00:00.000Z";
    expect(resolve(r).resolutions[0]?.source).toBe("BrandDefault");
    first(r.bindings.slice(1)).effectiveUntil = null;
    first(r.bindings.slice(1)).effectiveFrom = "2026-09-30T00:00:00.001Z";
    expect(resolve(r).resolutions[0]?.source).toBe("BrandDefault");
  });
  it("supports a future binding start exactly at intended activation and no implicit present-time selection", () => {
    const r = fixture();
    first(r.bindings).effectiveFrom = "2026-09-30T00:00:00.000Z";
    expect(resolve(r).decision).toBe("PassForDirectBrandAndStoreBindings");
    expect(resolve(r, stores(), "Unavailable", "2026-09-29T12:00:01.000Z").decision).toBe(
      "HardError",
    );
  });
  it.each(["brand", "intent", "freshness", "count", "unknownField"])(
    "rejects %s source substitution",
    (kind) => {
      const s: Record<string, unknown> = stores();
      if (kind === "brand") s.brandReference = id(200);
      if (kind === "intent") s.originalIntentDigest = "sha256:" + "b".repeat(64);
      if (kind === "freshness") s.observedAt = "2026-09-29T11:59:55.000Z";
      if (kind === "count") s.referenceCount = "2";
      if (kind === "unknownField") s.Ready = true;
      expect(() => resolve(fixture(), s as ReturnType<typeof stores>)).toThrow(
        expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" }),
      );
    },
  );
  it.each(["expired", "future", "until", "intent", "brand", "extra", "getter"])(
    "rejects %s policy input without invoking getters",
    (kind) => {
      const p: Record<string, unknown> = policy();
      if (kind === "expired") p.validUntil = at;
      if (kind === "future") p.observedAt = "2026-09-29T12:00:00.001Z";
      if (kind === "until") p.effectiveUntil = "2026-09-30T00:00:00.000Z";
      if (kind === "intent") p.originalIntentDigest = "sha256:" + "b".repeat(64);
      if (kind === "brand") p.brandReference = id(200);
      if (kind === "extra") p.Ready = true;
      if (kind === "getter")
        Object.defineProperty(p, "storeRecipeOverrideAllowed", {
          enumerable: true,
          get() {
            throw new Error("getter executed");
          },
        });
      expect(() => resolve(override(), stores(), p)).toThrow(
        expect.objectContaining({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" }),
      );
    },
  );
  it("does not silently infer no preparation from missing or empty SKU scope", () => {
    const t = target();
    expect(
      resolve(fixture(), stores(), "Unavailable", "2026-09-30T00:00:00.000Z", {
        ...t,
        skuReferences: [],
        bindings: [],
      }).decision,
    ).toBe("HardError");
  });
  it("fingerprints intended activation and current Store generation", () => {
    const s = stores();
    s.generation = "8";
    expect(resolve(fixture(), s).digest).not.toBe(resolve().digest);
    expect(resolve(fixture(), stores(), "Unavailable", "2026-09-30T00:00:00.001Z").digest).not.toBe(
      resolve().digest,
    );
  });
});
