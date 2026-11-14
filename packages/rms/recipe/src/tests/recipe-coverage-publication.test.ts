import type { RecipeTransactionRunner } from "../infrastructure/persistence/recipe-query-store.js";
import { describe, expect, it, vi } from "vitest";
import {
  createPostgresRecipeCoveragePublicationStore,
  type RecipeCoveragePublicationFence,
} from "../infrastructure/persistence/recipe-coverage-publication-store.js";
import { recipeSourceFamilies } from "../application/recipe-source-coverage.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) };
const coverage = () => ({
  ...scope,
  sources: recipeSourceFamilies.map((family) => ({
    family,
    ...scope,
    snapshotReference: id(4),
    digest: `sha256:${"a".repeat(64)}`,
    complete: true,
    dependencies: [],
  })),
});
const input = () => ({
  generationReference: id(3),
  actorReference: id(5),
  purpose: "RecipeProjectionBuild",
  expectedRevision: "0",
  builtAt: "2026-09-27T12:00:00.000Z",
  coverage: coverage(),
});
function setup() {
  const run = vi.fn(async () => {
    throw Error("synthetic database detail");
  });
  const fence: RecipeCoveragePublicationFence = {
    withAuthorizedCurrentCoverage: vi.fn(async (value, work) => work(value.coverage)),
  };
  return { run, fence, store: createPostgresRecipeCoveragePublicationStore({ run }, scope, fence) };
}
describe("Recipe coverage storage boundary", () => {
  it.each(["-1", "01", "1.5", "9223372036854775807", "999999999999999999999999"])(
    "rejects unsafe expected revision %s before authority or SQL",
    async (revision) => {
      const { store, run, fence } = setup();
      await expect(store.publish({ ...input(), expectedRevision: revision })).rejects.toMatchObject(
        { code: "RECIPE_PUBLICATION_INPUT_INVALID" },
      );
      expect(run).not.toHaveBeenCalled();
      expect(fence.withAuthorizedCurrentCoverage).not.toHaveBeenCalled();
    },
  );
  it("rejects foreign source scope and unauthorized purpose before SQL", async () => {
    const { store, run } = setup();
    const value = input();
    value.coverage.tenantReference = id(99);
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_INPUT_INVALID",
    });
    await expect(store.publish({ ...input(), purpose: "Other" })).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_INPUT_INVALID",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects incomplete coverage before transaction", async () => {
    const { store, run } = setup();
    const value = input();
    const first = value.coverage.sources[0];
    if (!first) throw Error();
    first.complete = false;
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_COVERAGE_INCOMPLETE",
    });
    expect(run).not.toHaveBeenCalled();
  });
  it("never executes input getters", async () => {
    const { store, run } = setup();
    const getter = vi.fn(() => {
      throw Error();
    });
    const value = input();
    Object.defineProperty(value, "actorReference", { get: getter });
    await expect(store.publish(value)).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it("rejects a hostile database row accessor without executing it", async () => {
    const getter = vi.fn(() => {
      throw Error("row getter executed");
    });
    const rows: unknown[] = [];
    Object.defineProperty(rows, "0", { enumerable: true, get: getter });
    const runner: RecipeTransactionRunner = {
      run: async (work) => work({ query: async () => ({ rows }) }),
    };
    const publicationFence: RecipeCoveragePublicationFence = {
      withAuthorizedCurrentCoverage: async (value, work) => work(value.coverage),
    };
    const store = createPostgresRecipeCoveragePublicationStore(runner, scope, publicationFence);
    await expect(store.publish(input())).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("bounds private infrastructure errors", async () => {
    const { store } = setup();
    await expect(store.publish(input())).rejects.toMatchObject({
      code: "RECIPE_PUBLICATION_UNAVAILABLE",
      message: "Recipe coverage publication is unavailable",
    });
  });
});
