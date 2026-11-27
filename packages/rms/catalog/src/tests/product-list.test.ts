import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productListCopy } from "../contracts/product-list.js";
import { describe, it, expect, vi } from "vitest";
import {
  createPostgresCatalogProductListQueryStore,
  CatalogProductListError,
  parseCatalogProductListView,
  type CatalogProductListAuthorization,
  type CatalogProductListTransactionRunner,
} from "../index.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const at = "2026-09-28T12:00:00.000Z",
  scope = { brandReference: id(1), storeReference: id(2) };
const request = () => ({
  actorReference: id(3),
  purposeCode: "CATALOG_READ",
  locale: "en-CA",
  observedAt: at,
  search: null,
  lifecycle: null,
  productType: null,
  limit: 1,
  cursor: null,
  includeArchived: false,
  hasActiveSku: null,
  missingTranslationLocale: null,
  updatedFrom: null,
  updatedUntil: null,
  createdFrom: null,
  createdUntil: null,
  sort: "updatedAt",
  direction: "DESC",
});
const generation = (extra: Record<string, unknown> = {}) => ({
  generationReference: id(500),
  brandReference: id(1),
  sourceRevision: "0",
  sourceDigest: "sha256:" + "1".repeat(64),
  projectedAt: at,
  productCount: 2,
  coverage: "CatalogProductDraftV1",
  partial: true,
  ...extra,
});
const row = (n = 4) => ({
  productReference: id(n),
  brandReference: id(1),
  internalCode: `P_${n}`,
  productType: "PreparedFood",
  lifecycle: "Draft",
  aggregateVersion: "1",
  updatedAt: at,
  createdAt: at,
  draftUpdatedAt: at,
  productVersionReference: id(n + 100),
  defaultLocale: "en-CA",
  localizedNames: {
    "en-CA": `Synthetic product ${n}`,
    "fr-CA": `Produit synthétique ${n}`,
  } as Record<string, string>,
  skuCount: "2",
  activeSkuCount: "1",
  precise: true,
  priority: 1,
});
function setup(
  items: unknown = [row()],
  overrides: {
    scope?: typeof scope;
    key?: Uint8Array;
    ended?: string;
    generation?: Record<string, unknown>;
    revision?: string;
    count?: string;
    corruptDigest?: boolean;
    noGeneration?: boolean;
  } = {},
) {
  let held = false,
    allowed = true,
    clockCalls = 0;
  const query = vi.fn(async (sql: string) => {
    expect(held).toBe(true);
    if (sql.includes("LEFT JOIN rms_catalog.product_source_head"))
      return {
        rows: overrides.noGeneration
          ? []
          : [
              {
                generation: generation(overrides.generation),
                revision: overrides.revision ?? "0",
                count: overrides.count ?? "2",
              },
            ],
      };
    const wrapped = Array.isArray(items)
      ? items.map((value) => {
          const { priority, ...fields } = value;
          const data = { ...fields, skuSearch: [] };
          let checksum = "bad";
          try {
            checksum = "sha256:" + sha256Hex(canonicalizeRfc8785(productListCopy(data)));
          } catch {
            /* malformed source must be rejected without invoking a getter */
          }
          return {
            data,
            checksum: overrides.corruptDigest ? "sha256:" + "0".repeat(64) : checksum,
            priority,
          };
        })
      : items;
    return { rows: [{ asOfUtc: at, items: wrapped }] };
  });
  const runCalls = vi.fn();
  const runner: CatalogProductListTransactionRunner = {
    async run(work) {
      runCalls();
      const result = await work({ query });
      expect(held).toBe(true);
      return result;
    },
  };
  const authorize = vi.fn();
  const authorization: CatalogProductListAuthorization = {
    async withAuthorizedProductList(input, work) {
      authorize(input);
      if (!allowed) throw new CatalogProductListError("Denied");
      held = true;
      try {
        return await work();
      } finally {
        held = false;
      }
    },
  };
  const store = createPostgresCatalogProductListQueryStore({
    runner,
    scope: overrides.scope ?? scope,
    authorization,
    clock: { now: () => (++clockCalls > 2 ? (overrides.ended ?? at) : at) },
    cursorKey: overrides.key ?? new Uint8Array(32).fill(7),
  });
  return {
    store,
    query,
    authorize,
    runCalls,
    deny: () => {
      allowed = false;
    },
  };
}
describe("Catalog Product list owner query", () => {
  it("uses actual names/counts/Draft source while missing summaries carry no value", async () => {
    const x = setup(),
      view = await x.store.load(request());
    expect(view.items[0]?.name).toBe("Synthetic product 4");
    expect(view.items[0]?.activeSkuCount).toBe(1);
    expect(view.items[0]?.source.configuration).toBe("Draft");
    expect(view.items[0]?.availability).toEqual({ status: "Unavailable" });
    expect(view.projection.partial).toBe(true);
    expect(Object.isFrozen(view.items[0])).toBe(true);
    expect(x.authorize).toHaveBeenCalledWith({
      ...request(),
      categoryReference: null,
      ...scope,
      permission: "catalog.manage",
      capability: "catalog.cat_product_list",
      requiredCategoryFields: [],
    });
  });
  it("returns explicit empty/hasMore false", async () => {
    const view = await setup([]).store.load(request());
    expect(view.items).toEqual([]);
    expect(view.hasMore).toBe(false);
    expect(view.nextCursor).toBe(null);
  });
  it("uses requested locale and names fallback honestly", async () => {
    const view = await setup().store.load({ ...request(), locale: "fr-CA" });
    expect(view.items[0]?.name).toBe("Produit synthétique 4");
    expect(view.items[0]?.localeFallback).toBe(false);
    const fallback = await setup().store.load({ ...request(), locale: "zh-CN" });
    expect(fallback.items[0]?.nameLocale).toBe("en-CA");
    expect(fallback.items[0]?.localeFallback).toBe(true);
  });
  it("binds signed continuation to actual last update/priority and applies next-page parameters", async () => {
    const first = await setup([row(4), row(5)]).store.load(request());
    expect(first.hasMore).toBe(true);
    const x = setup([row(5)]);
    await x.store.load({ ...request(), cursor: first.nextCursor });
    expect(x.query).toHaveBeenLastCalledWith(expect.any(String), [
      id(1),
      null,
      null,
      null,
      at,
      id(4),
      2,
      null,
      false,
      null,
      1,
      null,
      null,
      null,
      null,
      null,
      id(500),
      "en-CA",
      null,
      null,
    ]);
  });
  it.each([
    "actorReference",
    "locale",
    "search",
    "limit",
    "includeArchived",
    "hasActiveSku",
    "missingTranslationLocale",
    "updatedFrom",
    "updatedUntil",
    "createdFrom",
    "createdUntil",
    "sort",
    "direction",
  ])("rejects cursor after %s changes", async (field) => {
    const first = await setup([row(4), row(5)]).store.load(request()),
      x = setup();
    const replacements = {
      actorReference: id(99),
      locale: "fr-CA",
      search: "product",
      limit: 2,
      includeArchived: true,
      hasActiveSku: true,
      missingTranslationLocale: "zh-CN",
      updatedFrom: at,
      updatedUntil: "2026-09-28T13:00:00.000Z",
    };
    await expect(
      x.store.load({
        ...request(),
        cursor: first.nextCursor,
        [field]: replacements[field as keyof typeof replacements],
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(x.runCalls).not.toHaveBeenCalled();
  });
  it.each([
    { hasActiveSku: "true" },
    { missingTranslationLocale: "fr_ca" },
    { missingTranslationLocale: "" },
    { missingTranslationLocale: 1 },
    { missingTranslationLocale: " fr-CA" },
    { updatedFrom: "2026-09-28" },
    { updatedUntil: "2026-02-30T12:00:00.000Z" },
    { updatedFrom: at, updatedUntil: at },
    { updatedFrom: at, updatedUntil: "2026-09-28T11:59:59.999Z" },
  ])("rejects invalid filters before authority or SQL: %j", async (filters) => {
    const x = setup();
    await expect(x.store.load({ ...request(), ...filters })).rejects.toMatchObject({
      code: "Invalid",
    });
    expect(x.authorize).not.toHaveBeenCalled();
    expect(x.runCalls).not.toHaveBeenCalled();
  });
  it("holds complete filters and rejects a predicate-violating lookahead", async () => {
    const filters = {
      hasActiveSku: true,
      missingTranslationLocale: "zh-CN",
      updatedFrom: at,
      updatedUntil: "2026-09-28T12:00:00.001Z",
    };
    const x = setup();
    expect((await x.store.load({ ...request(), ...filters })).items).toHaveLength(1);
    expect(x.authorize).toHaveBeenCalledWith(expect.objectContaining(filters));
    const sentinel = { ...row(5), activeSkuCount: "0" };
    await expect(
      setup([row(4), sentinel]).store.load({ ...request(), ...filters }),
    ).rejects.toMatchObject({ code: "Unavailable" });
    await expect(setup().store.load({ ...request(), updatedUntil: at })).rejects.toMatchObject({
      code: "Unavailable",
    });
  });
  it.each([
    "updatedAt",
    "createdAt",
    "internalCode",
    "lifecycle",
    "activeSkuCount",
    "name",
  ] as const)(
    "paginates both directions for %s with source-typed keys and independent ordering",
    async (sort) => {
      const low = { ...row(4), skuCount: "20" },
        high = { ...row(5), skuCount: "20" };
      if (sort === "updatedAt" || sort === "createdAt") low[sort] = "2026-09-28T11:00:00.000Z";
      if (sort === "updatedAt") low.createdAt = low.updatedAt;
      if (sort === "internalCode") {
        low.internalCode = "A";
        high.internalCode = "Z";
      }
      if (sort === "lifecycle") {
        low.lifecycle = "Active";
        high.lifecycle = "Draft";
      }
      if (sort === "name") {
        low.localizedNames["en-CA"] = "Ｚebra";
        high.localizedNames["en-CA"] = "🍵 Tea";
      }
      if (sort === "activeSkuCount") {
        low.activeSkuCount = "2";
        high.activeSkuCount = "10";
      }
      for (const direction of ["ASC", "DESC"] as const) {
        const rows = direction === "ASC" ? [low, high] : [high, low];
        const first = await setup(rows).store.load({ ...request(), sort, direction });
        expect(first.items[0]?.productReference).toBe(rows[0]?.productReference);
        const second = await setup([rows[1]]).store.load({
          ...request(),
          sort,
          direction,
          cursor: first.nextCursor,
        });
        expect(second.items[0]?.productReference).toBe(rows[1]?.productReference);
        await expect(
          setup([rows[0]]).store.load({ ...request(), sort, direction, cursor: first.nextCursor }),
        ).rejects.toMatchObject({ code: "Unavailable" });
        await expect(
          setup([...rows].reverse()).store.load({ ...request(), sort, direction }),
        ).rejects.toMatchObject({ code: "Unavailable" });
      }
    },
  );
  it.each(["updatedAt", "createdAt", "lifecycle", "activeSkuCount"] as const)(
    "keeps Product ID ASC for tied %s descending",
    async (sort) => {
      expect(
        (await setup([row(4), row(5)]).store.load({ ...request(), sort, direction: "DESC" }))
          .items[0]?.productReference,
      ).toBe(id(4));
      await expect(
        setup([row(5), row(4)]).store.load({ ...request(), sort, direction: "DESC" }),
      ).rejects.toMatchObject({ code: "Unavailable" });
    },
  );
  it.each([
    { sort: "unknown" },
    { sort: "publishing_status" },
    { sort: "updated_at; DROP TABLE product" },
    { direction: "desc" },
    { createdFrom: "2026-09-28" },
    { createdFrom: at, createdUntil: at },
    { createdFrom: at, createdUntil: "2026-09-28T11:59:59.999Z" },
  ])(
    "rejects unsupported/invalid sort and creation filters before authority: %j",
    async (filters) => {
      const x = setup();
      await expect(x.store.load({ ...request(), ...filters })).rejects.toMatchObject({
        code: "Invalid",
      });
      expect(x.authorize).not.toHaveBeenCalled();
      expect(x.query).not.toHaveBeenCalled();
    },
  );
  it("rejects contradictory root creation time and outside-range lookahead", async () => {
    await expect(
      setup([{ ...row(), createdAt: "2026-09-28T12:00:00.001Z" }]).store.load(request()),
    ).rejects.toMatchObject({ code: "Unavailable" });
    await expect(
      setup([row(4), { ...row(5), createdAt: "2026-09-28T11:59:59.999Z" }]).store.load({
        ...request(),
        createdFrom: at,
      }),
    ).rejects.toMatchObject({ code: "Unavailable" });
  });
  it.each(["ASC", "DESC"] as const)(
    "keeps identical display names tied by Product ID ASC for %s",
    async (direction) => {
      const low = row(4),
        high = row(5);
      low.localizedNames["en-CA"] = "Synthetic tied name";
      high.localizedNames["en-CA"] = "Synthetic tied name";
      const first = await setup([low, high]).store.load({ ...request(), sort: "name", direction });
      const second = await setup([high]).store.load({
        ...request(),
        sort: "name",
        direction,
        cursor: first.nextCursor,
      });
      expect(second.items[0]?.productReference).toBe(id(5));
      await expect(
        setup([high, low]).store.load({ ...request(), sort: "name", direction }),
      ).rejects.toMatchObject({ code: "Unavailable" });
    },
  );
  it("rejects another scope and another signing key", async () => {
    const first = await setup([row(4), row(5)]).store.load(request());
    await expect(
      setup(undefined, { scope: { ...scope, storeReference: id(99) } }).store.load({
        ...request(),
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
    await expect(
      setup(undefined, { key: new Uint8Array(32).fill(8) }).store.load({
        ...request(),
        cursor: first.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
  });
  it("denies before private SQL", async () => {
    const x = setup();
    x.deny();
    await expect(x.store.load(request())).rejects.toMatchObject({ code: "Denied" });
    expect(x.query).not.toHaveBeenCalled();
  });
  it("preserves Feature Disabled from mandatory authority", async () => {
    const store = createPostgresCatalogProductListQueryStore({
      runner: {
        async run() {
          throw Error("unexpected SQL");
        },
      },
      scope,
      authorization: {
        async withAuthorizedProductList() {
          throw new CatalogProductListError("FeatureDisabled");
        },
      },
      clock: { now: () => at },
      cursorKey: new Uint8Array(32).fill(7),
    });
    await expect(store.load(request())).rejects.toMatchObject({ code: "FeatureDisabled" });
  });
  it("rejects foreign source Brand", async () => {
    const raw = row();
    raw.brandReference = id(99);
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({ code: "Unavailable" });
  });
  it("rejects impossible active count and corrupted sentinel", async () => {
    const raw = row(5);
    raw.activeSkuCount = "3";
    await expect(setup([row(4), raw]).store.load(request())).rejects.toMatchObject({
      code: "Unavailable",
    });
  });
  it("rejects duplicate/out-of-order source rows", async () => {
    await expect(setup([row(4), row(4)]).store.load(request())).rejects.toMatchObject({
      code: "Unavailable",
    });
    await expect(setup([row(5), row(4)]).store.load(request())).rejects.toMatchObject({
      code: "Unavailable",
    });
  });
  it("rejects future source timestamp", async () => {
    const raw = row();
    raw.updatedAt = "2026-09-29T12:00:00.000Z";
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({ code: "Unavailable" });
  });
  it("rejects nested getter without invocation", async () => {
    const raw = row(),
      getter = vi.fn(() => "Synthetic name");
    Object.defineProperty(raw.localizedNames, "en-CA", { get: getter, enumerable: true });
    await expect(setup([raw]).store.load(request())).rejects.toMatchObject({ code: "Unavailable" });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects open input/getter before authorization", async () => {
    const x = setup(),
      raw = request(),
      getter = vi.fn(() => id(3));
    Object.defineProperty(raw, "actorReference", { get: getter, enumerable: true });
    await expect(x.store.load(raw)).rejects.toMatchObject({ code: "Invalid" });
    expect(getter).not.toHaveBeenCalled();
    expect(x.authorize).not.toHaveBeenCalled();
    await expect(x.store.load({ ...request(), brandReference: id(99) })).rejects.toMatchObject({
      code: "Invalid",
    });
  });
  it("enforces Product-specific1–200 limit", async () => {
    expect((await setup().store.load({ ...request(), limit: 200 })).items.length).toBe(1);
    await expect(setup().store.load({ ...request(), limit: 201 })).rejects.toMatchObject({
      code: "Invalid",
    });
  });
  it("marks retained current read Stale after30seconds", async () => {
    const view = await setup(undefined, { ended: "2026-09-28T12:00:30.001Z" }).store.load(
      request(),
    );
    expect(view.projection.stale).toBe(true);
  });
  it.each([
    { noGeneration: true, code: "Unavailable" },
    { count: "1", code: "Unavailable" },
    { revision: "1", code: "Stale" },
    { generation: { projectedAt: "2026-09-28T11:59:29.999Z" }, code: "Stale" },
    { generation: { projectedAt: "2026-09-28T12:00:00.001Z" }, code: "Stale" },
    { generation: { brandReference: id(99) }, code: "Unavailable" },
    { corruptDigest: true, code: "Unavailable" },
  ])(
    "rejects absent, changed, incomplete, stale or corrupted generation: %j",
    async ({ code, ...override }) => {
      await expect(setup(undefined, override).store.load(request())).rejects.toMatchObject({
        code,
      });
    },
  );
  it("refuses continuation after an active generation changes at the same source revision", async () => {
    const first = await setup([row(4), row(5)]).store.load(request());
    const next = setup([row(5)], { generation: { generationReference: id(501) } });
    await expect(next.store.load({ ...request(), cursor: first.nextCursor })).rejects.toMatchObject(
      { code: "Stale" },
    );
    expect(next.query.mock.calls.some(([sql]) => sql.includes("WITH source AS"))).toBe(false);
  });
  it("rejects long normalized query rather than expanding bound", async () => {
    await expect(
      setup().store.load({ ...request(), search: "ﷺ".repeat(90) }),
    ).rejects.toMatchObject({ code: "Invalid" });
  });
  it("rejects unavailable summary with hidden data at public boundary", async () => {
    const view = await setup().store.load(request()),
      item = view.items[0];
    await expect(
      Promise.resolve().then(() =>
        parseCatalogProductListView({
          ...view,
          items: [{ ...item, menuCount: { status: "Unavailable", value: 0 } }],
        }),
      ),
    ).rejects.toMatchObject({ code: "Invalid" });
  });
});

it("filters actual Draft name absence without treating fallback as translation", async () => {
  const x = setup();
  const view = await x.store.load({
    ...request(),
    locale: "zh-CN",
    missingTranslationLocale: "zh-CN",
  });
  expect(view.items[0]).toMatchObject({ nameLocale: "en-CA", localeFallback: true });
  expect(x.authorize).toHaveBeenCalledWith(
    expect.objectContaining({ missingTranslationLocale: "zh-CN" }),
  );
  expect(x.query).toHaveBeenLastCalledWith(
    expect.stringContaining("NOT (list_json->'localizedNames' ? $19::text)"),
    expect.arrayContaining(["zh-CN"]),
  );
});
it.each([0, 1])("rejects a present translation in returned or lookahead row %s", async (index) => {
  const values = [row(4), row(5)];
  const selected = values[index];
  if (!selected) throw new Error("Missing synthetic row");
  values[index] = {
    ...selected,
    localizedNames: { ...selected.localizedNames, "zh-CN": "合成茶" },
  };
  await expect(
    setup(values).store.load({ ...request(), missingTranslationLocale: "zh-CN" }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});

it("fails closed before membership SQL when normal Category source holders are unconfigured", async () => {
  const x = setup();
  await expect(x.store.load({ ...request(), categoryReference: id(10) })).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(x.query.mock.calls.some(([sql]) => sql.startsWith("WITH source AS"))).toBe(false);
});
it("normalizes absent/explicit-null Category filter and rejects malformed/accessor input without invocation", async () => {
  expect((await setup().store.load({ ...request(), categoryReference: null })).items).toHaveLength(
    1,
  );
  const x = setup();
  await expect(
    x.store.load({ ...request(), categoryReference: "foreign caller value" }),
  ).rejects.toMatchObject({ code: "Invalid" });
  let invoked = false;
  const raw = { ...request() };
  Object.defineProperty(raw, "categoryReference", {
    enumerable: true,
    get() {
      invoked = true;
      return id(10);
    },
  });
  await expect(x.store.load(raw)).rejects.toMatchObject({ code: "Invalid" });
  expect(invoked).toBe(false);
  expect(x.runCalls).not.toHaveBeenCalled();
});
it("rejects continuation when a Category membership filter is added to an unfiltered cursor", async () => {
  const first = await setup([row(4), row(5)]).store.load(request());
  const x = setup();
  await expect(
    x.store.load({ ...request(), cursor: first.nextCursor, categoryReference: id(10) }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(x.runCalls).not.toHaveBeenCalled();
});

it("validates Category selector source/code/name and rejects mixed projection snapshots", async () => {
  const base = await setup().store.load(request());
  const source = { revision: "1", digest: "sha256:" + "2".repeat(64), asOfUtc: at };
  const name = {
    categoryReference: id(10),
    name: "Synthetic category",
    nameLocale: "en-CA",
    localeFallback: false,
  };
  const value = {
    ...base,
    items: base.items.map((item) => ({
      ...item,
      category: {
        status: "Known",
        configuration: "Draft",
        primary: name,
        matchedCategoryReference: null,
        source,
      },
    })),
    categoryOptions: {
      status: "Known",
      configuration: "Draft",
      source,
      items: [{ ...name, internalCode: "CATEGORY", lifecycle: "Active" }],
    },
  };
  expect(parseCatalogProductListView(value).categoryOptions.status).toBe("Known");
  for (const categoryOptions of [
    { ...value.categoryOptions, items: [] },
    { ...value.categoryOptions, source: { ...source, revision: "2" } },
    {
      ...value.categoryOptions,
      items: [value.categoryOptions.items[0], value.categoryOptions.items[0]],
    },
  ]) {
    expect(() => parseCatalogProductListView({ ...value, categoryOptions })).toThrow(
      CatalogProductListError,
    );
  }
});
