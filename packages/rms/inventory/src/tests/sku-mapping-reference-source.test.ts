import { describe, it, expect } from "vitest";
import {
  buildInventoryConfigurationReferenceSnapshot,
  buildInventorySkuMappingReferenceSnapshot,
  parseInventorySkuMappingReferenceSnapshot,
  createPostgresInventorySkuMappingReferenceSourceStore,
  inventorySkuMappingReferenceFields,
  inventoryConfigurationReferencePermissions,
  InventoryItemError,
  type InventorySkuMappingReferenceSourceOptions,
  type InventoryConfigurationReferenceTransaction,
} from "../index.js";
const id = (n: number) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  hash = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(1),
  brandReference: id(2),
  actorReference: id(3),
  operationReference: id(4),
  catalogIntentDigest: hash,
};
const scope = { tenantReference: id(1), brandReference: id(2) };
function baseRaw() {
  return {
    generation: "14",
    observedAt: at,
    counts: { items: "3", versions: "4", operations: "4" },
    items: [6, 20, 30].map((n) => ({
      ...scope,
      itemReference: id(n),
      itemType: n === 30 ? "RawMaterial" : "FinishedGood",
      createdAt: at,
      precise: true,
    })),
    versions: [
      [6, 1],
      [6, 2],
      [20, 1],
      [30, 1],
    ].map(([n = 0, v = 0]) => ({
      ...scope,
      itemReference: id(n),
      itemVersion: String(v),
      itemType: n === 30 ? "RawMaterial" : "FinishedGood",
      lifecycle: "Inactive",
      recordedAt: at,
      precise: true,
    })),
    operations: [
      [6, 1, 7],
      [6, 2, 17],
      [20, 1, 27],
      [30, 1, 37],
    ].map(([n = 0, v = 0, o = 0]) => ({
      ...scope,
      itemReference: id(n),
      itemVersion: String(v),
      operationReference: id(o),
      action: v === 1 ? "Create" : "Update",
    })),
  };
}
function mappingRaw() {
  return {
    generation: "14",
    observedAt: at,
    count: "2",
    mappings: [1, 2].map((v) => ({
      ...scope,
      mappingReference: id(5),
      itemReference: id(6),
      mappingVersion: String(v),
      sourceItemVersion: String(v),
      sourceConfigurationOperationReference: id(v === 1 ? 7 : 17),
      action: v === 1 ? "Set" : "Clear",
      target:
        v === 1
          ? {
              productReference: id(8),
              productVersionReference: id(9),
              skuReference: id(10),
              catalogConfigurationDigest: hash,
            }
          : null,
      operationReference: id(40 + v),
      mappingIntentDigest: hash,
      occurredAt: at,
      precise: true,
    })),
  };
}
function build(raw = mappingRaw(), base = baseRaw(), now = at) {
  return buildInventorySkuMappingReferenceSnapshot(
    raw,
    buildInventoryConfigurationReferenceSnapshot(base, request, now),
    request,
    now,
  );
}
const unavailable = expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" });
function first(raw: ReturnType<typeof mappingRaw>) {
  const v = raw.mappings[0];
  if (!v) throw new Error("fixture missing");
  return v;
}
describe("complete Inventory direct mapping reference contract", () => {
  it("requires each explicit Catalog target reference in the complete read field lease", () => {
    expect(inventorySkuMappingReferenceFields).toEqual(
      expect.arrayContaining([
        "target.productReference",
        "target.productVersionReference",
        "target.skuReference",
        "target.catalogConfigurationDigest",
      ]),
    );
  });
  it("preserves history, current pointer and explicit unmapped versus never recorded", () => {
    const source = build();
    expect(source.mappings.map((v) => [v.current, v.sourceConfigurationState])).toEqual([
      [false, "Historical"],
      [true, "Current"],
    ]);
    expect(source.items.map((v) => [v.coverage, v.currentLink])).toEqual([
      ["Recorded", "ExplicitlyCleared"],
      ["NotRecorded", "Unknown"],
      ["NotApplicable", "NotApplicable"],
    ]);
    expect(source.mappings[0]?.target?.skuReference).toBe(id(10));
    expect(Object.isFrozen(source.mappings)).toBe(true);
    expect(parseInventorySkuMappingReferenceSnapshot(source, request, at)).toEqual(source);
    expect(JSON.stringify(source)).not.toMatch(
      /audit_json|snapshot_json|actor_id|cost|allergen|quantity/,
    );
  });
  it("reports complete empty Brand source before a first Item creates its header", () => {
    const base = buildInventoryConfigurationReferenceSnapshot(
      {
        generation: null,
        observedAt: at,
        counts: { items: "0", versions: "0", operations: "0" },
        items: [],
        versions: [],
        operations: [],
      },
      request,
      at,
    );
    const source = buildInventorySkuMappingReferenceSnapshot(
      { generation: null, observedAt: at, count: "0", mappings: [] },
      base,
      request,
      at,
    );
    expect(source.generation).toBe("0");
    expect(source.items).toHaveLength(0);
    expect(parseInventorySkuMappingReferenceSnapshot(source, request, at)).toEqual(source);
  });
  it("keeps stable content identity across fresh observation instants", () => {
    const raw = mappingRaw(),
      base = baseRaw();
    raw.observedAt = "2026-09-29T12:00:01.000Z";
    base.observedAt = raw.observedAt;
    expect(build(raw, base, raw.observedAt).digest).toBe(build().digest);
  });
  it("retains a current direct link pinned to earlier configuration after ordinary Item update", () => {
    const raw = mappingRaw();
    raw.mappings = raw.mappings.slice(0, 1);
    raw.count = "1";
    const source = build(raw);
    expect(source.items[0]?.currentLink).toBe("Mapped");
    expect(source.mappings[0]?.sourceConfigurationState).toBe("Historical");
  });
  it.each([
    "generation",
    "count",
    "sequence",
    "operation",
    "version",
    "parent",
    "scope",
    "type",
    "duplicateOperation",
    "identity",
    "partialTarget",
    "clearTarget",
    "future",
    "precision",
  ])("refuses incomplete or inconsistent %s evidence", (mode) => {
    const raw = mappingRaw(),
      base = baseRaw(),
      v = first(raw);
    if (mode === "generation") raw.generation = "15";
    if (mode === "count") raw.count = "1";
    if (mode === "sequence") v.mappingVersion = "3";
    if (mode === "operation") v.sourceConfigurationOperationReference = id(99);
    if (mode === "version") v.sourceItemVersion = "9";
    if (mode === "parent") v.itemReference = id(99);
    if (mode === "scope") v.tenantReference = id(99);
    if (mode === "type") v.itemReference = id(30);
    if (mode === "duplicateOperation") {
      const last = raw.mappings[1];
      if (last) last.operationReference = v.operationReference;
    }
    if (mode === "identity") {
      const last = raw.mappings[1];
      if (last) last.mappingReference = id(99);
    }
    if (mode === "partialTarget") v.target = null;
    if (mode === "clearTarget") {
      const last = raw.mappings[1];
      if (last) last.target = v.target;
    }
    if (mode === "future") v.occurredAt = "2026-09-29T12:00:00.001Z";
    if (mode === "precision") v.precise = false;
    expect(() => build(raw, base)).toThrow(unavailable);
  });
  it("refuses current one-to-one SKU collisions while permitting retained old relations", () => {
    const raw = mappingRaw(),
      v = first(raw);
    raw.mappings = raw.mappings.slice(0, 1);
    raw.mappings.push({
      ...v,
      itemReference: id(20),
      mappingReference: id(25),
      sourceConfigurationOperationReference: id(27),
      operationReference: id(42),
    });
    expect(() => build(raw)).toThrow(unavailable);
  });
  it("refuses mapping pinned to an Archived Item state", () => {
    const base = baseRaw();
    const v = base.versions[0];
    if (v) v.lifecycle = "Archived";
    expect(() => build(mappingRaw(), base)).toThrow(unavailable);
  });
  it.each(["current", "sourceConfigurationState", "digest", "coverage", "request", "items"])(
    "refuses tampered public derived %s",
    (field) => {
      const source = structuredClone(build());
      if (field === "current") Object.assign(source.mappings[0] ?? {}, { current: true });
      if (field === "sourceConfigurationState")
        Object.assign(source.mappings[0] ?? {}, { sourceConfigurationState: "Current" });
      if (field === "digest") Object.assign(source, { digest: "sha256:" + "b".repeat(64) });
      if (field === "coverage") Object.assign(source, { coverage: "CompleteAllUsage" });
      if (field === "request") Object.assign(source.request, { actorReference: id(99) });
      if (field === "items")
        Object.assign(source.items[1] ?? {}, { currentLink: "ExplicitlyCleared" });
      expect(() => parseInventorySkuMappingReferenceSnapshot(source, request, at)).toThrow(
        unavailable,
      );
    },
  );
  it("refuses accessor rows/derived values without coercing or invoking them", () => {
    const raw = mappingRaw();
    let touched = false;
    Object.defineProperty(first(raw), "target", {
      enumerable: true,
      get() {
        touched = true;
        return null;
      },
    });
    expect(() => build(raw)).toThrow(unavailable);
    expect(touched).toBe(false);
    const source = structuredClone(build());
    Object.defineProperty(source.mappings[0], "current", {
      enumerable: true,
      get() {
        touched = true;
        return true;
      },
    });
    expect(() => parseInventorySkuMappingReferenceSnapshot(source, request, at)).toThrow(
      unavailable,
    );
    expect(touched).toBe(false);
  });
  it("refuses stale and sparse evidence", () => {
    expect(() => build(mappingRaw(), baseRaw(), "2026-09-29T12:00:05.001Z")).toThrow(unavailable);
    const raw = mappingRaw();
    delete raw.mappings[0];
    expect(() => build(raw)).toThrow(unavailable);
  });
});
function holderFixture() {
  const f = {
    now: at,
    generation: "14",
    authority: 0,
    denyAt: 0,
    sql: [] as string[],
    committed: 0,
    rollbacks: 0,
  };
  const tx: InventoryConfigurationReferenceTransaction = {
    async query<T extends Record<string, unknown>>(sql: string): Promise<{ rows: readonly T[] }> {
      f.sql.push(sql);
      let rows: Record<string, unknown>[] = [];
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.includes("AS header")) rows = [{ header: { generation: f.generation } }];
      else if (sql.includes("'mappings'")) rows = [{ source: mappingRaw() }];
      else if (sql.includes("'counts'")) rows = [{ source: baseRaw() }];
      return { rows: rows as T[] };
    },
  };
  const options: InventorySkuMappingReferenceSourceOptions = {
    ...scope,
    actorReference: id(3),
    clock: { now: () => f.now },
    transactions: {
      async run(work) {
        try {
          const result = await work(tx);
          f.committed++;
          return result;
        } catch (error) {
          f.rollbacks++;
          throw error;
        }
      },
    },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        expect(input.requiredFields).toBe(inventorySkuMappingReferenceFields);
        expect(input.requiredPermissions).toBe(inventoryConfigurationReferencePermissions);
        expect(input.requiredScope).toBe("FullBrandScope");
        if (++f.authority === f.denyAt)
          throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
      },
    },
  };
  return { f, store: createPostgresInventorySkuMappingReferenceSourceStore(options) };
}
describe("mapping source extends the same physical Inventory source fence", () => {
  it("reads public minimal mapping history inside own configuration holder and preserves callback result", async () => {
    const { f, store } = holderFixture();
    const result = { accepted: true };
    expect(
      await store.withCurrentSnapshot(request, async (source) => {
        expect(source.items[1]?.currentLink).toBe("Unknown");
        return result;
      }),
    ).toBe(result);
    expect(f.authority).toBe(5);
    expect(f.committed).toBe(1);
    expect(f.sql.filter((sql) => sql.includes("pg_advisory_xact_lock_shared")).length).toBe(1);
    expect(f.sql.filter((sql) => sql.includes("'mappings'")).length).toBe(1);
  });
  it.each([1, 2, 3, 4, 5])("propagates current permission denial at lease check %s", async (n) => {
    const { f, store } = holderFixture();
    f.denyAt = n;
    await expect(store.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_PERMISSION_DENIED",
    });
    expect(f.committed).toBe(0);
    if (n === 1) expect(f.sql).toHaveLength(0);
  });
  it("refuses header mutation after callback and stale callback completion", async () => {
    const { f, store } = holderFixture();
    await expect(
      store.withCurrentSnapshot(request, async () => {
        f.generation = "15";
        return true;
      }),
    ).rejects.toThrow(unavailable);
    f.generation = "14";
    await expect(
      store.withCurrentSnapshot(request, async () => {
        f.now = "2026-09-29T12:00:05.001Z";
        return true;
      }),
    ).rejects.toThrow(unavailable);
    expect(f.committed).toBe(0);
  });
});
