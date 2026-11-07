import { describe, it, expect } from "vitest";
import {
  createPostgresInventorySkuMappingStore,
  inventorySkuMappingIntentDigest,
  inventorySkuMappingWriteFields,
  inventorySkuMappingWritePermissions,
  planInventorySkuMapping,
  InventoryItemError,
  type InventorySkuMappingCommand,
  type InventorySkuMappingCurrentItem,
  type InventorySkuMappingHeldSku,
  type InventorySkuMappingVersion,
  type InventorySkuMappingStoreOptions,
  type InventoryConfigurationReferenceTransaction,
} from "../index.js";
const id = (n: number) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
function command(): InventorySkuMappingCommand {
  return {
    purpose: "InventorySkuMappingManagement",
    permission: "inventory.item.update",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    operationReference: id(4),
    occurredAt: at,
    mappingReference: id(5),
    itemReference: id(6),
    expectedMappingVersion: 0,
    expectedItemVersion: 2,
    configurationOperationReference: id(7),
    action: "Set",
    target: {
      productReference: id(8),
      productVersionReference: id(9),
      skuReference: id(10),
      catalogConfigurationDigest: "sha256:" + "a".repeat(64),
    },
    reasonCode: "LINK_FINISHED_GOOD",
  };
}
function current(): InventorySkuMappingCurrentItem {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    itemReference: id(6),
    itemType: "FinishedGood",
    lifecycle: "Inactive",
    itemVersion: 2,
    configurationOperationReference: id(7),
    recordedAt: at,
    coverage: "CurrentConfiguration",
    observedAt: at,
  };
}
function sku(c = command()): InventorySkuMappingHeldSku {
  if (!c.target) throw new Error("fixture missing target");
  return {
    tenantReference: c.tenantReference,
    brandReference: c.brandReference,
    actorReference: c.actorReference,
    operationReference: c.operationReference,
    mappingIntentDigest: inventorySkuMappingIntentDigest(c),
    ...c.target,
    coverage: "HeldCurrentSku",
    observedAt: at,
  };
}
function audit(v: InventorySkuMappingVersion) {
  return {
    auditId: id(50 + v.mappingVersion),
    brandId: v.brandReference,
    actor: { type: "User" as const, reference: v.actorReference },
    actionCode: "INVENTORY_SKU_MAPPING_" + v.action.toUpperCase(),
    targetType: "InventorySkuMapping",
    targetId: v.mappingReference,
    reasonCode: v.reasonCode,
    correlationId: v.operationReference,
    occurredAt: v.occurredAt,
    sourceChannel: "API",
    dataClassification: "Internal" as const,
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  };
}
function fixture() {
  const f = {
    now: at,
    item: current(),
    precise: true,
    conflict: false,
    isolation: "read committed",
    records: [] as InventorySkuMappingVersion[],
    sql: [] as string[],
    trace: [] as string[],
    authorityCalls: 0,
    denyAt: 0,
    catalogCalls: 0,
    auditWrites: 0,
    committed: 0,
    rollbacks: 0,
    catalogAfter: () => {
      /* no later source mutation by default */
    },
    beforeFence: () => {
      /* no overlapping retry by default */
    },
    queryOverride: undefined as ((sql: string) => unknown) | undefined,
    source: undefined as InventorySkuMappingHeldSku | undefined,
    catalogMode: "normal",
    runnerMode: "normal",
    auditMode: "normal",
  };
  const tx: InventoryConfigurationReferenceTransaction = {
    async query<T extends Record<string, unknown>>(
      sql: string,
      values: readonly unknown[],
    ): Promise<{ rows: readonly T[] }> {
      f.sql.push(sql);
      let rows: Record<string, unknown>[] = [];
      const override = f.queryOverride?.(sql);
      if (override !== undefined) return override as { rows: readonly T[] };
      if (sql.includes("transaction_isolation")) rows = [{ isolation: f.isolation }];
      else if (sql.includes("pg_advisory_xact_lock(")) {
        f.trace.push("InventoryFence");
        f.beforeFence();
      } else if (sql.includes("AS conflict")) rows = [{ conflict: f.conflict }];
      else if (sql.includes("FOR KEY SHARE")) {
        f.trace.push("ItemKeyShare");
        rows = [{ item: id(6) }];
      } else if (sql.includes("FROM rms_inventory.item_sku_mapping_version WHERE tenant_id=$1")) {
        const selected = sql.includes("AND operation_id=$3")
          ? f.records.find((v) => v.operationReference === values[2])
          : f.records.filter((v) => v.itemReference === values[2]).at(-1);
        if (selected) rows = [{ record: selected, audit: audit(selected) }];
      } else if (sql.includes("FROM rms_inventory.inventory_item i"))
        rows = [{ source: f.item, precise: f.precise }];
      else if (sql.startsWith("SELECT\n  next_sequence"))
        rows = [
          {
            next_sequence: String(f.auditWrites + 1),
            previous_hash: f.auditWrites === 0 ? null : "b".repeat(64),
            recorded_at: at,
          },
        ];
      else if (sql.startsWith("INSERT INTO platform_audit.audit_record")) {
        f.trace.push("Audit");
        f.auditWrites++;
      } else if (sql.startsWith("UPDATE platform_audit.audit_chain_head"))
        rows = [{ next_sequence: String(f.auditWrites + 1) }];
      else if (sql.startsWith("INSERT INTO rms_inventory.item_sku_mapping_version")) {
        f.trace.push("Mapping");
        const [
          tenantReference,
          brandReference,
          itemReference,
          mappingReference,
          mappingVersion,
          sourceItemVersion,
          sourceConfigurationOperationReference,
          action,
          productReference,
          productVersionReference,
          skuReference,
          catalogConfigurationDigest,
          operationReference,
          mappingIntentDigest,
          actorReference,
          occurredAt,
          reasonCode,
        ] = values;
        f.records.push({
          tenantReference,
          brandReference,
          itemReference,
          mappingReference,
          mappingVersion,
          sourceItemVersion,
          sourceConfigurationOperationReference,
          action,
          target:
            action === "Clear"
              ? null
              : {
                  productReference,
                  productVersionReference,
                  skuReference,
                  catalogConfigurationDigest,
                },
          operationReference,
          mappingIntentDigest,
          actorReference,
          occurredAt,
          reasonCode,
        } as InventorySkuMappingVersion);
        rows = [{ version: mappingVersion }];
      }
      return { rows: rows as T[] };
    },
  };
  const options: InventorySkuMappingStoreOptions = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => f.now },
    transactions: {
      async run(work) {
        const before = [...f.records],
          audits = f.auditWrites;
        try {
          if (f.runnerMode === "skip") return undefined as Awaited<ReturnType<typeof work>>;
          const result = await work(tx);
          if (f.runnerMode === "duplicate") await work(tx);
          if (f.runnerMode === "foreign") return { ...result } as Awaited<ReturnType<typeof work>>;
          f.committed++;
          return result;
        } catch (error) {
          f.records = before;
          f.auditWrites = audits;
          f.rollbacks++;
          throw error;
        }
      },
    },
    authority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        expect(input.requiredPermissions).toBe(inventorySkuMappingWritePermissions);
        expect(input.requiredFields).toBe(inventorySkuMappingWriteFields);
        expect(input.requiredScope).toBe("FullBrandScope");
        expect(input.command.actorReference).toBe(id(3));
        if (++f.authorityCalls === f.denyAt)
          throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
      },
    },
    catalog: {
      async withHeldCurrentSku(actual, input, work) {
        expect(actual).toBe(tx);
        expect(input.mappingIntentDigest).toBe(inventorySkuMappingIntentDigest(input.command));
        f.catalogCalls++;
        f.trace.push("CatalogFence");
        if (f.catalogMode === "skip") return undefined as Awaited<ReturnType<typeof work>>;
        const result = await work(f.source ?? sku(input.command));
        if (f.catalogMode === "duplicate") await work(f.source ?? sku(input.command));
        f.catalogAfter();
        if (f.catalogMode === "foreign") return { ...result } as Awaited<ReturnType<typeof work>>;
        return result;
      },
    },
    audit: {
      create(v) {
        const a = audit(v);
        return f.auditMode === "wrongActor"
          ? { ...a, actor: { type: "User", reference: id(90) } }
          : a;
      },
    },
  };
  return { f, tx, options, store: createPostgresInventorySkuMappingStore(options) };
}
const unavailable = expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
  denied = expect.objectContaining({ code: "INVENTORY_ITEM_PERMISSION_DENIED" }),
  conflict = expect.objectContaining({ code: "INVENTORY_ITEM_CONFLICT" });
describe("Inventory-owned mapping physical transaction adapter", () => {
  it("refuses Audit metadata coercion without invoking caller hooks", async () => {
    const { f, options } = fixture();
    let touched = false;
    const create = options.audit.create;
    options.audit.create = (v) => ({
      ...create(v),
      sourceChannel: {
        toString() {
          touched = true;
          return "API";
        },
      } as unknown as string,
    });
    await expect(
      createPostgresInventorySkuMappingStore(options).execute(command()),
    ).rejects.toThrow(unavailable);
    expect(touched).toBe(false);
    expect(f.auditWrites).toBe(0);
  });
  it("holds Catalog then global Inventory fence and appends exact Audit/mapping without Item row locks", async () => {
    const { f, store } = fixture();
    const result = await store.execute(command());
    expect(result.outcome).toBe("Applied");
    expect(result.version.mappingVersion).toBe(1);
    expect(f.trace).toEqual(["CatalogFence", "ItemKeyShare", "InventoryFence", "Audit", "Mapping"]);
    expect(f.authorityCalls).toBe(4);
    expect(f.committed).toBe(1);
    expect(f.auditWrites).toBe(1);
    expect(f.sql.some((sql) => sql.includes("inventory_item") && sql.includes("FOR UPDATE"))).toBe(
      false,
    );
  });
  it("replays immutable original intent after Item/SKU/time changes with fresh authority", async () => {
    const { f, store } = fixture();
    const first = await store.execute(command());
    f.item = { ...f.item, itemVersion: 3, lifecycle: "Archived" };
    f.now = "2026-09-30T12:00:00.000Z";
    const replay = await store.execute(command());
    expect(replay.version).toEqual(first.version);
    expect(replay.outcome).toBe("AlreadyApplied");
    expect(f.catalogCalls).toBe(1);
    expect(f.auditWrites).toBe(1);
    expect(f.authorityCalls).toBe(6);
    await expect(store.execute({ ...command(), reasonCode: "DIFFERENT" })).rejects.toMatchObject({
      code: "INVENTORY_ITEM_IDEMPOTENCY_CONFLICT",
    });
  });
  it("rechecks original recovery after an overlapping retry acquired the global fence", async () => {
    const { f, store } = fixture();
    f.beforeFence = () => {
      f.records.push(planInventorySkuMapping(command(), null, current(), sku(), at));
    };
    expect((await store.execute(command())).outcome).toBe("AlreadyApplied");
    expect(f.auditWrites).toBe(0);
  });
  it("clears with independent mapping version and no fabricated current SKU proof", async () => {
    const { f, store } = fixture();
    await store.execute(command());
    const c = {
      ...command(),
      operationReference: id(11),
      expectedMappingVersion: 1,
      action: "Clear" as const,
      target: null,
      reasonCode: "UNLINK_FINISHED_GOOD",
    };
    const next = await store.execute(c);
    expect(next.version.mappingVersion).toBe(2);
    expect(next.version.target).toBe(null);
    expect(f.records[0]?.target?.skuReference).toBe(id(10));
    expect(f.catalogCalls).toBe(1);
  });
  it.each([1, 2, 3, 4])(
    "current authority denial at lease check %s refuses or rolls back all writes",
    async (denyAt) => {
      const { f, store } = fixture();
      f.denyAt = denyAt;
      await expect(store.execute(command())).rejects.toThrow(denied);
      expect(f.records).toHaveLength(0);
      expect(f.auditWrites).toBe(0);
      expect(f.committed).toBe(0);
      if (denyAt === 1) expect(f.sql).toHaveLength(0);
    },
  );
  it("requires current authority for replay before any source SQL", async () => {
    const { f, store } = fixture();
    await store.execute(command());
    f.sql = [];
    f.denyAt = 5;
    await expect(store.execute(command())).rejects.toThrow(denied);
    expect(f.sql).toHaveLength(0);
    expect(f.records).toHaveLength(1);
  });
  it.each(["tenantReference", "brandReference", "actorReference"] as const)(
    "rejects wrong %s before transaction/SQL",
    async (field) => {
      const { f, store } = fixture();
      await expect(store.execute({ ...command(), [field]: id(99) })).rejects.toThrow(denied);
      expect(f.sql).toHaveLength(0);
      expect(f.authorityCalls).toBe(0);
    },
  );
  it("refuses one-to-one or stable identity reuse before appending Audit", async () => {
    const { f, store } = fixture();
    f.conflict = true;
    await expect(store.execute(command())).rejects.toThrow(conflict);
    expect(f.auditWrites).toBe(0);
    expect(f.records).toHaveLength(0);
  });
  it.each(["repeatable read", "serializable"])(
    "refuses unsupported isolation %s",
    async (isolation) => {
      const { f, store } = fixture();
      f.isolation = isolation;
      await expect(store.execute(command())).rejects.toThrow(unavailable);
      expect(f.catalogCalls).toBe(0);
    },
  );
  it.each(["skip", "duplicate", "foreign"])(
    "refuses untrusted Catalog callback/result %s",
    async (mode) => {
      const { f, store } = fixture();
      f.catalogMode = mode;
      await expect(store.execute(command())).rejects.toThrow(unavailable);
      expect(f.records).toHaveLength(0);
      expect(f.auditWrites).toBe(0);
    },
  );
  it.each(["skip", "duplicate", "foreign"])(
    "refuses transaction runner callback/result %s",
    async (mode) => {
      const { f, store } = fixture();
      f.runnerMode = mode;
      await expect(store.execute(command())).rejects.toThrow(unavailable);
    },
  );
  it("refuses mismatched public Catalog tuple before Audit", async () => {
    const { f, store } = fixture();
    f.source = { ...sku(), catalogConfigurationDigest: "sha256:" + "c".repeat(64) };
    await expect(store.execute(command())).rejects.toThrow(unavailable);
    expect(f.auditWrites).toBe(0);
  });
  it("sanitizes SQL faults rather than exposing statements or bind values", async () => {
    const { f, store } = fixture();
    f.queryOverride = () => {
      throw new Error("private source SQL and values");
    };
    await expect(store.execute(command())).rejects.toThrow(unavailable);
  });
  it("refuses malformed own Item proof and mismatched Audit binding", async () => {
    const { f, store } = fixture();
    f.precise = false;
    await expect(store.execute(command())).rejects.toThrow(unavailable);
    f.precise = true;
    f.auditMode = "wrongActor";
    await expect(store.execute(command())).rejects.toThrow(unavailable);
    expect(f.auditWrites).toBe(0);
  });
  it("refuses SQL row accessors without invoking them", async () => {
    const { f, store } = fixture();
    let touched = false;
    f.queryOverride = (sql) =>
      sql.includes("transaction_isolation")
        ? {
            rows: [
              Object.defineProperty({}, "isolation", {
                enumerable: true,
                get() {
                  touched = true;
                  return "read committed";
                },
              }),
            ],
          }
        : undefined;
    await expect(store.execute(command())).rejects.toThrow(unavailable);
    expect(touched).toBe(false);
  });
  it.each(["version", "operation", "archive", "late"])(
    "rolls back after Catalog callback changes %s",
    async (mode) => {
      const { f, store } = fixture();
      f.catalogAfter = () => {
        if (mode === "version") f.item = { ...f.item, itemVersion: 3 };
        if (mode === "operation") f.item = { ...f.item, configurationOperationReference: id(90) };
        if (mode === "archive") f.item = { ...f.item, lifecycle: "Archived" };
        if (mode === "late") f.now = "2026-09-29T12:00:05.001Z";
      };
      await expect(store.execute(command())).rejects.toThrow(unavailable);
      expect(f.records).toHaveLength(0);
      expect(f.auditWrites).toBe(0);
    },
  );
});
