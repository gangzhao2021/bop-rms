import { expect, it, vi } from "vitest";
import {
  CategoryTreeClientError,
  createCategoryTreeClient,
  initialCategoryTreeFilters,
  parseCategoryTreeView,
  categoryTreeMaximumResponseCharacters,
  categoryMenuReviewStates,
} from "./catalog-category-tree-client.js";
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T12:00:00.000Z";
const expected = { brandReference: id(2), storeReference: id(3) };
function fixture() {
  return {
    scope: { ...expected },
    query: {
      filters: { ...initialCategoryTreeFilters },
      matchedCategoryReferences: [id(300)],
      tree: {
        projection: {
          name: "catalog_category_tree_v1",
          version: 1,
          asOfUtc: at,
          stale: false,
          partial: true,
        },
        brandReference: id(2),
        locale: "en-CA",
        configuration: "Draft",
        classificationCoverage: "Known",
        source: {
          category: { revision: "1", digest: "sha256:" + "1".repeat(64), asOfUtc: at },
          products: {
            generationReference: id(600),
            revision: "0",
            digest: "sha256:" + "2".repeat(64),
            asOfUtc: at,
          },
        },
        items: [
          {
            categoryReference: id(300),
            internalCode: "CATEGORY_1",
            name: "Synthetic Category",
            nameLocale: "en-CA",
            localeFallback: false,
            lifecycle: "Draft",
            parentCategoryReference: null as string | null,
            level: 1,
            sortOrder: 0,
            aggregateVersion: "1",
            productCount: { status: "Known", includingArchived: 0, excludingArchived: 0 },
            menuUse: { status: "Unavailable" },
          },
        ],
      },
    },
  };
}
function first(data: ReturnType<typeof fixture>) {
  const row = data.query.tree.items[0];
  if (!row) throw new Error("fixture node missing");
  return row;
}
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });
const load = (
  fetcher: typeof fetch,
  clock = Date.parse(at),
  signal = new AbortController().signal,
  filters = initialCategoryTreeFilters,
) => createCategoryTreeClient(fetcher, () => clock).load(filters, expected, signal);
it("uses closed Unicode filters in headers and binds Brand and selected Store", async () => {
  const data = fixture();
  data.query.filters.search = "茶";
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(data));
  const view = await load(fetcher, Date.parse(at), undefined, {
    ...initialCategoryTreeFilters,
    search: "茶",
  });
  expect(view.query.tree.items[0]?.productCount).toEqual({
    status: "Known",
    includingArchived: 0,
    excludingArchived: 0,
  });
  expect(view.query.tree.items[0]?.menuUse).toEqual({ status: "Unavailable" });
  expect(Object.isFrozen(view.query.tree.items[0])).toBe(true);
  expect(fetcher.mock.calls[0]?.[0]).toBe("/merchant/catalog/categories");
  expect(fetcher.mock.calls[0]?.[1]).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  const packet = new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-bop-category-tree");
  expect(JSON.parse(Buffer.from(packet ?? "", "base64url").toString())).toEqual({
    ...initialCategoryTreeFilters,
    search: "茶",
  });
});
it.each([
  "scope",
  "brand",
  "parent",
  "depth",
  "order",
  "count",
  "menu",
  "fallback",
  "coverage",
  "extra",
  "match",
  "code",
])("rejects %s drift instead of exposing incomplete facts", (kind) => {
  const data = fixture();
  const row = first(data);
  switch (kind) {
    case "scope":
      data.scope.storeReference = id(4);
      break;
    case "brand":
      data.query.tree.brandReference = id(5);
      break;
    case "parent":
      row.parentCategoryReference = id(999);
      break;
    case "depth":
      row.level = 2;
      break;
    case "order":
      data.query.tree.items.push({
        ...row,
        categoryReference: id(301),
        internalCode: "CATEGORY_2",
      });
      break;
    case "count":
      row.productCount.excludingArchived = 1;
      break;
    case "menu":
      row.menuUse.status = "Known";
      break;
    case "fallback":
      row.localeFallback = true;
      break;
    case "coverage":
      data.query.tree.classificationCoverage = "Unavailable";
      break;
    case "extra":
      Object.assign(row, { actorReference: id(4) });
      break;
    case "match":
      data.query.matchedCategoryReferences = [];
      break;
    case "code":
      row.internalCode = "1CATEGORY";
      break;
  }
  expect(() => parseCategoryTreeView(data, expected)).toThrow(CategoryTreeClientError);
});
it("keeps complete ancestry while search matches an authorized child", () => {
  const data = fixture();
  const row = first(data);
  data.query.tree.items.push({
    ...row,
    categoryReference: id(301),
    internalCode: "CATEGORY_2",
    parentCategoryReference: row.categoryReference,
    level: 2,
    sortOrder: 0,
    name: "Child",
  });
  data.query.filters.search = "Child";
  data.query.matchedCategoryReferences = [id(301)];
  expect(parseCategoryTreeView(data, expected).query.tree.items).toHaveLength(2);
});
it("distinguishes unavailable classification from known empty and rejects usage claims", () => {
  const data = fixture();
  data.query.tree.classificationCoverage = "Unavailable";
  Object.assign(first(data), { productCount: { status: "Unavailable" } });
  expect(parseCategoryTreeView(data, expected).query.tree.items[0]?.productCount.status).toBe(
    "Unavailable",
  );
  data.query.filters.productUsage = "Empty";
  expect(() => parseCategoryTreeView(data, expected)).toThrow();
});
it("rejects accessors without invoking them", () => {
  const data = fixture();
  const getter = vi.fn(() => "Synthetic Category");
  Object.defineProperty(data.query.tree.items[0], "name", { get: getter, enumerable: true });
  expect(() => parseCategoryTreeView(data, expected)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([
  [403, "category_tree_denied", "Denied"],
  [403, "request_denied", "Denied"],
  [409, "category_tree_feature_disabled", "FeatureDisabled"],
  [409, "category_tree_stale", "Stale"],
  [503, "category_tree_unavailable", "Unavailable"],
  [400, "private_driver_error", "Unavailable"],
])("bounds HTTP %s error %s", async (status, error, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error }, status as number));
  await expect(load(fetcher)).rejects.toMatchObject({ code });
});
it("rejects echoed filters from an earlier request", async () => {
  const data = fixture();
  data.query.filters.search = "old";
  await expect(load(vi.fn<typeof fetch>().mockResolvedValue(response(data)))).rejects.toMatchObject(
    { code: "Unavailable" },
  );
});
it.each([
  [-1, "Unavailable"],
  [30001, "Stale"],
])("rejects future or expired projection at offset %s", async (offset, code) => {
  await expect(
    load(
      vi.fn<typeof fetch>().mockResolvedValue(response(fixture())),
      Date.parse(at) + (offset as number),
    ),
  ).rejects.toMatchObject({ code });
});
it("rejects stale Product source even when Category timestamp is current", () => {
  const data = fixture();
  data.query.tree.source.products.asOfUtc = "2026-09-28T11:59:29.000Z";
  expect(() => parseCategoryTreeView(data, expected)).toThrow();
});
it("rejects cacheable or non-JSON responses", async () => {
  for (const bad of [
    { ...headers, "Cache-Control": "public" },
    { ...headers, "Content-Type": "text/html" },
    { ...headers, "Content-Type": "application/json-invalid" },
  ])
    await expect(
      load(
        vi
          .fn<typeof fetch>()
          .mockResolvedValue(new Response(JSON.stringify(fixture()), { headers: bad })),
      ),
    ).rejects.toMatchObject({ code: "Unavailable" });
});
it("aborts before fetch and rejects a response arriving after cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn<typeof fetch>();
  await expect(load(fetcher, Date.parse(at), controller.signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(fetcher).not.toHaveBeenCalled();
  const late = new AbortController();
  const delayed = vi.fn<typeof fetch>().mockImplementation(async () => {
    late.abort();
    return response(fixture());
  });
  await expect(load(delayed, Date.parse(at), late.signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("rejects caller scope and generic Menu usage before making a request", async () => {
  for (const addition of [{ actorReference: id(4) }, { usage: "Empty" }]) {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      load(
        fetcher,
        Date.parse(at),
        undefined,
        Object.assign({ ...initialCategoryTreeFilters }, addition),
      ),
    ).rejects.toBeInstanceOf(CategoryTreeClientError);
    expect(fetcher).not.toHaveBeenCalled();
  }
});
it("accepts a complete large tree without legacy response truncation", async () => {
  const data = fixture(),
    row = first(data);
  data.query.tree.items = Array.from({ length: 1000 }, (_, i) => ({
    ...row,
    categoryReference: id(1000 + i),
    internalCode: "CATEGORY_" + i,
    sortOrder: i,
    name: "Synthetic " + "N".repeat(100),
  }));
  data.query.matchedCategoryReferences = data.query.tree.items.map((row) => row.categoryReference);
  expect(JSON.stringify(data).length).toBeGreaterThan(256000);
  expect(
    (await load(vi.fn<typeof fetch>().mockResolvedValue(response(data)))).query.tree.items,
  ).toHaveLength(1000);
});
it("bounds oversized envelopes without retaining sensitive unexpected data", async () => {
  await expect(
    load(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(" ".repeat(categoryTreeMaximumResponseCharacters + 1), { headers }),
        ),
    ),
  ).rejects.toMatchObject({ code: "Unavailable" });
});

it("cancels a stalled request at the finite timeout", async () => {
  vi.useFakeTimers();
  try {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(
      async (_url, options) =>
        new Promise((_resolve, reject) => {
          options?.signal?.addEventListener("abort", () => reject(new Error("synthetic abort")), {
            once: true,
          });
        }),
    );
    const pending = expect(load(fetcher)).rejects.toMatchObject({ code: "Unavailable" });
    await vi.advanceTimersByTimeAsync(15000);
    await pending;
    expect(fetcher.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

function menuFixture(partial = false) {
  const data = fixture(),
    row = first(data);
  const byLifecycle: Record<
    string,
    { status: "Known"; menuCount: number } | { status: "Unavailable" }
  > = Object.fromEntries(
    categoryMenuReviewStates.map((state) => [
      state,
      { status: "Known", menuCount: state === "Published" ? 1 : 0 },
    ]),
  );
  if (partial) byLifecycle.Archived = { status: "Unavailable" };
  return {
    ...data,
    query: {
      ...data.query,
      tree: {
        ...data.query.tree,
        source: {
          ...data.query.tree.source,
          menu: {
            digest: "sha256:" + "3".repeat(64),
            asOfUtc: at,
            consistency: "StatementSnapshot",
            reviewCategoryCoverage: partial ? "Unavailable" : "Known",
          },
        },
        items: [
          {
            ...row,
            menuUse: {
              status: partial ? "Partial" : "Known",
              draftMenuCount: 1,
              reviewed: {
                total: partial ? { status: "Unavailable" } : { status: "Known", menuCount: 1 },
                byLifecycle,
              },
            },
          },
        ],
      },
    },
  };
}
it.each([false, true])(
  "decodes known Menu facts and retained unknown history (%s)",
  async (partial) => {
    const view = await load(
      vi.fn<typeof fetch>().mockResolvedValue(response(menuFixture(partial))),
    );
    expect(view.query.tree.items[0]?.menuUse).toMatchObject({
      status: partial ? "Partial" : "Known",
      draftMenuCount: 1,
      reviewed: {
        byLifecycle: {
          Published: { status: "Known", menuCount: 1 },
          Archived: partial ? { status: "Unavailable" } : { status: "Known", menuCount: 0 },
        },
      },
    });
    expect(Object.isFrozen(view.query.tree.source.menu)).toBe(true);
  },
);
it.each(["coverage", "missing-source", "oversized", "extra-id", "future", "old-source"])(
  "rejects Menu count provenance drift %s",
  (kind) => {
    const data = menuFixture() as unknown as {
      query: {
        tree: {
          source: { menu?: Record<string, unknown> };
          items: { menuUse: Record<string, unknown> }[];
        };
      };
    };
    const menu = data.query.tree.source.menu,
      item = data.query.tree.items[0];
    if (!menu || !item) throw new Error("fixture node or Menu source missing");
    if (kind === "coverage") menu.reviewCategoryCoverage = "Unavailable";
    if (kind === "missing-source") delete data.query.tree.source.menu;
    if (kind === "oversized") item.menuUse.draftMenuCount = 10001;
    if (kind === "extra-id") item.menuUse.menuReference = id(999);
    if (kind === "future") menu.asOfUtc = "2026-09-28T12:00:00.001Z";
    if (kind === "old-source") menu.asOfUtc = "2026-09-28T11:59:54.999Z";
    expect(() => parseCategoryTreeView(data, expected)).toThrow();
  },
);
it("rejects Menu source aging while HTTP completes", async () => {
  await expect(
    load(vi.fn<typeof fetch>().mockResolvedValue(response(menuFixture())), Date.parse(at) + 5001),
  ).rejects.toMatchObject({ code: "Stale" });
});
