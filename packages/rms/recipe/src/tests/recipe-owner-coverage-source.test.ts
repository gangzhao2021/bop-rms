import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresRecipeOwnerCoverageSource,
  createPostgresRecipePreparationCoverageSource,
  createPostgresRecipeSubstitutionCoverageSource,
  createPostgresRecipeUsageCoverageSource,
  type RecipeOwnedSourceFamily,
} from "../infrastructure/persistence/recipe-owner-coverage-source.js";
import type { RecipeTransactionRunner } from "../infrastructure/persistence/recipe-query-store.js";
import { preparationRecipeFixture } from "./recipe-preparation-content.fixture.js";
import { preparationPublicationFixture } from "./recipe-preparation-publication.fixture.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) };
const at = "2026-09-27T12:00:00.000Z";
const request = () => ({
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  observedAtUtc: at,
});
const coverage = () => ({
  family: "Recipe",
  ...scope,
  snapshotReference: id(4),
  digest: `sha256:${createHash("sha256")
    .update(canonicalizeRfc8785({ family: "Recipe", ...scope, dependencies: [], roots: [] }))
    .digest("hex")}`,
  complete: true,
  dependencies: [],
});
function setup(allowed = true, family: RecipeOwnedSourceFamily = "Recipe") {
  const directory = () => ({
    ...scope,
    snapshotReference: id(6),
    digest: coverage().digest,
    complete: true,
    storeReferences: [],
  });
  const preparationCoverage = () => {
    const dependencies =
      family === "Usage"
        ? [
            {
              objectReference: scope.brandReference,
              versionReference: id(6),
              digest: `sha256:${createHash("sha256").update(canonicalizeRfc8785(directory())).digest("hex")}`,
            },
          ]
        : [];
    return {
      ...coverage(),
      family,
      dependencies,
      digest: `sha256:${createHash("sha256")
        .update(
          canonicalizeRfc8785({
            family,
            ...scope,
            recipeSourceDigest: coverage().digest,
            dependencies,
          }),
        )
        .digest("hex")}`,
    };
  };
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<{ rows: unknown[] }>>(
    async (sql) => ({
      rows: sql.startsWith("SELECT coverage_json AS coverage")
        ? [
            {
              coverage: family === "Recipe" ? coverage() : preparationCoverage(),
              capturedAtUtc: at,
            },
          ]
        : [],
    }),
  );
  const run: RecipeTransactionRunner["run"] = async (work) => work({ query });
  const authorize = vi.fn(async () => allowed),
    generateReference = vi.fn(() => id(5));
  const createSource = {
    Recipe: createPostgresRecipeOwnerCoverageSource,
    Preparation: createPostgresRecipePreparationCoverageSource,
    Substitution: createPostgresRecipeSubstitutionCoverageSource,
    Usage: createPostgresRecipeUsageCoverageSource,
  }[family];
  const source = createSource({
    runner: { run },
    scope,
    authorize,
    generateReference,
    usageStores: {
      async withCurrent(input, work) {
        expect(input.family).toBe("Usage");
        return work(directory());
      },
    },
  });
  return { source, query, authorize, generateReference };
}
describe("actual Recipe-family source boundary", () => {
  it("reuses a committed complete empty owner seal without inventing other families", async () => {
    const { source, query, generateReference } = setup();
    const read = await source.capture(request());
    expect(read.coverage).toEqual(coverage());
    expect(read.coverage.family).toBe("Recipe");
    expect(generateReference).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    expect(Object.isFrozen(read.coverage.dependencies)).toBe(true);
  });
  it("selects current statement snapshots before settings or authorization and rejects unavailable isolation", async () => {
    const { source, query, authorize } = setup();
    await source.capture(request());
    expect(query.mock.calls[0]?.[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    query.mockClear();
    authorize.mockClear();
    query.mockRejectedValueOnce(Error("synthetic pre-existing snapshot"));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
    });
    expect(query).toHaveBeenCalledTimes(1);
    expect(authorize).not.toHaveBeenCalled();
  });
  it("seals only committed Preparation history, bound to current Recipe source", async () => {
    const { source, query, authorize } = setup(true, "Preparation");
    const captured = await source.capture(request());
    expect(captured.coverage.family).toBe("Preparation");
    expect(captured.coverage.dependencies).toEqual([]);
    expect(authorize).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        family: "Preparation",
        purpose: "RecipeProjectionBuild",
        ...scope,
      }),
    );
    expect(
      query.mock.calls.some(
        ([sql]) => sql === "LOCK TABLE rms_recipe.recipe_preparation_content IN SHARE MODE",
      ),
    ).toBe(true);
    const work = vi.fn(async () => "prepared");
    expect(await source.withCurrent(request(), captured, work)).toBe("prepared");
    expect(work).toHaveBeenCalledTimes(1);
    await expect(setup().source.withCurrent(request(), captured, work)).rejects.toMatchObject({
      code: "RECIPE_SOURCE_INPUT_INVALID",
    });
  });
  it("denies Preparation authority and incomplete or excessive content without exposing details", async () => {
    const denied = setup(false, "Preparation");
    await expect(denied.source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_PERMISSION_DENIED",
    });
    expect(
      denied.query.mock.calls.some(
        ([sql]) => sql.includes("FROM rms_recipe") || sql.startsWith("LOCK"),
      ),
    ).toBe(false);
    const { source, query } = setup(true, "Preparation");
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FROM rms_recipe.recipe_preparation_content")
        ? Array.from({ length: 2049 }, () => ({ coverage: coverage(), capturedAtUtc: at }))
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
    });
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FROM rms_recipe.recipe_preparation_content")
        ? [{ coverage: coverage(), capturedAtUtc: at }]
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
      message: "Recipe owner coverage is unavailable",
    });
  });
  it.each(["valid", "lifecycle", "future", "review"])(
    "validates each pinned Modifier publication condition: %s",
    async (kind) => {
      const { source, query } = setup(true, "Preparation");
      const snapshot = {
        ...preparationRecipeFixture({ lifecycle: "Published" }),
        brandReference: scope.brandReference as never,
      };
      const rule = {
        ruleReference: id(70),
        ruleVersionReference: id(71),
        ruleDigest: coverage().digest,
        brandReference: scope.brandReference,
        recipeVersionReference: snapshot.versionReference,
        selection: { bindingReference: id(72), optionReference: id(73), quantity: 1 },
        changes: [],
      };
      const publication = preparationPublicationFixture(snapshot, rule).record;
      const row = {
        contentReference: publication.content.contentReference,
        recipeReference: snapshot.recipeReference,
        versionReference: snapshot.versionReference,
        modifierVersionReference: rule.ruleVersionReference,
        operationReference: publication.operationReference,
        digest: publication.content.contentDigest,
        record: publication,
        publishedAt: publication.publishedAt,
        snapshot,
        rule,
        modifierLifecycle: kind === "lifecycle" ? "Draft" : "Published",
        modifierOccurredAt: kind === "future" ? at : snapshot.createdAt,
        modifierPublication:
          kind === "review"
            ? {}
            : {
                ruleReference: rule.ruleReference,
                ruleVersionReference: rule.ruleVersionReference,
                brandReference: scope.brandReference,
                recipeVersionReference: rule.recipeVersionReference,
                ruleDigest: rule.ruleDigest,
                draftAuthorActorReference: publication.authoredByReference,
                reviews: publication.reviewEvidence.reviews,
              },
      };
      query.mockImplementation(async (sql: string, values: readonly unknown[] = []) => ({
        rows: sql.includes("FROM rms_recipe.recipe_preparation_content")
          ? [row as never]
          : sql.startsWith("INSERT INTO rms_recipe.recipe_admin_source_capture")
            ? [{ coverage: JSON.parse(String(values[7])), capturedAtUtc: at }]
            : [],
      }));
      if (kind === "valid") {
        const captured = await source.capture(request());
        expect(captured.coverage.dependencies).toEqual([
          {
            objectReference: publication.content.contentReference,
            versionReference: publication.operationReference,
            digest: publication.content.contentDigest,
          },
        ]);
      } else {
        await expect(source.capture(request())).rejects.toMatchObject({
          code: "RECIPE_SOURCE_UNAVAILABLE",
        });
        expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
      }
    },
  );
  it.each(["Substitution", "Usage"] as const)(
    "captures explicit empty %s history with held owner lock and authority",
    async (family) => {
      const { source, query, authorize } = setup(true, family);
      const captured = await source.capture(request());
      expect(captured.coverage.family).toBe(family);
      expect(captured.coverage.dependencies).toHaveLength(family === "Usage" ? 1 : 0);
      expect(authorize).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ family, ...scope }),
      );
      const table = family === "Substitution" ? "recipe_modifier_version" : "recipe_scope_binding";
      expect(
        query.mock.calls.some(([sql]) => sql === `LOCK TABLE rms_recipe.${table} IN SHARE MODE`),
      ).toBe(true);
      expect(await source.withCurrent(request(), captured, async () => "covered")).toBe("covered");
      await expect(setup(false, family).source.capture(request())).rejects.toMatchObject({
        code: "RECIPE_SOURCE_PERMISSION_DENIED",
      });
    },
  );
  it("rejects unresolved substitution policy without creating an approved policy version", async () => {
    const { source, query } = setup(true, "Substitution");
    const snapshot = {
      ...preparationRecipeFixture(),
      brandReference: scope.brandReference as never,
      substitutionPolicyReference: id(90) as never,
    };
    query.mockImplementation(async (sql) => ({
      rows: sql.includes("FROM rms_recipe.recipe r")
        ? [
            {
              recipeReference: snapshot.recipeReference,
              versionReference: snapshot.versionReference,
              aggregateVersion: snapshot.aggregateVersion,
              stableCode: snapshot.stableCode,
              digest: snapshot.snapshotDigest,
              snapshot,
              brandReference: scope.brandReference,
            },
          ]
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
    });
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("requires complete scoped Usage directory authority before any private transaction", async () => {
    const query = vi.fn(async () => ({ rows: [] })),
      authorize = vi.fn(async () => true);
    const common = {
      runner: {
        run: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => work({ query }),
      },
      scope,
      authorize,
      generateReference: () => id(5),
    };
    await expect(
      createPostgresRecipeUsageCoverageSource(common).capture(request()),
    ).rejects.toMatchObject({ code: "RECIPE_SOURCE_UNAVAILABLE" });
    for (const value of [
      {
        ...scope,
        snapshotReference: id(6),
        digest: coverage().digest,
        complete: false,
        storeReferences: [],
      },
      {
        ...scope,
        tenantReference: id(99),
        snapshotReference: id(6),
        digest: coverage().digest,
        complete: true,
        storeReferences: [],
      },
      {
        ...scope,
        snapshotReference: id(6),
        digest: coverage().digest,
        complete: true,
        storeReferences: [id(7), id(7)],
      },
    ]) {
      const source = createPostgresRecipeUsageCoverageSource({
        ...common,
        usageStores: {
          async withCurrent(input, work) {
            expect(input.family).toBe("Usage");
            return work(value);
          },
        },
      });
      await expect(source.capture(request())).rejects.toMatchObject({
        code: "RECIPE_SOURCE_UNAVAILABLE",
      });
    }
    expect(query).not.toHaveBeenCalled();
    expect(authorize).not.toHaveBeenCalled();
  });
  it.each(["Recipe", "Usage"] as const)(
    "checks %s historical version integrity before returning an exact reused seal",
    async (family) => {
      const { source, query, generateReference } = setup(true, family);
      query.mockImplementation(async (sql) => ({
        rows: sql.startsWith("SELECT 1 AS conflict")
          ? [{ conflict: 1 }]
          : sql.startsWith("SELECT coverage_json AS coverage")
            ? [{ coverage: coverage(), capturedAtUtc: at }]
            : [],
      }));
      await expect(source.capture(request())).rejects.toMatchObject({
        code: "RECIPE_SOURCE_INTEGRITY_CONFLICT",
      });
      expect(generateReference).not.toHaveBeenCalled();
      expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
    },
  );
  it("rejects request actor/scope injection, invalid time and getters before query", async () => {
    const { source, query } = setup();
    for (const input of [
      { ...request(), tenantReference: id(90) },
      { ...request(), actorReference: "bad" },
      { ...request(), observedAtUtc: "invalid" },
    ])
      await expect(source.capture(input)).rejects.toMatchObject({
        code: "RECIPE_SOURCE_INPUT_INVALID",
      });
    const getter = vi.fn(() => {
      throw Error();
    });
    const input = request();
    Object.defineProperty(input, "purpose", { get: getter });
    await expect(source.capture(input)).rejects.toMatchObject({
      code: "RECIPE_SOURCE_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("denies missing authority before private rows or sealing", async () => {
    const { source, query } = setup(false);
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_PERMISSION_DENIED",
    });
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes("FROM rms_recipe") ||
          sql.startsWith("LOCK TABLE") ||
          sql.startsWith("INSERT"),
      ),
    ).toBe(false);
  });
  it("uses committed seal and holds owner lock through callback with authority revalidation", async () => {
    const { source, query, authorize } = setup();
    const read = await source.capture(request());
    const result = await source.withCurrent(request(), read, async (current) => {
      expect(current.coverage).toEqual(read.coverage);
      expect(
        query.mock.calls.some(([sql]) => sql === "LOCK TABLE rms_recipe.recipe IN SHARE MODE"),
      ).toBe(true);
      return "read";
    });
    expect(result).toBe("read");
    expect(authorize).toHaveBeenCalledTimes(4);
  });
  it("rejects forged or foreign capture before authorization and callback", async () => {
    const { source, authorize } = setup();
    const captured = {
      coverage: { ...coverage(), brandReference: id(99) },
      capturedAtUtc: at,
      asOfUtc: at,
    };
    const work = vi.fn();
    await expect(source.withCurrent(request(), captured, work)).rejects.toMatchObject({
      code: "RECIPE_SOURCE_INPUT_INVALID",
    });
    expect(authorize).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  });
  it("bounds callback errors and clears authority-loss responses", async () => {
    const { source, authorize } = setup();
    const read = await source.capture(request());
    await expect(
      source.withCurrent(request(), read, async () => {
        throw Error("synthetic detail");
      }),
    ).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
      message: "Recipe owner coverage is unavailable",
    });
    authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(source.withCurrent(request(), read, async () => "private")).rejects.toMatchObject({
      code: "RECIPE_SOURCE_PERMISSION_DENIED",
    });
  });
  it("fails closed on oversized owner collection and hostile row accessors", async () => {
    const { source, query } = setup();
    query.mockImplementation(async (sql: string) => ({
      rows: sql.includes("FROM rms_recipe.recipe r")
        ? Array.from({ length: 2049 }, () => ({ coverage: coverage(), capturedAtUtc: at }))
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
    });
    const getter = vi.fn(() => {
      throw Error();
    });
    const rows: unknown[] = [];
    Object.defineProperty(rows, "0", { enumerable: true, get: getter });
    const runner: RecipeTransactionRunner = {
      run: async (work) => work({ query: async () => ({ rows }) }),
    };
    const malformed = createPostgresRecipeOwnerCoverageSource({
      runner,
      scope,
      authorize: async () => true,
      generateReference: () => id(4),
    });
    await expect(malformed.capture(request())).rejects.toMatchObject({
      code: "RECIPE_SOURCE_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
