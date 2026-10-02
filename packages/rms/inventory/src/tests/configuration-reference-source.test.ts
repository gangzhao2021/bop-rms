import { describe, it, expect } from "vitest";
import {
  buildInventoryConfigurationReferenceSnapshot,
  parseInventoryConfigurationReferenceSnapshot,
  parseInventoryConfigurationReferenceRequest,
  createPostgresInventoryConfigurationReferenceSourceStore,
  inventoryConfigurationReferenceFields,
  inventoryConfigurationReferencePermissions,
  InventoryItemError,
} from "../index.js";
const id = (n: number) => `01902418-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(4),
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture missing");
  return value;
}
function raw() {
  const scope = { tenantReference: id(4), brandReference: id(1) };
  return {
    generation: "9" as string | null,
    observedAt: at,
    counts: { items: "2", versions: "3", operations: "3" },
    items: [10, 20].map((n) => ({
      ...scope,
      itemReference: id(n),
      itemType: n === 10 ? "FinishedGood" : "RawMaterial",
      createdAt: at,
      precise: true,
    })),
    versions: [
      [10, 1],
      [10, 2],
      [20, 1],
    ].map(([n = 0, v = 0]) => ({
      ...scope,
      itemReference: id(n),
      itemVersion: String(v),
      itemType: n === 10 ? "FinishedGood" : "RawMaterial",
      lifecycle: v === 2 ? "Archived" : "Inactive",
      recordedAt: at,
      precise: true,
    })),
    operations: [
      [10, 1, 31],
      [10, 2, 32],
      [20, 1, 33],
    ].map(([n = 0, v = 0, o = 0]) => ({
      ...scope,
      itemReference: id(n),
      itemVersion: String(v),
      operationReference: id(o),
      action: v === 1 ? "Create" : "Archive",
    })),
  };
}
const denied = expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" });
describe("complete owning Inventory configuration references", () => {
  it("binds configuration operation UUID to numeric Item version, retains history and explicit unknown SKU mapping", () => {
    const s = buildInventoryConfigurationReferenceSnapshot(raw(), request, at);
    expect(s.sourceVersionKind).toBe("InventoryItemConfigurationOperation");
    expect(s.items[0]?.currentItemVersion).toBe(2);
    expect(s.items[0]?.currentOperationReference).toBe(id(32));
    expect(s.versions.map((v) => v.lifecycle)).toEqual(["Inactive", "Archived", "Inactive"]);
    expect(s.operations[0]?.itemVersion).toBe(1);
    expect(s.directSkuMappingCoverage).toBe("Unavailable");
    expect(s.applicability).toBe("Unavailable");
    expect(Object.isFrozen(s.operations[0])).toBe(true);
    expect(parseInventoryConfigurationReferenceSnapshot(s, request, at)).toEqual(s);
  });
  it("stable digest sorts independently from observation", () => {
    const r = raw(),
      s = buildInventoryConfigurationReferenceSnapshot(r, request, at);
    r.operations.reverse();
    r.versions.reverse();
    r.observedAt = "2026-09-29T12:00:01.000Z";
    expect(buildInventoryConfigurationReferenceSnapshot(r, request, r.observedAt).digest).toBe(
      s.digest,
    );
  });
  it("accepts truly empty scope, refuses missing header with existing roots", () => {
    const e = {
      generation: null,
      observedAt: at,
      counts: { items: "0", versions: "0", operations: "0" },
      items: [],
      versions: [],
      operations: [],
    };
    expect(buildInventoryConfigurationReferenceSnapshot(e, request, at).generation).toBe("0");
    expect(() =>
      buildInventoryConfigurationReferenceSnapshot({ ...raw(), generation: null }, request, at),
    ).toThrow(denied);
  });
  it.each([
    "count",
    "headerOverflow",
    "tenant",
    "brand",
    "duplicateRoot",
    "rootWithoutVersions",
    "versionParent",
    "versionDuplicate",
    "versionGap",
    "fixedType",
    "lifecycle",
    "versionTime",
    "versionUnsafe",
    "versionFormat",
    "operationParent",
    "operationVersion",
    "operationDuplicate",
    "operationIdDuplicate",
    "missingOperation",
    "createAction",
    "precision",
    "extra",
  ])("refuses partial/incoherent %s", (kind) => {
    const r = raw(),
      root = required(r.items[0]),
      v = required(r.versions[0]),
      second = required(r.versions[1]),
      op = required(r.operations[0]);
    if (kind === "count") r.counts.items = "3";
    if (kind === "headerOverflow") r.generation = "9223372036854775808";
    if (kind === "tenant") root.tenantReference = id(99);
    if (kind === "brand") v.brandReference = id(99);
    if (kind === "duplicateRoot") r.items[1] = root;
    if (kind === "rootWithoutVersions") root.itemReference = id(90);
    if (kind === "versionParent") v.itemReference = id(99);
    if (kind === "versionDuplicate") r.versions[1] = v;
    if (kind === "versionGap") second.itemVersion = "3";
    if (kind === "fixedType") second.itemType = "RawMaterial";
    if (kind === "lifecycle") v.lifecycle = "Unavailable";
    if (kind === "versionTime") v.recordedAt = "2026-02-30T00:00:00.000Z";
    if (kind === "versionUnsafe") v.itemVersion = "9007199254740992";
    if (kind === "versionFormat") v.itemVersion = "01";
    if (kind === "operationParent") op.itemReference = id(99);
    if (kind === "operationVersion") op.itemVersion = "3";
    if (kind === "operationDuplicate") r.operations[1] = op;
    if (kind === "operationIdDuplicate")
      required(r.operations[1]).operationReference = op.operationReference;
    if (kind === "missingOperation") {
      r.operations.pop();
      r.counts.operations = "2";
    }
    if (kind === "createAction") op.action = "Update";
    if (kind === "precision") v.precise = false;
    if (kind === "extra") Object.assign(op, { auditPayload: {} });
    expect(() => buildInventoryConfigurationReferenceSnapshot(r, request, at)).toThrow(denied);
  });
  it("refuses getter execution, added purpose fields, forged current pointers/digest/intent and stale/budget overflow", () => {
    let calls = 0;
    const r = raw();
    Object.defineProperty(r, "generation", {
      enumerable: true,
      get() {
        calls++;
        return "9";
      },
    });
    expect(() => buildInventoryConfigurationReferenceSnapshot(r, request, at)).toThrow(denied);
    expect(calls).toBe(0);
    expect(() => parseInventoryConfigurationReferenceRequest({ ...request, cost: "1" })).toThrow(
      denied,
    );
    const s = buildInventoryConfigurationReferenceSnapshot(raw(), request, at);
    expect(() =>
      parseInventoryConfigurationReferenceSnapshot(
        { ...s, items: s.items.map((i) => ({ ...i, currentOperationReference: id(99) })) },
        request,
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      parseInventoryConfigurationReferenceSnapshot(
        s,
        { ...request, operationReference: id(98) },
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      parseInventoryConfigurationReferenceSnapshot(
        { ...s, digest: "sha256:" + "b".repeat(64) },
        request,
        at,
      ),
    ).toThrow(denied);
    expect(() =>
      buildInventoryConfigurationReferenceSnapshot(raw(), request, "2026-09-29T12:00:05.001Z"),
    ).toThrow(denied);
    const full = raw();
    full.items = Array.from({ length: 10000 }, (_, n) => ({
      ...required(full.items[0]),
      itemReference: id(100 + n),
    }));
    full.counts.items = "10000";
    expect(() => buildInventoryConfigurationReferenceSnapshot(full, request, at)).toThrow(denied);
  });
});
function holder() {
  let generation = "9",
    now = at,
    allow = true;
  const sql: string[] = [],
    events: string[] = [];
  const tx = {
    async query<T extends Record<string, unknown>>(q: string, values: readonly unknown[]) {
      void values;
      sql.push(q);
      let rows: Record<string, unknown>[] = [];
      if (q.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      if (q.startsWith("SELECT jsonb_build_object(")) rows = [{ source: raw() }];
      if (q.includes(" AS header")) rows = [{ header: { generation } }];
      return { rows: rows as T[] };
    },
  };
  const options = {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(2),
    transactions: {
      async run<T>(work: (actual: typeof tx) => Promise<T>) {
        const result = await work(tx);
        events.push("commit");
        return result;
      },
    },
    clock: { now: () => now },
    authority: {
      async holdUntilTransactionCompletes(actual: typeof tx, input: unknown) {
        expect(actual).toBe(tx);
        expect(input).toMatchObject({
          request,
          requiredPermissions: inventoryConfigurationReferencePermissions,
          requiredScope: "FullBrandScope",
          requiredFields: inventoryConfigurationReferenceFields,
        });
        events.push("authorize");
        if (!allow) throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
      },
    },
  };
  return {
    options,
    tx,
    source: createPostgresInventoryConfigurationReferenceSourceStore(options),
    sql,
    events,
    mutate: () => {
      generation = "10";
    },
    stale: () => {
      now = "2026-09-29T12:00:05.001Z";
    },
    deny: () => {
      allow = false;
    },
  };
}
describe("same caller UoW Inventory source lifetime", () => {
  it("holds exact current field authority and shared fence until consumer return and outer commit", async () => {
    const h = holder(),
      marker = { done: true };
    expect(
      await h.source.withCurrentSnapshot(request, async (source) => {
        expect(source.items).toHaveLength(2);
        h.events.push("consumer");
        return marker;
      }),
    ).toBe(marker);
    expect(h.events).toEqual(["authorize", "authorize", "consumer", "authorize", "commit"]);
    expect(h.sql.some((q) => q.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  });
  it.each(["mutation", "stale", "permission"])(
    "denies late %s before outer completion",
    async (kind) => {
      const h = holder();
      await expect(
        h.source.withCurrentSnapshot(request, async () => {
          h.events.push("consumer");
          if (kind === "mutation") h.mutate();
          if (kind === "stale") h.stale();
          if (kind === "permission") h.deny();
          return true;
        }),
      ).rejects.toMatchObject({
        code:
          kind === "permission"
            ? "INVENTORY_ITEM_PERMISSION_DENIED"
            : "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
      });
      expect(h.events).toContain("consumer");
      expect(h.events).not.toContain("commit");
    },
  );
  it.each(["substituted", "repeated", "isolation"])("refuses %s runner evidence", async (kind) => {
    const h = holder();
    const source = createPostgresInventoryConfigurationReferenceSourceStore({
      ...h.options,
      transactions: {
        async run<T>(work: (actual: typeof h.tx) => Promise<T>): Promise<T> {
          if (kind === "isolation")
            return work({
              query: async <T extends Record<string, unknown>>(q: string, v: readonly unknown[]) =>
                q.includes("transaction_isolation")
                  ? { rows: [{ isolation: "repeatable read" }] as unknown as T[] }
                  : h.tx.query<T>(q, v),
            });
          const selected = await work(h.tx);
          if (kind === "repeated") return work(h.tx);
          void selected;
          return {} as T;
        },
      },
    });
    await expect(source.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
    });
  });
  it("denies foreign request and current permission before source SQL", async () => {
    const h = holder();
    await expect(
      h.source.withCurrentSnapshot({ ...request, brandReference: id(99) }, async () => true),
    ).rejects.toMatchObject({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" });
    expect(h.sql).toEqual([]);
    h.deny();
    await expect(h.source.withCurrentSnapshot(request, async () => true)).rejects.toMatchObject({
      code: "INVENTORY_ITEM_PERMISSION_DENIED",
    });
    expect(h.sql).toEqual([]);
  });
});
