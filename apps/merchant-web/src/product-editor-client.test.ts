import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createProductEditorClient,
  parseProductEditorView,
  productEditorMaximumResponseBytes,
} from "./product-editor-client.js";
const id = (n: number) => "01902443-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T22:00:00.000Z",
  until = "2026-09-30T22:00:05.000Z",
  hash = "sha256:" + "1".repeat(64),
  request = {
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    expectedAggregateVersion: 7,
  },
  input = { request, csrf: "c".repeat(43) };
function required<T>(v: T | undefined | null): T {
  if (v === undefined || v === null) throw Error("Synthetic fixture missing");
  return v;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical((v as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
function seal(v: Record<string, unknown>) {
  const { digest, ...body } = v;
  void digest;
  return {
    ...body,
    digest: "sha256:" + createHash("sha256").update(canonical(body)).digest("hex"),
  };
}
function fixture() {
  return {
    profile: "CatalogProductEditorSnapshotV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: 7,
    contentDigest: hash,
    configurationDigest: hash,
    contentStatus: "Present",
    observedAt: at,
    validUntil: until,
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
    aggregate: {
      productReference: id(4),
      brandReference: id(2),
      internalCode: "SYNTHETIC_FULL",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 7,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(5),
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic full Product" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: { "en-CA": "Synthetic short" },
          localizedDescriptions: { "en-CA": "Synthetic description\nSecond line" },
          preparationNotes: {},
          tagReferences: [id(10)],
          attributeValues: [
            { attributeReference: id(11), type: "Decimal", value: "1.25", unitCode: "KG" },
          ],
          media: [
            {
              mediaReference: id(12),
              assetReference: id(13),
              assetVersionReference: id(14),
              role: "Primary",
              altText: { "en-CA": "Synthetic image description" },
              sortOrder: 0,
              cropReference: null,
              focusReference: null,
            },
          ],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
          allergenReferences: [id(15)],
          nutritionProfile: { reference: id(16), versionReference: id(17) },
        },
      },
    },
  };
}
const response = (v: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(v), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
  });
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
it("detaches verified full wire content into scoped read-only presentation without raw reference labels", async () => {
  const raw = fixture(),
    v = await parseProductEditorView(seal(raw), request, () => Date.parse(at));
  expect(v.tenantReference).toBe(id(1));
  expect(v.content?.descriptions).toEqual(raw.aggregate.draft.editorContent.localizedDescriptions);
  expect(v.content?.tagCount).toBe(1);
  expect(v.draft.editorContent?.tagReferences).toEqual([id(10)]);
  expect(v.draft.editorContent?.media[0]?.assetVersionReference).toBe(id(14));
  expect(v.draft.editorContent?.nutritionProfile).toEqual({
    reference: id(16),
    versionReference: id(17),
  });
  expect(Object.isFrozen(v.draft.editorContent?.media[0])).toBe(true);
  expect(v.content?.allergenCount).toBe(1);
  expect(v.content?.attributeValues[0]?.display).toBe("1.25 KG");
  expect(v.content?.media[0]?.altText).toEqual({ "en-CA": "Synthetic image description" });
  raw.aggregate.draft.editorContent.localizedDescriptions["en-CA"] = "Changed";
  expect(v.content?.descriptions["en-CA"]).not.toBe("Changed");
  expect(Object.isFrozen(v)).toBe(true);
});
it("preserves absent legacy extension without inventing empty content", async () => {
  const raw = fixture();
  delete (raw.aggregate.draft as Partial<typeof raw.aggregate.draft>).editorContent;
  const v = await parseProductEditorView(
    seal({ ...raw, contentStatus: "Unavailable" }),
    request,
    () => Date.parse(at),
  );
  expect(v.content).toBeNull();
});
it.each([
  "digest",
  "extra",
  "qualification",
  "scope",
  "root",
  "status",
  "nested",
  "markup",
  "tuple",
])("refuses current wire abuse %s", async (mode) => {
  const raw = fixture();
  let value: unknown;
  if (mode === "scope") raw.brandReference = id(99);
  if (mode === "root") raw.aggregateVersion++;
  if (mode === "qualification") raw.eligibility = "Eligible";
  if (mode === "status") raw.contentStatus = "Unavailable";
  if (mode === "nested")
    Object.assign(required(raw.aggregate.draft.editorContent.media[0]), {
      url: "https://synthetic.invalid",
    });
  if (mode === "markup")
    raw.aggregate.draft.editorContent.localizedDescriptions["en-CA"] = "<script>synthetic</script>";
  if (mode === "tuple") raw.aggregate.productReference = id(99);
  value = seal(raw);
  if (mode === "digest") value = { ...seal(raw), digest: hash };
  if (mode === "extra") value = seal({ ...raw, privateObject: "Synthetic marker" });
  await expect(parseProductEditorView(value, request, () => Date.parse(at))).rejects.toMatchObject({
    code: mode === "scope" ? "ScopeChanged" : mode === "root" ? "Stale" : "Unavailable",
  });
});
it.each([Date.parse(at) - 1, Date.parse(until), Number.NaN])(
  "refuses original expiry/backwards/unknown clock %s",
  async (now) => {
    await expect(parseProductEditorView(seal(fixture()), request, () => now)).rejects.toMatchObject(
      { code: "Stale" },
    );
  },
);
it("rechecks original deadline after async envelope hashing", async () => {
  let calls = 0;
  await expect(
    parseProductEditorView(seal(fixture()), request, () =>
      ++calls === 1 ? Date.parse(at) : Date.parse(until),
    ),
  ).rejects.toMatchObject({ code: "Stale" });
});
it("does not invoke input getters or copy cyclic descriptors", async () => {
  const getter = vi.fn(),
    raw = seal(fixture());
  Object.defineProperty(raw, "aggregate", { enumerable: true, get: getter });
  await expect(parseProductEditorView(raw, request, () => Date.parse(at))).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(getter).not.toHaveBeenCalled();
  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  await expect(parseProductEditorView(cycle, request, () => Date.parse(at))).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("dispatches exact private body/scope headers with no-store and no object query string", async () => {
  const send = vi.fn(async () => response(seal(fixture()))),
    client = createProductEditorClient(send as typeof fetch, () => Date.parse(at));
  const v = await client.load(input, new AbortController().signal);
  expect(v.revision).toBe(7);
  const [url, options] = send.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/merchant/catalog/products/editor");
  expect(options).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(JSON.parse(options.body as string)).toEqual({
    productReference: id(4),
    expectedAggregateVersion: 7,
  });
  expect(
    JSON.parse(
      Buffer.from(
        required((options.headers as Record<string, string>)["x-bop-catalog-scope"]),
        "base64url",
      ).toString(),
    ),
  ).toEqual({ brandReference: id(2), storeReference: id(3) });
});
it.each([
  [403, { error: "request_denied" }, "Denied"],
  [400, { error: "product_editor_invalid" }, "Invalid"],
  [503, { error: "product_editor_unavailable" }, "Unavailable"],
] as const)("redacts bounded transport failure %s", async (status, body, code) => {
  const client = createProductEditorClient((async () => response(body, status)) as typeof fetch);
  await expect(client.load(input, new AbortController().signal)).rejects.toMatchObject({ code });
});
it.each([
  { "cache-control": "public" },
  { "content-type": "text/html" },
  { "content-length": String(productEditorMaximumResponseBytes + 1) },
])("rejects unsafe transport headers %#", async (headers) => {
  const client = createProductEditorClient(
    (async () => response(seal(fixture()), 200, headers)) as typeof fetch,
    () => Date.parse(at),
  );
  await expect(client.load(input, new AbortController().signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("aborts ignored fetches and applies finite timeout without old result recovery", async () => {
  vi.useFakeTimers();
  const ignored = vi.fn(() => new Promise<Response>(() => undefined));
  const client = createProductEditorClient(ignored as typeof fetch),
    c = new AbortController();
  const pending = client.load(input, c.signal);
  const refusal = expect(pending).rejects.toMatchObject({ name: "AbortError" });
  c.abort();
  await refusal;
  const timeout = client.load(input, new AbortController().signal);
  const unavailable = expect(timeout).rejects.toMatchObject({ code: "Unavailable" });
  await vi.advanceTimersByTimeAsync(15000);
  await unavailable;
});
it("rejects extra request and invalid csrf before dispatch", async () => {
  const send = vi.fn();
  const client = createProductEditorClient(send);
  const extra = { ...request, ready: true };
  await expect(
    client.load({ ...input, request: extra }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    client.load({ ...input, csrf: "invalid token" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(send).not.toHaveBeenCalled();
});

it("enforces the actual streamed byte ceiling without Content-Length and cancels unfinished body", async () => {
  const cancelled = vi.fn();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(new Uint8Array(productEditorMaximumResponseBytes + 1));
    },
    cancel: cancelled,
  });
  const client = createProductEditorClient(
    (async () =>
      new Response(stream, {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      })) as typeof fetch,
  );
  await expect(client.load(input, new AbortController().signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(cancelled).toHaveBeenCalledOnce();
});
