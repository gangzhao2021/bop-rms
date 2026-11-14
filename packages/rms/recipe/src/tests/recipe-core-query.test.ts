import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { buildRecipeProjectionCore } from "../application/recipe-projection-core.js";
import { decodeRecipeCoreGeneration } from "../application/recipe-core-query.js";
import { createPostgresRecipeCoreQueryStore } from "../infrastructure/persistence/recipe-core-query-store.js";
import { recipeSourceFamilies } from "../application/recipe-source-coverage.js";
import { preparationRecipeFixture } from "./recipe-preparation-content.fixture.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-27T12:00:00.000Z";
const hash = (value: unknown) =>
  `sha256:${createHash("sha256").update(canonicalizeRfc8785(value)).digest("hex")}`;
function record() {
  const child = { ...preparationRecipeFixture(), brandReference: scope.brandReference as never };
  const parent = {
    ...preparationRecipeFixture({ sub: child }),
    brandReference: child.brandReference,
    recipeReference: id(91) as never,
    versionReference: id(92) as never,
    ingredients: preparationRecipeFixture({ sub: child }).ingredients.map((item) => ({
      ...item,
      unitDimension: child.yieldDimension,
    })),
  };
  const current = [child, parent].sort((a, b) =>
    a.recipeReference.localeCompare(b.recipeReference),
  );
  const dependencies = current.map((item) => ({
    objectReference: item.recipeReference,
    versionReference: item.versionReference,
    digest: item.snapshotDigest,
  }));
  const recipeCoverage = {
    ...scope,
    family: "Recipe" as const,
    snapshotReference: id(10),
    complete: true,
    dependencies,
    digest: hash({
      family: "Recipe",
      ...scope,
      dependencies,
      roots: current.map((item) => ({
        objectReference: item.recipeReference,
        versionReference: item.versionReference,
      })),
    }),
  };
  const core = buildRecipeProjectionCore({
    source: { coverage: recipeCoverage, capturedAtUtc: at, asOfUtc: at },
    recipes: current,
    currentRecipes: current,
  });
  const coverage = {
    ...scope,
    sources: recipeSourceFamilies.map((family, i) =>
      family === "Recipe"
        ? recipeCoverage
        : {
            ...scope,
            family,
            snapshotReference: id(10 + i),
            digest: hash(family),
            complete: true,
            dependencies: [],
          },
    ),
  };
  const sourceRecord = {
    generationReference: id(3),
    actorReference: id(4),
    purpose: "RecipeProjectionBuild",
    expectedRevision: "0",
    builtAt: at,
    coverage,
  };
  return {
    generationReference: id(3),
    ...scope,
    revision: "1",
    projectionVersion: 2,
    coreDigest: hash(core),
    rowCount: 2,
    graph: core.graph,
    sourceRecord,
    rows: core.rows,
  };
}
function setup(
  current: unknown | null = record().sourceRecord.coverage,
  stored: unknown = record(),
) {
  const query = vi.fn(async () => ({ rows: stored === null ? [] : [stored] }));
  const ports = {
    authorization: { withAuthorizedCoreScope: vi.fn(async (_input, work) => work()) },
    coverage: { withCurrentCoverage: vi.fn(async (_input, work) => work(current)) },
  };
  const store = createPostgresRecipeCoreQueryStore(
    { run: async (work) => work({ query }) },
    scope,
    ports,
  );
  return { store, query, ports };
}
const request = (observedAtUtc = at) => ({
  actorReference: id(4),
  purpose: "RecipeProjectionRead",
  observedAtUtc,
});
describe("authorized durable Recipe core query", () => {
  it("decodes exact immutable current rows and historical graph without excluded evidence fields", () => {
    const stored = record(),
      decoded = decodeRecipeCoreGeneration(stored, scope);
    expect(decoded.core.rows).toEqual(stored.rows);
    expect(decoded.core.rows[0]?.ingredients[0]).not.toHaveProperty("allergens");
    expect(decoded.core.rows[0]?.ingredients[0]).not.toHaveProperty("unitCostMinorNumerator");
    expect(Object.isFrozen(decoded.core.rows[0]?.ingredients[0])).toBe(true);
    expect(Object.isFrozen(decoded.core.graph.edges)).toBe(true);
  });
  it.each(["scope", "revision", "digest", "rowCount", "extraEvidence", "missingRow", "postorder"])(
    "rejects corrupt generation: %s",
    (mode) => {
      const initial = structuredClone(record()),
        stored = {
          ...initial,
          rows: [...initial.rows],
          graph: { ...initial.graph, postorderVersions: [...initial.graph.postorderVersions] },
        };
      if (mode === "scope") stored.tenantReference = id(99);
      if (mode === "revision") stored.revision = "2";
      if (mode === "digest") stored.coreDigest = hash("wrong");
      if (mode === "rowCount") stored.rowCount = 1;
      if (mode === "extraEvidence")
        Object.assign(stored.rows[0]?.ingredients[0] ?? {}, { allergens: [] });
      if (mode === "missingRow") stored.rows.pop();
      if (mode === "postorder")
        stored.graph.postorderVersions = [...stored.graph.postorderVersions].reverse();
      expect(() => decodeRecipeCoreGeneration(stored, scope)).toThrow(
        expect.objectContaining({ code: "RECIPE_CORE_QUERY_INTEGRITY_CONFLICT" }),
      );
    },
  );
  it("rejects nested driver index getters without invoking them", () => {
    const stored = structuredClone(record()),
      getter = vi.fn(() => stored.graph.nodes[1]);
    Object.defineProperty(stored.graph.nodes, "0", { enumerable: true, get: getter });
    expect(() => decodeRecipeCoreGeneration(stored, scope)).toThrow(
      "Recipe core query is unavailable",
    );
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects unauthorized purpose before any lease or SQL", async () => {
    const { store, query, ports } = setup();
    await expect(
      store.load({ ...request(), purpose: "RecipeProjectionBuild" }),
    ).rejects.toMatchObject({ code: "RECIPE_CORE_QUERY_INPUT_INVALID" });
    expect(query).not.toHaveBeenCalled();
    expect(ports.authorization.withAuthorizedCoreScope).not.toHaveBeenCalled();
  });
  it("requires field-purpose authority before current sources and SQL", async () => {
    const { store, query, ports } = setup();
    ports.authorization.withAuthorizedCoreScope.mockImplementation(async () => {
      throw Error("private denied");
    });
    await expect(store.load(request())).rejects.toMatchObject({
      code: "RECIPE_CORE_QUERY_UNAVAILABLE",
    });
    expect(ports.coverage.withCurrentCoverage).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("does not turn an unavailable source capability into unconfirmed facts", async () => {
    const { store, query, ports } = setup();
    ports.coverage.withCurrentCoverage.mockImplementation(async () => {
      throw Error("private failure");
    });
    await expect(store.load(request())).rejects.toMatchObject({
      code: "RECIPE_CORE_QUERY_UNAVAILABLE",
    });
    expect(query).not.toHaveBeenCalled();
  });
  it.each([
    ["2026-09-27T12:00:30.000Z", "Fresh"],
    ["2026-09-27T12:00:30.001Z", "Stale"],
  ])("checks age at %s", async (observed, expected) => {
    const read = await setup().store.load(request(observed));
    expect(read?.freshness).toBe(expected);
    expect(read?.sourceCoverageStatus).toBe("Current");
  });
  it("rejects future build timestamps", async () => {
    await expect(setup().store.load(request("2026-09-27T11:59:59.999Z"))).rejects.toMatchObject({
      code: "RECIPE_CORE_QUERY_UNAVAILABLE",
    });
  });
  it.each(["Changed", "Incomplete", "Unconfirmed"])(
    "immediately marks %s source stale",
    async (status) => {
      const coverage = structuredClone(record().sourceRecord.coverage),
        source = coverage.sources.find((item) => item.family === "Supplier");
      if (!source) throw Error("missing source");
      if (status === "Changed") source.snapshotReference = id(99);
      if (status === "Incomplete") source.complete = false;
      const read = await setup(status === "Unconfirmed" ? null : coverage).store.load(request());
      expect(read?.freshness).toBe("Stale");
      expect(read?.sourceCoverageStatus).toBe(status);
    },
  );
  it("rejects same-version conflicting current source digest", async () => {
    const coverage = structuredClone(record().sourceRecord.coverage),
      source = coverage.sources.find((item) => item.family === "Supplier");
    if (!source) throw Error("missing source");
    source.digest = hash("conflict");
    await expect(setup(coverage).store.load(request())).rejects.toMatchObject({
      code: "RECIPE_CORE_QUERY_INTEGRITY_CONFLICT",
    });
  });
  it("does not hide a known source integrity conflict behind incomplete status", async () => {
    const coverage = structuredClone(record().sourceRecord.coverage),
      source = coverage.sources.find((item) => item.family === "Supplier");
    if (!source) throw Error("missing source");
    source.complete = false;
    source.digest = hash("known conflict");
    await expect(setup(coverage).store.load(request())).rejects.toMatchObject({
      code: "RECIPE_CORE_QUERY_INTEGRITY_CONFLICT",
    });
  });
  it("returns null only when no active generation exists", async () => {
    expect(await setup(record().sourceRecord.coverage, null).store.load(request())).toBeNull();
  });
});
