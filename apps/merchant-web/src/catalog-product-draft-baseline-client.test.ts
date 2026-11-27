import { expect, it, vi } from "vitest";
import {
  createProductDraftBaselineTransportClient,
  productDraftBaselineMaximumResponseBytes,
} from "./catalog-product-draft-baseline-client.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
const expected = { brandReference: id(2), storeReference: id(5), productReference: id(1) };
function fixture() {
  return {
    scope: { brandReference: id(2), storeReference: id(5) },
    baseline: {
      projection: {
        name: "catalog_product_draft_baseline_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      productReference: id(1),
      brandReference: id(2),
      internalCode: "DRAFT_1",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 4,
      updatedAt: at,
      classificationCoverage: "Known",
      draft: {
        versionReference: id(4),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic draft" } as Record<string, string>,
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        categoryClassification: { categoryReferences: [id(6)], primaryCategoryReference: id(6) },
        skus: [0, 1].map((n) => ({
          skuReference: id(10 + n),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "SKU_" + n,
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU " + n },
          variantSelections: [{ dimensionReference: id(20), valueReference: id(21 + n) }],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        })),
        optionBindings: [
          {
            bindingReference: id(40),
            optionSetReference: id(41),
            optionSetVersionReference: id(42),
            purpose: "SELECT",
            sortOrder: 0,
            enabledOptionReferences: [id(43)],
            defaultSelections: [{ optionReference: id(43), quantity: 2 }],
            minimumSelectionOverride: 0,
            maximumSelectionOverride: 2,
            includedSkuReferences: [id(10)],
            excludedSkuReferences: [],
            channelCodes: ["QR", "WEB"],
            storeOverrideAllowed: false,
          },
        ],
      },
    },
  };
}
const headers = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" };
const response = (value: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), { status, headers: { ...headers, ...extra } });
const run = (fetcher: typeof fetch, now = Date.parse(at), signal = new AbortController().signal) =>
  createProductDraftBaselineTransportClient(fetcher, () => now).load(expected, signal);
it("fetches fixed endpoint with closed target header and full immutable baseline", async () => {
  const fetcher = vi.fn<typeof fetch>(async () => response(fixture())),
    value = await run(fetcher);
  expect(value.baseline.draft).toEqual(fixture().baseline.draft);
  expect(Object.isFrozen(value.baseline.draft.optionBindings)).toBe(true);
  const call = fetcher.mock.calls[0];
  if (!call) throw new Error("Expected synthetic call");
  const [url, options] = call;
  expect(url).toBe("/merchant/catalog/products/draft-baseline");
  expect(options).toMatchObject({
    method: "GET",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(options?.body).toBeUndefined();
  const encoded = new Headers(options?.headers).get("x-bop-product-draft-baseline");
  if (!encoded) throw new Error("Expected header");
  expect(JSON.parse(atob(encoded.replace(/-/g, "+").replace(/_/g, "/")))).toEqual({
    productReference: id(1),
  });
});
it.each(["brandReference", "storeReference", "productReference"] as const)(
  "rejects expected %s drift",
  async (key) => {
    const client = createProductDraftBaselineTransportClient(
      async () => response(fixture()),
      () => Date.parse(at),
    );
    await expect(
      client.load({ ...expected, [key]: id(99) }, new AbortController().signal),
    ).rejects.toMatchObject({ code: "Unavailable" });
  },
);
it.each([
  [403, "product_draft_baseline_denied", "Denied"],
  [409, "product_draft_baseline_feature_disabled", "FeatureDisabled"],
  [409, "product_draft_baseline_stale", "Stale"],
  [503, "product_draft_baseline_unavailable", "Unavailable"],
  [500, "synthetic-private-SQL", "Unavailable"],
] as const)("bounds %s %s", async (status, error, code) => {
  await expect(run(async () => response({ error }, status))).rejects.toMatchObject({ code });
});
it("returns explicit missing target without inventing empty Draft", async () => {
  await expect(
    run(async () => response({ scope: fixture().scope, baseline: null })),
  ).rejects.toMatchObject({ code: "NotFound" });
});
it.each(["extra", "mime", "cache", "status", "length", "oversize", "utf8"])(
  "rejects transport %s",
  async (kind) => {
    let result: Response = response(fixture());
    if (kind === "extra") result = response({ ...fixture(), hidden: "synthetic" });
    if (kind === "mime") result = response(fixture(), 200, { "Content-Type": "text/plain" });
    if (kind === "cache") result = response(fixture(), 200, { "Cache-Control": "public" });
    if (kind === "status") result = response(fixture(), 201);
    if (kind === "length") result = response(fixture(), 200, { "Content-Length": "1" });
    if (kind === "oversize")
      result = response(fixture(), 200, {
        "Content-Length": String(productDraftBaselineMaximumResponseBytes + 1),
      });
    if (kind === "utf8") result = new Response(new Uint8Array([255]), { headers });
    await expect(run(async () => result)).rejects.toMatchObject({ code: "Unavailable" });
  },
);
it("counts streamed bytes without a declared length", async () => {
  const result = new Response(new Uint8Array(productDraftBaselineMaximumResponseBytes + 1), {
    headers,
  });
  await expect(run(async () => result)).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([5001, -1, NaN])("rejects stale/future/invalid reception clock %s", async (offset) => {
  await expect(run(async () => response(fixture()), Date.parse(at) + offset)).rejects.toMatchObject(
    { code: offset === 5001 ? "Stale" : "Unavailable" },
  );
});
it("cancels before fetch with AbortError", async () => {
  const controller = new AbortController(),
    fetcher = vi.fn<typeof fetch>();
  controller.abort();
  await expect(run(fetcher, Date.parse(at), controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["fetch", "reader"])("bounds noncooperative %s at15seconds", async (kind) => {
  vi.useFakeTimers();
  try {
    const fetcher: typeof fetch =
      kind === "fetch"
        ? () => new Promise(() => undefined)
        : async () =>
            new Response(new ReadableStream({ pull: () => new Promise(() => undefined) }), {
              headers,
            });
    const pending = run(fetcher);
    const assertion = expect(pending).rejects.toMatchObject({ code: "Unavailable" });
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
  } finally {
    vi.useRealTimers();
  }
});
it("aborts pending noncooperative response with caller cancellation", async () => {
  const controller = new AbortController(),
    pending = run(() => new Promise(() => undefined), Date.parse(at), controller.signal),
    assertion = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  controller.abort();
  await assertion;
});
it("rejects expected scope accessors without invoking them", async () => {
  const getter = vi.fn(() => id(2)),
    scope = { ...expected };
  Object.defineProperty(scope, "brandReference", { get: getter, enumerable: true });
  const fetcher = vi.fn<typeof fetch>();
  await expect(
    createProductDraftBaselineTransportClient(fetcher).load(scope, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(getter).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});
