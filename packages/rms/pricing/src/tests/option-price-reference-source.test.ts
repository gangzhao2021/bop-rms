import { parseOptionPriceReferenceSourceSnapshot } from "../index.js";
import { expect, it, vi } from "vitest";
import {
  buildOptionPriceReferenceSourceSnapshot as build,
  createPostgresOptionPriceReferenceSourceStore,
  optionPriceReferenceSourceFields,
  type OptionPriceReferenceSourceAuthority,
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
const unavailable = { code: "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE" };
function row(
  rootOverrides: Record<string, unknown> = {},
  versionOverrides: Record<string, unknown> = {},
) {
  return {
    root: {
      ruleReference: id(4),
      brandReference: id(1),
      bindingReference: id(5),
      optionReference: id(6),
      aggregateVersion: "2",
      currentVersionReference: id(7),
      rootCreatedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
      ...rootOverrides,
    },
    version: {
      versionReference: id(7),
      versionNumber: "2",
      snapshotDigest: `sha256:${"b".repeat(64)}`,
      lifecycle: "Published",
      skuReference: null,
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      timeZone: "UTC",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
      createdAt: "2026-08-02T00:00:00.000Z",
      ...versionOverrides,
    },
    precise: true,
  };
}
const source = (references: unknown[] = [row()], observedAt = at) => ({ references, observedAt });
function adapter(
  options: { deniedAt?: number; isolation?: string; payload?: unknown; clock?: () => string } = {},
) {
  const hold = vi.fn<OptionPriceReferenceSourceAuthority["holdUntilTransactionCompletes"]>(
    async () => {
      if (hold.mock.calls.length === options.deniedAt) throw new Error("denied");
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return sql.includes("transaction_isolation")
      ? { rows: [{ isolation: options.isolation ?? "read committed" }] }
      : sql.includes("set_config")
        ? { rows: [] }
        : { rows: [{ source: options.payload ?? source() }] };
  });
  const run = vi.fn(async <T>(work: (tx: { query: typeof query }) => Promise<T>) =>
    work({ query }),
  );
  const store = createPostgresOptionPriceReferenceSourceStore({
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
it("retains unversioned bindings and an actually empty Brand profile", () => {
  const r = row({ currentVersionReference: null });
  const result = build(source([{ ...r, version: null }]), request, at);
  expect(result).toMatchObject({
    profile: "OptionPriceBindings",
    coverage: "Complete",
    consistency: "StatementSnapshot",
    versions: [],
  });
  expect(result.roots[0]?.bindingReference).toBe(id(5));
  expect(build(source([]), request, at).roots).toEqual([]);
});
it("preserves all historical scopes, qualified SKU and distinct temporal states", () => {
  const rows = [
    row(),
    row(
      {},
      { versionReference: id(10), versionNumber: "1", lifecycle: "Archived", effectiveUntil: at },
    ),
    row(
      { ruleReference: id(20), currentVersionReference: id(21) },
      {
        versionReference: id(21),
        skuReference: id(22),
        scopeKind: "Store",
        scopeReference: id(23),
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      },
    ),
    row(
      { ruleReference: id(30), currentVersionReference: id(31) },
      {
        versionReference: id(31),
        scopeKind: "StoreGroup",
        scopeReference: id(32),
        channelCode: "CUSTOMER_PWA",
        orderType: "Pickup",
      },
    ),
    row(
      { ruleReference: id(40), currentVersionReference: id(41) },
      { versionReference: id(41), scopeKind: "Region", scopeReference: id(42), lifecycle: "Draft" },
    ),
  ];
  const result = build(source(rows), request, at);
  expect(result.roots).toHaveLength(4);
  expect(result.versions).toHaveLength(5);
  expect(result.versions.find((v) => v.versionReference === id(10))).toMatchObject({
    isCurrentVersion: false,
    temporalStatus: "Expired",
  });
  expect(result.versions.find((v) => v.versionReference === id(21))).toMatchObject({
    skuReference: id(22),
    temporalStatus: "Future",
  });
  expect(JSON.stringify(result)).not.toMatch(
    /unitAmount|currency|includedQuantity|createdByActor|productReference/,
  );
  expect(Object.isFrozen(result.versions[0])).toBe(true);
});
it("preserves exact int64 counters beyond JS integer precision", () => {
  const result = build(
    source([
      row({ aggregateVersion: "9223372036854775807" }, { versionNumber: "9007199254740993" }),
    ]),
    request,
    at,
  );
  expect(result.roots[0]?.aggregateVersion).toBe("9223372036854775807");
  expect(result.versions[0]?.versionNumber).toBe("9007199254740993");
});
it("hashes immutable content and intent with deterministic order, excluding observation time", () => {
  const rows = [
    row(),
    row({ ruleReference: id(20), currentVersionReference: id(21) }, { versionReference: id(21) }),
  ];
  const initial = build(source(rows), request, at);
  expect(
    build(
      source([...rows].reverse(), "2026-09-29T12:00:01.000Z"),
      request,
      "2026-09-29T12:00:01.000Z",
    ).digest,
  ).toBe(initial.digest);
  expect(
    build(source(rows), { ...request, catalogIntentDigest: `sha256:${"c".repeat(64)}` }, at).digest,
  ).not.toBe(initial.digest);
  expect(build(source([row({ currentVersionReference: null })]), request, at).digest).not.toBe(
    build(source(), request, at).digest,
  );
});
it.each([
  { aggregateVersion: 2 },
  { aggregateVersion: "0" },
  { aggregateVersion: "01" },
  { aggregateVersion: "9223372036854775808" },
  { brandReference: id(99) },
  { currentVersionReference: id(99) },
  { rootCreatedAt: "2026-08-03T00:00:00.000Z" },
  { updatedAt: "2026-10-01T00:00:00.000Z" },
])("rejects invalid or incomplete root %s", (overrides) => {
  expect(() => build(source([row(overrides)]), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it.each([
  { versionNumber: "3" },
  { versionNumber: "0" },
  { skuReference: "invalid" },
  { scopeKind: "Store", scopeReference: null },
  { scopeReference: id(20) },
  { lifecycle: "Suspended" },
  { timeZone: "+01:00" },
  { effectiveUntil: "2026-07-01T00:00:00.000Z" },
  { createdAt: "2026-08-03T00:00:00.000Z" },
  { orderType: "Delivery" },
])("rejects invalid version %s", (overrides) => {
  expect(() => build(source([row({}, overrides)]), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects duplicate IDs, version numbers, inconsistent roots, dangling pointers and null-version mixes", () => {
  const empty = { ...row({ currentVersionReference: null }), version: null };
  for (const rows of [
    [row(), row()],
    [row(), row({}, { versionReference: id(10) })],
    [row(), row({ bindingReference: id(99) }, { versionReference: id(10), versionNumber: "1" })],
    [{ ...row(), version: null }],
    [empty, row({ currentVersionReference: null })],
    [{ ...row(), precise: false }],
  ])
    expect(() => build(source(rows), request, at)).toThrow(expect.objectContaining(unavailable));
});
it("rejects getters, sparse/oversized rows, unknown fields and stale observations", () => {
  const getter = vi.fn(() => at);
  const raw = { references: [] };
  Object.defineProperty(raw, "observedAt", { enumerable: true, get: getter });
  for (const value of [
    raw,
    source(new Array(1)),
    source(Array.from({ length: 1001 }, () => row())),
    { ...source(), extra: true },
    source([], "2026-09-29T11:59:54.000Z"),
    source([], "2026-09-29T12:00:01.000Z"),
  ])
    expect(() => build(value, request, at)).toThrow(expect.objectContaining(unavailable));
  expect(getter).not.toHaveBeenCalled();
});
it("requires current authority and all owner fields before and after bounded own SQL", async () => {
  const a = adapter();
  await a.store.loadSnapshot(request);
  expect(a.hold).toHaveBeenCalledTimes(2);
  expect(a.hold.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(8),
    request,
    permission: "pricing.price-book.manage",
    requiredFields: optionPriceReferenceSourceFields,
    observedAt: at,
  });
  expect(a.query.mock.calls[2]?.[0]).toContain("LEFT JOIN rms_pricing.option_price_rule_version");
  expect(a.query.mock.calls[2]?.[0]).toContain("LIMIT 1001");
  expect(a.query.mock.calls[2]?.[0]).not.toMatch(
    /rms_catalog|unit_amount|currency|included_quantity|created_by_actor/,
  );
});
it("denies wrong caller/early authority before SQL and fails on late authority/isolation/source loss", async () => {
  const a = adapter();
  await expect(a.store.loadSnapshot({ ...request, brandReference: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(a.run).not.toHaveBeenCalled();
  const b = adapter({ deniedAt: 1 });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  expect(b.query).not.toHaveBeenCalled();
  for (const options of [{ deniedAt: 2 }, { isolation: "repeatable read" }, { payload: {} }])
    await expect(adapter(options).store.loadSnapshot(request)).rejects.toMatchObject({
      ...unavailable,
      message: "option price references are unavailable",
    });
});
it("rejects bypassed, duplicated or substituted transaction callbacks", async () => {
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
  expect(parseOptionPriceReferenceSourceSnapshot(snapshot, request, at)).toEqual(snapshot);
  for (const altered of [
    { ...snapshot, coverage: "Partial" },
    { ...snapshot, digest: "sha256:" + "f".repeat(64) },
    { ...snapshot, request: { ...request, operationReference: id(99) } },
    { ...snapshot, profile: "Invented" },
  ])
    expect(() => parseOptionPriceReferenceSourceSnapshot(altered, request, at)).toThrow(
      expect.objectContaining({ code: "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE" }),
    );
  const get = vi.fn(() => "Complete"),
    raw = { ...snapshot };
  Object.defineProperty(raw, "coverage", { enumerable: true, get });
  expect(() => parseOptionPriceReferenceSourceSnapshot(raw, request, at)).toThrow(
    expect.objectContaining({ code: "OPTION_PRICE_REFERENCE_SOURCE_UNAVAILABLE" }),
  );
  expect(get).not.toHaveBeenCalled();
});
