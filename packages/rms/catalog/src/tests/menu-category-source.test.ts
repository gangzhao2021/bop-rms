import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildMenuCategorySourceSnapshot,
  createPostgresMenuCategorySourceStore,
  menuCategorySourceFields,
} from "../index.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-28T12:00:00.000Z",
  brand = id(1),
  digest = `sha256:${"a".repeat(64)}`;
function raw() {
  return {
    observedAt: at,
    roots: [
      {
        menuReference: id(2),
        brandReference: brand,
        aggregateVersion: 1,
        createdAt: at,
        updatedAt: at,
        precise: true,
      },
    ],
    drafts: [
      {
        menuReference: id(2),
        brandReference: brand,
        menuVersionReference: id(3),
        status: "Draft",
        createdAt: at,
        updatedAt: at,
        precise: true,
      },
    ],
    sections: [
      {
        menuReference: id(2),
        brandReference: brand,
        menuVersionReference: id(3),
        sectionReference: id(4),
      },
    ],
    bindings: [
      {
        menuReference: id(2),
        brandReference: brand,
        sectionReference: id(4),
        categoryReference: id(5),
      },
    ],
    reviews: [
      {
        lifecycleReference: id(6),
        menuReference: id(2),
        brandReference: brand,
        menuVersionReference: id(3),
        snapshotDigest: digest,
        createdAt: at,
        coherent: true,
        sectionReferences: [id(4)],
        hasCategoryBindings: true,
        categoryBindings: [{ sectionReference: id(4), categoryReferences: [id(7)] }],
      },
    ],
    revisions: [
      {
        lifecycleReference: id(6),
        menuReference: id(2),
        brandReference: brand,
        menuVersionReference: id(3),
        snapshotDigest: digest,
        state: "InReview",
        lifecycleVersion: 2,
        firstVersion: 2,
        revisionCount: 1,
        coherent: true,
      },
    ],
  };
}
const build = (value: unknown, now = at) => buildMenuCategorySourceSnapshot(value, brand, now);
describe("complete Menu Category statement source", () => {
  it("separates current Draft and immutable reviewed bindings without inventing release facts", () => {
    const input = raw(),
      result = build(input);
    expect(result).toMatchObject({
      brandReference: brand,
      consistency: "StatementSnapshot",
      reviewCategoryCoverage: "Known",
      menus: [
        {
          draftCategoryBindings: [{ categoryReferences: [id(5)] }],
          reviewedSnapshots: [
            {
              lifecycle: "InReview",
              lifecycleVersion: 2,
              categoryBindings: [{ categoryReferences: [id(7)] }],
            },
          ],
        },
      ],
    });
    const first = input.bindings[0];
    if (!first) throw new Error("fixture");
    first.categoryReference = id(8);
    expect(result.menus[0]?.draftCategoryBindings[0]?.categoryReferences).toEqual([id(5)]);
    expect(Object.isFrozen(result.menus[0]?.reviewedSnapshots)).toBe(true);
    expect(build(raw(), "2026-09-28T12:00:00.001Z").sourceDigest).toBe(result.sourceDigest);
    expect(JSON.stringify(result)).not.toMatch(
      /createdByActor|localizedNames|storeReferences|sellable|allergen/,
    );
  });
  it("keeps legacy reviewed coverage unknown while retaining complete current Draft facts", () => {
    const input: Record<string, unknown> = raw();
    input.reviews = [{ ...raw().reviews[0], hasCategoryBindings: false, categoryBindings: null }];
    const result = build(input);
    expect(result.reviewCategoryCoverage).toBe("Unavailable");
    expect(Object.hasOwn(result.menus[0]?.reviewedSnapshots[0] ?? {}, "categoryBindings")).toBe(
      false,
    );
    expect(result.menus[0]?.draftCategoryBindings[0]?.categoryReferences).toEqual([id(5)]);
  });
  it("distinguishes complete empty Brand, empty sections, unsubmitted review and explicit empty review bindings", () => {
    expect(
      build({
        observedAt: at,
        roots: [],
        drafts: [],
        sections: [],
        bindings: [],
        reviews: [],
        revisions: [],
      }),
    ).toMatchObject({ menus: [], reviewCategoryCoverage: "Known" });
    const input: Record<string, unknown> = raw();
    input.sections = [];
    input.bindings = [];
    input.reviews = [];
    input.revisions = [];
    expect(build(input).menus[0]?.draftCategoryBindings).toEqual([]);
    const unsubmitted = { ...raw(), revisions: [] };
    expect(build(unsubmitted).menus[0]?.reviewedSnapshots[0]).toMatchObject({
      lifecycle: null,
      lifecycleVersion: null,
    });
    const empty = raw();
    const review = empty.reviews[0],
      binding = review?.categoryBindings[0];
    if (!binding) throw new Error("fixture");
    binding.categoryReferences = [];
    expect(build(empty).reviewCategoryCoverage).toBe("Known");
  });
  it("preserves all existing publication states and source digest changes", () => {
    const original = build(raw());
    for (const state of ["Draft", "InReview", "Approved", "Published", "Archived", "Superseded"]) {
      const input = raw();
      const revision = input.revisions[0];
      if (!revision) throw new Error("fixture");
      revision.state = state;
      expect(build(input).menus[0]?.reviewedSnapshots[0]?.lifecycle).toBe(state);
      if (state !== "InReview") expect(build(input).sourceDigest).not.toBe(original.sourceDigest);
    }
  });
  it.each(["roots", "drafts", "sections", "bindings", "reviews", "revisions"] as const)(
    "rejects scope drift, duplicates and forged fields in %s",
    (key) => {
      const input = raw();
      for (const rows of [
        [{ ...input[key][0], brandReference: id(99) }],
        [...input[key], ...input[key]],
        [{ ...input[key][0], actorReference: id(99) }],
      ])
        expect(() => build({ ...input, [key]: rows })).toThrow(CatalogError);
    },
  );
  it("rejects incomplete graphs and review evidence rather than returning known zero", () => {
    const base = raw();
    for (const input of [
      { ...base, roots: [] },
      { ...base, drafts: [] },
      { ...base, sections: [] },
      { ...base, reviews: [] },
      {
        ...base,
        reviews: [{ ...base.reviews[0], menuVersionReference: id(99) }],
        revisions: [{ ...base.revisions[0], menuVersionReference: id(99) }],
      },
      { ...base, revisions: [{ ...base.revisions[0], coherent: false }] },
      { ...base, revisions: [{ ...base.revisions[0], revisionCount: 2 }] },
      {
        ...base,
        revisions: [{ ...base.revisions[0], snapshotDigest: `sha256:${"b".repeat(64)}` }],
      },
      { ...base, reviews: [{ ...base.reviews[0], sectionReferences: [id(99)] }] },
      { ...base, reviews: [{ ...base.reviews[0], categoryBindings: [] }] },
      { ...base, reviews: [{ ...base.reviews[0], hasCategoryBindings: false }] },
      { ...base, roots: [{ ...base.roots[0], precise: false }] },
      { ...base, drafts: [{ ...base.drafts[0], updatedAt: "2026-09-28T12:00:00.001Z" }] },
    ])
      expect(() => build(input)).toThrow(CatalogError);
  });
  it("enforces actual statement freshness, descriptor and resource budgets", () => {
    expect(() => build(raw(), "2026-09-28T11:59:59.999Z")).toThrow(CatalogError);
    expect(() => build(raw(), "2026-09-28T12:00:05.001Z")).toThrow(CatalogError);
    expect(build(raw(), "2026-09-28T12:00:05.000Z").observedAt).toBe(at);
    let invoked = 0;
    expect(() =>
      build({
        ...raw(),
        get bindings() {
          invoked++;
          return [];
        },
      }),
    ).toThrow(CatalogError);
    expect(invoked).toBe(0);
    expect(() => build({ ...raw(), roots: new Array(10001) })).toThrow(CatalogError);
  });
  it("binds one exact owning transaction, independent current fields and closed SQL data", async () => {
    const hold = vi.fn(async () => undefined);
    let sourceReads = 0;
    const tx: ProductLifecycleTransaction = {
      async query<Row>(sql: string, values: readonly unknown[]) {
        if (sql.includes("transaction_isolation"))
          return { rows: [{ isolation: "read committed" }] as Row[], rowCount: 1 };
        if (sql.includes(") source")) {
          sourceReads++;
          expect(values).toEqual([brand]);
          expect(sql).not.toMatch(/LOCK TABLE|SELECT \*|created_by_actor|localized_names|allergen/);
          return { rows: [{ source: raw() }] as Row[], rowCount: 1 };
        }
        return { rows: [] as Row[], rowCount: 1 };
      },
    };
    const store = createPostgresMenuCategorySourceStore({
      tenantReference: id(10),
      brandReference: brand,
      actorReference: id(11),
      transactions: { run: async (work) => work(tx) },
      authority: { holdUntilTransactionCompletes: hold },
      clock: { now: () => at },
    });
    expect((await store.loadSnapshot()).reviewCategoryCoverage).toBe("Known");
    expect(sourceReads).toBe(1);
    expect(hold).toHaveBeenCalledTimes(2);
    expect(hold).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        purposeCode: "CATALOG_MENU_CATEGORY_SOURCE_READ",
        requiredFields: menuCategorySourceFields,
        tenantReference: id(10),
        actorReference: id(11),
      }),
    );
  });
  it("rejects clock rollback or expiry after authorization and outer COMMIT denial", async () => {
    const tx: ProductLifecycleTransaction = {
      async query<Row>(sql: string) {
        return {
          rows: (sql.includes("transaction_isolation")
            ? [{ isolation: "read committed" }]
            : [{ source: raw() }]) as Row[],
          rowCount: 1,
        };
      },
    };
    for (const last of ["2026-09-28T11:59:59.999Z", "2026-09-28T12:00:05.001Z"]) {
      let n = 0;
      const store = createPostgresMenuCategorySourceStore({
        tenantReference: id(10),
        brandReference: brand,
        actorReference: id(11),
        transactions: { run: async (work) => work(tx) },
        authority: { holdUntilTransactionCompletes: async () => undefined },
        clock: { now: () => (++n === 4 ? last : at) },
      });
      await expect(store.loadSnapshot()).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    }
    const store = createPostgresMenuCategorySourceStore({
      tenantReference: id(10),
      brandReference: brand,
      actorReference: id(11),
      transactions: {
        async run(work) {
          await work(tx);
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        },
      },
      authority: { holdUntilTransactionCompletes: async () => undefined },
      clock: { now: () => at },
    });
    await expect(store.loadSnapshot()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  });
  it("rejects slow outer COMMIT and a runner replacing the authorized result", async () => {
    const tx: ProductLifecycleTransaction = {
      async query<Row>(sql: string) {
        return {
          rows: (sql.includes("transaction_isolation")
            ? [{ isolation: "read committed" }]
            : [{ source: raw() }]) as Row[],
          rowCount: 1,
        };
      },
    };
    for (const mode of [
      "slowCommit",
      "replacedResult",
      "duplicateCallback",
      "missingCallback",
    ] as const) {
      let now = at;
      const store = createPostgresMenuCategorySourceStore({
        tenantReference: id(10),
        brandReference: brand,
        actorReference: id(11),
        transactions: {
          async run<T>(work: (value: ProductLifecycleTransaction) => Promise<T>): Promise<T> {
            if (mode === "missingCallback") return {} as T;
            const result = await work(tx);
            if (mode === "duplicateCallback") await work(tx);
            if (mode === "replacedResult") return JSON.parse(JSON.stringify(result)) as T;
            now = "2026-09-28T12:00:05.001Z";
            return result;
          },
        },
        authority: { holdUntilTransactionCompletes: async () => undefined },
        clock: { now: () => now },
      });
      await expect(store.loadSnapshot()).rejects.toMatchObject({
        code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    }
  });
  it("keeps typed denial and bounds raw errors, stale reads and old isolation snapshots", async () => {
    for (const mode of ["denied", "lateDenied", "private", "oldIsolation", "stale"] as const) {
      let calls = 0;
      const tx: ProductLifecycleTransaction = {
        async query<Row>(sql: string) {
          if (mode === "private") throw new Error("private SQL");
          if (sql.includes("transaction_isolation"))
            return {
              rows: [
                { isolation: mode === "oldIsolation" ? "repeatable read" : "read committed" },
              ] as Row[],
              rowCount: 1,
            };
          return { rows: [{ source: raw() }] as Row[], rowCount: 1 };
        },
      };
      const store = createPostgresMenuCategorySourceStore({
        tenantReference: id(10),
        brandReference: brand,
        actorReference: id(11),
        transactions: { run: async (work) => work(tx) },
        authority: {
          async holdUntilTransactionCompletes() {
            if (mode === "denied" || (mode === "lateDenied" && ++calls === 2))
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
          },
        },
        clock: { now: () => (mode === "stale" ? "2026-09-28T12:00:05.001Z" : at) },
      });
      await expect(store.loadSnapshot()).rejects.toMatchObject({
        code:
          mode.includes("Denied") || mode === "denied"
            ? "CATALOG_PERMISSION_DENIED"
            : "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
    }
  });
});
