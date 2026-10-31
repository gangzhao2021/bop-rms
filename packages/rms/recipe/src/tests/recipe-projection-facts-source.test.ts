import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresRecipeProjectionFactsSource,
  createPostgresRecipeOwnerCoverageSource,
  createPostgresRecipePreparationCoverageSource,
  createPostgresRecipeSubstitutionCoverageSource,
  createPostgresRecipeUsageCoverageSource,
} from "../infrastructure/persistence/recipe-owner-coverage-source.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-28T00:00:00.000Z";
const request = () => ({
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  observedAtUtc: at,
});
const coverage = () => ({
  ...scope,
  family: "Recipe",
  snapshotReference: id(4),
  digest: `sha256:${createHash("sha256")
    .update(canonicalizeRfc8785({ family: "Recipe", ...scope, dependencies: [], roots: [] }))
    .digest("hex")}`,
  complete: true,
  dependencies: [],
});
function setup() {
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
    async (sql) => ({
      rows: sql.startsWith("SELECT coverage_json")
        ? [{ coverage: coverage(), capturedAtUtc: at }]
        : [],
    }),
  );
  const authorize = vi.fn(async () => true),
    authorizeFacts = vi.fn(async () => true),
    generateReference = vi.fn(() => id(5));
  const options = {
    scope,
    runner: {
      run: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => work({ query }),
    },
    authorize,
    authorizeFacts,
    generateReference,
  };
  return {
    query,
    authorize,
    authorizeFacts,
    generateReference,
    options,
    source: createPostgresRecipeProjectionFactsSource(options),
  };
}
describe("separate Recipe projection graph facts capability", () => {
  it("keeps all existing source factories metadata-only", () => {
    const { options } = setup();
    for (const create of [
      createPostgresRecipeOwnerCoverageSource,
      createPostgresRecipePreparationCoverageSource,
      createPostgresRecipeSubstitutionCoverageSource,
      createPostgresRecipeUsageCoverageSource,
    ])
      expect(Object.keys(create(options))).toEqual(["capture", "withCurrent"]);
  });
  it("returns explicit complete empty roots/closure while holding and rechecking both authorities", async () => {
    const { source, query, authorize, authorizeFacts } = setup(),
      seal = await source.capture(request());
    const facts = await source.withCurrentFacts(request(), seal, async (value) => {
      expect(
        query.mock.calls.some(([sql]) => sql === "LOCK TABLE rms_recipe.recipe IN SHARE MODE"),
      ).toBe(true);
      return value;
    });
    expect(facts).toEqual({ source: seal, currentRecipes: [], recipes: [] });
    expect(Object.isFrozen(facts.currentRecipes)).toBe(true);
    expect(Object.isFrozen(facts.recipes)).toBe(true);
    expect(authorize).toHaveBeenCalledTimes(4);
    expect(authorizeFacts).toHaveBeenCalledTimes(4);
    expect(authorizeFacts).toHaveBeenCalledWith(expect.anything(), {
      ...request(),
      ...scope,
      family: "Recipe",
      access: "ProjectionFacts",
    });
  });
  it("denies field permission before private SQL and does not equate coverage permission with facts authority", async () => {
    const { source, query, authorizeFacts } = setup();
    authorizeFacts.mockResolvedValue(false);
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_PERMISSION_DENIED",
    });
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes("FROM rms_recipe") || sql.startsWith("LOCK") || sql.startsWith("INSERT"),
      ),
    ).toBe(false);
  });
  it("does not invoke field authority after coverage authority denies", async () => {
    const { source, authorize, authorizeFacts } = setup();
    authorize.mockResolvedValue(false);
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_PERMISSION_DENIED",
    });
    expect(authorizeFacts).not.toHaveBeenCalled();
  });
  it("rejects field permission loss after callback and bounds unknown callback detail", async () => {
    const { source, authorizeFacts } = setup(),
      seal = await source.capture(request());
    authorizeFacts.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(
      source.withCurrentFacts(request(), seal, async () => "private"),
    ).rejects.toMatchObject({ code: "RECIPE_SOURCE_PERMISSION_DENIED" });
    authorizeFacts.mockResolvedValue(true);
    await expect(
      source.withCurrentFacts(request(), seal, async () => {
        throw Error("synthetic private graph detail");
      }),
    ).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
      message: "Recipe owner coverage is unavailable",
    });
  });
  it("rejects forged/foreign seals and hostile caller fields before either authority", async () => {
    const { source, authorize, authorizeFacts } = setup(),
      getter = vi.fn(() => {
        throw Error();
      }),
      input = request();
    Object.defineProperty(input, "purpose", { get: getter });
    await expect(source.capture(input)).rejects.toMatchObject({
      code: "RECIPE_SOURCE_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    await expect(
      source.withCurrentFacts(
        request(),
        { coverage: { ...coverage(), brandReference: id(99) }, capturedAtUtc: at, asOfUtc: at },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "RECIPE_SOURCE_INPUT_INVALID" });
    expect(authorize).not.toHaveBeenCalled();
    expect(authorizeFacts).not.toHaveBeenCalled();
  });
});
