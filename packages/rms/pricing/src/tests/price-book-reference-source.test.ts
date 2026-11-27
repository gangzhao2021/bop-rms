import { parsePriceBookReferenceSourceSnapshot } from "../index.js";
import { describe, expect, it, vi } from "vitest";
import {
  buildPriceBookReferenceSourceSnapshot as build,
  parsePriceBookReferenceSourceRequest,
  priceBookReferenceSourceFields,
  createPostgresPriceBookReferenceSourceStore,
  type PriceBookReferenceSourceAuthority,
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
const unavailable = { code: "PRICE_BOOK_REFERENCE_SOURCE_UNAVAILABLE" };
function row(overrides: Record<string, unknown> = {}, precise = true) {
  return {
    precise,
    reference: {
      priceBookReference: id(4),
      brandReference: id(1),
      aggregateVersion: 2,
      currentVersionReference: id(5),
      updatedAt: "2026-08-01T00:00:00.000Z",
      versionReference: id(5),
      versionNumber: 1,
      snapshotDigest: `sha256:${"b".repeat(64)}`,
      lifecycle: "Published",
      createdAt: "2026-08-01T00:00:00.000Z",
      entryReference: id(6),
      sellableReference: id(7),
      scopeKind: "Brand",
      scopeReference: null,
      channelCode: null,
      orderType: null,
      timeZone: "America/Toronto",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
      ...overrides,
    },
  };
}
function source(references: unknown[] = [row()], observedAt = at) {
  return { observedAt, references };
}
function adapter(
  options: {
    deniedAt?: number;
    isolation?: string;
    payload?: unknown;
    clock?: () => string;
    privateError?: boolean;
  } = {},
) {
  const hold = vi.fn<PriceBookReferenceSourceAuthority["holdUntilTransactionCompletes"]>(
    async () => {
      if (hold.mock.calls.length === options.deniedAt) throw new Error("denied");
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    if (options.privateError) throw new Error("private row data");
    return sql.includes("transaction_isolation")
      ? { rows: [{ isolation: options.isolation ?? "read committed" }] }
      : sql.includes("set_config")
        ? { rows: [] }
        : { rows: [{ source: options.payload ?? source() }] };
  });
  const run = vi.fn(async <T>(work: (tx: { query: typeof query }) => Promise<T>) =>
    work({ query }),
  );
  const store = createPostgresPriceBookReferenceSourceStore({
    tenantReference: id(8),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      async run<T>(work: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
        return (await run(work)) as T;
      },
    },
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: options.clock ?? (() => at) },
  });
  return { store, hold, query, run };
}
describe("PriceBookEntries reference source", () => {
  it("retains historical scopes and timing without amounts or foreign identity claims", () => {
    const rows = [
      row({ entryReference: id(10), effectiveUntil: at }),
      row({
        entryReference: id(11),
        scopeKind: "Store",
        scopeReference: id(20),
        effectiveFrom: "2026-10-01T00:00:00.000Z",
      }),
      row({
        entryReference: id(12),
        scopeKind: "Region",
        scopeReference: id(21),
        lifecycle: "Archived",
        versionReference: id(30),
        versionNumber: 2,
      }),
      row({
        entryReference: id(13),
        scopeKind: "StoreGroup",
        scopeReference: id(22),
        channelCode: "CUSTOMER_PWA",
        orderType: "Pickup",
      }),
    ];
    const result = build(source(rows), request, at);
    expect(result).toMatchObject({
      profile: "PriceBookEntries",
      coverage: "Complete",
      consistency: "StatementSnapshot",
    });
    expect(result.references.map((r) => r.temporalStatus)).toEqual([
      "Expired",
      "Future",
      "Effective",
      "Effective",
    ]);
    expect(result.references[2]?.isCurrentVersion).toBe(false);
    expect(JSON.stringify(result)).not.toMatch(
      /amount|currency|productReference|skuReference|reasonCode/,
    );
    expect(Object.isFrozen(result.references[0])).toBe(true);
  });
  it("allows an actually empty profile and a null current pointer", () => {
    expect(build(source([]), request, at).references).toEqual([]);
    expect(
      build(source([row({ currentVersionReference: null })]), request, at).references[0]
        ?.isCurrentVersion,
    ).toBe(false);
  });
  it("binds the original opaque intent and canonical content while excluding observation time", () => {
    const rows = [row(), row({ entryReference: id(9) })];
    const initial = build(source(rows), request, at);
    expect(
      build(
        source([...rows].reverse(), "2026-09-29T12:00:01.000Z"),
        request,
        "2026-09-29T12:00:01.000Z",
      ).digest,
    ).toBe(initial.digest);
    expect(
      build(source(rows), { ...request, catalogIntentDigest: `sha256:${"c".repeat(64)}` }, at)
        .digest,
    ).not.toBe(initial.digest);
    expect(build(source([row({ aggregateVersion: 3 })]), request, at).digest).not.toBe(
      build(source(), request, at).digest,
    );
  });
  it.each([
    { brandReference: id(99) },
    { aggregateVersion: 0 },
    { aggregateVersion: 2147483648 },
    { versionNumber: 1.5 },
    { scopeKind: "Store", scopeReference: null },
    { scopeReference: id(20) },
    { lifecycle: "Suspended" },
    { orderType: "Delivery" },
    { timeZone: "+01:00" },
    { timeZone: "not-a-zone" },
    { effectiveUntil: "2026-07-01T00:00:00.000Z" },
    { createdAt: "2026-10-01T00:00:00.000Z" },
    { snapshotDigest: "bad" },
  ])("rejects malformed or foreign references %s", (overrides) => {
    expect(() => build(source([row(overrides)]), request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
  });
  it("rejects inconsistent root/version identities, duplicates and lost precision", () => {
    for (const rows of [
      [row(), row()],
      [row(), row({ entryReference: id(9), aggregateVersion: 3 })],
      [row(), row({ entryReference: id(9), lifecycle: "Draft" })],
      [row({}, false)],
    ])
      expect(() => build(source(rows), request, at)).toThrow(expect.objectContaining(unavailable));
  });
  it("rejects oversized, sparse and accessor-backed data without invoking getters", () => {
    const getter = vi.fn(() => at);
    const raw = { references: [row()] };
    Object.defineProperty(raw, "observedAt", { enumerable: true, get: getter });
    for (const value of [
      raw,
      source(new Array(1)),
      source(Array.from({ length: 1001 }, () => row())),
    ])
      expect(() => build(value, request, at)).toThrow(expect.objectContaining(unavailable));
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects stale or future observation and unknown request fields", () => {
    for (const observedAt of ["2026-09-29T11:59:54.000Z", "2026-09-29T12:00:01.000Z"])
      expect(() => build(source([], observedAt), request, at)).toThrow(
        expect.objectContaining(unavailable),
      );
    expect(() =>
      parsePriceBookReferenceSourceRequest({ ...request, productReference: id(4) }),
    ).toThrow(expect.objectContaining(unavailable));
  });
  it("requires actual purpose/permission/fields before and after scoped SQL", async () => {
    const a = adapter();
    await a.store.loadSnapshot(request);
    expect(a.hold).toHaveBeenCalledTimes(2);
    expect(a.hold.mock.calls[0]?.[1]).toEqual({
      tenantReference: id(8),
      request,
      permission: "pricing.price-book.manage",
      requiredFields: priceBookReferenceSourceFields,
      observedAt: at,
    });
    const sql = a.query.mock.calls[2]?.[0];
    expect(sql).toContain("LIMIT 1001");
    expect(sql).not.toContain("rms_catalog");
    expect(sql).not.toMatch(/amount_minor|currency_code|created_by_actor_id|reason_code/);
  });
  it("denies foreign caller and early authority loss before SQL", async () => {
    const a = adapter();
    await expect(
      a.store.loadSnapshot({ ...request, actorReference: id(99) }),
    ).rejects.toMatchObject(unavailable);
    expect(a.run).not.toHaveBeenCalled();
    const denied = adapter({ deniedAt: 1 });
    await expect(denied.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
    expect(denied.query).not.toHaveBeenCalled();
  });
  it("rejects late authority loss, wrong isolation and private driver failure", async () => {
    for (const options of [
      { deniedAt: 2 },
      { isolation: "repeatable read" },
      { privateError: true },
    ])
      await expect(adapter(options).store.loadSnapshot(request)).rejects.toMatchObject({
        ...unavailable,
        message: "price book references are unavailable",
      });
  });
  it("rejects a transaction provider that bypasses or replaces the callback result", async () => {
    const a = adapter();
    a.run.mockImplementationOnce(async () => undefined as never);
    await expect(a.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
    const b = adapter();
    b.run.mockImplementationOnce(async (work) => {
      await work({ query: b.query });
      return {} as never;
    });
    await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  });
});

it("validates complete public snapshot and rejects altered request/coverage/digest/computed metadata", () => {
  const snapshot = build(source(), request, at);
  expect(parsePriceBookReferenceSourceSnapshot(snapshot, request, at)).toEqual(snapshot);
  for (const altered of [
    { ...snapshot, coverage: "Partial" },
    { ...snapshot, digest: "sha256:" + "f".repeat(64) },
    { ...snapshot, request: { ...request, operationReference: id(99) } },
    { ...snapshot, profile: "Invented" },
  ])
    expect(() => parsePriceBookReferenceSourceSnapshot(altered, request, at)).toThrow(
      expect.objectContaining({ code: "PRICE_BOOK_REFERENCE_SOURCE_UNAVAILABLE" }),
    );
  const get = vi.fn(() => "Complete"),
    raw = { ...snapshot };
  Object.defineProperty(raw, "coverage", { enumerable: true, get });
  expect(() => parsePriceBookReferenceSourceSnapshot(raw, request, at)).toThrow(
    expect.objectContaining({ code: "PRICE_BOOK_REFERENCE_SOURCE_UNAVAILABLE" }),
  );
  expect(get).not.toHaveBeenCalled();
});
