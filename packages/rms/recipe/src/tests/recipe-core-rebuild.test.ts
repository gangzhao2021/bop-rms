import { describe, expect, it, vi } from "vitest";
import {
  createRecipeCoreRebuildCoordinator,
  type RecipeCoreRebuildState,
} from "../application/recipe-core-rebuild.js";
import {
  parseRecipeCoverageSnapshot,
  recipeSourceFamilies,
} from "../application/recipe-source-coverage.js";
import { createPostgresRecipeCoreRebuildStateStore } from "../infrastructure/persistence/recipe-core-rebuild-state-store.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-27T12:00:00.000Z";
const request = () => ({
  generationReference: id(3),
  actorReference: id(4),
  purpose: "RecipeProjectionBuild",
  observedAtUtc: at,
});
const coverage = () => ({
  ...scope,
  sources: recipeSourceFamilies.map((family, i) => ({
    ...scope,
    family,
    snapshotReference: id(10 + i),
    digest: `sha256:${"a".repeat(64)}`,
    complete: true,
    dependencies: [],
  })),
});
const receipt = () => ({
  generationReference: id(3),
  publicationRevision: "6",
  projectionVersion: 2 as const,
  coreDigest: `sha256:${"b".repeat(64)}`,
  rowCount: 2,
  active: true,
  replay: false,
});
const initial = (): RecipeCoreRebuildState => ({
  ...scope,
  sourceRevision: "5",
  sourceGenerationReference: id(90),
  coreRevision: "4",
  coreGenerationReference: id(91),
  operation: null,
});
function committed(): RecipeCoreRebuildState {
  return {
    ...scope,
    sourceRevision: "6",
    sourceGenerationReference: id(3),
    coreRevision: "6",
    coreGenerationReference: id(3),
    operation: {
      intent: {
        generationReference: id(3),
        actorReference: id(4),
        purpose: "RecipeProjectionBuild",
        expectedRevision: "5",
        builtAt: at,
        coverage: coverage(),
      },
      result: { ...receipt(), replay: true },
    },
  };
}
function setup() {
  const head = { load: vi.fn(async () => initial()) },
    sources = { capture: vi.fn(async () => coverage()) },
    publication = { publish: vi.fn(async () => receipt()) };
  return {
    head,
    sources,
    publication,
    coordinator: createRecipeCoreRebuildCoordinator({ scope, head, sources, publication }),
  };
}
describe("Recipe core rebuild and committed-outcome recovery", () => {
  it("uses actual source revision5 rather than current core revision4", async () => {
    const x = setup();
    expect(await x.coordinator.rebuild(request())).toEqual(receipt());
    expect(x.publication.publish).toHaveBeenCalledWith({
      generationReference: id(3),
      actorReference: id(4),
      purpose: "RecipeProjectionBuild",
      expectedRevision: "5",
      builtAt: at,
      coverage: parseRecipeCoverageSnapshot(coverage()),
    });
  });
  it("resolves original committed receipt at a later attempt clock without recapture", async () => {
    const x = setup();
    x.head.load.mockResolvedValue(committed());
    const read = await x.coordinator.rebuild({
      ...request(),
      observedAtUtc: "2026-09-27T12:00:30.000Z",
    });
    expect(read.replay).toBe(true);
    expect(x.sources.capture).not.toHaveBeenCalled();
    expect(x.publication.publish).not.toHaveBeenCalled();
  });
  it("recovers response loss only from exact committed evidence", async () => {
    const x = setup();
    x.head.load.mockResolvedValueOnce(initial()).mockResolvedValueOnce(committed());
    x.publication.publish.mockRejectedValue(Error("private response loss"));
    expect(await x.coordinator.rebuild(request())).toEqual({ ...receipt(), replay: true });
    expect(x.head.load).toHaveBeenCalledTimes(2);
    expect(x.sources.capture).toHaveBeenCalledTimes(1);
    expect(x.publication.publish).toHaveBeenCalledTimes(1);
  });
  it("never acknowledges failed publication without a saved core", async () => {
    const x = setup();
    x.publication.publish.mockRejectedValue(Error("private uncommitted SQL"));
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_REBUILD_UNAVAILABLE",
      message: "Recipe core rebuild is unavailable",
    });
    expect(x.head.load).toHaveBeenCalledTimes(2);
  });
  it("allows a fresh actual head on retry only when no generation committed", async () => {
    const x = setup();
    x.publication.publish
      .mockRejectedValueOnce(Error("private failure"))
      .mockResolvedValueOnce({ ...receipt(), publicationRevision: "8" });
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_REBUILD_UNAVAILABLE",
    });
    x.head.load.mockResolvedValue({
      ...initial(),
      sourceRevision: "7",
      sourceGenerationReference: id(97),
      coreRevision: "6",
    });
    expect((await x.coordinator.rebuild(request())).publicationRevision).toBe("8");
    expect(x.publication.publish).toHaveBeenLastCalledWith(
      expect.objectContaining({ generationReference: id(3), expectedRevision: "7" }),
    );
  });
  it("rejects metadata-only identity reuse before capture", async () => {
    const x = setup(),
      saved = committed();
    if (!saved.operation) throw Error();
    x.head.load.mockResolvedValue({ ...saved, operation: { ...saved.operation, result: null } });
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
    });
    expect(x.sources.capture).not.toHaveBeenCalled();
  });
  it("rejects conflicting Actor for an existing identity", async () => {
    const x = setup(),
      saved = committed();
    if (!saved.operation) throw Error();
    x.head.load.mockResolvedValue({
      ...saved,
      operation: {
        ...saved.operation,
        intent: { ...saved.operation.intent, actorReference: id(99) },
      },
    });
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_IDEMPOTENCY_CONFLICT",
    });
    expect(x.sources.capture).not.toHaveBeenCalled();
  });
  it("does not reactivate an old receipt", async () => {
    const x = setup(),
      saved = committed();
    if (!saved.operation?.result) throw Error();
    x.head.load.mockResolvedValue({
      ...saved,
      sourceRevision: "8",
      coreRevision: "7",
      sourceGenerationReference: id(97),
      coreGenerationReference: id(97),
      operation: { ...saved.operation, result: { ...saved.operation.result, active: false } },
    });
    expect((await x.coordinator.rebuild(request())).active).toBe(false);
    expect(x.publication.publish).not.toHaveBeenCalled();
  });
  it("rejects inconsistent or foreign head before source access", async () => {
    const x = setup();
    x.head.load.mockResolvedValue({ ...initial(), tenantReference: id(99) });
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_REBUILD_UNAVAILABLE",
    });
    expect(x.sources.capture).not.toHaveBeenCalled();
  });
  it("rejects incomplete source without publication", async () => {
    const x = setup(),
      value = coverage(),
      first = value.sources[0];
    if (!first) throw Error();
    first.complete = false;
    x.sources.capture.mockResolvedValue(value);
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_COVERAGE_INCOMPLETE",
    });
    expect(x.publication.publish).not.toHaveBeenCalled();
  });
  it("rejects input getter before head access", async () => {
    const x = setup(),
      value = request(),
      getter = vi.fn(() => id(4));
    Object.defineProperty(value, "actorReference", { get: getter });
    await expect(x.coordinator.rebuild(value)).rejects.toMatchObject({
      code: "RECIPE_REBUILD_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(x.head.load).not.toHaveBeenCalled();
  });
  it("does not trust a malformed publisher result without committed readback", async () => {
    const x = setup();
    x.publication.publish.mockResolvedValue({ ...receipt(), generationReference: id(99) });
    await expect(x.coordinator.rebuild(request())).rejects.toMatchObject({
      code: "RECIPE_REBUILD_UNAVAILABLE",
    });
  });
  it("requires head authority before SQL", async () => {
    const run = vi.fn(async () => {
        throw Error("unexpected invocation");
      }),
      authority = {
        withAuthorizedRebuildScope: vi.fn(async () => {
          throw Error("private denied");
        }),
      };
    const store = createPostgresRecipeCoreRebuildStateStore({ run }, scope, authority);
    await expect(store.load(request())).rejects.toMatchObject({
      code: "RECIPE_REBUILD_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects wrong head purpose before authority", async () => {
    const run = vi.fn(async () => {
        throw Error("unexpected invocation");
      }),
      authority = {
        withAuthorizedRebuildScope: vi.fn(async () => {
          throw Error("unexpected invocation");
        }),
      },
      store = createPostgresRecipeCoreRebuildStateStore({ run }, scope, authority);
    await expect(
      store.load({ ...request(), purpose: "RecipeProjectionRead" }),
    ).rejects.toMatchObject({ code: "RECIPE_REBUILD_INPUT_INVALID" });
    expect(authority.withAuthorizedRebuildScope).not.toHaveBeenCalled();
  });
  it("bounds driver errors and rejects row getters without invocation", async () => {
    const getter = vi.fn(() => initial()),
      rows: unknown[] = [];
    Object.defineProperty(rows, "0", { get: getter, enumerable: true });
    const store = createPostgresRecipeCoreRebuildStateStore(
      { run: async (work) => work({ query: async () => ({ rows }) }) },
      scope,
      { withAuthorizedRebuildScope: async (_input, work) => work() },
    );
    await expect(store.load(request())).rejects.toMatchObject({
      code: "RECIPE_REBUILD_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
});
