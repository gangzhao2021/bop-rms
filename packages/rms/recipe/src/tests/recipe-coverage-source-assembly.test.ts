import { RecipeCoveragePublicationError } from "../application/recipe-coverage-publication-error.js";
import { describe, expect, it, vi } from "vitest";
import {
  createRecipeCoverageSourceAssembly,
  type RecipeCoverageOwnerSource,
  type RecipeCoverageOwnerRead,
} from "../application/recipe-coverage-source-assembly.js";
import {
  recipeSourceFamilies,
  type RecipeSourceFamily,
} from "../application/recipe-source-coverage.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-28T00:00:00.000Z";
const request = () => ({
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  observedAtUtc: at,
});
function setup() {
  const holds = new Set<string>(),
    events: string[] = [];
  const reads = new Map<RecipeSourceFamily, RecipeCoverageOwnerRead>();
  const sources: Partial<Record<RecipeSourceFamily, RecipeCoverageOwnerSource>> = {};
  for (const [index, family] of recipeSourceFamilies.entries()) {
    const initial = {
      coverage: {
        ...scope,
        family,
        snapshotReference: id(10 + index),
        digest: `sha256:${"a".repeat(64)}`,
        complete: true,
        dependencies: [
          {
            objectReference: id(30 + index),
            versionReference: id(50 + index),
            digest: `sha256:${"b".repeat(64)}`,
          },
        ],
      },
      capturedAtUtc: at,
      asOfUtc: at,
    };
    reads.set(family, initial);
    sources[family] = {
      async capture() {
        events.push(`capture:${family}`);
        return initial;
      },
      async withCurrent(_request, _read, work) {
        events.push(`hold:${family}`);
        holds.add(family);
        try {
          const value = reads.get(family);
          if (!value) throw Error();
          return await work(value);
        } finally {
          events.push(`release:${family}`);
          holds.delete(family);
        }
      },
    };
  }
  const authorization = {
    withAuthorizedScope: vi.fn(async <T>(_input: unknown, work: () => Promise<T>) => {
      holds.add("authority");
      try {
        return await work();
      } finally {
        holds.delete("authority");
      }
    }),
  };
  const create = () =>
    createRecipeCoverageSourceAssembly({
      scope,
      sources,
      authorization: {
        withAuthorizedScope: async <T>(input: unknown, work: () => Promise<T>) =>
          (await authorization.withAuthorizedScope(input, work)) as T,
      },
    });
  return { create, sources, reads, holds, events, authorization };
}
const publication = (coverage: unknown) => ({
  generationReference: id(99),
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  expectedRevision: "0",
  builtAt: at,
  coverage,
});
describe("Recipe all-owner held source composition", () => {
  it("holds service metadata coverage without inventing a publication intent", async () => {
    const x = setup(),
      assembly = x.create();
    const result = await assembly.withCurrentCoverage(request(), async (current) => {
      expect(x.holds.size).toBe(8);
      expect(current.sources).toHaveLength(7);
      return current;
    });
    expect(result.sources).toHaveLength(7);
    expect(x.holds.size).toBe(0);
    await expect(
      assembly.withCurrentCoverage(
        { ...request(), purpose: "RecipeProjectionRead" },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "RECIPE_ASSEMBLY_INPUT_INVALID" });
  });

  it("revalidates all committed captures in fixed order and retains every lease through inner commit", async () => {
    const x = setup(),
      assembly = x.create(),
      snapshot = await assembly.capture(request());
    expect(x.holds.size).toBe(0);
    expect(Object.isFrozen(snapshot.sources)).toBe(true);
    x.events.length = 0;
    const result = await assembly.withAuthorizedCurrentCoverage(
      publication(snapshot),
      async (current) => {
        expect(current).toEqual(snapshot);
        expect([...x.holds]).toEqual(["authority", ...recipeSourceFamilies]);
        await Promise.resolve();
        x.events.push("publication:COMMIT");
        return "committed";
      },
    );
    expect(result).toBe("committed");
    expect(x.events).toEqual([
      ...recipeSourceFamilies.map((f) => `capture:${f}`),
      ...recipeSourceFamilies.map((f) => `hold:${f}`),
      "publication:COMMIT",
      ...[...recipeSourceFamilies].reverse().map((f) => `release:${f}`),
    ]);
    expect(x.holds.size).toBe(0);
  });
  it("never substitutes an empty source for a missing Supplier owner", async () => {
    const x = setup();
    delete x.sources.Supplier;
    await expect(x.create().capture(request())).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_INCOMPLETE",
    });
    expect(x.authorization.withAuthorizedScope).not.toHaveBeenCalled();
    expect(x.events).toEqual([]);
  });
  it("fails before private capture when held authorization denies", async () => {
    const x = setup();
    x.authorization.withAuthorizedScope.mockRejectedValueOnce(Error("synthetic private authority"));
    await expect(x.create().capture(request())).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_UNAVAILABLE",
      message: "Recipe source assembly is unavailable",
    });
    expect(x.events).toEqual([]);
  });
  it.each(["scope", "family", "incomplete", "time"])(
    "rejects incoherent owner result: %s",
    async (mode) => {
      const x = setup(),
        initial = x.reads.get("Allergen");
      if (!initial) throw Error();
      x.reads.set("Allergen", {
        ...initial,
        asOfUtc: mode === "time" ? "2026-09-29T00:00:00.000Z" : at,
        coverage: {
          ...initial.coverage,
          brandReference: mode === "scope" ? id(999) : scope.brandReference,
          family: mode === "family" ? "Inventory" : "Allergen",
          complete: mode !== "incomplete",
        },
      });
      await expect(x.create().capture(request())).rejects.toMatchObject({
        code: mode === "incomplete" ? "RECIPE_ASSEMBLY_INCOMPLETE" : "RECIPE_ASSEMBLY_UNAVAILABLE",
      });
      expect(x.holds.size).toBe(0);
    },
  );
  it.each(["changed", "conflict"])(
    "rejects a source that changes between capture and acquisition: %s",
    async (mode) => {
      const x = setup(),
        initial = x.reads.get("Inventory");
      if (!initial) throw Error();
      x.reads.set("Inventory", {
        ...initial,
        coverage: {
          ...initial.coverage,
          snapshotReference: mode === "changed" ? id(999) : initial.coverage.snapshotReference,
          digest: `sha256:${"c".repeat(64)}`,
        },
      });
      const work = vi.fn(async () => null),
        snapshot = {
          ...scope,
          sources: recipeSourceFamilies.map((f) => {
            const r = x.reads.get(f);
            if (!r) throw Error();
            return r.coverage;
          }),
        };
      await expect(
        x.create().withAuthorizedCurrentCoverage(publication(snapshot), work),
      ).rejects.toMatchObject({
        code: mode === "changed" ? "RECIPE_COVERAGE_CHANGED" : "RECIPE_COVERAGE_INTEGRITY_CONFLICT",
      });
      expect(work).not.toHaveBeenCalled();
      expect(x.holds.size).toBe(0);
    },
  );
  it("releases all leases and bounds inner errors without exposing private detail", async () => {
    const x = setup(),
      assembly = x.create(),
      snapshot = await assembly.capture(request());
    await expect(
      assembly.withAuthorizedCurrentCoverage(publication(snapshot), async () => {
        throw Error("synthetic SQL/token detail");
      }),
    ).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_UNAVAILABLE",
      message: "Recipe source assembly is unavailable",
    });
    expect(x.holds.size).toBe(0);
  });
  it("requires exactly one lease callback and invokes inner work once", async () => {
    const x = setup();
    x.authorization.withAuthorizedScope.mockImplementationOnce(
      async <T>(_input: unknown, work: () => Promise<T>) => {
        await work();
        return work();
      },
    );
    await expect(x.create().capture(request())).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_UNAVAILABLE",
    });
    expect(x.events.filter((e) => e.startsWith("capture:")).length).toBe(7);
    const y = setup();
    y.sources.Supplier = {
      async capture() {
        const value = y.reads.get("Supplier");
        if (!value) throw Error();
        return value;
      },
      async withCurrent(_input, _read, work) {
        const value = y.reads.get("Supplier");
        if (!value) throw Error();
        await work(value);
        return work(value);
      },
    };
    await expect(y.create().capture(request())).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_UNAVAILABLE",
    });
    expect(y.holds.size).toBe(0);
  });
  it("rejects caller scope fields and getters before acquiring any lease", async () => {
    const x = setup(),
      assembly = x.create(),
      getter = vi.fn(() => {
        throw Error();
      }),
      input = request();
    Object.defineProperty(input, "purpose", { get: getter });
    await expect(assembly.capture(input)).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_INPUT_INVALID",
    });
    await expect(assembly.capture({ ...request(), tenantReference: id(99) })).rejects.toMatchObject(
      { code: "RECIPE_ASSEMBLY_INPUT_INVALID" },
    );
    expect(getter).not.toHaveBeenCalled();
    expect(x.authorization.withAuthorizedScope).not.toHaveBeenCalled();
  });
  it("preserves only recognized bounded errors when actual-style owners mask callbacks", async () => {
    const x = setup();
    for (const family of recipeSourceFamilies) {
      const original = x.sources[family];
      if (!original) throw Error();
      x.sources[family] = {
        capture: original.capture,
        async withCurrent(input, read, work) {
          try {
            return await original.withCurrent(input, read, work);
          } catch {
            throw Error("synthetic owner masked");
          }
        },
      };
    }
    const assembly = x.create(),
      snapshot = await assembly.capture(request());
    const changed = {
      ...snapshot,
      sources: snapshot.sources.map((source) =>
        source.family === "Allergen" ? { ...source, snapshotReference: id(999) } : source,
      ),
    };
    await expect(
      assembly.withAuthorizedCurrentCoverage(publication(changed), async () => null),
    ).rejects.toMatchObject({ code: "RECIPE_COVERAGE_CHANGED" });
    await expect(
      assembly.withAuthorizedCurrentCoverage(publication(snapshot), async () => {
        throw new RecipeCoveragePublicationError("RECIPE_PUBLICATION_VERSION_CONFLICT");
      }),
    ).rejects.toMatchObject({ code: "RECIPE_PUBLICATION_VERSION_CONFLICT" });
    await expect(
      assembly.withAuthorizedCurrentCoverage(publication(snapshot), async () => {
        throw Error("synthetic SQL detail");
      }),
    ).rejects.toMatchObject({
      code: "RECIPE_ASSEMBLY_UNAVAILABLE",
      message: "Recipe source assembly is unavailable",
    });
    expect(x.holds.size).toBe(0);
  });
});
