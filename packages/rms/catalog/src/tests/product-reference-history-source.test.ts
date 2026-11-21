import { expect, it, vi } from "vitest";
import {
  buildProductReferenceHistorySourceSnapshot as build,
  buildProductPricingBindingSourceSnapshot,
  parseProductCurrentReferenceHistoryPair,
  parseProductReferenceHistorySourceSnapshot as parse,
  createPostgresProductReferenceHistorySourceStore,
  productReferenceHistorySourceFields,
  productReferenceHistoryCurrentSourceFields,
  CatalogError,
  type ProductReferenceHistorySourceAuthority,
  type ProductLifecycleTransaction,
} from "../index.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_REVIEW" as const,
  brandReference: id(1),
  actorReference: id(2),
  productReference: id(3),
  skuReference: null,
  operationReference: id(4),
  expectedAggregateVersion: 1,
  originalProductVersionReference: id(5),
  beforeLifecycle: "Draft" as const,
  targetLifecycle: "Archived" as const,
  reasonCode: "REVIEW",
  activeSkuCount: 0,
};
const unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
const binding = (overrides: Record<string, unknown> = {}) => ({
  bindingReference: id(10),
  optionSetReference: id(11),
  optionSetVersionReference: id(12),
  enabledOptionReferences: [id(13)],
  includedSkuReferences: [id(6)],
  excludedSkuReferences: [id(7)],
  channelCodes: ["CUSTOMER_PWA"],
  ...overrides,
});
const configuration = (overrides: Record<string, unknown> = {}) => ({
  versionReference: id(5),
  categoryClassificationKnown: true,
  categoryReferences: [id(8)],
  primaryCategoryReference: id(8),
  taxClassificationReference: id(9),
  skuReferences: [id(6), id(7)],
  bindings: [binding()],
  ...overrides,
});
const source = (overrides: Record<string, unknown> = {}) => ({
  observedAt: at,
  targetExists: true,
  recordedAggregateVersion: 1,
  recordCoverage: true,
  configurations: [configuration()],
  ...overrides,
});
function adapter(
  options: {
    deniedAt?: number;
    denyCurrentFields?: boolean;
    isolation?: string;
    payload?: unknown;
    target?: unknown;
    now?: () => string;
  } = {},
) {
  const hold = vi.fn<ProductReferenceHistorySourceAuthority["holdUntilTransactionCompletes"]>(
    async (_tx, input) => {
      if (
        options.denyCurrentFields &&
        input.requiredFields.length > productReferenceHistorySourceFields.length
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      if (hold.mock.calls.length === options.deniedAt)
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  );
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return sql.includes("transaction_isolation")
      ? { rows: [{ isolation: options.isolation ?? "read committed" }] }
      : sql.includes("set_config") || sql.includes("pg_advisory_xact_lock")
        ? { rows: [] }
        : sql.startsWith("SELECT p.aggregate_version::text revision")
          ? { rows: [options.target ?? { revision: "1", intent_matches: true }] }
          : { rows: [{ source: options.payload ?? source() }] };
  });
  const tx: ProductLifecycleTransaction = { query: query as ProductLifecycleTransaction["query"] };
  const run = vi.fn(async <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => work(tx));
  const store = createPostgresProductReferenceHistorySourceStore({
    tenantReference: id(20),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      async run<T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) {
        return (await run(work)) as T;
      },
    },
    authority: { holdUntilTransactionCompletes: hold },
    clock: { now: options.now ?? (() => at) },
  });
  return { store, hold, query, run };
}
it("preserves recorded configurations without inferring published or future coverage", () => {
  const result = build(source(), request, at);
  expect(result).toMatchObject({
    profile: "RecordedDraftConfigurations",
    coverage: "Complete",
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
    consistency: "StatementSnapshot",
    recordedAggregateVersion: 1,
  });
  expect(result.configurations[0]).toMatchObject({
    categoryCoverage: "Known",
    categoryReferences: [id(8)],
    taxClassificationReference: id(9),
    bindings: [binding()],
  });
  expect(Object.isFrozen(result.configurations[0]?.bindings)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /localizedNames|createdByActor|quantity|amount|snapshot_json/,
  );
});
it("deduplicates lifecycle-equivalent history while retaining changed references", () => {
  const original = build(source(), request, at);
  const repeated = build(
    source({
      recordedAggregateVersion: 4,
      configurations: [configuration(), configuration(), configuration()],
    }),
    request,
    at,
  );
  expect(repeated.configurations).toHaveLength(1);
  expect(repeated.digest).toBe(original.digest);
  const changed = build(
    source({
      recordedAggregateVersion: 2,
      configurations: [
        configuration(),
        configuration({ categoryReferences: [], primaryCategoryReference: null, bindings: [] }),
      ],
    }),
    request,
    at,
  );
  expect(changed.configurations).toHaveLength(2);
  expect(changed.digest).not.toBe(original.digest);
  expect(
    build(
      source({
        recordedAggregateVersion: 2,
        configurations: [
          configuration({ categoryReferences: [], primaryCategoryReference: null, bindings: [] }),
          configuration(),
        ],
      }),
      request,
      at,
    ).digest,
  ).toBe(changed.digest);
});
it("retains legacy unknown separately from known empty classification and historical SKU membership", () => {
  const result = build(
    source({
      recordedAggregateVersion: 3,
      configurations: [
        configuration({
          categoryClassificationKnown: false,
          categoryReferences: null,
          primaryCategoryReference: null,
        }),
        configuration({
          versionReference: id(15),
          skuReferences: [id(7)],
          bindings: [],
          categoryReferences: [],
          primaryCategoryReference: null,
        }),
      ],
    }),
    { ...request, skuReference: id(6) },
    at,
  );
  expect(
    result.configurations.some(
      (c) => c.categoryCoverage === "Unavailable" && c.categoryReferences === null,
    ),
  ).toBe(true);
  expect(
    result.configurations.some(
      (c) => c.categoryCoverage === "Known" && c.categoryReferences?.length === 0,
    ),
  ).toBe(true);
  expect(result.configurations.some((c) => c.skuReferences.includes(id(6)))).toBe(true);
  expect(() => build(source(), { ...request, skuReference: id(99) }, at)).toThrow(
    expect.objectContaining(unavailable),
  );
  expect(() =>
    build(source(), { ...request, originalProductVersionReference: id(99) }, at),
  ).toThrow(expect.objectContaining(unavailable));
});
it.each([
  { targetExists: false },
  { recordCoverage: false },
  { recordCoverage: null },
  { recordedAggregateVersion: 0 },
  { recordedAggregateVersion: 1.5 },
  { recordedAggregateVersion: 2147483648 },
  { configurations: [] },
  { configurations: new Array(1) },
  { configurations: Array.from({ length: 1001 }, () => configuration()) },
  { observedAt: "2026-09-29T11:59:54.000Z" },
  { observedAt: "2026-09-29T12:00:01.000Z" },
])("rejects incomplete, oversized or stale recorded coverage %s", (overrides) => {
  expect(() => build(source(overrides), request, at)).toThrow(expect.objectContaining(unavailable));
});
it.each([
  { categoryClassificationKnown: false, categoryReferences: [] },
  { primaryCategoryReference: id(99) },
  { skuReferences: [id(6), id(6)] },
  { bindings: [binding({ includedSkuReferences: [id(99)] })] },
  { bindings: [binding({ excludedSkuReferences: [id(6)] })] },
  { bindings: [binding({ channelCodes: ["web"] })] },
  { bindings: [binding(), binding()] },
  { taxClassificationReference: "invalid" },
])("rejects corrupted reference graphs instead of empty history %s", (overrides) => {
  expect(() => build(source({ configurations: [configuration(overrides)] }), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects unknown fields and accessor graphs without evaluating them", () => {
  const get = vi.fn(() => []),
    graph = configuration();
  Object.defineProperty(graph, "bindings", { enumerable: true, get });
  for (const raw of [
    source({ configurations: [graph] }),
    source({ permission: true }),
    source({ configurations: [configuration({ localizedNames: { "en-CA": "private" } })] }),
  ])
    expect(() => build(raw, request, at)).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
});
it("requires history fine action, purpose, fields and scope around exact three-table owner read", async () => {
  const a = adapter();
  await a.store.loadSnapshot(request);
  expect(a.hold).toHaveBeenCalledTimes(2);
  expect(a.hold.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(20),
    actorReference: id(2),
    request,
    purposeCode: "CATALOG_LIFECYCLE_REFERENCE_HISTORY_READ",
    permission: "catalog.manage",
    owningAction: "catalog.product.history.read",
    requiredFields: productReferenceHistorySourceFields,
    observedAt: at,
  });
  const sql = a.query.mock.calls[2]?.[0];
  expect(sql).toContain("LIMIT 1001");
  expect(sql).toContain("bool_and(coherent IS TRUE)");
  expect(sql).toContain("count(*)=p.aggregate_version");
  expect(sql).toContain("rms_catalog.product_operation_snapshot");
  expect(sql).toContain("rms_catalog.product_operation_record");
  expect(sql).not.toMatch(
    /rms_pricing|rms_inventory|bop_publishing|localized_names|created_by_actor|default_quantity/,
  );
  expect(a.query.mock.calls[2]?.[1]).toEqual([id(1), id(3)]);
});
it("denies caller mismatch and early/late authority, wrong isolation and corrupt coverage", async () => {
  const a = adapter();
  await expect(a.store.loadSnapshot({ ...request, actorReference: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(a.run).not.toHaveBeenCalled();
  const b = adapter({ deniedAt: 1 });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(b.query).not.toHaveBeenCalled();
  await expect(adapter({ deniedAt: 2 }).store.loadSnapshot(request)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  await expect(
    adapter({ isolation: "repeatable read" }).store.loadSnapshot(request),
  ).rejects.toMatchObject(unavailable);
  await expect(
    adapter({ payload: source({ recordCoverage: false }) }).store.loadSnapshot(request),
  ).rejects.toMatchObject(unavailable);
});
it("rejects skipped, substituted or repeated transaction callbacks", async () => {
  const a = adapter();
  a.run.mockImplementationOnce(async () => undefined as never);
  await expect(a.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const b = adapter();
  b.run.mockImplementationOnce(async (work) => {
    await work({ query: b.query as ProductLifecycleTransaction["query"] });
    return {} as never;
  });
  await expect(b.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
  const c = adapter();
  c.run.mockImplementationOnce(async (work) => {
    await work({ query: c.query as ProductLifecycleTransaction["query"] });
    return work({ query: c.query as ProductLifecycleTransaction["query"] });
  });
  await expect(c.store.loadSnapshot(request)).rejects.toMatchObject(unavailable);
});

it("validates the closed public profile under exact original intent", () => {
  const snapshot = build(
    source({
      recordedAggregateVersion: 2,
      configurations: [configuration(), configuration({ bindings: [] })],
    }),
    request,
    at,
  );
  expect(parse(snapshot, request, at)).toEqual(snapshot);
  for (const changes of [
    { profile: "CurrentDraftBindings" },
    { coverage: "Partial" },
    { publicationCoverage: "Complete" },
    { futureScheduleCoverage: "Complete" },
    { digest: "sha256:" + "f".repeat(64) },
    { request: { ...request, reasonCode: "CHANGED" } },
    { configurations: snapshot.configurations.slice(0, 1) },
  ])
    expect(() => parse({ ...snapshot, ...changes }, request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
  expect(() => parse(snapshot, { ...request, operationReference: id(99) }, at)).toThrow(
    expect.objectContaining(unavailable),
  );
  expect(() => parse(snapshot, request, "2026-09-29T12:00:06.000Z")).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects altered computed category coverage and public accessor graphs without evaluating getters", () => {
  const snapshot = build(source(), request, at),
    c = snapshot.configurations[0];
  if (!c) throw new Error("missing synthetic history fixture");
  expect(() =>
    parse({ ...snapshot, configurations: [{ ...c, categoryCoverage: "Unknown" }] }, request, at),
  ).toThrow(expect.objectContaining(unavailable));
  const get = vi.fn(() => []),
    raw = { ...snapshot };
  Object.defineProperty(raw, "configurations", { enumerable: true, get });
  expect(() => parse(raw, request, at)).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
});

it("holds the existing exclusive owner barrier before consumer work and authority through its end", async () => {
  const a = adapter(),
    value = Object.freeze({ answer: 7 });
  await expect(
    a.store.withCurrentSnapshot(request, async (snapshot) => {
      expect(snapshot.consistency).toBe("StatementSnapshot");
      expect(a.hold).toHaveBeenCalledTimes(2);
      expect(a.hold.mock.calls[0]?.[1].requiredFields).toBe(
        productReferenceHistoryCurrentSourceFields,
      );
      const queries = a.query.mock.calls;
      expect(queries[2]?.[0]).toBe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))");
      expect(queries[2]?.[1]).toEqual(["CatalogProductSource:" + id(1)]);
      expect(queries[3]?.[1]).toEqual([id(1), id(3), id(5), null, "Draft", 0]);
      expect(queries[4]?.[0]).toContain("jsonb_build_object");
      return value;
    }),
  ).resolves.toBe(value);
  expect(a.hold).toHaveBeenCalledTimes(3);
});
it.each([
  { revision: "2", intent_matches: true },
  { revision: "1", intent_matches: false },
  { revision: 1, intent_matches: true },
  { revision: "1", intent_matches: true, extra: true },
])("rejects changed or incomplete original target before the held consumer %s", async (target) => {
  const work = vi.fn(async () => "unused"),
    a = adapter({ target });
  await expect(a.store.withCurrentSnapshot(request, work)).rejects.toMatchObject(unavailable);
  expect(work).not.toHaveBeenCalled();
});
it("denies before barrier acquisition or after consumer authority revocation, preserving typed denial", async () => {
  const work = vi.fn(async () => "result"),
    early = adapter({ deniedAt: 1 });
  await expect(early.store.withCurrentSnapshot(request, work)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(early.query).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
  const late = adapter({ deniedAt: 3 });
  await expect(late.store.withCurrentSnapshot(request, work)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(work).toHaveBeenCalledTimes(1);
});
it("aborts stale or failed callbacks inside the owning transaction and refuses runner replay/substitution", async () => {
  let clock = at;
  const a = adapter({ now: () => clock });
  await expect(
    a.store.withCurrentSnapshot(request, async () => {
      clock = "2026-09-29T12:00:06.000Z";
      return "too late";
    }),
  ).rejects.toMatchObject(unavailable);
  const b = adapter();
  await expect(
    b.store.withCurrentSnapshot(request, async () => {
      throw new Error("opaque");
    }),
  ).rejects.toMatchObject(unavailable);
  expect(b.hold).toHaveBeenCalledTimes(2);
  for (const replay of [false, true]) {
    const c = adapter(),
      work = vi.fn(async () => 1);
    c.run.mockImplementationOnce(async (action) => {
      await action({ query: c.query as ProductLifecycleTransaction["query"] });
      return replay
        ? action({ query: c.query as ProductLifecycleTransaction["query"] })
        : ({} as never);
    });
    await expect(c.store.withCurrentSnapshot(request, work)).rejects.toMatchObject(unavailable);
    expect(work).toHaveBeenCalledTimes(1);
  }
});

it("requires held target field authority independently of permitted statement reference fields", async () => {
  const a = adapter({ denyCurrentFields: true }),
    work = vi.fn(async () => 1);
  await expect(a.store.loadSnapshot(request)).resolves.toBeDefined();
  a.query.mockClear();
  await expect(a.store.withCurrentSnapshot(request, work)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(work).not.toHaveBeenCalled();
  expect(a.query).not.toHaveBeenCalled();
});

function currentPairInput(overrides: Record<string, unknown> = {}) {
  return buildProductPricingBindingSourceSnapshot(
    { observedAt: at, targetExists: true, precise: true, ...configuration(), ...overrides },
    request,
    at,
  );
}
it("correlates current graph to the exact recorded owner revision without resolving unknown facts", () => {
  const current = currentPairInput(),
    recorded = build(source(), request, at);
  expect(parseProductCurrentReferenceHistoryPair(current, recorded, request, at)).toEqual({
    current,
    recorded,
  });
  const unknown = {
    categoryClassificationKnown: false,
    categoryReferences: null,
    primaryCategoryReference: null,
    taxClassificationReference: null,
  };
  const pair = parseProductCurrentReferenceHistoryPair(
    currentPairInput(unknown),
    build(source({ configurations: [configuration(unknown)] }), request, at),
    request,
    at,
  );
  expect(pair.current.categoryCoverage).toBe("Unavailable");
  expect(pair.recorded.configurations[0]?.taxClassificationReference).toBeNull();
});
it("rejects individually coherent but different root revisions or current graph missing from recorded history", () => {
  const current = currentPairInput();
  for (const recorded of [
    build(source({ recordedAggregateVersion: 2 }), request, at),
    build(source({ configurations: [configuration({ bindings: [] })] }), request, at),
  ])
    expect(() => parseProductCurrentReferenceHistoryPair(current, recorded, request, at)).toThrow(
      expect.objectContaining(unavailable),
    );
  expect(() =>
    parseProductCurrentReferenceHistoryPair(
      current,
      build(source(), request, at),
      { ...request, reasonCode: "CHANGED" },
      at,
    ),
  ).toThrow();
});
