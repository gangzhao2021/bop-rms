import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  parseOptionSetListView as parseOwningView,
  parseOptionSetListRequest as parseOwningRequest,
} from "../../../packages/rms/catalog/src/index.js";
import {
  createOptionSetListClient,
  parseOptionSetListView,
  parseOptionSetListRequest,
} from "./option-set-list-client.js";
const id = (n: number) => "01902421-7700-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  csrf = "A".repeat(43);
const scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  selected = { brandReference: id(2), storeReference: id(3) };
const filters = {
  locale: "fr-CA",
  search: null,
  lifecycle: null,
  selectionType: null,
  includeArchived: false,
  hasProductBinding: null,
  hasPricingReference: null,
  hasConsumptionReference: null,
  hasConflict: null,
  missingTranslationLocale: null,
  publishingStatus: null,
  sort: "name",
  direction: "ASC",
  limit: 100,
  cursor: null,
} as const;
function item(n = 10) {
  return {
    optionSetReference: id(n),
    internalCode: "CHOICES_" + n,
    lifecycle: "Draft",
    aggregateVersion: 1,
    draftVersionReference: id(n + 1000),
    createdAt: at,
    updatedAt: at,
    name: "Synthetic choices",
    nameLocale: "en-CA",
    localeFallback: true,
    selectionRule: {
      displayStyle: "MultiChoice",
      minimumSelection: 0,
      maximumSelection: 2,
      allowRepeatedOption: false,
      perOptionMaximumQuantity: 1,
      maximumTotalQuantity: 2,
    },
    optionCount: 2,
    activeOptionCount: 1,
    productBindingCount: 0,
    recordedPricingReference: { status: "Known", present: true },
    recordedConsumptionReference: { status: "Unknown" },
    recordedConflict: { status: "Known", present: false },
    publishingStatus: { status: "Unavailable" },
    referenceEligibility: "NotEvaluated",
  };
}
function view() {
  return parseOwningView({
    projection: {
      name: "catalog_option_set_search_v1",
      version: 1,
      asOfUtc: at,
      stale: false,
      partial: true,
      sourceGeneration: "sha256:" + "a".repeat(64),
    },
    scope,
    locale: "fr-CA",
    items: [item()],
    hasMore: false,
    nextCursor: null,
  });
}
function response(value: unknown = view(), status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
function harness() {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response()),
    client = createOptionSetListClient(fetcher),
    request = {
      filters: filters as unknown,
      expectedScope: selected as unknown,
      csrf,
      expectedFullScope: undefined as unknown,
    };
  return { fetcher, client, request, load: () => client.load(request) };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(at);
});
afterEach(() => vi.useRealTimers());
it("matches the public owning filters and all current partial list facts", async () => {
  const h = harness(),
    actual = await h.load();
  expect(parseOptionSetListRequest(filters)).toEqual(parseOwningRequest(filters));
  expect(actual).toEqual(view());
  expect(Object.isFrozen(actual.items[0]?.selectionRule)).toBe(true);
  expect(actual.items[0]?.referenceEligibility).toBe("NotEvaluated");
  expect(actual.items[0]?.recordedConsumptionReference).toEqual({ status: "Unknown" });
});
it("uses POST with closed filters, selected-only scope header, csrf and no-store", async () => {
  const h = harness();
  await h.load();
  const [url, options] = h.fetcher.mock.calls[0] ?? [];
  expect(url).toBe("/merchant/catalog/option-sets/list");
  expect(options).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
    body: JSON.stringify(filters),
  });
  const headers = new Headers(options?.headers);
  expect(headers.get("X-BOP-CSRF")).toBe(csrf);
  expect(headers.get("X-BOP-Catalog-Scope")).toBe(
    btoa(JSON.stringify(selected)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  );
  expect(String(url)).not.toContain(id(2));
});
it("accepts initial server tenant and actor while comparing full identity when known", async () => {
  const h = harness();
  h.request.expectedFullScope = scope;
  expect((await h.load()).scope).toEqual(scope);
});
it.each(["tenantReference", "actorReference"])("refuses known changed %s", async (key) => {
  const h = harness();
  h.request.expectedFullScope = { ...scope, [key]: id(99) };
  await expect(h.load()).rejects.toMatchObject({ code: "ScopeChanged" });
});
it.each(["brandReference", "storeReference"])("refuses changed selected %s", async (key) => {
  const h = harness();
  h.fetcher.mockResolvedValue(response({ ...view(), scope: { ...scope, [key]: id(99) } }));
  await expect(h.load()).rejects.toMatchObject({ code: "ScopeChanged" });
});
it("refuses conflicting expected full scope before sending", async () => {
  const h = harness();
  h.request.expectedFullScope = { ...scope, brandReference: id(99) };
  await expect(h.load()).rejects.toMatchObject({ code: "ScopeChanged" });
  expect(h.fetcher).not.toHaveBeenCalled();
});
it.each([
  [400, "option_set_list_invalid", "Invalid"],
  [403, "request_denied", "Denied"],
  [409, "option_set_list_feature_disabled", "FeatureDisabled"],
  [409, "option_set_list_stale", "Stale"],
  [503, "option_set_list_unavailable", "Unavailable"],
] as const)("maps exact bounded %s %s", async (status, error, code) => {
  const h = harness();
  h.fetcher.mockResolvedValue(response({ error }, status));
  await expect(h.load()).rejects.toMatchObject({
    code,
    message: "Option Sets could not be loaded",
  });
});
it.each([
  [409, "unknown_private_error"],
  [503, "option_set_list_stale"],
  [200, "request_denied"],
] as const)("refuses unmapped %s error without echo", async (status, error) => {
  const h = harness();
  h.fetcher.mockResolvedValue(response({ error }, status));
  await expect(h.load()).rejects.toMatchObject({
    code: "Unavailable",
    message: "Option Sets could not be loaded",
  });
});
it("rejects added server error detail", async () => {
  const h = harness();
  h.fetcher.mockResolvedValue(
    response({ error: "request_denied", detail: "synthetic private data" }, 403),
  );
  await expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
});
it.each(["tenantReference", "actorReference", "purposeCode", "unknown"])(
  "rejects browser %s in closed filters",
  async (key) => {
    const h = harness();
    h.request.filters = { ...filters, [key]: id(99) };
    await expect(h.load()).rejects.toMatchObject({ code: "Invalid" });
    expect(h.fetcher).not.toHaveBeenCalled();
  },
);
it.each([
  { locale: undefined },
  { limit: 101 },
  { search: "bad\u0000text" },
  { sort: "lifecycle" },
  { cursor: "" },
])("rejects invalid request %j", async (change) => {
  const h = harness();
  h.request.filters = { ...filters, ...change };
  await expect(h.load()).rejects.toMatchObject({ code: "Invalid" });
  expect(h.fetcher).not.toHaveBeenCalled();
});
it("keeps an encrypted cursor opaque in JSON and never in the URL", async () => {
  const h = harness(),
    token = "OptionSetListV1.encrypted_tag";
  h.request.filters = { ...filters, cursor: token };
  h.fetcher.mockResolvedValue(response({ ...view(), hasMore: true, nextCursor: token }));
  expect((await h.load()).nextCursor).toBe(token);
  expect(h.fetcher.mock.calls[0]?.[1]?.body).toContain(token);
  expect(h.fetcher.mock.calls[0]?.[0]).not.toContain(token);
});
it.each([
  "a".repeat(64),
  "sha256:" + "A".repeat(64),
  "sha256:" + "a".repeat(63),
  "sha512:" + "a".repeat(64),
])("refuses altered source generation %s", async (generation) => {
  const h = harness();
  h.fetcher.mockResolvedValue(
    response({ ...view(), projection: { ...view().projection, sourceGeneration: generation } }),
  );
  await expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([
  { optionCount: 0 },
  { activeOptionCount: 3 },
  { aggregateVersion: 0 },
  { localeFallback: false },
  { publishingStatus: { status: "Published" } },
  { referenceEligibility: "Eligible" },
  { recordedConsumptionReference: { status: "Unknown", present: false } },
  { selectionRule: { ...item().selectionRule, minimumSelection: 3 } },
])("refuses tampered item %j", async (change) => {
  const h = harness();
  h.fetcher.mockResolvedValue(response({ ...view(), items: [{ ...item(), ...change }] }));
  await expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([
  { locale: "en-CA" },
  { hasMore: true, nextCursor: null },
  { items: [item(), item()] },
  { unknown: "synthetic" },
])("refuses malformed view %j", async (change) => {
  const h = harness();
  h.fetcher.mockResolvedValue(response({ ...view(), ...change }));
  await expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
});
it("roundtrips the maximum rich hundred-item view without qualifying references", async () => {
  const h = harness(),
    rich = parseOwningView({
      ...view(),
      items: Array.from({ length: 100 }, (_, i) => ({ ...item(20 + i), name: "é".repeat(120) })),
    });
  h.fetcher.mockResolvedValue(response(rich));
  expect(await h.load()).toEqual(rich);
});
it("refuses descriptors without invoking a caller getter", () => {
  const getter = vi.fn(() => "fr-CA"),
    raw = { ...filters };
  Object.defineProperty(raw, "locale", { enumerable: true, get: getter });
  expect(() => parseOptionSetListRequest(raw)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it.each([{ "cache-control": "private" }, { "content-type": "text/plain" }])(
  "requires actual no-store JSON response %j",
  async (headers) => {
    const h = harness();
    h.fetcher.mockResolvedValue(response(view(), 200, headers));
    await expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
  },
);
it("bounds streamed response bytes without echo", async () => {
  const h = harness();
  h.fetcher.mockResolvedValue(
    new Response("x".repeat(262145), {
      headers: { "cache-control": "no-store", "content-type": "application/json" },
    }),
  );
  await expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
});
it("refuses already aborted calls without fetch", async () => {
  const h = harness(),
    controller = new AbortController();
  controller.abort();
  await expect(h.client.load({ ...h.request, signal: controller.signal })).rejects.toMatchObject({
    code: "Unavailable",
  });
  expect(h.fetcher).not.toHaveBeenCalled();
});
it("bounds a fetch that ignores abort", async () => {
  const h = harness();
  h.fetcher.mockImplementation(
    () =>
      new Promise<Response>(() => {
        return undefined;
      }),
  );
  const waiting = expect(h.load()).rejects.toMatchObject({ code: "Unavailable" });
  await vi.advanceTimersByTimeAsync(15000);
  await waiting;
});
it("bounds a body stream that ignores abort", async () => {
  const h = harness(),
    controller = new AbortController();
  h.fetcher.mockResolvedValue(
    new Response(
      new ReadableStream<Uint8Array>({
        start() {
          return undefined;
        },
      }),
      { headers: { "cache-control": "no-store", "content-type": "application/json" } },
    ),
  );
  const waiting = expect(
    h.client.load({ ...h.request, signal: controller.signal }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  await Promise.resolve();
  controller.abort();
  await waiting;
});
it("sanitizes raw fetch failures", async () => {
  const h = harness();
  h.fetcher.mockRejectedValue(Error("synthetic private driver payload"));
  await expect(h.load()).rejects.toMatchObject({
    code: "Unavailable",
    message: "Option Sets could not be loaded",
  });
});
it("does not fill a missing locale or source fact", () => {
  const raw = { ...view(), locale: undefined };
  expect(() => parseOptionSetListView(raw)).toThrow();
});
