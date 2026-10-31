import { expect, it, vi } from "vitest";
import {
  createProductCategoryLookupClient,
  parseProductCategoryLookupView,
  productCategoryLookupMaximumResponseBytes,
  type ProductCategoryLookupScope,
} from "./catalog-product-category-lookup-client.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z",
  parent = "CAT-PRODUCT-CREATE";
const expected: ProductCategoryLookupScope = {
  brandReference: id(2),
  storeReference: id(3),
  locale: "en-CA",
};
function fixture() {
  return {
    scope: { brandReference: id(2), storeReference: id(3) },
    lookup: {
      projection: {
        name: "catalog_product_category_lookup_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      parentScreenId: parent,
      brandReference: id(2),
      locale: "en-CA",
      configuration: "Draft",
      source: { revision: "1", digest: "sha256:" + "1".repeat(64), asOfUtc: at },
      policy: { allowedLifecycles: ["Active", "Draft"] },
      items: [
        {
          categoryReference: id(10),
          internalCode: "CATEGORY_1",
          name: "合成分类",
          nameLocale: "en-CA",
          localeFallback: false,
          lifecycle: "Draft",
        },
      ],
    },
  };
}
function first(value: ReturnType<typeof fixture>) {
  const item = value.lookup.items[0];
  if (!item) throw new Error("Synthetic fixture choice missing");
  return item;
}
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const response = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
const run = (fetcher: typeof fetch, now = Date.parse(at), signal = new AbortController().signal) =>
  createProductCategoryLookupClient(fetcher, () => now).load(parent, expected, signal);
it("fetches fixed safe endpoint and exact parent header, validates minimal current choices", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(fixture())),
    view = await run(fetcher);
  expect(view.lookup.items[0]?.name).toBe("合成分类");
  expect(Object.isFrozen(view.lookup.items[0])).toBe(true);
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error("Expected lookup request");
  const [url, options] = call;
  expect(url).toBe("/merchant/catalog/products/category-lookup");
  expect(options).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(options?.body).toBeUndefined();
  const wire = new Headers(options?.headers).get("x-bop-product-category-lookup");
  if (!wire) throw new Error("Expected parent header");
  expect(JSON.parse(Buffer.from(wire, "base64url").toString("utf8"))).toEqual({
    parentScreenId: parent,
  });
  expect(wire).not.toContain(expected.brandReference);
});
it("binds Edit parent and known policy-empty separately from absent policy", async () => {
  const value = fixture();
  value.lookup.parentScreenId = "CAT-PRODUCT-EDIT";
  value.lookup.items = [];
  value.lookup.policy.allowedLifecycles = [];
  const view = await createProductCategoryLookupClient(
    async () => response(value),
    () => Date.parse(at),
  ).load("CAT-PRODUCT-EDIT", expected, new AbortController().signal);
  expect(view.lookup.items).toEqual([]);
});
it("checks language fallback while retaining Unicode names", () => {
  const value = fixture();
  value.lookup.locale = "fr-CA";
  first(value).localeFallback = true;
  const view = parseProductCategoryLookupView(value, parent, { ...expected, locale: "fr-CA" });
  expect(view.lookup.items[0]).toMatchObject({
    name: "合成分类",
    nameLocale: "en-CA",
    localeFallback: true,
  });
});
it.each([
  "extra",
  "scope",
  "brand",
  "store",
  "locale",
  "parent",
  "partial",
  "asof",
  "digest",
  "revision",
  "policy",
  "duplicate",
  "ineligible",
  "fallback",
  "normalized",
  "order",
  "actor",
])("rejects malformed or rebound %s", (kind) => {
  const value = fixture();
  switch (kind) {
    case "extra":
      Object.assign(value, { hidden: "synthetic-private" });
      break;
    case "scope":
      Object.assign(value.scope, { permission: "Allow" });
      break;
    case "brand":
      value.lookup.brandReference = id(99);
      break;
    case "store":
      value.scope.storeReference = id(99);
      break;
    case "locale":
      value.lookup.locale = "fr-CA";
      break;
    case "parent":
      value.lookup.parentScreenId = "CAT-PRODUCT-EDIT";
      break;
    case "partial":
      value.lookup.projection.partial = false;
      break;
    case "asof":
      value.lookup.source.asOfUtc = "2026-09-28T12:00:00.001Z";
      break;
    case "digest":
      value.lookup.source.digest = "unverified";
      break;
    case "revision":
      value.lookup.source.revision = "01";
      break;
    case "policy":
      delete (value.lookup as Partial<typeof value.lookup>).policy;
      break;
    case "duplicate":
      value.lookup.items.push({ ...first(value) });
      break;
    case "ineligible":
      value.lookup.policy.allowedLifecycles = ["Active"];
      break;
    case "fallback":
      first(value).localeFallback = true;
      break;
    case "normalized":
      first(value).name = " Two  spaces ";
      break;
    case "order":
      first(value).internalCode = "CAT_2";
      value.lookup.items.push({
        ...first(value),
        categoryReference: id(11),
        internalCode: "CAT-2",
      });
      break;
    case "actor":
      Object.assign(first(value), { actorReference: id(4) });
      break;
  }
  expect(() => parseProductCategoryLookupView(value, parent, expected)).toThrow();
});
it("rejects getters, cycles and sparse choices without evaluation", () => {
  const getter = vi.fn(() => fixture().lookup);
  const value = { scope: fixture().scope };
  Object.defineProperty(value, "lookup", { get: getter, enumerable: true });
  expect(() => parseProductCategoryLookupView(value, parent, expected)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const sparse = fixture();
  sparse.lookup.items = new Array(1);
  expect(() => parseProductCategoryLookupView(sparse, parent, expected)).toThrow();
  const cycle = fixture();
  Object.assign(cycle.lookup, { cycle });
  expect(() => parseProductCategoryLookupView(cycle, parent, expected)).toThrow();
});
it("supports the complete10000choice contract without invented truncation", () => {
  const value = fixture();
  value.lookup.items = Array.from({ length: 10000 }, (_, n) => ({
    ...first(value),
    categoryReference: id(n + 100),
    internalCode: "C" + String(n).padStart(5, "0"),
  }));
  expect(parseProductCategoryLookupView(value, parent, expected).lookup.items).toHaveLength(10000);
});
it.each([
  [403, "product_category_lookup_denied", "Denied"],
  [409, "product_category_lookup_stale", "Stale"],
  [409, "product_category_lookup_feature_disabled", "FeatureDisabled"],
  [503, "product_category_lookup_unavailable", "Unavailable"],
])("bounds known HTTP %s %s", async (status, error, code) => {
  await expect(run(async () => response({ error }, status as number))).rejects.toMatchObject({
    code,
  });
});
it("never returns unknown error fields or driver messages", async () => {
  await expect(
    run(async () =>
      response({ error: "product_category_lookup_denied", sql: "synthetic-driver" }, 403),
    ),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await expect(
    run(async () => {
      throw new Error("synthetic-secret-SQL");
    }),
  ).rejects.toMatchObject({
    code: "Unavailable",
    message: "Product categories could not be loaded",
  });
});
it.each([
  { "Cache-Control": "public" },
  { "Content-Type": "text/plain" },
  { "Content-Length": "8388609" },
  { "Content-Length": "01" },
  { "Content-Length": "1" },
])("rejects unsafe or mismatching response headers %#", async (extra) => {
  await expect(run(async () => response(fixture(), 200, extra))).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("rejects unexpected successful status and invalid UTF8", async () => {
  await expect(run(async () => response(fixture(), 201))).rejects.toMatchObject({
    code: "Unavailable",
  });
  await expect(
    run(async () => new Response(new Uint8Array([0xff]), { headers })),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("rejects oversized actual streaming bytes and cancels the reader", async () => {
  const cancel = vi.fn(),
    stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(productCategoryLookupMaximumResponseBytes + 1));
      },
      cancel,
    });
  await expect(run(async () => new Response(stream, { headers }))).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("decodes split multibyte chunks losslessly and checks actual declared bytes", async () => {
  const bytes = new TextEncoder().encode(JSON.stringify(fixture()));
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const byte of bytes) controller.enqueue(new Uint8Array([byte]));
      controller.close();
    },
  });
  const view = await run(
    async () =>
      new Response(stream, { headers: { ...headers, "Content-Length": String(bytes.length) } }),
  );
  expect(view.lookup.items[0]?.name).toBe("合成分类");
});
it("rejects stale/future/invalid client time, accepts exact5second boundary", async () => {
  await expect(run(async () => response(fixture()), Date.parse(at) + 5001)).rejects.toMatchObject({
    code: "Stale",
  });
  await expect(run(async () => response(fixture()), Date.parse(at) - 1)).rejects.toMatchObject({
    code: "Unavailable",
  });
  await expect(run(async () => response(fixture()), NaN)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(
    (await run(async () => response(fixture()), Date.parse(at) + 5000)).lookup.items,
  ).toHaveLength(1);
});
it("preaborted and mid-flight noncooperative fetch cancel without waiting", async () => {
  const controller = new AbortController(),
    fetcher = vi.fn<typeof fetch>(() => new Promise(() => undefined));
  controller.abort();
  await expect(run(fetcher, Date.parse(at), controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fetcher).not.toHaveBeenCalled();
  const active = new AbortController(),
    pending = run(fetcher, Date.parse(at), active.signal);
  const check = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  active.abort();
  await check;
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it.each(["fetch", "reader"])("total timeout ends noncooperative %s", async (kind) => {
  vi.useFakeTimers();
  try {
    const cancel = vi.fn(),
      fetcher: typeof fetch =
        kind === "fetch"
          ? () => new Promise(() => undefined)
          : async () =>
              new Response(
                new ReadableStream<Uint8Array>({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("{"));
                  },
                  cancel,
                }),
                { headers },
              );
    const pending = run(fetcher),
      check = expect(pending).rejects.toMatchObject({ code: "Unavailable" });
    await vi.advanceTimersByTimeAsync(15001);
    await check;
    if (kind === "reader") expect(cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
it("validates caller parent and closed expected scope before fetch", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(fixture()));
  await expect(
    createProductCategoryLookupClient(fetcher).load(
      "CAT-CATEGORY-TREE" as never,
      expected,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await expect(
    createProductCategoryLookupClient(fetcher).load(
      parent,
      { ...expected, permission: "Allow" } as ProductCategoryLookupScope,
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(fetcher).not.toHaveBeenCalled();
});
