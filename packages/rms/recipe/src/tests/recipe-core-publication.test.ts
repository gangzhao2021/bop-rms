import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { createPostgresRecipeCorePublicationStore } from "../infrastructure/persistence/recipe-core-publication-store.js";
import { recipeSourceFamilies } from "../application/recipe-source-coverage.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-27T12:00:00.000Z";
const digest = `sha256:${createHash("sha256")
  .update(canonicalizeRfc8785({ family: "Recipe", ...scope, dependencies: [], roots: [] }))
  .digest("hex")}`;
function input() {
  return {
    generationReference: id(3),
    actorReference: id(4),
    purpose: "RecipeProjectionBuild",
    expectedRevision: "0",
    builtAt: at,
    coverage: {
      ...scope,
      sources: recipeSourceFamilies.map((family, i) => ({
        ...scope,
        family,
        snapshotReference: id(10 + i),
        digest: family === "Recipe" ? digest : `sha256:${"a".repeat(64)}`,
        complete: true,
        dependencies: [],
      })),
    },
  };
}
function setup() {
  const value = input(),
    recipeSource = value.coverage.sources[0];
  if (!recipeSource) throw Error("missing fixture Recipe source");
  const source = { coverage: recipeSource, capturedAtUtc: at, asOfUtc: at };
  const run = vi.fn(async () => {
    throw Error("private raw SQL credentials");
  });
  const ports = {
    coverage: {
      withAuthorizedCurrentCoverage: vi.fn(async (_input, work) => work(value.coverage)),
    },
    facts: {
      capture: vi.fn(async () => source),
      withCurrentFacts: vi.fn(async (_request, _captured, work) =>
        work({ source, recipes: [], currentRecipes: [] }),
      ),
    },
    authorization: { withAuthorizedFactsScope: vi.fn(async (_input, work) => work()) },
  };
  const store = createPostgresRecipeCorePublicationStore({ run }, scope, ports);
  return { value, source, run, ports, store };
}
describe("durable Recipe core publication boundary", () => {
  it.each(["-1", "01", "9223372036854775807", "99999999999999999999999"])(
    "rejects invalid revision %s before any capability or SQL",
    async (revision) => {
      const { value, store, run, ports } = setup();
      await expect(store.publish({ ...value, expectedRevision: revision })).rejects.toMatchObject({
        code: "RECIPE_PUBLICATION_INPUT_INVALID",
      });
      expect(run).not.toHaveBeenCalled();
      expect(ports.coverage.withAuthorizedCurrentCoverage).not.toHaveBeenCalled();
    },
  );
  it("rejects raw core rows and foreign input without reading authority or SQL", async () => {
    const { value, store, run, ports } = setup();
    await expect(store.publish({ ...value, rows: [] })).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_INPUT_INVALID",
    });
    await expect(
      store.publish({ ...value, coverage: { ...value.coverage, tenantReference: id(99) } }),
    ).rejects.toMatchObject({ code: "RECIPE_PUBLICATION_INPUT_INVALID" });
    expect(run).not.toHaveBeenCalled();
    expect(ports.coverage.withAuthorizedCurrentCoverage).not.toHaveBeenCalled();
  });
  it("never reads a caller getter", async () => {
    const { value, store, run } = setup(),
      getter = vi.fn(() => id(4));
    Object.defineProperty(value, "actorReference", { get: getter });
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects incomplete source coverage before field facts or SQL", async () => {
    const { value, store, run, ports } = setup(),
      first = value.coverage.sources[0];
    if (!first) throw Error("missing fixture");
    first.complete = false;
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_COVERAGE_INCOMPLETE",
    });
    expect(ports.facts.capture).not.toHaveBeenCalled();
    expect(ports.authorization.withAuthorizedFactsScope).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("requires a separate field-purpose lease before raw facts access", async () => {
    const { value, store, run, ports } = setup();
    ports.authorization.withAuthorizedFactsScope.mockImplementation(async () => {
      throw Error("private denied");
    });
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
    });
    expect(ports.facts.capture).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects a lease which skips its callback", async () => {
    const { value, store, run, ports } = setup();
    ports.authorization.withAuthorizedFactsScope.mockImplementation(async () => undefined);
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("requires exact Recipe source identity even when its dependency set is empty", async () => {
    const { value, source, store, run } = setup();
    if (!source.coverage) throw Error("missing fixture");
    source.coverage = { ...source.coverage, snapshotReference: id(99) };
    await expect(store.publish(value)).rejects.toMatchObject({ code: "RECIPE_COVERAGE_CHANGED" });
    expect(run).not.toHaveBeenCalled();
  });
  it("requires the requested facts as-of instant and bounds infrastructure errors", async () => {
    const { value, source, store, run } = setup();
    source.asOfUtc = "2026-09-27T12:00:01.000Z";
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
    const next = setup();
    await expect(next.store.publish(next.value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
      message: "Recipe coverage publication is unavailable",
    });
  });
  it("rejects a driver array-index getter without invoking it", async () => {
    const { value, ports } = setup(),
      getter = vi.fn(() => ({ revision: "0", generation: null })),
      rows: unknown[] = [];
    Object.defineProperty(rows, "0", { enumerable: true, get: getter });
    const store = createPostgresRecipeCorePublicationStore(
      { run: async (work) => work({ query: async () => ({ rows }) }) },
      scope,
      ports,
    );
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
