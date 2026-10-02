import { parsePromotionReferenceSourceSnapshot } from "../index.js";
import { expect, it, vi } from "vitest";
import {
  buildPromotionReferenceSourceSnapshot as build,
  createPostgresPromotionReferenceSourceStore,
  promotionReferenceSourceFields,
  type PromotionReferenceSourceAuthority,
} from "../index.js";
const id = (n: number) => `018fb000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: `sha256:${"a".repeat(64)}`,
};
const unavailable = { code: "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE" };
function row(
  rootOverrides: Record<string, unknown> = {},
  versionOverrides: Record<string, unknown> = {},
) {
  return {
    root: {
      promotionReference: id(4),
      brandReference: id(1),
      aggregateVersion: 2,
      currentVersionReference: id(7),
      rootCreatedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...rootOverrides,
    },
    version: {
      versionReference: id(7),
      versionNumber: 2,
      snapshotDigest: `sha256:${"b".repeat(64)}`,
      lifecycle: "Published",
      promotionType: "ItemPercentage",
      benefitScope: "Item",
      timeZone: "America/Toronto",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      eligibility: [],
      ...versionOverrides,
    },
    precise: true,
  };
}
const qualifier = (n: number, referenceKind = "Sellable", publicReference = id(100 + n)) => ({
  eligibilityReference: id(n),
  referenceKind,
  publicReference,
});
const source = (references: unknown[] = [row()], observedAt = at) => ({ references, observedAt });
function adapter(
  options: {
    deniedAt?: number;
    isolation?: string;
    payload?: unknown;
    clock?: () => string;
    privateError?: boolean;
  } = {},
) {
  const hold = vi.fn<PromotionReferenceSourceAuthority["holdUntilTransactionCompletes"]>(
    async () => {
      if (hold.mock.calls.length === options.deniedAt) throw new Error("denied");
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    if (options.privateError) throw new Error("private budget data");
    return sql.includes("transaction_isolation")
      ? { rows: [{ isolation: options.isolation ?? "read committed" }] }
      : sql.includes("set_config")
        ? { rows: [] }
        : { rows: [{ source: options.payload ?? source() }] };
  });
  const run = vi.fn(async <T>(work: (tx: { query: typeof query }) => Promise<T>) =>
    work({ query }),
  );
  const store = createPostgresPromotionReferenceSourceStore({
    tenantReference: id(8),
    brandReference: id(1),
    actorReference: id(2),
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: options.clock ?? (() => at) },
    transactions: {
      async run<T>(work: (tx: { query: typeof query }) => Promise<T>) {
        return (await run(work)) as T;
      },
    },
  });
  return { store, hold, query, run };
}
it("preserves unversioned roots and actually empty profiles", () => {
  const empty = { ...row({ currentVersionReference: null }), version: null };
  expect(build(source([empty]), request, at)).toMatchObject({
    profile: "PromotionEligibility",
    coverage: "Complete",
    consistency: "StatementSnapshot",
    versions: [],
  });
  expect(build(source([]), request, at).roots).toEqual([]);
});
it("retains explicit and unrestricted targeting plus segment qualification independently", () => {
  const rows = [
    row({}, { eligibility: [qualifier(10, "Segment")] }),
    row(
      { promotionReference: id(20), currentVersionReference: id(21) },
      {
        versionReference: id(21),
        eligibility: [
          qualifier(22, "Category"),
          qualifier(23, "Sellable"),
          qualifier(24, "Segment"),
        ],
      },
    ),
    row(
      { promotionReference: id(30), currentVersionReference: id(31) },
      {
        versionReference: id(31),
        benefitScope: "Order",
        promotionType: "OrderFixed",
        eligibility: [qualifier(32)],
      },
    ),
  ];
  const result = build(source(rows), request, at);
  expect(result.versions.map((v) => v.catalogReferenceMode)).toEqual([
    "AllSellables",
    "ExplicitSellableOrCategory",
    "OrderSubtotal",
  ]);
  expect(result.versions[0]?.eligibility[0]?.referenceKind).toBe("Segment");
  expect(JSON.stringify(result)).not.toMatch(
    /benefitRate|budget|currency|customerCopy|createdByActor|productReference|skuReference/,
  );
  expect(Object.isFrozen(result.versions[1]?.eligibility[0])).toBe(true);
});
it("retains all lifecycle history and timing instead of current eligible promotions", () => {
  const rows = [
    row(),
    row(
      {},
      { versionReference: id(10), versionNumber: 1, lifecycle: "Archived", effectiveUntil: at },
    ),
    row(
      { promotionReference: id(20), currentVersionReference: id(21) },
      { versionReference: id(21), lifecycle: "Paused", effectiveFrom: "2026-10-01T00:00:00.000Z" },
    ),
    row(
      { promotionReference: id(30), currentVersionReference: id(31) },
      { versionReference: id(31), lifecycle: "Draft" },
    ),
  ];
  const result = build(source(rows), request, at);
  expect(result.versions.find((v) => v.versionReference === id(10))).toMatchObject({
    isCurrentVersion: false,
    temporalStatus: "Expired",
  });
  expect(result.versions.find((v) => v.versionReference === id(21))).toMatchObject({
    lifecycle: "Paused",
    temporalStatus: "Future",
  });
  expect(result.versions).toHaveLength(4);
});
it("hashes deterministic qualifier order, actual source and original opaque intent", () => {
  const a = qualifier(10),
    b = qualifier(11, "Category");
  const initial = build(source([row({}, { eligibility: [a, b] })]), request, at);
  expect(
    build(
      source([row({}, { eligibility: [b, a] })], "2026-09-29T12:00:01.000Z"),
      request,
      "2026-09-29T12:00:01.000Z",
    ).digest,
  ).toBe(initial.digest);
  expect(build(source([row({}, { eligibility: [a] })]), request, at).digest).not.toBe(
    initial.digest,
  );
  expect(
    build(
      source([row({}, { eligibility: [a, b] })]),
      { ...request, catalogIntentDigest: `sha256:${"c".repeat(64)}` },
      at,
    ).digest,
  ).not.toBe(initial.digest);
});
it.each([
  { aggregateVersion: 0 },
  { aggregateVersion: 2147483648 },
  { brandReference: id(99) },
  { currentVersionReference: id(99) },
  { rootCreatedAt: "2026-08-03T00:00:00.000Z" },
  { updatedAt: "2026-10-01T00:00:00.000Z" },
])("rejects inconsistent root %s", (overrides) => {
  expect(() => build(source([row(overrides)]), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it.each([
  { versionNumber: 3 },
  { versionNumber: 1.5 },
  { promotionType: "Invented" },
  { benefitScope: "Store" },
  { lifecycle: "Suspended" },
  { timeZone: "+01:00" },
  { effectiveUntil: "2026-07-01T00:00:00.000Z" },
  { createdAt: "2026-08-03T00:00:00.000Z" },
  { snapshotDigest: "bad" },
])("rejects malformed version %s", (overrides) => {
  expect(() => build(source([row({}, overrides)]), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects duplicate eligibility IDs/targets, unknown kinds and multiple segment qualifiers", () => {
  for (const eligibility of [
    [qualifier(10), qualifier(10, "Category")],
    [qualifier(10), qualifier(11, "Sellable", id(110))],
    [qualifier(10, "Store")],
    [qualifier(10, "Segment"), qualifier(11, "Segment")],
  ])
    expect(() => build(source([row({}, { eligibility })]), request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
  const rows = [
    row({}, { eligibility: [qualifier(10)] }),
    row(
      { promotionReference: id(20), currentVersionReference: id(21) },
      { versionReference: id(21), eligibility: [qualifier(10)] },
    ),
  ];
  expect(() => build(source(rows), request, at)).toThrow(expect.objectContaining(unavailable));
});
it("rejects duplicate version IDs/numbers, root drift, dangling pointer and null mixes", () => {
  const empty = { ...row({ currentVersionReference: null }), version: null };
  for (const rows of [
    [row(), row()],
    [row(), row({}, { versionReference: id(10) })],
    [row(), row({ aggregateVersion: 3 }, { versionReference: id(10), versionNumber: 1 })],
    [{ ...row(), version: null }],
    [empty, row({ currentVersionReference: null })],
    [{ ...row(), precise: false }],
  ])
    expect(() => build(source(rows), request, at)).toThrow(expect.objectContaining(unavailable));
});
it("rejects getters, sparse/oversized qualifiers and references and stale observation", () => {
  const getter = vi.fn(() => []),
    v = row();
  Object.defineProperty(v.version, "eligibility", { enumerable: true, get: getter });
  for (const raw of [
    source([v]),
    source(new Array(1)),
    source(Array.from({ length: 1001 }, () => row())),
    source([row({}, { eligibility: new Array(1) })]),
    source([row({}, { eligibility: Array.from({ length: 1001 }, (_, i) => qualifier(i)) })]),
    source([], "2026-09-29T11:59:54.000Z"),
    source([], "2026-09-29T12:00:01.000Z"),
  ])
    expect(() => build(raw, request, at)).toThrow(expect.objectContaining(unavailable));
  expect(getter).not.toHaveBeenCalled();
});
it("requires actual promotion purpose/permission/fields before and after own bounded SQL", async () => {
  const a = adapter();
  await a.store.loadSnapshot(request);
  expect(a.hold).toHaveBeenCalledTimes(2);
  expect(a.hold.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(8),
    request,
    permission: "pricing.promotion.manage",
    requiredFields: promotionReferenceSourceFields,
    observedAt: at,
  });
  const sql = a.query.mock.calls[2]?.[0];
  expect(sql).toContain("LEFT JOIN rms_pricing.promotion_version");
  expect(sql).toContain("promotion_eligibility_reference");
  expect(sql?.match(/LIMIT 1001/g)).toHaveLength(2);
  expect(sql).not.toMatch(
    /rms_catalog|benefit_rate|budget_minor|currency_code|customer_copy|created_by_actor/,
  );
});
it("denies wrong caller and early authority before SQL; late authority/source/driver loss fails generically", async () => {
  const a = adapter();
  await expect(a.store.loadSnapshot({ ...request, actorReference: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(a.run).not.toHaveBeenCalled();
  const b = adapter({ deniedAt: 1 });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  expect(b.query).not.toHaveBeenCalled();
  for (const options of [
    { deniedAt: 2 },
    { isolation: "repeatable read" },
    { payload: {} },
    { privateError: true },
  ])
    await expect(adapter(options).store.loadSnapshot(request)).rejects.toMatchObject({
      ...unavailable,
      message: "promotion references are unavailable",
    });
});
it("rejects callback bypass, duplication and substituted results", async () => {
  const a = adapter();
  a.run.mockImplementationOnce(async () => undefined as never);
  await expect(a.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const b = adapter();
  b.run.mockImplementationOnce(async (work) => {
    await work({ query: b.query });
    return {} as never;
  });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const c = adapter();
  c.run.mockImplementationOnce(async (work) => {
    await work({ query: c.query });
    return await work({ query: c.query });
  });
  await expect(c.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
});

it("validates complete public snapshot and rejects altered request/coverage/digest/computed metadata", () => {
  const snapshot = build(source(), request, at);
  expect(parsePromotionReferenceSourceSnapshot(snapshot, request, at)).toEqual(snapshot);
  for (const altered of [
    { ...snapshot, coverage: "Partial" },
    { ...snapshot, digest: "sha256:" + "f".repeat(64) },
    { ...snapshot, request: { ...request, operationReference: id(99) } },
    { ...snapshot, profile: "Invented" },
  ])
    expect(() => parsePromotionReferenceSourceSnapshot(altered, request, at)).toThrow(
      expect.objectContaining({ code: "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE" }),
    );
  const get = vi.fn(() => "Complete"),
    raw = { ...snapshot };
  Object.defineProperty(raw, "coverage", { enumerable: true, get });
  expect(() => parsePromotionReferenceSourceSnapshot(raw, request, at)).toThrow(
    expect.objectContaining({ code: "PROMOTION_REFERENCE_SOURCE_UNAVAILABLE" }),
  );
  expect(get).not.toHaveBeenCalled();
});
