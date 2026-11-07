import { describe, it, expect, vi } from "vitest";
import {
  buildMenuReferenceSourceSnapshot,
  parseMenuReferenceSourceSnapshot,
  createPostgresMenuReferenceSourceStore,
  menuReferenceSourceFields,
  CatalogError,
} from "../index.js";
const id = (n: number) => `01902415-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_MENU_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function raw() {
  const parent = {
    reviewReference: id(10),
    brandReference: id(1),
    menuReference: id(20),
    menuVersionReference: id(21),
    snapshotDigest: digest,
  };
  return {
    generation: "7",
    observedAt: at,
    counts: { reviews: "2", placements: "1", revisions: "2", releases: "1", periods: "1" },
    reviews: [
      { ...parent, createdAt: at, precise: true },
      {
        ...parent,
        reviewReference: id(11),
        menuVersionReference: id(22),
        createdAt: at,
        precise: true,
      },
    ],
    placements: [
      {
        reviewReference: id(10),
        sectionReference: id(30),
        placementReference: id(31),
        skuReference: id(40),
        productVersionReference: id(41),
      },
    ],
    revisions: [
      { ...parent, lifecycleVersion: 3, state: "Published", changedAt: at, precise: true },
      { ...parent, lifecycleVersion: 4, state: "Superseded", changedAt: at, precise: true },
    ],
    releases: [
      {
        ...parent,
        releaseReference: id(50),
        lifecycleVersion: 3,
        releaseSequence: 1,
        previousReleaseReference: null as string | null,
        releaseKind: "Publish",
        createdAt: at,
        precise: true,
      },
    ],
    periods: [
      {
        timingReference: id(60),
        releaseReference: id(50),
        brandReference: id(1),
        menuReference: id(20),
        timeZone: "America/Toronto",
        effectiveFrom: "2027-01-01T00:00:00.000Z",
        effectiveUntil: null as string | null,
        periodDigest: digest,
        createdAt: at,
        precise: true,
      },
    ],
  };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("complete owning Menu stored reference graph", () => {
  it("retains empty review, all immutable lifecycle history and future schedule without approval inference", () => {
    const s = buildMenuReferenceSourceSnapshot(raw(), request, at);
    expect(s.reviews).toHaveLength(2);
    expect(s.revisions.map((v) => v.state)).toEqual(["Published", "Superseded"]);
    expect(s.periods[0]).toMatchObject({
      effectiveFrom: "2027-01-01T00:00:00.000Z",
      timeZone: "America/Toronto",
    });
    expect(s.applicability).toBe("Unavailable");
    expect(Object.isFrozen(s.placements[0])).toBe(true);
    expect(parseMenuReferenceSourceSnapshot(s, request, at)).toEqual(s);
  });
  it("keeps data digest stable across input order and observation time", () => {
    const a = raw(),
      s = buildMenuReferenceSourceSnapshot(a, request, at),
      later = "2026-09-29T12:00:01.000Z";
    a.reviews.reverse();
    a.revisions.reverse();
    a.observedAt = later;
    expect(buildMenuReferenceSourceSnapshot(a, request, later).digest).toBe(s.digest);
    a.generation = "8";
    expect(buildMenuReferenceSourceSnapshot(a, request, later).digest).not.toBe(s.digest);
  });
  it("accepts truly empty source, denies missing header over existing history", () => {
    const empty = {
      generation: null,
      observedAt: at,
      counts: { reviews: "0", placements: "0", revisions: "0", releases: "0", periods: "0" },
      reviews: [],
      placements: [],
      revisions: [],
      releases: [],
      periods: [],
    };
    expect(buildMenuReferenceSourceSnapshot(empty, request, at).generation).toBe("0");
    expect(() =>
      buildMenuReferenceSourceSnapshot({ ...raw(), generation: null }, request, at),
    ).toThrow(denied);
    expect(() =>
      buildMenuReferenceSourceSnapshot(
        { ...empty, generation: "9223372036854775808" },
        request,
        at,
      ),
    ).toThrow(denied);
  });
  it.each([
    "count",
    "brand",
    "reviewDuplicate",
    "placementParent",
    "placementDuplicate",
    "revisionParent",
    "revisionDuplicate",
    "revisionGap",
    "releaseState",
    "releaseParent",
    "releaseChain",
    "periodParent",
    "periodZone",
    "offsetZone",
    "periodOrder",
    "precision",
  ])("refuses incoherent %s", (kind) => {
    const r = raw();
    const review = r.reviews[0],
      secondReview = r.reviews[1],
      placement = r.placements[0],
      revision = r.revisions[0],
      secondRevision = r.revisions[1],
      release = r.releases[0],
      period = r.periods[0];
    if (
      !review ||
      !secondReview ||
      !placement ||
      !revision ||
      !secondRevision ||
      !release ||
      !period
    )
      throw new Error("fixture missing");
    if (kind === "count") r.counts.reviews = "3";
    if (kind === "brand") review.brandReference = id(99);
    if (kind === "reviewDuplicate") secondReview.reviewReference = id(10);
    if (kind === "placementParent") placement.reviewReference = id(99);
    if (kind === "placementDuplicate") {
      r.placements.push(placement);
      r.counts.placements = "2";
    }
    if (kind === "revisionParent") revision.snapshotDigest = "sha256:" + "b".repeat(64);
    if (kind === "revisionDuplicate") secondRevision.lifecycleVersion = 3;
    if (kind === "revisionGap") secondRevision.lifecycleVersion = 5;
    if (kind === "releaseState") revision.state = "Approved";
    if (kind === "releaseParent") release.menuVersionReference = id(99);
    if (kind === "releaseChain") release.releaseSequence = 2;
    if (kind === "periodParent") period.releaseReference = id(99);
    if (kind === "periodZone") period.timeZone = "Not/A_Zone";
    if (kind === "offsetZone") period.timeZone = "+01:00";
    if (kind === "periodOrder") period.effectiveUntil = period.effectiveFrom;
    if (kind === "precision") review.precise = false;
    expect(() => buildMenuReferenceSourceSnapshot(r, request, at)).toThrow(denied);
  });
  it("refuses changed original request, stable source hash, partial profile, stale clock and getters", () => {
    const s = buildMenuReferenceSourceSnapshot(raw(), request, at);
    expect(() =>
      parseMenuReferenceSourceSnapshot(s, { ...request, operationReference: id(99) }, at),
    ).toThrow(denied);
    expect(() =>
      parseMenuReferenceSourceSnapshot({ ...s, digest: "sha256:" + "b".repeat(64) }, request, at),
    ).toThrow(denied);
    expect(() =>
      parseMenuReferenceSourceSnapshot({ ...s, coverage: "Partial" }, request, at),
    ).toThrow(denied);
    expect(() => parseMenuReferenceSourceSnapshot(s, request, "2026-09-29T12:00:05.001Z")).toThrow(
      denied,
    );
    const getter = vi.fn(() => []),
      executable = { ...s };
    Object.defineProperty(executable, "placements", { enumerable: true, get: getter });
    expect(() => parseMenuReferenceSourceSnapshot(executable, request, at)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects aggregate graph budget instead of truncating references", () => {
    const r = raw(),
      placement = r.placements[0];
    if (!placement) throw new Error("fixture missing");
    r.placements = Array.from({ length: 10000 }, (_, i) => ({
      ...placement,
      placementReference: id(100 + i),
    }));
    r.counts.placements = "10000";
    expect(() => buildMenuReferenceSourceSnapshot(r, request, at)).toThrow(denied);
  });
});
function holder() {
  let generation = "7",
    now = at,
    allow = true;
  const sql: string[] = [],
    events: string[] = [];
  const tx = {
    async query<T extends Record<string, unknown>>(q: string, values: readonly unknown[]) {
      void values;
      sql.push(q);
      let rows: Record<string, unknown>[] = [];
      if (q.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      if (q.startsWith("SELECT jsonb_build_object(")) rows = [{ source: raw() }];
      if (q.includes(" AS generation")) rows = [{ generation }];
      return { rows: rows as T[] };
    },
  };
  const options = {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      async run<T>(work: (actual: typeof tx) => Promise<T>) {
        const result = await work(tx);
        events.push("commit");
        return result;
      },
    },
    clock: { now: () => now },
    authority: {
      async holdUntilTransactionCompletes(actual: typeof tx, input: unknown) {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({
          request,
          permission: "catalog.manage",
          requiredScope: "FullBrandScope",
          requiredFields: menuReferenceSourceFields,
        });
        events.push("authorize");
        if (!allow) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
  };
  return {
    options,
    tx,
    source: createPostgresMenuReferenceSourceStore(options),
    sql,
    events,
    mutate: () => {
      generation = "8";
    },
    stale: () => {
      now = "2026-09-29T12:00:05.001Z";
    },
    deny: () => {
      allow = false;
    },
  };
}
describe("same caller UoW Menu source lifetime", () => {
  it("holds exact current field authority and shared fence until consumer return and outer commit", async () => {
    const h = holder(),
      marker = { done: true };
    expect(
      await h.source.withCurrentSnapshot(request, async (source) => {
        expect(source.reviews).toHaveLength(2);
        h.events.push("consumer");
        return marker;
      }),
    ).toBe(marker);
    expect(h.events).toEqual(["authorize", "authorize", "consumer", "authorize", "commit"]);
    expect(h.sql.some((q) => q.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  });
  it.each(["mutation", "stale", "permission"])(
    "denies late %s before outer completion",
    async (kind) => {
      const h = holder();
      await expect(
        h.source.withCurrentSnapshot(request, async () => {
          h.events.push("consumer");
          if (kind === "mutation") h.mutate();
          if (kind === "stale") h.stale();
          if (kind === "permission") h.deny();
          return true;
        }),
      ).rejects.toMatchObject({
        code:
          kind === "permission" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      expect(h.events).toContain("consumer");
      expect(h.events).not.toContain("commit");
    },
  );
  it.each(["substituted", "repeated", "isolation"])("refuses %s runner evidence", async (kind) => {
    const h = holder();
    const source = createPostgresMenuReferenceSourceStore({
      ...h.options,
      transactions: {
        async run<T>(work: (actual: typeof h.tx) => Promise<T>): Promise<T> {
          if (kind === "isolation")
            return work({
              query: async <T extends Record<string, unknown>>(q: string, v: readonly unknown[]) =>
                q.includes("transaction_isolation")
                  ? { rows: [{ isolation: "repeatable read" }] as unknown as T[] }
                  : h.tx.query<T>(q, v),
            });
          const selected = await work(h.tx);
          if (kind === "repeated") return work(h.tx);
          void selected;
          return {} as T;
        },
      },
    });
    await expect(source.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("denies foreign request and current permission before source SQL", async () => {
    const h = holder();
    await expect(
      h.source.withCurrentSnapshot({ ...request, brandReference: id(99) }, async () => true),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(h.sql).toEqual([]);
    h.deny();
    await expect(h.source.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(h.sql).toEqual([]);
  });
});
