import { describe, expect, it } from "vitest";
import {
  CatalogError,
  parseCatalogReference,
  categorySourceDigest,
  parseCategoryAggregate,
  parseMenuCategorySourceSnapshot,
  deriveCategoryMenuUse,
  parseCategoryMenuUse,
  deriveCatalogCategoryTreeView,
  parseCatalogCategoryTreeView,
  parseProductClassificationSourceSnapshot,
  type MenuCategorySourceSnapshot,
} from "../index.js";
const id = (n: number) =>
  parseCatalogReference(`01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-09-28T12:00:00.000Z",
  brand = id(1),
  sha = `sha256:${"a".repeat(64)}`;
function category() {
  const categories = [10, 11, 12].map((n) =>
    parseCategoryAggregate({
      categoryReference: id(n),
      brandReference: brand,
      internalCode: "CATEGORY_" + n,
      lifecycle: "Draft",
      aggregateVersion: 1,
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic " + n },
      localizedDescriptions: {},
      parentCategoryReference: n === 11 ? id(10) : null,
      level: n === 11 ? 2 : 1,
      sortOrder: n,
      storeReferences: [],
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(2),
    }),
  );
  const core = { brandReference: brand, sourceRevision: "3", categories };
  return { ...core, observedAt: at, sourceDigest: categorySourceDigest(core) };
}
function menu(legacy = false): MenuCategorySourceSnapshot {
  const binding = (section: number, category: number) => ({
    sectionReference: id(section),
    categoryReferences: [id(category)],
  });
  const reviews = [
    {
      lifecycleReference: id(40),
      menuVersionReference: id(21),
      snapshotDigest: sha,
      lifecycle: "Published" as const,
      lifecycleVersion: 4,
      categoryBindings: [binding(30, 11)],
    },
    {
      lifecycleReference: id(41),
      menuVersionReference: id(21),
      snapshotDigest: sha,
      lifecycle: "Archived" as const,
      lifecycleVersion: 5,
      ...(legacy ? {} : { categoryBindings: [binding(30, 11)] }),
    },
    {
      lifecycleReference: id(42),
      menuVersionReference: id(21),
      snapshotDigest: sha,
      lifecycle: "Published" as const,
      lifecycleVersion: 4,
      categoryBindings: [binding(30, 11)],
    },
  ];
  const menus = [
    {
      menuReference: id(20),
      aggregateVersion: 1,
      draftVersionReference: id(21),
      draftCategoryBindings: [binding(30, 11), binding(31, 11)],
      reviewedSnapshots: reviews,
    },
    {
      menuReference: id(22),
      aggregateVersion: 1,
      draftVersionReference: id(23),
      draftCategoryBindings: [binding(32, 12)],
      reviewedSnapshots: [
        {
          lifecycleReference: id(43),
          menuVersionReference: id(23),
          snapshotDigest: sha,
          lifecycle: "Published" as const,
          lifecycleVersion: 4,
          categoryBindings: [binding(32, 11)],
        },
      ],
    },
  ];
  return {
    brandReference: brand,
    consistency: "StatementSnapshot",
    observedAt: at,
    sourceDigest: categorySourceDigest({ brandReference: brand, menus }),
    reviewCategoryCoverage: legacy ? "Unavailable" : "Known",
    menus,
  } as MenuCategorySourceSnapshot;
}
function product() {
  return parseProductClassificationSourceSnapshot({
    observedAt: at,
    products: [],
    generation: {
      generationReference: id(60),
      brandReference: brand,
      sourceRevision: "0",
      sourceDigest: sha,
      projectedAt: at,
      productCount: 0,
      coverage: "CatalogProductDraftV1",
      partial: true,
    },
  });
}
describe("Category Menu use from complete owner source", () => {
  it("counts distinct Menus across sections and snapshots and keeps archive separate", () => {
    const view = deriveCategoryMenuUse(menu(), category());
    expect(view.categories[0]?.menuUse).toMatchObject({
      status: "Known",
      draftMenuCount: 0,
      reviewed: { total: { status: "Known", menuCount: 0 } },
    });
    expect(view.categories[1]?.menuUse).toMatchObject({
      status: "Known",
      draftMenuCount: 1,
      reviewed: {
        total: { status: "Known", menuCount: 2 },
        byLifecycle: {
          Published: { status: "Known", menuCount: 2 },
          Archived: { status: "Known", menuCount: 1 },
          NoPersistedLifecycle: { status: "Known", menuCount: 0 },
        },
      },
    });
    expect(view.categories[2]?.menuUse).toMatchObject({
      draftMenuCount: 1,
      reviewed: { total: { status: "Known", menuCount: 0 } },
    });
    expect(Object.isFrozen(view.categories[1]?.menuUse)).toBe(true);
    const publicResult = JSON.stringify(view);
    for (const reference of [id(20), id(21), id(30), id(40)])
      expect(publicResult).not.toContain(reference);
  });
  it("keeps unknown legacy state and total separate from other known lifecycle measures", () => {
    const view = deriveCategoryMenuUse(menu(true), category());
    expect(view.categories[1]?.menuUse).toMatchObject({
      status: "Partial",
      draftMenuCount: 1,
      reviewed: {
        total: { status: "Unavailable" },
        byLifecycle: {
          Archived: { status: "Unavailable" },
          Published: { status: "Known", menuCount: 2 },
        },
      },
    });
    expect(view.categories[2]?.menuUse).toMatchObject({
      status: "Partial",
      draftMenuCount: 1,
      reviewed: { byLifecycle: { Archived: { status: "Unavailable" } } },
    });
  });
  it("preserves complete empty Source as known zero and null lifecycle as NoPersistedLifecycle", () => {
    const empty = {
      ...menu(),
      menus: [],
      sourceDigest: categorySourceDigest({ brandReference: brand, menus: [] }),
    };
    expect(deriveCategoryMenuUse(empty, category()).categories[1]?.menuUse).toMatchObject({
      draftMenuCount: 0,
      reviewed: { total: { status: "Known", menuCount: 0 } },
    });
    const input = structuredClone(menu());
    const row = input.menus[0]?.reviewedSnapshots[0];
    if (!row) throw new Error("fixture");
    const altered = { ...row, lifecycle: null, lifecycleVersion: null };
    const menus = input.menus.map((item, n) =>
      n === 0 ? { ...item, reviewedSnapshots: [altered] } : item,
    );
    const result = deriveCategoryMenuUse(
      { ...input, menus, sourceDigest: categorySourceDigest({ brandReference: brand, menus }) },
      category(),
    );
    expect(result.categories[1]?.menuUse).toMatchObject({
      reviewed: { byLifecycle: { NoPersistedLifecycle: { status: "Known", menuCount: 1 } } },
    });
  });
  it("validates Source scope, checksum, timing and complete reference ownership", () => {
    const base = menu();
    for (const input of [
      { ...base, brandReference: id(99) },
      { ...base, sourceDigest: sha },
      { ...base, reviewCategoryCoverage: "Unavailable" },
      { ...base, observedAt: "2026-09-28T12:00:00.001Z" },
      { ...base, observedAt: "2026-09-28T11:59:54.999Z" },
      { ...base, menus: [...base.menus, ...base.menus] },
      { ...base, actorReference: id(99) },
    ])
      expect(() => deriveCategoryMenuUse(input as MenuCategorySourceSnapshot, category())).toThrow(
        CatalogError,
      );
    const menus = base.menus.map((item) => ({
      ...item,
      draftCategoryBindings: [{ sectionReference: id(30), categoryReferences: [id(99) as never] }],
    }));
    expect(() =>
      deriveCategoryMenuUse(
        { ...base, menus, sourceDigest: categorySourceDigest({ brandReference: brand, menus }) },
        category(),
      ),
    ).toThrow(CatalogError);
    expect(() => deriveCategoryMenuUse(base, { ...category(), sourceDigest: sha })).toThrow(
      CatalogError,
    );
  });
  it("parses/freeze-copies the public Source and rejects mixed version/getter packets", () => {
    const input = menu(),
      parsed = parseMenuCategorySourceSnapshot(input, brand, at);
    expect(parsed).toEqual(input);
    expect(Object.isFrozen(parsed.menus[0]?.draftCategoryBindings)).toBe(true);
    let called = 0;
    expect(() =>
      parseMenuCategorySourceSnapshot(
        {
          ...input,
          get menus() {
            called++;
            return [];
          },
        },
        brand,
        at,
      ),
    ).toThrow(CatalogError);
    expect(called).toBe(0);
    const menus = input.menus.map((item) => ({
      ...item,
      reviewedSnapshots: item.reviewedSnapshots.map((row) => ({
        ...row,
        menuVersionReference: id(99),
      })),
    }));
    expect(() =>
      parseMenuCategorySourceSnapshot(
        { ...input, menus, sourceDigest: categorySourceDigest({ brandReference: brand, menus }) },
        brand,
        at,
      ),
    ).toThrow(CatalogError);
  });
  it("binds the tree count variants to their Menu source provenance", () => {
    const tree = deriveCatalogCategoryTreeView(product(), category(), "en-CA", menu());
    expect(tree.source.menu).toMatchObject({
      consistency: "StatementSnapshot",
      reviewCategoryCoverage: "Known",
      asOfUtc: at,
    });
    expect(tree.items[1]?.menuUse).toMatchObject({ draftMenuCount: 1 });
    expect(parseCatalogCategoryTreeView(tree)).toEqual(tree);
    const { menu: omitted, ...source } = tree.source;
    expect(omitted).toBeDefined();
    expect(() => parseCatalogCategoryTreeView({ ...tree, source })).toThrow(CatalogError);
    expect(() =>
      parseCatalogCategoryTreeView({
        ...tree,
        source: {
          ...tree.source,
          menu: { ...tree.source.menu, reviewCategoryCoverage: "Unavailable" },
        },
      }),
    ).toThrow(CatalogError);
    const legacy = deriveCatalogCategoryTreeView(product(), category(), "en-CA", menu(true));
    expect(parseCatalogCategoryTreeView(legacy).items[1]?.menuUse).toMatchObject({
      status: "Partial",
    });
  });
  it("rejects forged, inconsistent, oversized and false-zero count variants", () => {
    const known = deriveCategoryMenuUse(menu(), category()).categories[1]?.menuUse;
    if (!known || known.status !== "Known") throw new Error("fixture");
    for (const input of [
      { ...known, draftMenuCount: 10001 },
      { ...known, menuReference: id(99) },
      { ...known, status: "Partial" },
      { ...known, reviewed: { ...known.reviewed, total: { status: "Known", menuCount: 0 } } },
      { ...known, reviewed: { ...known.reviewed, total: { status: "Unavailable" } } },
    ])
      expect(() => parseCategoryMenuUse(input, "Known")).toThrow(CatalogError);
    expect(() => parseCategoryMenuUse(known)).toThrow(CatalogError);
  });
});
