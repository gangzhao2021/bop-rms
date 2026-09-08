import { describe, expect, it, vi } from "vitest";
import {
  createPostgresPublishedMenuQueryStore,
  type PublishedMenuProjection,
  type PublishedMenuQueryTransactionRunner,
} from "../index.js";

const id = (n: number) => `018f7300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scope = { brandReference: id(2), storeReference: id(20) };
const input = scope as Parameters<
  ReturnType<typeof createPostgresPublishedMenuQueryStore>["loadCandidates"]
>[0];
const at = "2026-08-02T16:00:00.000Z";
function projection(): PublishedMenuProjection {
  return {
    projectionName: "catalog_published_menu_v1",
    projectionVersion: 1,
    generationReference: id(9) as never,
    sourceEventReference: id(10) as never,
    sourceAggregateVersion: 4,
    sourceCheckpoint: id(10) as never,
    lastRebuiltAt: at as never,
    freshnessStatus: "Fresh",
    snapshot: {
      brandReference: id(2) as never,
      menuReference: id(1) as never,
      menuVersionReference: id(4) as never,
      releaseReference: id(8) as never,
      snapshotDigest: `sha256:${"a".repeat(64)}` as never,
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "All Day" },
      storeReferences: [id(20) as never],
      channelCodes: ["DINE_IN" as never],
      orderTypeCodes: ["TABLE_SERVICE" as never],
      timeZone: "America/Toronto",
      effectiveFrom: at as never,
      effectiveUntil: null,
      sections: [],
    },
  };
}
function fixture(result: unknown = { rows: [{ projection: projection() }] }) {
  const query = vi.fn<(sql: string, values: readonly unknown[]) => Promise<unknown>>(
    async () => result,
  );
  const run = vi.fn(async () => undefined);
  const runner: PublishedMenuQueryTransactionRunner = {
    async run(action) {
      await run();
      return action({ query });
    },
  };
  return { query, run, runner, store: createPostgresPublishedMenuQueryStore(runner, scope) };
}

describe("PostgreSQL Published Menu query store", () => {
  it("hydrates immutable candidates in one scoped read transaction", async () => {
    const f = fixture();
    const found = await f.store.loadCandidates(input);
    expect(found).toEqual([projection()]);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found[0]?.snapshot)).toBe(true);
    expect(f.run).toHaveBeenCalledOnce();
    expect(f.query).toHaveBeenCalledTimes(2);
    expect(f.query.mock.calls.map((call) => call[1])).toEqual([
      [scope.brandReference, ""],
      [scope.brandReference, scope.storeReference],
    ]);
  });
  it("preserves absence and all freshness states for the existing query policy", async () => {
    expect(await fixture({ rows: [] }).store.loadCandidates(input)).toEqual([]);
    for (const freshnessStatus of ["Fresh", "Stale", "Rebuilding", "Failed"] as const) {
      const candidate = { ...projection(), freshnessStatus };
      expect(
        await fixture({ rows: [{ projection: candidate }] }).store.loadCandidates(input),
      ).toEqual([candidate]);
    }
  });
  it("rejects malformed construction and request scope before any transaction", async () => {
    const f = fixture();
    expect(() =>
      createPostgresPublishedMenuQueryStore(f.runner, { ...scope, brandReference: "invalid" }),
    ).toThrow();
    for (const request of [
      null,
      {},
      { ...input, brandReference: id(99) },
      { ...input, storeReference: id(99) },
    ])
      await expect(f.store.loadCandidates(request as typeof input)).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each([
    null,
    {},
    { rows: null },
    { rows: [null] },
    { rows: [{}] },
    { rows: [{ projection: null }] },
  ])("rejects malformed database result %j", async (result) => {
    await expect(fixture(result).store.loadCandidates(input)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("rejects unsafe versions, malformed nested facts and returned scope drift", async () => {
    const base = projection();
    for (const candidate of [
      { ...base, sourceAggregateVersion: Number.MAX_SAFE_INTEGER + 1 },
      { ...base, snapshot: { ...base.snapshot, brandReference: id(99) } },
      { ...base, snapshot: { ...base.snapshot, storeReferences: [id(99)] } },
      { ...base, snapshot: { ...base.snapshot, sections: [{}] } },
    ])
      await expect(
        fixture({ rows: [{ projection: candidate }] }).store.loadCandidates(input),
      ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    await expect(
      fixture({ rows: [{ projection: base }, { projection: base }] }).store.loadCandidates(input),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  });
  it("does not expose SQL, binds or causes from a failed transaction", async () => {
    const f = fixture();
    f.run.mockRejectedValueOnce(new Error("synthetic SQL and credential material"));
    try {
      await f.store.loadCandidates(input);
      expect.fail("dependency failure was admitted");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
        message: "catalog is unavailable",
      });
      expect(error).not.toHaveProperty("cause");
      expect(JSON.stringify(error)).not.toContain("synthetic");
    }
  });
});
