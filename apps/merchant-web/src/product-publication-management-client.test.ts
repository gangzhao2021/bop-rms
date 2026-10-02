import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import {
  createProductPublicationManagementClient,
  parseProductPublicationManagementView,
  productPublicationManagementMaximumResponseBytes,
} from "./product-publication-management-client.js";
const id = (n: number) => "01902443-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T22:00:00.000Z",
  until = "2026-09-30T22:00:05.000Z",
  hash = "sha256:" + "1".repeat(64);
const request = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    expectedAggregateVersion: 7,
  },
  input = { request, csrf: "c".repeat(43) };
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
function row() {
  return {
    versionReference: id(6),
    publicationVersion: 2,
    state: "Scheduled",
    contentDigest: hash,
    configurationDigest: hash,
    scopeSet: [{ level: "Store", reference: id(3), channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "America/Toronto",
      effectiveFrom: {
        instant: at,
        localDateTime: "2026-09-30T18:00:00.000",
        utcOffsetMinutes: -240,
      },
      effectiveUntil: null,
    },
    scheduleReference: id(20),
    scheduleVersion: 2,
    recordedAt: at,
  };
}
function fixture() {
  return {
    profile: "CatalogProductPublicationManagementV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    productReference: id(4),
    aggregateVersion: 7,
    observedAt: at,
    validUntil: until,
    coverage: "CompleteRecordedPublicationManagement",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
    draft: {
      versionReference: id(6),
      contentDigest: hash,
      configurationDigest: hash,
      contentStatus: "Present",
    },
    versions: [row()],
  };
}
function response(value: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
  });
}
const read = (raw: unknown, clock: () => number = () => Date.parse(at)) =>
  parseProductPublicationManagementView(raw, request, clock);
afterEach(() => vi.useRealTimers());
it("retains exact owning command parameters and exclusive original lease without qualification", async () => {
  const view = await read(seal(fixture()));
  expect(view.versions).toEqual([row()]);
  expect(view.draft).toEqual(fixture().draft);
  expect(view.publishValidation).toBe("Incomplete");
  expect(view.eligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(view)).toBe(true);
  expect(Object.isFrozen(view.versions[0]?.scopeSet)).toBe(true);
});
it("accepts shortest joined lease and truthful empty history/legacy unavailable Draft", async () => {
  const raw = fixture();
  raw.validUntil = "2026-09-30T22:00:02.000Z";
  raw.versions = [];
  raw.draft.contentStatus = "Unavailable";
  const view = await read(seal(raw));
  expect(view.versions).toEqual([]);
  expect(view.draft.contentStatus).toBe("Unavailable");
  expect(view.validUntil).toBe(raw.validUntil);
});
it.each(["tenantReference", "brandReference", "storeReference", "productReference"] as const)(
  "refuses exact scope rebound %s",
  async (key) => {
    const raw = fixture();
    raw[key] = id(99);
    await expect(read(seal(raw))).rejects.toMatchObject({ code: "ScopeChanged" });
  },
);
it.each([
  ["aggregateVersion", 8, "Stale"],
  ["profile", "Unknown", "Unavailable"],
  ["coverage", "Partial", "Unavailable"],
  ["eligibility", "Eligible", "Unavailable"],
  ["publishValidation", "Pass", "Unavailable"],
  ["validUntil", "2026-09-30T22:00:05.001Z", "Stale"],
  ["validUntil", at, "Stale"],
  ["observedAt", "2026-09-30T22:00:01.000Z", "Stale"],
  ["actorReference", id(99), "Unavailable"],
] as const)("refuses resealed envelope %s", async (key, value, code) => {
  await expect(read(seal({ ...fixture(), [key]: value }))).rejects.toMatchObject({ code });
});
it.each([
  "versionReference",
  "publicationVersion",
  "state",
  "contentDigest",
  "configurationDigest",
  "scheduleReference",
  "scheduleVersion",
  "recordedAt",
  "validationDecision",
])("refuses malformed or private recorded row %s", async (key) => {
  const raw = fixture();
  Object.assign(raw.versions[0] ?? {}, {
    [key]:
      key === "publicationVersion" || key === "scheduleVersion"
        ? 0
        : key === "recordedAt"
          ? until
          : key === "scheduleReference"
            ? null
            : "Invalid",
  });
  await expect(read(seal(raw))).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([
  "duplicate",
  "sparse",
  "nestedExtra",
  "scopeCodeNormalization",
  "badOffset",
  "badLocal",
  "badEnd",
  "tooMany",
])("refuses recorded graph wire %s", async (mode) => {
  const raw = fixture();
  const v = raw.versions[0];
  if (!v) throw Error("Missing fixture");
  if (mode === "duplicate") raw.versions.push(row());
  if (mode === "sparse") delete raw.versions[0];
  if (mode === "nestedExtra") Object.assign(v.effectivePeriod, { authority: true });
  if (mode === "scopeCodeNormalization")
    Object.assign(v.scopeSet[0] ?? {}, { channelCodes: ["pickup"] });
  if (mode === "badOffset") v.effectivePeriod.effectiveFrom.utcOffsetMinutes = 0;
  if (mode === "badLocal")
    v.effectivePeriod.effectiveFrom.localDateTime = "2026-09-30T19:00:00.000";
  if (mode === "badEnd")
    Object.assign(v.effectivePeriod, { effectiveUntil: v.effectivePeriod.effectiveFrom });
  if (mode === "tooMany") raw.versions = Array.from({ length: 1001 }, row);
  await expect(read(seal(raw))).rejects.toMatchObject({ code: "Unavailable" });
});
it("refuses digest tamper, cyclic input and getters without executing them", async () => {
  await expect(read({ ...seal(fixture()), digest: hash })).rejects.toMatchObject({
    code: "Unavailable",
  });
  const getter = vi.fn();
  const raw = seal(fixture());
  Object.defineProperty(raw, "draft", { enumerable: true, get: getter });
  await expect(read(raw)).rejects.toMatchObject({ code: "Unavailable" });
  expect(getter).not.toHaveBeenCalled();
  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  await expect(read(cyclic)).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([Date.parse(at) - 1, Date.parse(until), Number.NaN])(
  "refuses current clock %s",
  async (clock) => {
    await expect(read(seal(fixture()), () => clock)).rejects.toMatchObject({ code: "Stale" });
  },
);
it.each(["expires", "reverses"])(
  "rechecks original lease after crypto when time %s",
  async (mode) => {
    let n = 0;
    await expect(
      read(seal(fixture()), () =>
        ++n < 3 ? Date.parse(at) + 1 : mode === "expires" ? Date.parse(until) : Date.parse(at),
      ),
    ).rejects.toMatchObject({ code: "Stale" });
  },
);
it("sends exact ordinary POST body and native selected scope with no Tenant/Actor query data", async () => {
  const send = vi.fn<typeof fetch>(async () => response(seal(fixture())));
  const view = await createProductPublicationManagementClient(send as typeof fetch, () =>
    Date.parse(at),
  ).load(input, new AbortController().signal);
  expect(view.revision).toBe(7);
  const call = send.mock.calls[0];
  if (!call) throw Error("Missing request");
  expect(call[0]).toBe("/merchant/catalog/products/publication/management");
  expect(call[1]).toMatchObject({
    method: "POST",
    credentials: "same-origin",
    cache: "no-store",
    redirect: "error",
  });
  expect(JSON.parse(String(call[1]?.body))).toEqual({
    productReference: id(4),
    expectedAggregateVersion: 7,
  });
  const headers = call[1]?.headers as Record<string, string>;
  expect(headers["x-bop-csrf"]).toBe(input.csrf);
  expect(
    JSON.parse(Buffer.from(headers["x-bop-catalog-scope"] ?? "", "base64url").toString()),
  ).toEqual({ brandReference: id(2), storeReference: id(3) });
});
it.each([
  [403, "request_denied", "Denied"],
  [401, "request_denied", "Denied"],
  [400, "product_publication_management_invalid", "Invalid"],
  [503, "product_publication_management_unavailable", "Unavailable"],
] as const)("redacts native failure %s", async (status, error, code) => {
  await expect(
    createProductPublicationManagementClient((async () =>
      response({ error }, status)) as typeof fetch).load(input, new AbortController().signal),
  ).rejects.toMatchObject({ code });
});
it.each([
  { "cache-control": "public" },
  { "content-type": "text/html" },
  { "content-length": String(productPublicationManagementMaximumResponseBytes + 1) },
  { "content-length": "1" },
])("refuses unsafe HTTP headers %#", async (headers) => {
  await expect(
    createProductPublicationManagementClient(
      (async () => response(seal(fixture()), 200, headers)) as typeof fetch,
      () => Date.parse(at),
    ).load(input, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it("bounds ignored fetch timeout and external abort without renewing a result", async () => {
  vi.useFakeTimers();
  const client = createProductPublicationManagementClient(
    (() => new Promise<Response>(() => undefined)) as typeof fetch,
  );
  const c = new AbortController();
  const pending = expect(client.load(input, c.signal)).rejects.toMatchObject({
    name: "AbortError",
  });
  c.abort();
  await pending;
  const late = expect(client.load(input, new AbortController().signal)).rejects.toMatchObject({
    code: "Unavailable",
  });
  await vi.advanceTimersByTimeAsync(15000);
  await late;
});
it("refuses client authority/invalid CSRF before dispatch", async () => {
  const send = vi.fn();
  const client = createProductPublicationManagementClient(send);
  const extra = { ...request, approval: true };
  await expect(
    client.load({ ...input, request: extra }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Invalid" });
  await expect(
    client.load({ ...input, csrf: "short" }, new AbortController().signal),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(send).not.toHaveBeenCalled();
});
it.each(["oversize", "invalidUtf8", "stalled"])(
  "bounds actual streamed response %s",
  async (mode) => {
    vi.useFakeTimers();
    const cancelled = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        if (mode === "oversize")
          c.enqueue(new Uint8Array(productPublicationManagementMaximumResponseBytes + 1));
        if (mode === "invalidUtf8") {
          c.enqueue(new Uint8Array([0xff]));
          c.close();
        }
      },
      cancel: cancelled,
    });
    const client = createProductPublicationManagementClient(
      (async () =>
        new Response(stream, {
          headers: { "content-type": "application/json", "cache-control": "no-store" },
        })) as typeof fetch,
      () => Date.parse(at),
    );
    const refusal = expect(client.load(input, new AbortController().signal)).rejects.toMatchObject({
      code: "Unavailable",
    });
    if (mode === "stalled") await vi.advanceTimersByTimeAsync(15000);
    await refusal;
    if (mode !== "invalidUtf8") expect(cancelled).toHaveBeenCalled();
  },
);
