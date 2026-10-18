import { describe, it, expect } from "vitest";
import {
  buildCatalogInventorySkuReferenceSnapshot,
  parseCatalogInventorySkuReferenceSnapshot,
  parseCatalogInventorySkuReferenceRequest,
  createPostgresCatalogInventorySkuReferenceSourceStore,
  catalogInventorySkuReferenceFields,
  catalogInventorySkuReferencePermissions,
  CatalogError,
  type CatalogInventorySkuReferenceOptions,
} from "../index.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ" as const,
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  operationReference: id(4),
  consumerIntentDigest: hash,
  productReference: id(5),
  productVersionReference: id(6),
  skuReference: id(7),
  expectedConfigurationDigest: null as string | null,
};
function raw() {
  return {
    brandReference: id(2),
    productReference: id(5),
    skuReference: id(7),
    sourceRevision: "10",
    productAggregateVersion: 2,
    observedAt: at,
    precise: true,
    configuration: {
      versionReference: id(6),
      skuReferences: [id(8), id(7)],
      categoryCoverage: "Known",
      categoryReferences: [id(9)],
      primaryCategoryReference: id(9),
      taxClassificationReference: null,
      bindings: [
        {
          bindingReference: id(10),
          optionSetReference: id(11),
          optionSetVersionReference: id(12),
          enabledOptionReferences: [id(13)],
          includedSkuReferences: [id(7)],
          excludedSkuReferences: [id(8)],
          channelCodes: ["CUSTOMER_PWA"],
        },
      ],
    },
  };
}
const unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  invalid = expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  denied = expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" });
describe("dedicated Catalog current SKU reference contract", () => {
  it("returns only canonical current reference configuration without inventing lifecycle intent", () => {
    const s = buildCatalogInventorySkuReferenceSnapshot(raw(), request, at);
    expect(s.configuration.skuReferences).toEqual([id(7), id(8)]);
    expect(s.configurationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(parseCatalogInventorySkuReferenceSnapshot(s, request, at)).toEqual(s);
    expect(JSON.stringify(s)).not.toMatch(
      /beforeLifecycle|targetLifecycle|quantity|localizedNames|allergen|cost|audit/,
    );
    expect(Object.isFrozen(s.configuration.bindings)).toBe(true);
  });
  it("keeps configuration identity separate from consumer operation/request and observation", () => {
    const first = buildCatalogInventorySkuReferenceSnapshot(raw(), request, at),
      r = raw();
    r.observedAt = "2026-09-29T12:00:01.000Z";
    const second = buildCatalogInventorySkuReferenceSnapshot(
      r,
      { ...request, operationReference: id(90), consumerIntentDigest: "sha256:" + "b".repeat(64) },
      r.observedAt,
    );
    expect(second.configurationDigest).toBe(first.configurationDigest);
    expect(second.digest).not.toBe(first.digest);
    expect(buildCatalogInventorySkuReferenceSnapshot(r, request, r.observedAt).digest).toBe(
      first.digest,
    );
  });
  it("accepts only the actual current canonical digest for a mapping intent", () => {
    const first = buildCatalogInventorySkuReferenceSnapshot(raw(), request, at);
    expect(
      buildCatalogInventorySkuReferenceSnapshot(
        raw(),
        { ...request, expectedConfigurationDigest: first.configurationDigest },
        at,
      ).configurationDigest,
    ).toBe(first.configurationDigest);
    expect(() =>
      buildCatalogInventorySkuReferenceSnapshot(
        raw(),
        { ...request, expectedConfigurationDigest: hash },
        at,
      ),
    ).toThrow(unavailable);
  });
  it("keeps unknown legacy classifications instead of pretending an empty set", () => {
    const r = raw();
    Object.assign(r.configuration, {
      categoryCoverage: "Unavailable",
      categoryReferences: null,
      primaryCategoryReference: null,
    });
    expect(
      buildCatalogInventorySkuReferenceSnapshot(r, request, at).configuration.categoryReferences,
    ).toBe(null);
  });
  it.each([
    "tenantReference",
    "brandReference",
    "actorReference",
    "operationReference",
    "consumerIntentDigest",
    "productReference",
    "productVersionReference",
    "skuReference",
    "purposeCode",
    "expectedConfigurationDigest",
  ])("rejects malformed request %s", (field) => {
    expect(() => parseCatalogInventorySkuReferenceRequest({ ...request, [field]: "bad" })).toThrow(
      invalid,
    );
  });
  it.each([
    "brand",
    "product",
    "sku",
    "revision",
    "version",
    "time",
    "precise",
    "missingSku",
    "duplicateSku",
    "primary",
    "unknown",
    "bindingParent",
    "bindingOverlap",
    "bindingDuplicate",
    "extra",
  ])("rejects incoherent source %s", (mode) => {
    const r = raw(),
      b = r.configuration.bindings[0];
    if (mode === "brand") r.brandReference = id(99);
    if (mode === "product") r.productReference = id(99);
    if (mode === "sku") r.skuReference = id(99);
    if (mode === "revision") r.sourceRevision = "0";
    if (mode === "version") r.productAggregateVersion = 0;
    if (mode === "time") r.observedAt = "2026-09-29T12:00:00.001Z";
    if (mode === "precise") r.precise = false;
    if (mode === "missingSku") r.configuration.skuReferences = [id(8)];
    if (mode === "duplicateSku") r.configuration.skuReferences = [id(7), id(7)];
    if (mode === "primary") r.configuration.primaryCategoryReference = id(99);
    if (mode === "unknown") r.configuration.categoryCoverage = "Unavailable";
    if (mode === "bindingParent" && b) b.includedSkuReferences = [id(99)];
    if (mode === "bindingOverlap" && b) b.excludedSkuReferences = [id(7)];
    if (mode === "bindingDuplicate" && b) r.configuration.bindings.push(b);
    if (mode === "extra") Object.assign(r, { names: { en: "unsupported" } });
    expect(() => buildCatalogInventorySkuReferenceSnapshot(r, request, at)).toThrow(unavailable);
  });
  it("refuses getters, coercion, sparse arrays and prototype-bearing input without invoking hooks", () => {
    let touched = false;
    const r = raw();
    Object.defineProperty(r.configuration, "skuReferences", {
      enumerable: true,
      get() {
        touched = true;
        return [];
      },
    });
    expect(() => buildCatalogInventorySkuReferenceSnapshot(r, request, at)).toThrow(unavailable);
    expect(touched).toBe(false);
    const sparse = raw();
    delete sparse.configuration.skuReferences[0];
    expect(() => buildCatalogInventorySkuReferenceSnapshot(sparse, request, at)).toThrow(
      unavailable,
    );
    expect(() => parseCatalogInventorySkuReferenceRequest(Object.create(request))).toThrow(invalid);
  });
  it("refuses oversize source lists and stale source proofs", () => {
    const r = raw();
    r.configuration.skuReferences = Array.from({ length: 1001 }, (_, i) => id(100 + i));
    expect(() => buildCatalogInventorySkuReferenceSnapshot(r, request, at)).toThrow(unavailable);
    expect(() =>
      buildCatalogInventorySkuReferenceSnapshot(raw(), request, "2026-09-29T12:00:05.001Z"),
    ).toThrow(unavailable);
  });
  it.each(["profile", "coverage", "applicability", "digest", "configurationDigest", "request"])(
    "refuses tampered public %s",
    (field) => {
      const s = structuredClone(buildCatalogInventorySkuReferenceSnapshot(raw(), request, at));
      if (field === "request") Object.assign(s.request, { operationReference: id(99) });
      else Object.assign(s, { [field]: "bad" });
      expect(() => parseCatalogInventorySkuReferenceSnapshot(s, request, at)).toThrow(unavailable);
    },
  );
});
function fixture() {
  const f = {
    raw: raw(),
    sql: [] as string[],
    authority: 0,
    denyAt: 0,
    now: at,
    committed: 0,
    isolation: "read committed",
    mode: "normal",
  };
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string): Promise<{ rows: readonly Row[]; rowCount: number }> {
      f.sql.push(sql);
      const rows = sql.includes("transaction_isolation")
        ? [{ isolation: f.isolation }]
        : sql.includes("JOIN rms_catalog.sku target")
          ? [{ source: f.raw }]
          : [];
      return { rows: rows as Row[], rowCount: rows.length };
    },
  };
  const options: CatalogInventorySkuReferenceOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => f.now },
    transactions: {
      async run(work) {
        if (f.mode === "skip") return undefined as Awaited<ReturnType<typeof work>>;
        const result = await work(tx);
        if (f.mode === "duplicate") await work(tx);
        if (f.mode === "foreign") return { ...result } as Awaited<ReturnType<typeof work>>;
        f.committed++;
        return result;
      },
    },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        expect(input.requiredPermissions).toBe(catalogInventorySkuReferencePermissions);
        expect(input.requiredFields).toBe(catalogInventorySkuReferenceFields);
        expect(input.requiredScope).toBe("FullBrandScope");
        if (++f.authority === f.denyAt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    },
  };
  return { f, store: createPostgresCatalogInventorySkuReferenceSourceStore(options) };
}
describe("Catalog Product fence held through caller transaction", () => {
  it("reads and rechecks current source around callback with canonical current authority", async () => {
    const { f, store } = fixture(),
      marker = { accepted: true };
    expect(await store.withCurrentSnapshot(request, async () => marker)).toBe(marker);
    expect(f.authority).toBe(3);
    expect(f.committed).toBe(1);
    expect(f.sql.findIndex((sql) => sql.includes("pg_advisory_xact_lock"))).toBeLessThan(
      f.sql.findIndex((sql) => sql.includes("JOIN rms_catalog.sku target")),
    );
    expect(f.sql.filter((sql) => sql.includes("JOIN rms_catalog.sku target"))).toHaveLength(2);
  });
  it.each([1, 2, 3])(
    "current authority check %s rejects before SQL or transaction completion",
    async (n) => {
      const { f, store } = fixture();
      f.denyAt = n;
      await expect(store.withCurrentSnapshot(request, async () => true)).rejects.toThrow(denied);
      expect(f.committed).toBe(0);
      if (n === 1) expect(f.sql).toHaveLength(0);
    },
  );
  it.each(["tenantReference", "brandReference", "actorReference"])(
    "refuses wrong %s before SQL",
    async (field) => {
      const { f, store } = fixture();
      await expect(
        store.withCurrentSnapshot({ ...request, [field]: id(99) }, async () => true),
      ).rejects.toThrow(denied);
      expect(f.sql).toHaveLength(0);
    },
  );
  it.each(["skip", "duplicate", "foreign"])(
    "refuses transaction runner %s callback/result",
    async (mode) => {
      const { f, store } = fixture();
      f.mode = mode;
      await expect(store.withCurrentSnapshot(request, async () => true)).rejects.toThrow(
        unavailable,
      );
    },
  );
  it.each(["repeatable read", "serializable"])("refuses isolation %s", async (isolation) => {
    const { f, store } = fixture();
    f.isolation = isolation;
    await expect(store.withCurrentSnapshot(request, async () => true)).rejects.toThrow(unavailable);
  });
  it.each(["head", "configuration", "version", "stale"])(
    "rejects source mutation or expiry %s after callback",
    async (mode) => {
      const { f, store } = fixture();
      await expect(
        store.withCurrentSnapshot(request, async () => {
          if (mode === "head") f.raw.sourceRevision = "11";
          if (mode === "configuration")
            Object.assign(f.raw.configuration, { taxClassificationReference: id(99) });
          if (mode === "version") f.raw.productAggregateVersion = 3;
          if (mode === "stale") f.now = "2026-09-29T12:00:05.001Z";
          return true;
        }),
      ).rejects.toThrow(unavailable);
      expect(f.committed).toBe(0);
    },
  );
});
