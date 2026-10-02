import { parseProductPricingBindingSourceSnapshot } from "../index.js";
import { expect, it, vi } from "vitest";
import {
  buildProductPricingBindingSourceSnapshot as build,
  createPostgresProductPricingBindingSourceStore,
  productPricingBindingSourceFields,
  productPricingBindingCurrentSourceFields,
  CatalogError,
  type ProductPricingBindingSourceAuthority,
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
const source = (overrides: Record<string, unknown> = {}) => ({
  observedAt: at,
  targetExists: true,
  precise: true,
  versionReference: id(5),
  categoryClassificationKnown: true,
  categoryReferences: [id(8)],
  primaryCategoryReference: id(8),
  taxClassificationReference: id(9),
  skuReferences: [id(6), id(7)],
  bindings: [binding()],
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
  const hold = vi.fn<ProductPricingBindingSourceAuthority["holdUntilTransactionCompletes"]>(
    async (_tx, input) => {
      if (
        options.denyCurrentFields &&
        input.requiredFields.length > productPricingBindingSourceFields.length
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
  const store = createPostgresProductPricingBindingSourceStore({
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
it("returns actual current reference facts without private labels, amounts or approval", () => {
  const result = build(source(), request, at);
  expect(result).toMatchObject({
    profile: "CurrentDraftBindings",
    coverage: "Complete",
    consistency: "StatementSnapshot",
    categoryCoverage: "Known",
    categoryReferences: [id(8)],
    taxClassificationReference: id(9),
  });
  expect(result.bindings[0]).toEqual(binding());
  expect(Object.isFrozen(result.bindings[0]?.enabledOptionReferences)).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(
    /localizedNames|createdByActor|defaultSelections|unitQuantity|amount/,
  );
});
it("preserves unavailable legacy categories distinct from explicitly empty categories", () => {
  expect(
    build(
      source({
        categoryClassificationKnown: false,
        categoryReferences: null,
        primaryCategoryReference: null,
      }),
      request,
      at,
    ),
  ).toMatchObject({ categoryCoverage: "Unavailable", categoryReferences: null });
  expect(
    build(source({ categoryReferences: [], primaryCategoryReference: null }), request, at),
  ).toMatchObject({ categoryCoverage: "Known", categoryReferences: [] });
});
it("keeps all SKU and binding qualifiers for Product or an exact existing SKU review", () => {
  const result = build(source(), { ...request, skuReference: id(7) }, at);
  expect(result.skuReferences).toEqual([id(6), id(7)]);
  expect(result.bindings[0]?.includedSkuReferences).toEqual([id(6)]);
  expect(() => build(source(), { ...request, skuReference: id(99) }, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("canonicalizes references and detects binding/classification changes under original intent", () => {
  const a = build(source(), request, at);
  expect(
    build(
      source({ skuReferences: [id(7), id(6)], observedAt: "2026-09-29T12:00:01.000Z" }),
      request,
      "2026-09-29T12:00:01.000Z",
    ).digest,
  ).toBe(a.digest);
  expect(build(source({ bindings: [] }), request, at).digest).not.toBe(a.digest);
  expect(
    build(source({ categoryReferences: [], primaryCategoryReference: null }), request, at).digest,
  ).not.toBe(a.digest);
});
it.each([
  { targetExists: false },
  { precise: false },
  { versionReference: id(99) },
  { categoryClassificationKnown: "unknown" },
  { categoryClassificationKnown: false, categoryReferences: [] },
  { primaryCategoryReference: id(99) },
  { skuReferences: [id(6), id(6)] },
  { observedAt: "2026-09-29T11:59:54.000Z" },
  { observedAt: "2026-09-29T12:00:01.000Z" },
])("rejects missing/incoherent source %s", (overrides) => {
  expect(() => build(source(overrides), request, at)).toThrow(expect.objectContaining(unavailable));
});
it.each([
  { includedSkuReferences: [id(99)] },
  { excludedSkuReferences: [id(6)] },
  { enabledOptionReferences: [id(13), id(13)] },
  { channelCodes: ["invalid"] },
  { channelCodes: ["CUSTOMER_PWA", "CUSTOMER_PWA"] },
])("rejects incoherent binding qualifiers %s", (overrides) => {
  expect(() => build(source({ bindings: [binding(overrides)] }), request, at)).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects duplicate bindings, oversized/sparse/accessor source without reading getters", () => {
  const get = vi.fn(() => true),
    raw = source();
  Object.defineProperty(raw, "targetExists", { enumerable: true, get });
  for (const data of [
    raw,
    source({ skuReferences: new Array(1) }),
    source({ skuReferences: Array.from({ length: 1001 }, (_, i) => id(100 + i)) }),
    source({ bindings: [binding(), binding()] }),
    source({
      bindings: [
        binding({ enabledOptionReferences: Array.from({ length: 1001 }, (_, i) => id(100 + i)) }),
      ],
    }),
  ])
    expect(() => build(data, request, at)).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
});
it("requires purpose/fields and current scope before/after bounded owning read", async () => {
  const a = adapter();
  await a.store.loadSnapshot(request);
  expect(a.hold).toHaveBeenCalledTimes(2);
  expect(a.hold.mock.calls[0]?.[1]).toEqual({
    tenantReference: id(20),
    actorReference: id(2),
    request,
    purposeCode: "CATALOG_LIFECYCLE_PRICING_BINDING_SOURCE_READ",
    permission: "catalog.manage",
    requiredFields: productPricingBindingSourceFields,
    observedAt: at,
  });
  const sql = a.query.mock.calls[2]?.[0];
  expect(sql).toContain("LIMIT 1001");
  expect(sql).not.toMatch(/rms_pricing|localized_names|created_by_actor|default_quantity/);
  expect(a.query.mock.calls[2]?.[1]).toEqual([id(1), id(3), id(5)]);
});
it("denies wrong caller/early permission before SQL, late permission and wrong isolation", async () => {
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
});
it("rejects callback bypass, substitution and repetition", async () => {
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

it("validates complete public snapshot and rejects altered request/coverage/digest/computed metadata", () => {
  const snapshot = build(source(), request, at);
  expect(parseProductPricingBindingSourceSnapshot(snapshot, request, at)).toEqual(snapshot);
  for (const altered of [
    { ...snapshot, coverage: "Partial" },
    { ...snapshot, digest: "sha256:" + "f".repeat(64) },
    { ...snapshot, request: { ...request, operationReference: id(99) } },
    { ...snapshot, profile: "Invented" },
  ])
    expect(() => parseProductPricingBindingSourceSnapshot(altered, request, at)).toThrow(
      expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
    );
  const get = vi.fn(() => "Complete"),
    raw = { ...snapshot };
  Object.defineProperty(raw, "coverage", { enumerable: true, get });
  expect(() => parseProductPricingBindingSourceSnapshot(raw, request, at)).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
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
        productPricingBindingCurrentSourceFields,
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
