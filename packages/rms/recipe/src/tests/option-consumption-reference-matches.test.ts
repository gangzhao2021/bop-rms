import { expect, it, vi } from "vitest";
import {
  matchOptionDraftRecipeConsumptionMetadata as assess,
  buildRecipeReferenceSourceSnapshot as build,
} from "../contracts/recipe-reference-source.js";
const id = (n: number) => "01902458-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T04:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function raw() {
  return {
    generation: "2",
    bindingCount: "0",
    observedAt: at,
    counts: { recipes: "1", versions: "2", bindings: "0", modifiers: "0" },
    recipes: [
      {
        recipeReference: id(10),
        brandReference: id(1),
        aggregateVersion: 3,
        currentVersionReference: id(32),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [1, 2].map((v) => ({
      recipeVersionReference: id(30 + v),
      recipeReference: id(10),
      brandReference: id(1),
      versionNumber: v,
      lifecycle: "Published",
      snapshotDigest: digest,
      effectiveFrom: at,
      effectiveUntil: null as string | null,
      timeZone: "UTC",
      createdAt: at,
      precise: true,
    })),
    bindings: [],
    modifiers: [],
  };
}
const pins = () => ({
  profile: "CurrentFullOptionDraftConsumptionPinsV1",
  brandReference: id(1),
  optionSetReference: id(100),
  versionReference: id(101),
  sourceDigest: digest,
  contentDigest: digest,
  configurationDigest: digest,
  pins: [{ optionReference: id(110), reference: id(10), versionReference: id(32) }],
});
function run(
  input: unknown = pins(),
  r = raw(),
  now = at,
  activation = "2026-10-01T04:00:02.000Z",
) {
  return assess(input, build(r, request, at), request, now, activation);
}
it("matches exact current owning version metadata without qualification", () => {
  const p = run();
  expect(p.decision).toBe("PassForMetadata");
  expect(p.quantityEligibility).toBe("NotEvaluated");
  expect(p.referenceEligibility).toBe("NotEvaluated");
  expect(p.bindingApplicability).toBe("NotEvaluated");
  expect(Object.isFrozen(p)).toBe(true);
  expect(Object.isFrozen(p.matches)).toBe(true);
});
it.each([
  ["reference", id(999), "MissingRecipe"],
  ["versionReference", id(999), "MissingVersion"],
  ["versionReference", id(31), "StaleVersion"],
])("refuses metadata pin %s", (key, v, status) => {
  const p = pins();
  Object.assign(p.pins[0] ?? {}, { [key]: v });
  const a = run(p);
  expect(a.decision).toBe("HardError");
  expect(a.matches[0]?.status).toBe(status);
});
it("refuses stored noncurrent lifecycle", () => {
  const r = raw();
  const v = r.versions[1];
  if (!v) throw Error("fixture");
  v.lifecycle = "Draft";
  expect(run(pins(), r).matches[0]?.status).toBe("UnpublishedVersion");
});
it("checks empty pins but retains source identity and obligations", () => {
  const p = pins();
  p.pins = [];
  const r = run(p);
  expect(r.decision).toBe("PassForMetadata");
  expect(r.ownerSourceDigest).toMatch(/^sha256:/);
  expect(r.eligibility).toBe("NotEvaluated");
});
it.each(["scope", "duplicate", "overflow", "field", "getter", "activation", "expiry"])(
  "refuses %s",
  (mode) => {
    const p = pins();
    if (mode === "scope") p.brandReference = id(999);
    if (mode === "duplicate")
      p.pins.push({
        ...(p.pins[0] ?? { optionReference: id(110), reference: id(10), versionReference: id(32) }),
      });
    if (mode === "overflow")
      p.pins = Array.from({ length: 101 }, (_, i) => ({
        optionReference: id(1000 + i),
        reference: id(10),
        versionReference: id(32),
      }));
    if (mode === "field") Object.assign(p, { Ready: true });
    const getter = vi.fn(() => id(10));
    if (mode === "getter")
      Object.defineProperty(p.pins[0], "reference", { get: getter, enumerable: true });
    expect(() =>
      run(
        p,
        raw(),
        mode === "expiry" ? "2026-10-01T04:00:05.001Z" : at,
        mode === "activation" ? "2026-10-01T03:59:59.999Z" : "2026-10-01T04:00:10.000Z",
      ),
    ).toThrow();
    expect(getter).not.toHaveBeenCalled();
  },
);
it.each(["observed", "activation"])("refuses half-open Recipe %s period", (mode) => {
  const r = raw();
  const v = r.versions[1];
  if (!v) throw Error("fixture");
  v.effectiveUntil = "2026-10-01T04:00:02.000Z";
  expect(
    run(pins(), r, mode === "observed" ? "2026-10-01T04:00:02.000Z" : at).matches[0]?.status,
  ).toBe(mode === "observed" ? "InactiveObservedPeriod" : "InactiveActivationPeriod");
});
it("refuses an existing current version owned by a different existing Recipe", () => {
  const r = raw();
  r.counts = { recipes: "2", versions: "3", bindings: "0", modifiers: "0" };
  r.recipes.push({
    recipeReference: id(20),
    brandReference: id(1),
    aggregateVersion: 2,
    currentVersionReference: id(33),
    updatedAt: at,
    precise: true,
  });
  r.versions.push({
    recipeVersionReference: id(33),
    recipeReference: id(20),
    brandReference: id(1),
    versionNumber: 1,
    lifecycle: "Published",
    snapshotDigest: digest,
    effectiveFrom: at,
    effectiveUntil: null,
    timeZone: "UTC",
    createdAt: at,
    precise: true,
  });
  const p = pins();
  const pin = p.pins[0];
  if (!pin) throw Error("fixture");
  pin.versionReference = id(33);
  expect(run(p, r).matches[0]?.status).toBe("WrongRecipe");
});
