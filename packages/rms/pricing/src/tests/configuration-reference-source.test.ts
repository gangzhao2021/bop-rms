import { expect, it, vi } from "vitest";
import {
  buildConfigurationReferenceSourceSnapshot as build,
  parseConfigurationReferenceSourceSnapshot as parse,
  buildPriceBookReferenceSourceSnapshot,
  buildOptionPriceReferenceSourceSnapshot,
  buildPromotionReferenceSourceSnapshot,
  createPostgresConfigurationReferenceSourceStore,
  configurationReferenceSourceFields,
  type ConfigurationReferenceSourceOptions,
  type PriceQuoteQueryTransaction,
} from "../index.js";
const id = (n: number) => `01902412-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_PRICING_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
const unavailable = { code: "CONFIGURATION_REFERENCE_SOURCE_UNAVAILABLE" };
const raw = () => ({ observedAt: at, references: [] });
const input = () => ({
  generation: "0",
  priceBooks: buildPriceBookReferenceSourceSnapshot(raw(), request, at),
  optionPrices: buildOptionPriceReferenceSourceSnapshot(raw(), request, at),
  promotions: buildPromotionReferenceSourceSnapshot(raw(), request, at),
});
function adapter(overrides: { isolation?: string; head?: unknown; deny?: number } = {}) {
  let now = at;
  let head: unknown = overrides.head ?? { generation: "0", has_source: false };
  const authority = vi.fn<
    ConfigurationReferenceSourceOptions["authority"]["holdUntilTransactionCompletes"]
  >(async () => {
    if (authority.mock.calls.length === overrides.deny) throw new Error("opaque");
  });
  const books = vi.fn<
    ConfigurationReferenceSourceOptions["priceBookAuthority"]["holdUntilTransactionCompletes"]
  >(async (_tx, input) => {
    expect(input.request).toEqual(request);
  });
  const options = vi.fn<
    ConfigurationReferenceSourceOptions["optionPriceAuthority"]["holdUntilTransactionCompletes"]
  >(async (_tx, input) => {
    expect(input.request).toEqual(request);
  });
  const promotions = vi.fn<
    ConfigurationReferenceSourceOptions["promotionAuthority"]["holdUntilTransactionCompletes"]
  >(async (_tx, input) => {
    expect(input.request).toEqual(request);
  });
  const query = vi.fn(async (sql: string) =>
    sql.includes("transaction_isolation")
      ? { rows: [{ isolation: overrides.isolation ?? "read committed" }] }
      : sql.includes("SELECT g.generation")
        ? { rows: [head] }
        : sql.includes("jsonb_build_object")
          ? { rows: [{ source: raw() }] }
          : { rows: [] },
  );
  const tx = { query: query as PriceQuoteQueryTransaction["query"] };
  const run = vi.fn(async <T>(work: (tx: PriceQuoteQueryTransaction) => Promise<T>) => work(tx));
  const store = createPostgresConfigurationReferenceSourceStore({
    tenantReference: id(9),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      run: async <T>(work: (tx: PriceQuoteQueryTransaction) => Promise<T>) =>
        (await run(work)) as T,
    },
    clock: { now: () => now },
    authority: { holdUntilTransactionCompletes: authority },
    priceBookAuthority: { holdUntilTransactionCompletes: books },
    optionPriceAuthority: { holdUntilTransactionCompletes: options },
    promotionAuthority: { holdUntilTransactionCompletes: promotions },
  });
  return {
    store,
    authority,
    books,
    options,
    promotions,
    query,
    run,
    tx,
    setHead: (value: unknown) => {
      head = value;
    },
    setNow: (value: string) => {
      now = value;
    },
  };
}
it("keeps complete empty profiles, original intent and deterministic generation binding without Tax approval", () => {
  const source = build(input(), request, at);
  expect(parse(source, request, at)).toEqual(source);
  expect(source).toMatchObject({
    profile: "PriceBookOptionPromotionReferencesV1",
    coverage: "CompleteStoredReferences",
    taxCoverage: "Unavailable",
    consistency: "StatementSnapshots",
    generation: "0",
  });
  expect(Object.isFrozen(source)).toBe(true);
  expect(build({ ...input(), generation: "1" }, request, at).digest).not.toBe(source.digest);
});
it.each(["-1", "01", "9223372036854775808", 1, null])(
  "refuses invalid generation %s",
  (generation) => {
    expect(() => build({ ...input(), generation }, request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
  },
);
it("refuses supplied partial/altered sources, stale intent or getters without evaluating them", () => {
  const source = build(input(), request, at),
    getter = vi.fn(() => "0"),
    fields = input();
  Object.defineProperty(fields, "generation", { enumerable: true, get: getter });
  expect(() => build(fields, request, at)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  for (const changed of [
    { digest: "sha256:" + "b".repeat(64) },
    { coverage: "Partial" },
    { taxCoverage: "Complete" },
    { request: { ...request, actorReference: id(5) } },
    { observedAt: "2026-09-29T12:00:01.000Z" },
  ])
    expect(() => parse({ ...source, ...changed }, request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
  expect(() => parse(source, request, "2026-09-29T12:00:06.000Z")).toThrow();
  expect(() =>
    build({ ...input(), promotions: { ...source.promotions, coverage: "Partial" } }, request, at),
  ).toThrow();
});
it("requires full Brand/fields/both permissions and holds one source fence through all callbacks", async () => {
  const a = adapter(),
    marker = { held: true };
  await expect(
    a.store.withCurrentSnapshot(request, async (source) => {
      expect(source.generation).toBe("0");
      expect(a.authority).toHaveBeenCalledTimes(2);
      expect(
        a.query.mock.calls.some(
          ([sql]) => sql === "SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))",
        ),
      ).toBe(true);
      return marker;
    }),
  ).resolves.toBe(marker);
  expect(a.authority).toHaveBeenCalledTimes(3);
  expect(a.authority.mock.calls[0]?.[1]).toMatchObject({
    requiredScope: "Brand",
    requiredPermissions: ["pricing.price-book.manage", "pricing.promotion.manage"],
    requiredFields: configurationReferenceSourceFields,
    request,
  });
  for (const family of [a.books, a.options, a.promotions]) expect(family).toHaveBeenCalledTimes(3);
});
it.each([
  { generation: null, has_source: true },
  { generation: "-1", has_source: false },
  { generation: "0", has_source: "false" },
  { generation: "0", has_source: false, extra: 1 },
])("refuses missing/corrupt source heads before consumer %s", async (head) => {
  const a = adapter({ head }),
    work = vi.fn(async () => 1);
  await expect(a.store.withCurrentSnapshot(request, work)).rejects.toMatchObject(unavailable);
  expect(work).not.toHaveBeenCalled();
});
it("allows known empty missing head, denies wrong identity before SQL and wrong isolation", async () => {
  await expect(
    adapter({ head: { generation: null, has_source: false } }).store.withCurrentSnapshot(
      request,
      async (s) => s.generation,
    ),
  ).resolves.toBe("0");
  const a = adapter();
  await expect(
    a.store.withCurrentSnapshot({ ...request, actorReference: id(7) }, async () => 1),
  ).rejects.toMatchObject(unavailable);
  expect(a.query).not.toHaveBeenCalled();
  await expect(
    adapter({ isolation: "repeatable read" }).store.withCurrentSnapshot(request, async () => 1),
  ).rejects.toMatchObject(unavailable);
});
it("denies early/late header or family authority and failed/stale/self-changing callbacks generically", async () => {
  const early = adapter({ deny: 1 });
  await expect(early.store.withCurrentSnapshot(request, async () => 1)).rejects.toMatchObject(
    unavailable,
  );
  expect(early.query).not.toHaveBeenCalled();
  await expect(
    adapter({ deny: 3 }).store.withCurrentSnapshot(request, async () => 1),
  ).rejects.toMatchObject(unavailable);
  for (const mode of ["changed", "stale", "failed"]) {
    const a = adapter();
    await expect(
      a.store.withCurrentSnapshot(request, async () => {
        if (mode === "changed") a.setHead({ generation: "1", has_source: false });
        if (mode === "stale") a.setNow("2026-09-29T12:00:06.000Z");
        if (mode === "failed") throw new Error("opaque");
        return 1;
      }),
    ).rejects.toMatchObject(unavailable);
  }
  const late = adapter();
  late.promotions.mockImplementation(async () => {
    if (late.promotions.mock.calls.length === 3) throw new Error("opaque");
  });
  await expect(late.store.withCurrentSnapshot(request, async () => 1)).rejects.toMatchObject(
    unavailable,
  );
  const slow = adapter();
  slow.promotions.mockImplementation(async () => {
    if (slow.promotions.mock.calls.length === 3) slow.setNow("2026-09-29T12:00:06.000Z");
  });
  await expect(slow.store.withCurrentSnapshot(request, async () => 1)).rejects.toMatchObject(
    unavailable,
  );
});
it("refuses runner bypass, substitution or repetition and never repeats consumer work", async () => {
  for (const mode of ["bypass", "substitute", "repeat"]) {
    const a = adapter(),
      work = vi.fn(async () => 1);
    a.run.mockImplementationOnce(async (action) => {
      if (mode === "bypass") return undefined as never;
      await action(a.tx);
      return mode === "repeat" ? action(a.tx) : ({} as never);
    });
    await expect(a.store.withCurrentSnapshot(request, work)).rejects.toMatchObject(unavailable);
    expect(work).toHaveBeenCalledTimes(mode === "bypass" ? 0 : 1);
  }
});

it("rejects multiplied combined qualifier output even when each source profile is individually valid", () => {
  const references = Array.from({ length: 300 }, (_, n) => ({
    root: {
      promotionReference: id(1000 + n),
      brandReference: id(1),
      aggregateVersion: 1,
      currentVersionReference: id(2000 + n),
      rootCreatedAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
    },
    version: {
      versionReference: id(2000 + n),
      versionNumber: 1,
      snapshotDigest: "sha256:" + "b".repeat(64),
      lifecycle: "Draft",
      promotionType: "ItemPercentage",
      benefitScope: "Item",
      timeZone: "America/Toronto",
      effectiveFrom: "2026-08-01T00:00:00.000Z",
      effectiveUntil: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      eligibility: Array.from({ length: 50 }, (_, i) => ({
        eligibilityReference: id(10000 + n * 100 + i),
        referenceKind: "Sellable",
        publicReference: id(100 + i),
      })),
    },
    precise: true,
  }));
  const promotions = buildPromotionReferenceSourceSnapshot(
    { observedAt: at, references },
    request,
    at,
  );
  expect(promotions.versions).toHaveLength(300);
  expect(() => build({ ...input(), promotions }, request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});

it("keeps the same data fingerprint on fresh reobservation while independently validating observation time", () => {
  const first = build(input(), request, at),
    later = "2026-09-29T12:00:01.000Z",
    raw = { observedAt: later, references: [] };
  const next = build(
    {
      generation: "0",
      priceBooks: buildPriceBookReferenceSourceSnapshot(raw, request, later),
      optionPrices: buildOptionPriceReferenceSourceSnapshot(raw, request, later),
      promotions: buildPromotionReferenceSourceSnapshot(raw, request, later),
    },
    request,
    later,
  );
  expect(next.digest).toBe(first.digest);
  expect(next.observedAt).not.toBe(first.observedAt);
  expect(parse(next, request, later)).toEqual(next);
  expect(() => parse(next, request, "2026-09-29T12:00:07.000Z")).toThrow();
});

it("rejects nested request accessors and nonprimitive derived metadata without invoking caller code", () => {
  const source = build(input(), request, at),
    get = vi.fn(() => id(2)),
    rawRequest = { ...request },
    toJSON = vi.fn(() => source.profile);
  Object.defineProperty(rawRequest, "actorReference", { enumerable: true, get });
  expect(() => parse({ ...source, request: rawRequest }, request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
  expect(get).not.toHaveBeenCalled();
  expect(() => parse({ ...source, profile: { toJSON } }, request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
  expect(toJSON).not.toHaveBeenCalled();
});
