import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  createPostgresProductSearchGenerationStore,
  parseCategoryAggregate,
  parseProductClassificationSourceSnapshot,
  deriveCatalogCategoryProductView,
  deriveCatalogCategoryTreeView,
  parseCatalogCategoryTreeView,
  categoryTreeViewFields,
  deriveCatalogCategoryTreeQueryView,
  parseCatalogCategoryTreeFilters,
  parseCatalogCategoryTreeQueryView,
  selectCatalogCategoryProducts,
  categorySourceDigest,
} from "../index.js";
import type { CategorySourceSnapshot } from "../index.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T08:00:00.000Z";
function fixtures(known = true) {
  const product = parseProductClassificationSourceSnapshot({
    generation: {
      generationReference: id(100),
      brandReference: id(1),
      sourceRevision: "9007199254740993",
      sourceDigest: "sha256:" + "a".repeat(64),
      projectedAt: at,
      productCount: 2,
      coverage: "CatalogProductDraftV1",
      partial: true,
    },
    observedAt: at,
    products: [
      {
        productReference: id(20),
        productVersionReference: id(21),
        lifecycle: "Draft",
        ...(known
          ? {
              categoryClassification: {
                categoryReferences: [id(11)],
                primaryCategoryReference: id(11),
              },
            }
          : {}),
      },
      {
        productReference: id(22),
        productVersionReference: id(23),
        lifecycle: "Archived",
        categoryClassification: { categoryReferences: [id(11)], primaryCategoryReference: null },
      },
    ],
  });
  const categories = [10, 11, 12].map((n, index) =>
    parseCategoryAggregate({
      categoryReference: id(n),
      brandReference: id(1),
      internalCode: "CATEGORY_" + n,
      lifecycle: "Draft" as const,
      aggregateVersion: 1,
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic " + n },
      localizedDescriptions: {},
      parentCategoryReference: n === 11 ? id(10) : null,
      level: n === 11 ? (2 as const) : (1 as const),
      sortOrder: index,
      storeReferences: [],
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
    }),
  );
  const core = { brandReference: id(1), sourceRevision: "3", categories };
  const category: CategorySourceSnapshot = {
    ...core,
    observedAt: at,
    sourceDigest: categorySourceDigest(core),
  };
  return { product, category };
}
describe("complete Product classification / Category view", () => {
  it("counts direct Draft membership with explicit Archived measures and no ancestor roll-up", () => {
    const f = fixtures(),
      view = deriveCatalogCategoryProductView(f.product, f.category);
    expect(view.configuration).toBe("Draft");
    expect(view.categories[0]?.productCount).toEqual({
      status: "Known",
      includingArchived: 0,
      excludingArchived: 0,
    });
    expect(view.categories[1]?.productCount).toEqual({
      status: "Known",
      includingArchived: 2,
      excludingArchived: 1,
    });
    expect(selectCatalogCategoryProducts(view, id(11)).map((row) => row.productReference)).toEqual([
      id(20),
    ]);
    expect(selectCatalogCategoryProducts(view, id(11), true)).toHaveLength(2);
    expect(selectCatalogCategoryProducts(view, id(10))).toHaveLength(0);
    expect(Object.isFrozen(view.categories[1])).toBe(true);
    expect(JSON.stringify(view)).not.toContain("createdByActorReference");
  });
  it("preserves unknown absence and fails count/membership coverage rather than inventing zero", () => {
    const f = fixtures(false),
      view = deriveCatalogCategoryProductView(f.product, f.category);
    expect(view.unknownClassificationProductCount).toBe(1);
    expect(view.categories.every((node) => node.productCount.status === "Unavailable")).toBe(true);
    expect(Object.hasOwn(view.products[0] ?? {}, "categoryClassification")).toBe(false);
    expect(() => selectCatalogCategoryProducts(view, id(11))).toThrow(CatalogError);
  });
  it("keeps explicit empty classification known zero", () => {
    const f = fixtures();
    const product = {
      ...f.product,
      products: f.product.products.map((row) => ({
        ...row,
        categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      })),
    };
    const view = deriveCatalogCategoryProductView(product, f.category);
    expect(view.unknownClassificationProductCount).toBe(0);
    expect(
      view.categories.every(
        (node) => node.productCount.status === "Known" && node.productCount.includingArchived === 0,
      ),
    ).toBe(true);
  });
  it.each(["brand", "digest", "missing"])("rejects invalid Category source %s", (change) => {
    const f = fixtures();
    const category =
      change === "brand"
        ? { ...f.category, brandReference: id(2) }
        : change === "digest"
          ? { ...f.category, sourceDigest: "sha256:" + "f".repeat(64) }
          : { ...f.category, categories: [] };
    expect(() => deriveCatalogCategoryProductView(f.product, category)).toThrow(CatalogError);
  });
  it.each(["count", "duplicate", "stale", "future", "coverage", "primary"])(
    "rejects invalid complete Product snapshot %s",
    (change) => {
      const f = fixtures();
      const product =
        change === "count"
          ? { ...f.product, generation: { ...f.product.generation, productCount: 3 } }
          : change === "duplicate"
            ? { ...f.product, products: [f.product.products[0], f.product.products[0]] }
            : change === "stale"
              ? { ...f.product, observedAt: "2026-09-28T08:00:30.001Z" }
              : change === "future"
                ? { ...f.product, observedAt: "2026-09-28T07:59:59.999Z" }
                : change === "coverage"
                  ? { ...f.product, generation: { ...f.product.generation, partial: false } }
                  : {
                      ...f.product,
                      products: [
                        {
                          ...f.product.products[0],
                          categoryClassification: {
                            categoryReferences: [id(11)],
                            primaryCategoryReference: id(12),
                          },
                        },
                        f.product.products[1],
                      ],
                    };
      expect(() => parseProductClassificationSourceSnapshot(product)).toThrow(CatalogError);
    },
  );
  it("never invokes source or selector getters", () => {
    const f = fixtures(),
      getter = vi.fn(() => f.product.products);
    const source = { ...f.product };
    Object.defineProperty(source, "products", { enumerable: true, get: getter });
    expect(() => parseProductClassificationSourceSnapshot(source)).toThrow(CatalogError);
    const view = deriveCatalogCategoryProductView(f.product, f.category);
    const poison = { ...view };
    Object.defineProperty(poison, "products", { enumerable: true, get: getter });
    expect(() => selectCatalogCategoryProducts(poison, id(11))).toThrow(CatalogError);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects forged zero unknown coverage and invalid membership scope", () => {
    const f = fixtures(false),
      view = deriveCatalogCategoryProductView(f.product, f.category);
    expect(() =>
      selectCatalogCategoryProducts({ ...view, unknownClassificationProductCount: 0 }, id(11)),
    ).toThrow(CatalogError);
    const complete = deriveCatalogCategoryProductView(fixtures().product, fixtures().category);
    expect(() => selectCatalogCategoryProducts(complete, id(99))).toThrow(CatalogError);
  });
});

describe("complete classification resource budget", () => {
  it("rejects a complete valid-per-Product source over its assignment budget instead of returning partial counts", () => {
    const f = fixtures(),
      refs = Array.from({ length: 10000 }, (_, n) => id(100000 + n));
    const products = Array.from({ length: 6 }, (_, n) => ({
      productReference: id(200000 + n),
      productVersionReference: id(300000 + n),
      lifecycle: "Draft",
      categoryClassification: { categoryReferences: refs, primaryCategoryReference: null },
    }));
    expect(() =>
      parseProductClassificationSourceSnapshot({
        ...f.product,
        generation: { ...f.product.generation, productCount: products.length },
        products,
      }),
    ).toThrow(CatalogError);
  });
});
describe("derived Category view authority", () => {
  it("has no default count/Phase holder and refuses before source SQL", async () => {
    const run = vi.fn(),
      hold = vi.fn();
    const store = createPostgresProductSearchGenerationStore({
      tenantReference: id(4),
      brandReference: id(1),
      actorReference: id(3),
      maximumProducts: 100,
      transactions: { run },
      authorization: { holdUntilTransactionCompletes: hold },
      clock: { now: () => at },
    });
    await expect(store.loadCategoryProductView()).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
    expect(hold).not.toHaveBeenCalled();
  });
  it("requires derived fields independently before reading either source", async () => {
    const sourceHold = vi.fn(),
      categoryHold = vi.fn(),
      query = vi.fn(async () => {
        throw new Error("unexpected source SQL");
      });
    const viewHold = vi.fn(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
    const store = createPostgresProductSearchGenerationStore({
      tenantReference: id(4),
      brandReference: id(1),
      actorReference: id(3),
      maximumProducts: 100,
      transactions: { run: async (work) => work({ query }) },
      authorization: { holdUntilTransactionCompletes: sourceHold },
      clock: { now: () => at },
      categorySource: {
        authority: { holdUntilTransactionCompletes: categoryHold },
        viewAuthority: { holdUntilTransactionCompletes: viewHold },
        maximumCategoryNodes: 100,
        maximumSourceCommits: 100,
      },
    });
    await expect(store.loadCategoryProductView()).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(viewHold).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(3),
        purposeCode: "CATALOG_CATEGORY_PRODUCT_VIEW_READ",
        permission: "catalog.manage",
        capability: "catalog.cat_category_tree",
        referencedCapability: "catalog.cat_product_list",
        requiredFields: [
          "productCount",
          "primaryCategoryName",
          "categoryMembership",
          "categoryFilterOptions",
        ],
      }),
    );
    expect(sourceHold).not.toHaveBeenCalled();
    expect(categoryHold).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});

describe("complete normal Category tree source", () => {
  function tree(known = true) {
    const f = fixtures(known);
    return deriveCatalogCategoryTreeView(f.product, f.category, "fr-CA");
  }
  it("returns source-bound parent-before-child topology, localized fallback and precise direct Draft counts", () => {
    const view = tree();
    expect(
      view.items.map((row) => [
        row.categoryReference,
        row.parentCategoryReference,
        row.level,
        row.sortOrder,
      ]),
    ).toEqual([
      [id(10), null, 1, 0],
      [id(11), id(10), 2, 1],
      [id(12), null, 1, 2],
    ]);
    expect(view.items[1]).toMatchObject({
      name: "Synthetic 11",
      nameLocale: "en-CA",
      localeFallback: true,
      aggregateVersion: "1",
      productCount: { status: "Known", includingArchived: 2, excludingArchived: 1 },
      menuUse: { status: "Unavailable" },
    });
    expect(view.items[0]?.productCount).toEqual({
      status: "Known",
      includingArchived: 0,
      excludingArchived: 0,
    });
    expect(view.source.category).toEqual({
      revision: "3",
      digest: fixtures().category.sourceDigest,
      asOfUtc: at,
    });
    expect(view.source.products.revision).toBe("9007199254740993");
    expect(view.projection).toEqual({
      name: "catalog_category_tree_v1",
      version: 1,
      asOfUtc: at,
      stale: false,
      partial: true,
    });
    expect(Object.isFrozen(view.items[1]?.productCount)).toBe(true);
    const json = JSON.stringify(view);
    for (const forbidden of [
      "createdByActorReference",
      "updatedAt",
      "localizedDescriptions",
      "storeReferences",
      "productReference",
      "categoryClassification",
    ])
      expect(json).not.toContain(forbidden);
  });
  it("keeps unknown classification count coverage distinct from complete topology and absent Menu source", () => {
    const view = tree(false);
    expect(view.items).toHaveLength(3);
    expect(view.classificationCoverage).toBe("Unavailable");
    expect(
      view.items.every(
        (row) => row.productCount.status === "Unavailable" && row.menuUse.status === "Unavailable",
      ),
    ).toBe(true);
  });
  it("orders by actual sibling order rather than incoming source order", () => {
    const f = fixtures();
    const categories = [...f.category.categories].reverse();
    const source = {
      ...f.category,
      categories,
      sourceDigest: categorySourceDigest({
        brandReference: f.category.brandReference,
        sourceRevision: f.category.sourceRevision,
        categories,
      }),
    };
    expect(
      deriveCatalogCategoryTreeView(f.product, source, "en-CA").items.map(
        (row) => row.internalCode,
      ),
    ).toEqual(["CATEGORY_10", "CATEGORY_11", "CATEGORY_12"]);
  });
  it.each([
    "duplicate",
    "code",
    "parent",
    "cycle",
    "depth",
    "order",
    "count",
    "coverage",
    "fallback",
    "menu",
    "source",
    "future",
    "budget",
    "extra",
  ])("rejects malformed/incoherent complete tree %s", (change) => {
    const view = structuredClone(tree());
    const first = view.items[0],
      child = view.items[1],
      last = view.items[2];
    if (!first || !child || !last) throw new Error("missing fixture row");
    const bad = view as unknown as Record<string, unknown>;
    if (change === "duplicate") bad.items = [first, first, last];
    if (change === "code")
      bad.items = [first, child, { ...last, internalCode: first.internalCode }];
    if (change === "parent")
      bad.items = [first, { ...child, parentCategoryReference: id(999) }, last];
    if (change === "cycle")
      bad.items = [{ ...first, parentCategoryReference: child.categoryReference }, child, last];
    if (change === "depth") bad.items = [first, { ...child, level: 3 }, last];
    if (change === "order") bad.items = [last, first, child];
    if (change === "count")
      bad.items = [
        first,
        { ...child, productCount: { status: "Known", includingArchived: 1, excludingArchived: 2 } },
        last,
      ];
    if (change === "coverage") bad.classificationCoverage = "Unavailable";
    if (change === "fallback") bad.items = [first, { ...child, localeFallback: false }, last];
    if (change === "menu")
      bad.items = [first, { ...child, menuUse: { status: "Known", count: 0 } }, last];
    if (change === "source")
      bad.source = {
        ...view.source,
        category: { ...view.source.category, asOfUtc: "2026-09-28T08:00:00.001Z" },
      };
    if (change === "future")
      bad.source = {
        ...view.source,
        products: { ...view.source.products, asOfUtc: "2026-09-28T08:00:00.001Z" },
      };
    if (change === "budget")
      bad.items = [
        first,
        {
          ...child,
          productCount: { status: "Known", includingArchived: 10001, excludingArchived: 0 },
        },
        last,
      ];
    if (change === "extra") bad.actorReference = id(3);
    expect(() => parseCatalogCategoryTreeView(bad)).toThrow(CatalogError);
  });
  it("rejects accessor snapshots and DTOs without invoking them", () => {
    const f = fixtures(),
      getter = vi.fn(() => f.category.categories),
      category = { ...f.category };
    Object.defineProperty(category, "categories", { enumerable: true, get: getter });
    expect(() => deriveCatalogCategoryTreeView(f.product, category, "en-CA")).toThrow(CatalogError);
    const view = { ...tree() };
    Object.defineProperty(view, "items", { enumerable: true, get: getter });
    expect(() => parseCatalogCategoryTreeView(view)).toThrow(CatalogError);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects unconfigured tree holder before a transaction and never borrows Product view grants", async () => {
    const run = vi.fn(async () => {
      throw new Error("unexpected SQL");
    });
    const store = createPostgresProductSearchGenerationStore({
      tenantReference: id(2),
      brandReference: id(1),
      actorReference: id(3),
      transactions: { run },
      authorization: { holdUntilTransactionCompletes: vi.fn() },
      clock: { now: () => at },
      maximumProducts: 100,
    });
    await expect(store.loadCategoryTreeView("en-CA")).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(run).not.toHaveBeenCalled();
    expect(categoryTreeViewFields).toEqual([
      "categoryReference",
      "internalCode",
      "localizedNames",
      "lifecycle",
      "parentCategoryReference",
      "level",
      "sortOrder",
      "aggregateVersion",
      "productCount",
      "source",
    ]);
  });
});

describe("source-bound Category tree query", () => {
  const defaults = {
    search: null,
    lifecycle: null,
    productUsage: null,
    includeArchivedProducts: false,
  } as const;
  it("filters AND while preserving complete ancestor context and source identity", () => {
    const f = fixtures();
    const query = deriveCatalogCategoryTreeQueryView(f.product, f.category, "en-CA", {
      ...defaults,
      search: "ＣＡＴＥＧＯＲＹ_１１",
      productUsage: "Used",
      lifecycle: "Draft",
    });
    expect(query.matchedCategoryReferences).toEqual([id(11)]);
    expect(query.tree.items.map((item) => item.categoryReference)).toEqual([
      id(10),
      id(11),
      id(12),
    ]);
    expect(query.tree.items[1]?.parentCategoryReference).toBe(id(10));
    expect(query.tree.source.category.digest).toBe(f.category.sourceDigest);
    expect(
      deriveCatalogCategoryTreeQueryView(f.product, f.category, "en-CA", {
        ...defaults,
        search: "CATEGORY_11",
        lifecycle: "Active",
      }).matchedCategoryReferences,
    ).toEqual([]);
    expect(Object.isFrozen(query.matchedCategoryReferences)).toBe(true);
  });
  it("searches actual authorized localized maps even when the requested display locale falls back", () => {
    const f = fixtures();
    const categories = f.category.categories.map((node) =>
      node.categoryReference === id(11)
        ? { ...node, localizedNames: { ...node.localizedNames, "zh-CN": "合成饮品" } }
        : node,
    );
    const category = {
      ...f.category,
      categories,
      sourceDigest: categorySourceDigest({
        brandReference: f.category.brandReference,
        sourceRevision: f.category.sourceRevision,
        categories,
      }),
    };
    const result = deriveCatalogCategoryTreeQueryView(f.product, category, "fr-CA", {
      ...defaults,
      search: "饮品",
    });
    expect(result.matchedCategoryReferences).toEqual([id(11)]);
    expect(result.tree.items[1]?.name).toBe("Synthetic 11");
    expect(JSON.stringify(result)).not.toContain("合成饮品");
  });
  it("uses the explicit Archived Product measure for Empty/Used instead of choosing a hidden lifecycle meaning", () => {
    const f = fixtures();
    const product = {
      ...f.product,
      products: f.product.products.map((row) =>
        row.lifecycle === "Draft"
          ? {
              ...row,
              categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
            }
          : row,
      ),
    };
    const excluding = deriveCatalogCategoryTreeQueryView(product, f.category, "en-CA", {
      ...defaults,
      productUsage: "Empty",
    });
    const including = deriveCatalogCategoryTreeQueryView(product, f.category, "en-CA", {
      ...defaults,
      productUsage: "Used",
      includeArchivedProducts: true,
    });
    expect(excluding.matchedCategoryReferences).toEqual([id(10), id(11), id(12)]);
    expect(including.matchedCategoryReferences).toEqual([id(11)]);
    expect(including.tree.items[1]?.productCount).toEqual({
      status: "Known",
      includingArchived: 1,
      excludingArchived: 0,
    });
  });
  it("keeps unknown counts visible for name/status reads and refuses both usage predicates", () => {
    const f = fixtures(false);
    expect(
      deriveCatalogCategoryTreeQueryView(f.product, f.category, "en-CA", {
        ...defaults,
        search: "CATEGORY_11",
      }).matchedCategoryReferences,
    ).toEqual([id(11)]);
    for (const usage of ["Empty", "Used"])
      expect(() =>
        deriveCatalogCategoryTreeQueryView(f.product, f.category, "en-CA", {
          ...defaults,
          productUsage: usage,
        }),
      ).toThrow(CatalogError);
  });
  it.each([
    { search: "" },
    { search: "x".repeat(101) },
    { search: "bad\u0000" },
    { lifecycle: "Suspended" },
    { productUsage: "Maybe" },
    { usage: "Empty" },
    { includeArchivedProducts: "false" },
    { brandReference: id(99) },
  ])("rejects invalid or caller scope filters %j", (change) => {
    expect(() => parseCatalogCategoryTreeFilters({ ...defaults, ...change })).toThrow(CatalogError);
  });
  it.each(["missing", "duplicate", "foreign", "order", "coverage"])(
    "rejects non-complete or incoherent match packet %s",
    (change) => {
      const f = fixtures(),
        query = deriveCatalogCategoryTreeQueryView(f.product, f.category, "en-CA", defaults);
      const bad: Record<string, unknown> = { ...query };
      if (change === "missing") bad.matchedCategoryReferences = [id(10)];
      if (change === "duplicate") bad.matchedCategoryReferences = [id(10), id(10), id(12)];
      if (change === "foreign") bad.matchedCategoryReferences = [id(999)];
      if (change === "order") bad.matchedCategoryReferences = [id(12), id(11), id(10)];
      if (change === "coverage") bad.filters = { ...defaults, productUsage: "Used" };
      expect(() => parseCatalogCategoryTreeQueryView(bad)).toThrow(CatalogError);
    },
  );
  it("never invokes filter or match getters", () => {
    const getter = vi.fn(() => null),
      filters = { ...defaults };
    Object.defineProperty(filters, "search", { enumerable: true, get: getter });
    expect(() => parseCatalogCategoryTreeFilters(filters)).toThrow(CatalogError);
    const f = fixtures(),
      query = { ...deriveCatalogCategoryTreeQueryView(f.product, f.category, "en-CA", defaults) };
    Object.defineProperty(query, "matchedCategoryReferences", { enumerable: true, get: getter });
    expect(() => parseCatalogCategoryTreeQueryView(query)).toThrow(CatalogError);
    expect(getter).not.toHaveBeenCalled();
  });
});
