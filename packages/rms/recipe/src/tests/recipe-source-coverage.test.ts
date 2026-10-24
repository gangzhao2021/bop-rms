import { describe, expect, it } from "vitest";
import {
  assertRecipeCoverageUnchanged,
  parseRecipeCoverageSnapshot,
  recipeSourceFamilies,
} from "../application/recipe-source-coverage.js";
const ref = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const digest = `sha256:${"a".repeat(64)}`;
const snapshot = () => ({
  tenantReference: ref(1),
  brandReference: ref(2),
  sources: recipeSourceFamilies.map((family, i) => ({
    family,
    tenantReference: ref(1),
    brandReference: ref(2),
    snapshotReference: ref(10 + i),
    digest,
    complete: true,
    dependencies: [{ objectReference: ref(30 + i), versionReference: ref(50 + i), digest }],
  })),
});
function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("Missing synthetic fixture");
  return item;
}
function code(action: () => unknown, expected: string) {
  expect(action).toThrow(expect.objectContaining({ code: expected }));
}
describe("Recipe source coverage publication fence", () => {
  it("captures complete independent source identities immutably", () => {
    const input = snapshot();
    const parsed = parseRecipeCoverageSnapshot(input);
    first(first(input.sources).dependencies).digest = `sha256:${"b".repeat(64)}`;
    expect(parsed.sources.find((x) => x.family === "Recipe")?.dependencies[0]?.digest).toBe(digest);
    expect(Object.isFrozen(parsed.sources[0]?.dependencies)).toBe(true);
  });
  it("accepts exact replay despite input family/object ordering", () => {
    const a = snapshot();
    const b = snapshot();
    b.sources.reverse();
    expect(assertRecipeCoverageUnchanged(a, b)).toEqual(parseRecipeCoverageSnapshot(a));
  });
  it("allows explicitly complete empty owner feeds without inventing a dependency", () => {
    const a = snapshot();
    a.sources.forEach((source) => {
      source.dependencies = [];
    });
    expect(assertRecipeCoverageUnchanged(a, a).sources).toHaveLength(7);
  });
  it.each(["tenantReference", "brandReference"] as const)("rejects %s drift", (field) => {
    const b = snapshot();
    b[field] = ref(99);
    b.sources.forEach((source) => {
      source[field] = ref(99);
    });
    code(() => assertRecipeCoverageUnchanged(snapshot(), b), "RECIPE_COVERAGE_CHANGED");
  });
  it.each(recipeSourceFamilies)("requires complete %s coverage", (family) => {
    const b = snapshot();
    const source = b.sources.find((x) => x.family === family);
    if (!source) throw Error();
    source.complete = false;
    code(() => assertRecipeCoverageUnchanged(snapshot(), b), "RECIPE_COVERAGE_INCOMPLETE");
  });
  it("rejects independent Recipe B change even with unrelated Recipe A high version", () => {
    const a = snapshot();
    const b = snapshot();
    const aRecipe = a.sources.find((x) => x.family === "Recipe");
    const bRecipe = b.sources.find((x) => x.family === "Recipe");
    if (!aRecipe || !bRecipe) throw Error();
    aRecipe.dependencies.push({ objectReference: ref(90), versionReference: ref(999), digest });
    bRecipe.dependencies.push({ objectReference: ref(90), versionReference: ref(999), digest });
    bRecipe.snapshotReference = ref(100);
    first(bRecipe.dependencies).versionReference = ref(101);
    code(() => assertRecipeCoverageUnchanged(a, b), "RECIPE_COVERAGE_CHANGED");
  });
  it("rejects same snapshot with contradictory contents", () => {
    const b = snapshot();
    first(b.sources).dependencies = [];
    code(() => assertRecipeCoverageUnchanged(snapshot(), b), "RECIPE_COVERAGE_INTEGRITY_CONFLICT");
  });
  it("rejects same object version conflicting digest across new snapshot", () => {
    const b = snapshot();
    first(b.sources).snapshotReference = ref(100);
    first(first(b.sources).dependencies).digest = `sha256:${"b".repeat(64)}`;
    code(() => assertRecipeCoverageUnchanged(snapshot(), b), "RECIPE_COVERAGE_INTEGRITY_CONFLICT");
  });
  it("covers multiple pinned versions of one object and checks integrity for each pair", () => {
    const a = snapshot();
    first(a.sources).dependencies.push({
      objectReference: ref(30),
      versionReference: ref(51),
      digest,
    });
    expect(
      parseRecipeCoverageSnapshot(a).sources.find((entry) => entry.family === "Recipe")
        ?.dependencies,
    ).toHaveLength(2);
    const b = snapshot();
    first(b.sources).dependencies.push({
      objectReference: ref(30),
      versionReference: ref(51),
      digest,
    });
    first(b.sources).snapshotReference = ref(100);
    first(first(b.sources).dependencies).digest = `sha256:${"b".repeat(64)}`;
    code(() => assertRecipeCoverageUnchanged(a, b), "RECIPE_COVERAGE_INTEGRITY_CONFLICT");
  });
  it("rejects duplicate, missing or excess families", () => {
    for (const kind of ["duplicate", "missing", "extra"]) {
      const a = snapshot();
      if (kind === "duplicate") a.sources[1] = first(a.sources);
      else if (kind === "missing") a.sources.pop();
      else a.sources.push(first(a.sources));
      code(() => parseRecipeCoverageSnapshot(a), "RECIPE_COVERAGE_INPUT_INVALID");
    }
  });
  it("rejects duplicate dependencies, excessive input and unknown fields", () => {
    const a = snapshot();
    first(a.sources).dependencies.push(first(first(a.sources).dependencies));
    code(() => parseRecipeCoverageSnapshot(a), "RECIPE_COVERAGE_INPUT_INVALID");
    const b = snapshot();
    first(b.sources).dependencies = Array.from({ length: 2049 }, () => ({
      objectReference: ref(30),
      versionReference: ref(50),
      digest,
    }));
    code(() => parseRecipeCoverageSnapshot(b), "RECIPE_COVERAGE_INPUT_INVALID");
    code(
      () => parseRecipeCoverageSnapshot({ ...snapshot(), actor: ref(80) }),
      "RECIPE_COVERAGE_INPUT_INVALID",
    );
  });
  it.each(["tenantReference", "brandReference"] as const)(
    "rejects a foreign %s source within matching outer scope",
    (field) => {
      const input = snapshot();
      first(input.sources)[field] = ref(99);
      code(() => parseRecipeCoverageSnapshot(input), "RECIPE_COVERAGE_INPUT_INVALID");
    },
  );
  it("rejects malformed dependency identity, version or digest", () => {
    for (const field of ["objectReference", "versionReference", "digest"] as const) {
      const input = snapshot();
      first(first(input.sources).dependencies)[field] = "invalid";
      code(() => parseRecipeCoverageSnapshot(input), "RECIPE_COVERAGE_INPUT_INVALID");
    }
  });
  it("never executes getters and safely rejects hostile proxy/prototype/array metadata", () => {
    const getter = () => {
      throw Error("getter executed");
    };
    const a = snapshot();
    Object.defineProperty(a, "brandReference", { get: getter });
    code(() => parseRecipeCoverageSnapshot(a), "RECIPE_COVERAGE_INPUT_INVALID");
    code(
      () => parseRecipeCoverageSnapshot(new Proxy({}, { ownKeys: getter })),
      "RECIPE_COVERAGE_INPUT_INVALID",
    );
    const b = snapshot();
    Object.defineProperty(b.sources, "extra", { value: true });
    code(() => parseRecipeCoverageSnapshot(b), "RECIPE_COVERAGE_INPUT_INVALID");
    code(
      () => parseRecipeCoverageSnapshot(Object.assign(Object.create(null), snapshot())),
      "RECIPE_COVERAGE_INPUT_INVALID",
    );
  });
});
