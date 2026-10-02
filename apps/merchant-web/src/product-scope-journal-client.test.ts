import { afterEach, expect, it, vi } from "vitest";
import {
  createProductScopeJournalClient,
  parseProductScopeJournalView,
  parseProductScopeJournalRequest,
  productScopeJournalMaximumResponseBytes,
} from "./product-scope-journal-client.js";
function required<T>(value: T | null | undefined): T {
  if (value === undefined || value === null) throw new Error("Synthetic fixture missing");
  return value;
}
const id = (n: number) => "01902439-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T21:00:00.000Z",
  until = "2026-09-30T21:00:05.000Z",
  hash = "sha256:" + "1".repeat(64),
  request = {
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    expectedAggregateVersion: 7,
  },
  input = { request, csrf: "c".repeat(43) };
function fixture() {
  const journal = {
    digest: hash,
    sourceHeadDigest: hash,
    sourceAggregateVersion: 3,
    policyReference: id(5),
    policyVersion: 1,
    policyEvidenceReference: id(6),
    recordedAt: "2026-09-29T12:00:00.000Z",
    originalEvidenceValidUntil: "2026-09-29T12:00:05.000Z",
    relations: [] as Record<string, unknown>[],
  };
  return {
    profile: "CatalogProductScopeJournalManagementV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(4),
    aggregateVersion: 7,
    sourceDigest: hash,
    observedAt: at,
    validUntil: until,
    coverage: "CompleteRecordedScopeJournalCoverage",
    eligibility: "NotEvaluated",
    currentDisposition: "NotEvaluated",
    digest: hash,
    versions: [
      {
        versionReference: id(10),
        currentPublicationVersion: 2,
        currentState: "Published",
        originalPublicationOperationReference: id(11),
        recordStatus: "Recorded",
        journal,
      },
      {
        versionReference: id(12),
        currentPublicationVersion: 1,
        currentState: "Superseded",
        originalPublicationOperationReference: id(13),
        recordStatus: "NotRecorded",
        journal: null,
      },
      {
        versionReference: id(14),
        currentPublicationVersion: 1,
        currentState: "Draft",
        originalPublicationOperationReference: null,
        recordStatus: "NotApplicable",
        journal: null,
      },
    ],
  };
}
const response = (value: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "cache-control": "no-store", "content-type": "application/json", ...headers },
  });
const load = (fetcher: typeof fetch, now = Date.parse(at)) =>
  createProductScopeJournalClient(fetcher, () => now).load(input, new AbortController().signal);
afterEach(() => vi.useRealTimers());
it("keeps recorded empty, legacy absent and unpublished states distinct with historical expiry", () => {
  const value = parseProductScopeJournalView(fixture(), request, Date.parse(at));
  expect(value.versions.map((v) => v.recordStatus)).toEqual([
    "Recorded",
    "NotRecorded",
    "NotApplicable",
  ]);
  expect(value.versions[0]?.journal?.relations).toEqual([]);
  expect(Date.parse(required(value.versions[0]?.journal?.originalEvidenceValidUntil))).toBeLessThan(
    Date.parse(value.observedAt),
  );
  expect(Object.isFrozen(value.versions)).toBe(true);
});
it("binds recorded partial preference to its actual previous original publication", () => {
  const f = fixture();
  f.versions[0]?.journal?.relations.push({
    previousVersionReference: id(12),
    previousOperationReference: id(13),
    previousIntentDigest: hash,
    previousScopeDigest: hash,
    previousSelectorIndex: 0,
    incomingSelectorIndex: 1,
    storeReference: id(3),
    channelCodes: [],
    orderTypeCodes: ["PICKUP"],
    effectiveFrom: at,
    effectiveUntil: null,
    relation: "IncomingSelectorPreferred",
  });
  const value = parseProductScopeJournalView(f, request, Date.parse(at));
  expect(value.versions[0]?.journal?.relations[0]?.storeReference).toBe(id(3));
  required(required(f.versions[0]?.journal).relations[0]).previousOperationReference = id(99);
  expect(() => parseProductScopeJournalView(f, request, Date.parse(at))).toThrow();
});
it.each(["brandReference", "productReference"])("rejects changed owning %s", (key) => {
  expect(() =>
    parseProductScopeJournalView({ ...fixture(), [key]: id(99) }, request, Date.parse(at)),
  ).toThrow(/could not/);
});
it.each(["eligibility", "currentDisposition", "coverage", "profile", "digest"])(
  "refuses changed %s claim",
  (key) => {
    expect(() =>
      parseProductScopeJournalView({ ...fixture(), [key]: "Complete" }, request, Date.parse(at)),
    ).toThrow();
  },
);
it.each([Date.parse(at) - 1, Date.parse(until), NaN])(
  "uses exclusive freshness and refuses future/nonfinite observation %#",
  (now) => {
    expect(() => parseProductScopeJournalView(fixture(), request, now)).toThrow();
  },
);
it("refuses changed root, renewed deadline and unknown full-source fields", () => {
  for (const patch of [
    { aggregateVersion: 8 },
    { validUntil: "2026-09-30T21:00:06.000Z" },
    { incoming: {} },
  ])
    expect(() =>
      parseProductScopeJournalView({ ...fixture(), ...patch }, request, Date.parse(at)),
    ).toThrow();
});
it.each([
  "duplicate",
  "wrong-status",
  "missing-journal",
  "future-journal",
  "count",
  "getter",
  "cycle",
])("refuses malformed complete history %s", (mode) => {
  const f = fixture();
  if (mode === "duplicate") f.versions.push(required(f.versions[0]));
  if (mode === "wrong-status") required(f.versions[1]).recordStatus = "Recorded";
  if (mode === "missing-journal") required(f.versions[0]).journal = null;
  if (mode === "future-journal")
    required(f.versions[0]?.journal).recordedAt = "2026-09-30T21:00:01.000Z";
  if (mode === "count") f.versions = Array.from({ length: 1001 }, () => required(f.versions[0]));
  const getter = vi.fn(() => id(1));
  if (mode === "getter")
    Object.defineProperty(f, "tenantReference", { enumerable: true, get: getter });
  if (mode === "cycle") Object.assign(f, { versions: [f] });
  expect(() => parseProductScopeJournalView(f, request, Date.parse(at))).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([0, 1.5, 2147483648])("refuses invalid read revision %s", (version) => {
  expect(() =>
    parseProductScopeJournalRequest({ ...request, expectedAggregateVersion: version }),
  ).toThrow();
});
it("uses private bounded POST, exact scope/CSRF and no cache, storage or redirects", async () => {
  const fetcher = vi.fn(async () => response(fixture()));
  await load(fetcher);
  const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
  expect(url).toBe("/merchant/catalog/products/publication/scope-journals");
  expect(init).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(JSON.parse(String(init.body))).toEqual({
    productReference: id(4),
    expectedAggregateVersion: 7,
  });
  const headers = new Headers(init.headers);
  expect(headers.get("x-bop-csrf")).toBe(input.csrf);
  expect(
    JSON.parse(Buffer.from(required(headers.get("x-bop-catalog-scope")), "base64url").toString()),
  ).toEqual({ brandReference: id(2), storeReference: id(3) });
});
it.each([401, 403])("maps current denial %s without retaining data", async (status) => {
  await expect(
    load(vi.fn(async () => response({ error: "request_denied" }, status))),
  ).rejects.toMatchObject({ code: "Denied" });
});
it.each([
  [503, "product_scope_journals_unavailable", "Unavailable"],
  [400, "product_scope_journals_invalid", "Invalid"],
  [409, "private_error", "Unavailable"],
] as const)("maps bounded error %s %s", async (status, error, code) => {
  await expect(load(vi.fn(async () => response({ error }, status)))).rejects.toMatchObject({
    code,
  });
});
it.each([
  { "cache-control": "public" },
  { "content-type": "text/html" },
  { "content-length": String(productScopeJournalMaximumResponseBytes + 1) },
  { "content-length": "1" },
])("rejects unsafe/incoherent headers %#", async (headers) => {
  await expect(load(vi.fn(async () => response(fixture(), 200, headers)))).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it("refuses oversized streamed response and invalid UTF8", async () => {
  const huge = new Response("x".repeat(productScopeJournalMaximumResponseBytes + 1), {
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
  await expect(load(vi.fn(async () => huge))).rejects.toMatchObject({ code: "Unavailable" });
  const invalid = new Response(new Uint8Array([0xff]), {
    headers: { "cache-control": "no-store", "content-type": "application/json" },
  });
  await expect(load(vi.fn(async () => invalid))).rejects.toMatchObject({ code: "Unavailable" });
});
it("bounds a fetcher ignoring abort and stops pre-aborted reads", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(() => new Promise<Response>(() => undefined)),
    client = createProductScopeJournalClient(fetcher, () => Date.parse(at));
  const outcome = client.load(input, new AbortController().signal).catch((e: unknown) => e);
  await vi.advanceTimersByTimeAsync(15001);
  expect(await outcome).toMatchObject({ code: "Unavailable" });
  const controller = new AbortController();
  controller.abort();
  await expect(client.load(input, controller.signal)).rejects.toMatchObject({ name: "AbortError" });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
it("rejects malformed request/CSRF before fetch", async () => {
  const fetcher = vi.fn(async () => response(fixture()));
  await expect(
    createProductScopeJournalClient(fetcher).load(
      { ...input, csrf: "" },
      new AbortController().signal,
    ),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(fetcher).not.toHaveBeenCalled();
});
