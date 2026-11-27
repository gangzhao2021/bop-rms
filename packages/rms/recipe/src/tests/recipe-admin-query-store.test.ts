import { describe, expect, it, vi } from "vitest";
import { createPostgresRecipeAdminQueryStore } from "../index.js";

const id = (n: number) => `018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T18:00:00.000Z";
const unavailable = { code: "RECIPE_DEPENDENCY_UNAVAILABLE" };
function fixture() {
  return {
    generationReference: id(2),
    brandReference: id(1),
    projectionVersion: 1,
    sourceEventSequence: "9007199254740993",
    builtAt: at,
    checkpointVersion: 1,
    checkpointSequence: "9007199254740993",
    checkpointUpdatedAt: at,
    item: {
      generationReference: id(2),
      brandReference: id(1),
      recipeReference: id(3),
      versionReference: id(4),
      stableCode: "SYNTHETIC_RECIPE",
      displayName: "Synthetic recipe",
      lifecycle: "Published",
      yieldSummary: "1 PORTION",
      costMinor: "9007199254740993",
      allergenStatus: "MissingEvidence",
      usageSummary: "Synthetic usage",
      mappingMissing: true,
      costChanged: false,
      aggregateVersion: 2,
      snapshotDigest: `sha256:${"a".repeat(64)}`,
      effectiveFrom: at,
      projectedAt: at,
    },
  };
}
function setup(result: unknown) {
  const query = vi.fn(async (sql: string, values: readonly unknown[]): Promise<unknown> => {
    expect(values).toBeInstanceOf(Array);
    if (sql.startsWith("SELECT set_config")) return { rows: [] };
    return result;
  });
  const run = vi.fn();
  const runner = {
    run: async <T>(work: (tx: { query: typeof query }) => Promise<T>) => {
      run();
      return work({ query });
    },
  };
  return { store: createPostgresRecipeAdminQueryStore(runner, id(1)), query, run, runner };
}
describe("Recipe admin generation reader", () => {
  it("reads a single scoped generation without rounding money or event sequence", async () => {
    const source = fixture();
    const target = setup({ rows: [source] });
    const result = await target.store.load(id(3));
    expect(result).toMatchObject({
      generationReference: id(2),
      sourceEventSequence: "9007199254740993",
      item: {
        recipeReference: id(3),
        costMinor: "9007199254740993",
        allergenStatus: "MissingEvidence",
      },
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.item)).toBe(true);
    source.item.displayName = "Changed source";
    expect(result?.item?.displayName).toBe("Synthetic recipe");
    expect(target.run).toHaveBeenCalledTimes(1);
    expect(target.query).toHaveBeenCalledTimes(2);
    expect(target.query.mock.calls[0]?.[1]).toEqual([id(1)]);
    expect(target.query.mock.calls[1]?.[1]).toEqual([id(1), id(3)]);
    const sql = target.query.mock.calls[1]?.[0];
    expect(sql).toContain("g.brand_id=c.brand_id");
    expect(sql).toContain("p.brand_id=g.brand_id");
    expect(sql).toContain("p.generation_id=g.generation_id");
    expect(sql).toContain("WHERE c.brand_id=$1");
  });
  it("distinguishes absent checkpoint from an absent item in a known generation", async () => {
    expect(await setup({ rows: [] }).store.load(id(3))).toBeNull();
    expect(await setup({ rows: [{ ...fixture(), item: null }] }).store.load(id(3))).toMatchObject({
      generationReference: id(2),
      item: null,
    });
  });
  it("rejects malformed references before any transaction", async () => {
    const target = setup({ rows: [] });
    await expect(target.store.load("not-a-reference")).rejects.toMatchObject(unavailable);
    expect(target.run).not.toHaveBeenCalled();
    expect(() => createPostgresRecipeAdminQueryStore(target.runner, "invalid")).toThrow();
  });
  it.each([
    { brandReference: id(99) },
    { generationReference: null },
    { projectionVersion: 2 },
    { checkpointVersion: 2 },
    { checkpointSequence: "2" },
    { sourceEventSequence: 1 },
    { sourceEventSequence: "9223372036854775808", checkpointSequence: "9223372036854775808" },
    { builtAt: "2026-02-30T00:00:00.000Z" },
    { checkpointUpdatedAt: "invalid" },
    { extra: true },
  ])("rejects inconsistent or malformed generation %j", async (override) => {
    await expect(
      setup({ rows: [{ ...fixture(), ...override }] }).store.load(id(3)),
    ).rejects.toMatchObject(unavailable);
  });
  it.each([
    { brandReference: id(99) },
    { generationReference: id(99) },
    { recipeReference: id(99) },
    { versionReference: "invalid" },
    { stableCode: "invalid code" },
    { displayName: "" },
    { lifecycle: "Unknown" },
    { costMinor: "1.5" },
    { costMinor: 1 },
    { costMinor: "-1" },
    { costMinor: "01" },
    { allergenStatus: "Approved" },
    { mappingMissing: "false" },
    { aggregateVersion: 0 },
    { aggregateVersion: 1.5 },
    { snapshotDigest: "invalid" },
    { effectiveFrom: "invalid" },
    { projectedAt: "2026-08-13T18:00:00Z" },
    { extra: true },
  ])("rejects malformed or cross-scope projection %j", async (override) => {
    const source = fixture();
    await expect(
      setup({ rows: [{ ...source, item: { ...source.item, ...override } }] }).store.load(id(3)),
    ).rejects.toMatchObject(unavailable);
  });
  it("rejects driver ambiguity and accessors without executing getters", async () => {
    const getter = vi.fn(() => fixture());
    const row = fixture();
    Object.defineProperty(row, "item", { enumerable: true, get: getter });
    const accessorRows = Object.defineProperty([fixture()], "0", { get: getter });
    for (const result of [
      null,
      {},
      { rows: [fixture(), fixture()] },
      { rows: [row] },
      { rows: accessorRows },
      Object.defineProperty({}, "rows", { get: getter }),
    ]) {
      await expect(setup(result).store.load(id(3))).rejects.toMatchObject(unavailable);
    }
    expect(getter).not.toHaveBeenCalled();
  });
  it("sanitizes transaction failures", async () => {
    const store = createPostgresRecipeAdminQueryStore(
      {
        run: async () => {
          throw new Error("private driver detail");
        },
      },
      id(1),
    );
    await expect(store.load(id(3))).rejects.toMatchObject({
      ...unavailable,
      message: "Recipe operation is unavailable",
    });
  });
});
