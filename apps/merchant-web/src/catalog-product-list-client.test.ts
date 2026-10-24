import { expect, it, vi } from "vitest";
import {
  createProductListClient,
  initialProductListFilters,
  parseProductListFilters,
  parseProductListView,
  ProductListClientError,
  productListMaximumResponseCharacters,
} from "./catalog-product-list-client.js";
export const productId = (n: number) =>
  "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const productAt = "2026-09-28T12:00:00.000Z";
export function productListFixture() {
  const unavailable = { status: "Unavailable" };
  return {
    projection: {
      name: "catalog_product_search_v1",
      version: 1,
      asOfUtc: productAt,
      stale: false,
      partial: true,
    },
    scope: { brandReference: productId(2), storeReference: productId(3) },
    locale: "en-CA",
    items: [
      {
        productReference: productId(10),
        internalCode: "SYNTH-PRODUCT",
        name: "Synthetic tea",
        nameLocale: "en-CA",
        localeFallback: false,
        productType: "NonAlcoholicBeverage",
        lifecycle: "Active",
        aggregateVersion: 3,
        updatedAt: productAt,
        createdAt: productAt,
        source: { productVersionReference: productId(11), configuration: "Draft" },
        skuCount: 2,
        activeSkuCount: 1,
        category: unavailable,
        menuCount: unavailable,
        availability: unavailable,
        storeCoverage: unavailable,
        tax: unavailable,
        updatedBy: unavailable,
      },
    ],
    hasMore: false,
    nextCursor: null,
  };
}
const headers = { "Cache-Control": "no-store", "Content-Type": "application/json" };
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers });
const load = (
  fetcher: typeof fetch,
  value = initialProductListFilters,
  signal = new AbortController().signal,
) =>
  createProductListClient(fetcher, () => Date.parse(productAt)).load(value, productId(3), signal);
it("accepts actual Draft fields, honest unavailable summaries, hyphenated codes and freezes the envelope", () => {
  const view = parseProductListView(productListFixture(), productId(3));
  expect(view.items[0]?.source.configuration).toBe("Draft");
  expect(view.items[0]?.availability.status).toBe("Unavailable");
  expect(Object.isFrozen(view.items[0])).toBe(true);
});
it("uses same-origin no-store GET with canonical Unicode header and no scope/name/cursor in URL", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(productListFixture()));
  const view = await load(fetcher, { ...initialProductListFilters, search: "茶 ☕" });
  expect(view.items).toHaveLength(1);
  const call = fetcher.mock.calls[0];
  expect(call?.[0]).toBe("/merchant/catalog/products");
  expect(call?.[1]).toMatchObject({
    credentials: "same-origin",
    redirect: "error",
    cache: "no-store",
    method: "GET",
  });
  const encoded = new Headers(call?.[1]?.headers).get("x-bop-product-list");
  expect(JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"))).toEqual({
    ...initialProductListFilters,
    search: "茶 ☕",
  });
});
it("rejects foreign Store and unscoped Brand-only envelopes", () => {
  const value = productListFixture();
  expect(() => parseProductListView(value, productId(99))).toThrow(ProductListClientError);
  expect(() =>
    parseProductListView(
      { ...value, scope: { ...value.scope, storeReference: null } },
      productId(3),
    ),
  ).toThrow(ProductListClientError);
});
it("rejects extra hidden fields throughout the DTO", () => {
  const value = productListFixture(),
    row = value.items[0];
  for (const altered of [
    { ...value, hidden: productId(99) },
    { ...value, projection: { ...value.projection, hidden: true } },
    { ...value, items: [{ ...row, secret: "synthetic-private" }] },
    { ...value, items: [{ ...row, tax: { status: "Unavailable", amount: "1" } }] },
  ])
    expect(() => parseProductListView(altered, productId(3))).toThrow(ProductListClientError);
});
it("rejects getters without executing them and sparse/decorated collections", () => {
  const value = productListFixture(),
    getter = vi.fn();
  const raw = { ...value };
  Object.defineProperty(raw, "locale", { get: getter, enumerable: true });
  expect(() => parseProductListView(raw, productId(3))).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const sparse = new Array(1);
  expect(() => parseProductListView({ ...value, items: sparse }, productId(3))).toThrow();
  Object.assign(value.items, { hidden: true });
  expect(() => parseProductListView(value, productId(3))).toThrow();
});
it("rejects impossible counts, future roots, duplicate products and missing Draft source", () => {
  const value = productListFixture(),
    row = value.items[0];
  for (const items of [
    [{ ...row, activeSkuCount: 3 }],
    [{ ...row, updatedAt: "2027-01-01T00:00:00.000Z" }],
    [row, row],
    [{ ...row, source: { productVersionReference: productId(11), configuration: "Published" } }],
  ])
    expect(() => parseProductListView({ ...value, items }, productId(3))).toThrow();
});
it("requires explicit locale fallback and supported fields", () => {
  const value = productListFixture(),
    row = value.items[0];
  expect(() =>
    parseProductListView({ ...value, items: [{ ...row, nameLocale: "fr-CA" }] }, productId(3)),
  ).toThrow();
  const view = parseProductListView(
    { ...value, items: [{ ...row, nameLocale: "fr-CA", localeFallback: true }] },
    productId(3),
  );
  expect(view.items[0]?.localeFallback).toBe(true);
});
it("rejects inconsistent pagination and excess records", () => {
  const value = productListFixture();
  expect(() => parseProductListView({ ...value, hasMore: true }, productId(3))).toThrow();
  expect(() =>
    parseProductListView(
      { ...value, items: [], hasMore: true, nextCursor: "opaque.signed" },
      productId(3),
    ),
  ).toThrow();
});
it.each([0, 201, 1.5])("rejects invalid page limit %s before HTTP", async (limit) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(load(fetcher, { ...initialProductListFilters, limit })).rejects.toBeInstanceOf(
    ProductListClientError,
  );
  expect(fetcher).not.toHaveBeenCalled();
});
it("rejects caller authority/open fields and expanded Unicode filters", () => {
  expect(() =>
    parseProductListFilters({ ...initialProductListFilters, storeReference: productId(99) }),
  ).toThrow();
  expect(() =>
    parseProductListFilters({ ...initialProductListFilters, search: "㍿".repeat(26) }),
  ).toThrow();
  expect(parseProductListFilters({ ...initialProductListFilters, limit: 200 }).limit).toBe(200);
});
it.each([
  [403, "product_list_denied", "Denied"],
  [403, "request_denied", "Denied"],
  [409, "product_list_feature_disabled", "FeatureDisabled"],
  [409, "product_list_stale", "Stale"],
])("bounds HTTP %s %s", async (status, error, code) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ error }, Number(status)));
  await expect(load(fetcher)).rejects.toMatchObject({ code });
});
it("rejects cached/unknown/extra-field/malformed responses without leaking content", async () => {
  const cases = [
    new Response(JSON.stringify(productListFixture()), {
      headers: { ...headers, "Cache-Control": "public" },
    }),
    response({ error: "product_list_denied", hidden: "synthetic-private" }, 403),
    response({ error: "unknown-private" }, 503),
    new Response("synthetic-secret-SQL", { headers }),
  ];
  for (const value of cases) {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(value);
    await expect(load(fetcher)).rejects.toMatchObject({
      message: "Products could not be loaded",
      code: "Unavailable",
    });
  }
});
it("rejects stale and future server snapshots", async () => {
  const value = productListFixture();
  await expect(
    load(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          response({ ...value, projection: { ...value.projection, stale: true } }),
        ),
    ),
  ).rejects.toMatchObject({ code: "Stale" });
  await expect(
    createProductListClient(
      vi.fn<typeof fetch>().mockResolvedValue(response(value)),
      () => Date.parse(productAt) + 30001,
    ).load(initialProductListFilters, productId(3), new AbortController().signal),
  ).rejects.toMatchObject({ code: "Stale" });
  await expect(
    createProductListClient(
      vi.fn<typeof fetch>().mockResolvedValue(response(value)),
      () => Date.parse(productAt) - 1,
    ).load(initialProductListFilters, productId(3), new AbortController().signal),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("aborts before HTTP and rejects late responses after scope cancellation", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetcher = vi.fn<typeof fetch>();
  await expect(load(fetcher, initialProductListFilters, controller.signal)).rejects.toBeInstanceOf(
    ProductListClientError,
  );
  expect(fetcher).not.toHaveBeenCalled();
  const later = new AbortController();
  const delayed = vi.fn<typeof fetch>(async () => {
    later.abort();
    return response(productListFixture());
  });
  await expect(load(delayed, initialProductListFilters, later.signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("rejects oversized response and hidden source messages", async () => {
  await expect(
    load(
      vi
        .fn<typeof fetch>()
        .mockResolvedValue(
          new Response(
            JSON.stringify(productListFixture()) + " ".repeat(productListMaximumResponseCharacters),
            { headers },
          ),
        ),
    ),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await expect(
    load(vi.fn<typeof fetch>().mockRejectedValue(new Error("synthetic-private-cause"))),
  ).rejects.toMatchObject({ message: "Products could not be loaded" });
});

it.each([
  { hasActiveSku: 1 },
  { missingTranslationLocale: "fr_ca" },
  { missingTranslationLocale: " fr-CA" },
  { missingTranslationLocale: "" },
  { missingTranslationLocale: 1 },
  { updatedFrom: "2026-09-28" },
  { updatedUntil: "2026-02-30T00:00:00.000Z" },
  { updatedFrom: "2026-09-28T12:00:00.000Z", updatedUntil: "2026-09-28T12:00:00.000Z" },
  { updatedFrom: "2026-09-28T12:00:00.000Z", updatedUntil: "2026-09-28T11:59:59.999Z" },
])("rejects invalid typed/time-range filters before HTTP: %j", async (invalid) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    load(fetcher, { ...initialProductListFilters, ...invalid } as typeof initialProductListFilters),
  ).rejects.toBeInstanceOf(ProductListClientError);
  expect(fetcher).not.toHaveBeenCalled();
});
it("transports normalized source filters without URL query parameters", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(productListFixture()));
  const filters = {
    ...initialProductListFilters,
    hasActiveSku: true,
    missingTranslationLocale: "fr-CA",
    updatedFrom: "2026-09-28T11:00:00.000Z",
    updatedUntil: "2026-09-28T13:00:00.000Z",
  };
  await load(fetcher, filters);
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error("HTTP call missing");
  const [url, init] = call;
  expect(String(url)).toBe("/merchant/catalog/products");
  const encoded = new Headers(init?.headers).get("x-bop-product-list");
  if (!encoded) throw new Error("Filter header missing");
  expect(JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"))).toEqual(filters);
});

it.each([
  { hasActiveSku: false },
  { missingTranslationLocale: "en-CA" },
  { updatedUntil: "2026-09-28T12:00:00.000Z" },
  { updatedFrom: "2026-09-28T12:00:00.001Z" },
])("rejects returned source facts outside requested filter: %j", async (filters) => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(productListFixture()));
  await expect(load(fetcher, { ...initialProductListFilters, ...filters })).rejects.toMatchObject({
    code: "Unavailable",
  });
});

it.each([
  { sort: "unknown" },
  { sort: "publishing_status" },
  { sort: "created_at; DROP TABLE product" },
  { direction: "desc" },
  { createdFrom: "2026-09-28" },
  { createdFrom: productAt, createdUntil: productAt },
])("rejects unavailable sort/invalid creation input before HTTP: %j", async (input) => {
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    load(fetcher, { ...initialProductListFilters, ...input } as typeof initialProductListFilters),
  ).rejects.toBeInstanceOf(ProductListClientError);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each([{ createdUntil: productAt }, { createdFrom: "2026-09-28T12:00:00.001Z" }])(
  "rejects rows outside creation filter: %j",
  async (input) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(productListFixture()));
    await expect(load(fetcher, { ...initialProductListFilters, ...input })).rejects.toMatchObject({
      code: "Unavailable",
    });
  },
);
it("requires actual coherent creation time at response boundary", () => {
  const value = productListFixture();
  const row = value.items[0];
  if (!row) throw new Error("fixture row missing");
  const missing: Record<string, unknown> = { ...row };
  delete missing.createdAt;
  expect(() => parseProductListView({ ...value, items: [missing] }, productId(3))).toThrow();
  expect(() =>
    parseProductListView(
      { ...value, items: [{ ...row, createdAt: "2026-09-28T12:00:00.001Z" }] },
      productId(3),
    ),
  ).toThrow();
});

it("transports requested name sorting with its locale and unchanged scoped headers", async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(productListFixture()));
  await load(fetcher, { ...initialProductListFilters, sort: "name", direction: "ASC" });
  const encoded = new Headers(fetcher.mock.calls[0]?.[1]?.headers).get("x-bop-product-list");
  expect(JSON.parse(Buffer.from(encoded ?? "", "base64url").toString("utf8"))).toMatchObject({
    sort: "name",
    direction: "ASC",
  });
});

const knownCategory = (extra: Record<string, unknown> = {}) => ({
  status: "Known",
  configuration: "Draft",
  primary: {
    categoryReference: productId(20),
    name: "Catégorie synthétique",
    nameLocale: "fr-CA",
    localeFallback: true,
  },
  matchedCategoryReference: null,
  source: { revision: "7", digest: "sha256:" + "2".repeat(64), asOfUtc: productAt },
  ...extra,
});
const withCategory = (category: unknown) => {
  const value = productListFixture();
  return { ...value, items: value.items.map((row) => ({ ...row, category })) };
};
it("parses held primary Category source/fallback and known null separately from unavailable", () => {
  const known = parseProductListView(withCategory(knownCategory()), productId(3)).items[0]
    ?.category;
  expect(known).toMatchObject({
    status: "Known",
    primary: { name: "Catégorie synthétique", localeFallback: true },
    source: { revision: "7" },
  });
  expect(Object.isFrozen(known)).toBe(true);
  expect(
    parseProductListView(withCategory(knownCategory({ primary: null })), productId(3)).items[0]
      ?.category,
  ).toMatchObject({ status: "Known", primary: null });
  expect(parseProductListView(productListFixture(), productId(3)).items[0]?.category.status).toBe(
    "Unavailable",
  );
});
it("transports Category membership in the normal header and rejects ignored or mismatched returned membership", async () => {
  const filters = { ...initialProductListFilters, categoryReference: productId(20) };
  const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
    expect(url).toBe("/merchant/catalog/products");
    expect(options?.method).toBe("GET");
    return response(withCategory(knownCategory({ matchedCategoryReference: productId(20) })));
  });
  const value = await createProductListClient(fetcher, () => Date.parse(productAt)).load(
    filters,
    productId(3),
    new AbortController().signal,
  );
  expect(value.items[0]?.category.status).toBe("Known");
  const headers = fetcher.mock.calls[0]?.[1] as RequestInit | undefined;
  const encoded = (headers?.headers as Record<string, string>)["x-bop-product-list"];
  if (typeof encoded !== "string") throw new Error("synthetic header missing");
  expect(JSON.parse(atob(encoded))).toMatchObject({ categoryReference: productId(20) });
  for (const category of [
    { status: "Unavailable" },
    knownCategory(),
    knownCategory({ matchedCategoryReference: productId(99) }),
  ]) {
    await expect(
      createProductListClient(async () => response(withCategory(category))).load(
        filters,
        productId(3),
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: "Unavailable" });
  }
});
it.each([
  knownCategory({ configuration: "Published" }),
  knownCategory({ extra: true }),
  knownCategory({ source: { revision: "7", digest: "2".repeat(64), asOfUtc: productAt } }),
  knownCategory({
    source: { revision: "07", digest: "sha256:" + "2".repeat(64), asOfUtc: productAt },
  }),
  knownCategory({
    source: {
      revision: "7",
      digest: "sha256:" + "2".repeat(64),
      asOfUtc: "2026-09-28T11:59:59.999Z",
    },
  }),
  knownCategory({
    primary: {
      categoryReference: productId(20),
      name: "<unsafe>",
      nameLocale: "fr-CA",
      localeFallback: true,
    },
  }),
  knownCategory({
    primary: {
      categoryReference: productId(20),
      name: "Synthetic",
      nameLocale: "fr-CA",
      localeFallback: false,
    },
  }),
])("rejects malformed/unheld Category DTO %#", (category) => {
  expect(() => parseProductListView(withCategory(category), productId(3))).toThrow(
    ProductListClientError,
  );
});
it("rejects Category filter and DTO accessors without invocation", () => {
  let invoked = false;
  const filter = { ...initialProductListFilters };
  Object.defineProperty(filter, "categoryReference", {
    enumerable: true,
    get() {
      invoked = true;
      return productId(20);
    },
  });
  expect(() => parseProductListFilters(filter)).toThrow(ProductListClientError);
  const category = knownCategory();
  Object.defineProperty(category, "primary", {
    enumerable: true,
    get() {
      invoked = true;
      return null;
    },
  });
  expect(() => parseProductListView(withCategory(category), productId(3))).toThrow(
    ProductListClientError,
  );
  expect(invoked).toBe(false);
});

const option = (n = 20) => ({
  categoryReference: productId(n),
  internalCode: "CATEGORY_" + n,
  name: n === 20 ? "Catégorie synthétique" : "Synthetic category " + n,
  nameLocale: "fr-CA",
  localeFallback: true,
  lifecycle: "Active",
});
const options = (extra: Record<string, unknown> = {}) => ({
  status: "Known",
  configuration: "Draft",
  source: knownCategory().source,
  items: [option()],
  ...extra,
});
const withOptions = (categoryOptions: unknown) => ({
  ...withCategory(knownCategory()),
  categoryOptions,
});
it("parses complete source-backed Category options and retains business code/fallback", () => {
  const view = parseProductListView(withOptions(options()), productId(3));
  expect(view.categoryOptions).toMatchObject({
    status: "Known",
    items: [{ internalCode: "CATEGORY_20", nameLocale: "fr-CA", localeFallback: true }],
  });
  expect(Object.isFrozen(view.categoryOptions)).toBe(true);
  expect(parseProductListView(productListFixture(), productId(3)).categoryOptions).toEqual({
    status: "Unavailable",
  });
});
it.each([
  options({ items: [option(), option()] }),
  options({ items: [option(99)] }),
  options({ source: { ...knownCategory().source, revision: "8" } }),
  options({ items: [{ ...option(), name: "Wrong current name" }] }),
  options({ items: [{ ...option(), lifecycle: "Suspended" }] }),
  options({ extra: true }),
])("rejects incoherent or malformed Category options %#", (categoryOptions) => {
  expect(() => parseProductListView(withOptions(categoryOptions), productId(3))).toThrow(
    ProductListClientError,
  );
});
it("rejects complete options attached to unknown classification rows and accessor options", () => {
  expect(() =>
    parseProductListView({ ...productListFixture(), categoryOptions: options() }, productId(3)),
  ).toThrow(ProductListClientError);
  let invoked = false;
  const raw = options();
  Object.defineProperty(raw, "items", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  expect(() => parseProductListView(withOptions(raw), productId(3))).toThrow(
    ProductListClientError,
  );
  expect(invoked).toBe(false);
});
it("loads complete legitimate Category options larger than the old Product-only cap without truncation", async () => {
  const items = Array.from({ length: 1000 }, (_, index) => ({
    ...option(index + 20),
    name: index === 0 ? "Catégorie synthétique" : "Synthetic " + "x".repeat(110),
  }));
  const packet = withOptions(options({ items }));
  expect(JSON.stringify(packet).length).toBeGreaterThan(262144);
  const view = await createProductListClient(
    async () => response(packet),
    () => Date.parse(productAt),
  ).load(initialProductListFilters, productId(3), new AbortController().signal);
  expect(view.categoryOptions.status).toBe("Known");
  if (view.categoryOptions.status !== "Known") throw new Error("synthetic options unavailable");
  expect(view.categoryOptions.items).toHaveLength(1000);
});
