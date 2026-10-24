import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryProductPublicationReferenceRequestV2,
  buildInventoryProductPublicationConfigurationReferenceSnapshotV2 as buildConfiguration,
  parseInventoryProductPublicationConfigurationReferenceSnapshotV2 as parseConfiguration,
  buildInventoryProductPublicationSkuMappingReferenceSnapshotV2 as buildMapping,
  parseInventoryProductPublicationSkuMappingReferenceSnapshotV2 as parseMapping,
  createPostgresInventoryProductPublicationConfigurationReferenceSourceV2 as configurationStore,
  createPostgresInventoryProductPublicationSkuMappingReferenceSourceV2 as mappingStore,
  inventoryProductPublicationConfigurationReferenceFieldsV2,
  inventoryProductPublicationSkuMappingReferenceFieldsV2,
  inventoryConfigurationReferencePermissions,
  buildInventoryConfigurationReferenceSnapshot,
  buildInventorySkuMappingReferenceSnapshot,
  type InventoryConfigurationReferenceTransaction,
  type InventoryProductPublicationConfigurationReferenceOptionsV2,
  type InventoryProductPublicationConfigurationReferenceSnapshotV2,
  type InventoryProductPublicationSkuMappingReferenceSnapshotV2,
} from "../index.js";
const id = (n: number) => `01902419-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const h = "sha256:" + "a".repeat(64),
  at = "2026-10-03T12:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const request = (actorKind: "User" | "System" = "User") =>
  parseInventoryProductPublicationReferenceRequestV2({
    profile: "InventoryProductPublicationReferenceRequestV2",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_INVENTORY_CONFIGURATION_SOURCE_READ",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind,
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    originalIntentDigest: h,
    replacementIntentDigest: h,
    aggregateSnapshotDigest: h,
    currentPublicationDigest: null,
    observedAt: at,
    validUntil: "2026-10-03T12:00:05.000Z",
  });
function records(empty = false) {
  const scope = { tenantReference: id(1), brandReference: id(2) };
  return {
    configuration: {
      generation: empty ? null : "5",
      observedAt: at,
      counts: {
        items: empty ? "0" : "2",
        versions: empty ? "0" : "3",
        operations: empty ? "0" : "3",
      },
      items: empty
        ? []
        : [10, 20].map((n) => ({
            ...scope,
            itemReference: id(n),
            itemType: "FinishedGood",
            createdAt: at,
            precise: true,
          })),
      versions: empty
        ? []
        : [
            [10, 1],
            [10, 2],
            [20, 1],
          ].map(([n = 0, v = 0]) => ({
            ...scope,
            itemReference: id(n),
            itemVersion: String(v),
            itemType: "FinishedGood",
            lifecycle: "Inactive",
            recordedAt: at,
            precise: true,
          })),
      operations: empty
        ? []
        : [
            [10, 1, 11],
            [10, 2, 12],
            [20, 1, 21],
          ].map(([n = 0, v = 0, op = 0]) => ({
            ...scope,
            itemReference: id(n),
            itemVersion: String(v),
            operationReference: id(op),
            action: v === 1 ? "Create" : "Update",
          })),
    },
    mapping: {
      generation: empty ? null : "5",
      observedAt: at,
      count: empty ? "0" : "1",
      mappings: empty
        ? []
        : [
            {
              ...scope,
              mappingReference: id(30),
              itemReference: id(10),
              mappingVersion: "1",
              sourceItemVersion: "1",
              sourceConfigurationOperationReference: id(11),
              action: "Set",
              target: {
                productReference: id(5),
                productVersionReference: id(6),
                skuReference: id(7),
                catalogConfigurationDigest: h,
              },
              operationReference: id(31),
              mappingIntentDigest: h,
              occurredAt: at,
              precise: true,
            },
          ],
    },
  };
}
function harness(
  kind: "configuration" | "mapping",
  empty = false,
  actorKind: "User" | "System" = "User",
) {
  const input = request(actorKind),
    raw = records(empty),
    guards: { guard: () => Promise<void>; final: () => void }[] = [];
  let clock = at,
    denied = false,
    generation = empty ? "0" : "5",
    mode: "normal" | "swallow" | "repeat" = "normal";
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  // Controlled transaction/authority doubles; actual owning SQL is exercised in the native helper.
  const tx: InventoryConfigurationReferenceTransaction = {
    async query<T extends Record<string, unknown>>(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      const rows = sql.includes(" AS isolation")
        ? [{ isolation: "read committed" }]
        : sql.includes(" AS generation")
          ? [{ generation }]
          : sql.includes("jsonb_build_object('generation'") && sql.includes("'mappings'")
            ? [{ source: raw.mapping }]
            : sql.includes("jsonb_build_object(")
              ? [{ source: raw.configuration }]
              : [];
      return { rows } as unknown as { rows: readonly T[] };
    },
  };
  const authority = vi.fn(
    async (
      _tx: InventoryConfigurationReferenceTransaction,
      metadata: Omit<
        Parameters<
          InventoryProductPublicationConfigurationReferenceOptionsV2["authority"]["holdUntilTransactionCompletes"]
        >[1],
        "requiredFields"
      > & { readonly requiredFields: readonly string[] },
    ) => {
      expect(_tx).toBe(tx);
      expect(metadata.request).toEqual(input);
      expect(metadata.actorKind).toBe(actorKind);
      expect(metadata.tenantReference).toBe(id(1));
      expect(metadata.requiredScope).toBe("FullBrandScope");
      expect(metadata.requiredPermissions).toEqual(inventoryConfigurationReferencePermissions);
      expect(metadata.requiredFields).toEqual(
        kind === "configuration"
          ? inventoryProductPublicationConfigurationReferenceFieldsV2
          : inventoryProductPublicationSkuMappingReferenceFieldsV2,
      );
      if (denied) throw new InventoryItemError("INVENTORY_ITEM_PERMISSION_DENIED");
    },
  );
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind,
    clock: { now: () => clock },
    transactions: {
      async run<T>(
        work: (actual: InventoryConfigurationReferenceTransaction) => Promise<T>,
      ): Promise<T> {
        if (mode === "swallow") {
          try {
            return await work(tx);
          } catch {
            return undefined as T;
          }
        }
        const value = await work(tx);
        if (mode === "repeat") {
          try {
            await work(tx);
          } catch {
            /* The first call must remain poisoned. */
          }
        }
        return value;
      },
    },
    authority: { holdUntilTransactionCompletes: authority },
    async registerBeforeCommit(
      actual: InventoryConfigurationReferenceTransaction,
      guard: () => Promise<void>,
      final: () => void,
    ) {
      expect(actual).toBe(tx);
      guards.push({ guard, final });
    },
  };
  const store = kind === "configuration" ? configurationStore(options) : mappingStore(options);
  return {
    input,
    raw,
    tx,
    store,
    options,
    authority,
    guards,
    queries,
    setClock: (value: string) => {
      clock = value;
    },
    setDenied: () => {
      denied = true;
    },
    setGeneration: (value: string) => {
      generation = value;
    },
    setMode: (value: typeof mode) => {
      mode = value;
    },
    async finish(afterAsync?: () => void) {
      for (const g of guards) await g.guard();
      afterAsync?.();
      for (const g of guards) g.final();
    },
  };
}
describe("Inventory publication source graphs", () => {
  it("keeps operation UUID distinct from itemVersion and historical mapping distinct from current configuration", () => {
    const input = request(),
      raw = records(),
      c = buildConfiguration(raw.configuration, input, at),
      m = buildMapping(raw.mapping, c, input, at);
    expect(c.items[0]).toMatchObject({ currentItemVersion: 2, currentOperationReference: id(12) });
    expect(m.mappings[0]).toMatchObject({
      sourceItemVersion: 1,
      sourceConfigurationOperationReference: id(11),
      sourceConfigurationState: "Historical",
      current: true,
    });
    expect(m.items[1]).toMatchObject({ coverage: "NotRecorded", currentLink: "Unknown" });
    expect(m.applicability).toBe("Unavailable");
    expect(parseMapping(m, input, at)).toEqual(m);
    expect(Object.isFrozen(m.configuration.operations)).toBe(true);
    if (!raw.configuration.operations[0]) throw new Error("fixture");
    raw.configuration.operations[0].operationReference = id(91);
    expect(c.operations.some((o) => o.operationReference === id(11))).toBe(true);
    const wrong = structuredClone(raw.mapping);
    if (!wrong.mappings[0]) throw new Error("fixture");
    wrong.mappings[0].sourceConfigurationOperationReference = id(12);
    expect(() => buildMapping(wrong, c, input, at)).toThrow(
      expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
    );
  });
  it("distinguishes true empty from missing generation and binds both original source observations to the deadline", () => {
    const input = request(),
      raw = records(true),
      c = buildConfiguration(raw.configuration, input, at),
      m = buildMapping(raw.mapping, c, input, at);
    expect(c.generation).toBe("0");
    expect(m.items).toEqual([]);
    expect(m.coverage).toBe("CompleteStoredMappingReferences");
    const nonempty = records();
    nonempty.configuration.generation = null;
    expect(() => buildConfiguration(nonempty.configuration, input, at)).toThrow();
    expect(() => buildMapping({ ...raw.mapping, generation: "1" }, c, input, at)).toThrow();
    expect(() => parseMapping(m, input, input.validUntil)).toThrow();
    expect(() =>
      buildConfiguration(
        { ...raw.configuration, observedAt: "2026-10-03T11:59:59.999Z" },
        input,
        at,
      ),
    ).toThrow();
  });
  it("rejects resealed request/derived graph changes, mixed V1 packets and getters", () => {
    const input = request(),
      raw = records(),
      c = buildConfiguration(raw.configuration, input, at),
      m = buildMapping(raw.mapping, c, input, at);
    const packet = {
      ...m,
      request: { ...m.request, aggregateSnapshotDigest: "sha256:" + "b".repeat(64) },
    };
    const { digest: _digest, ...body } = packet;
    void _digest;
    expect(() => parseMapping({ ...body, digest: hash(body) }, input, at)).toThrow();
    const bad = {
      ...c,
      items: c.items.map((item, index) =>
        index === 0 ? { ...item, currentItemVersion: 1 } : item,
      ),
    };
    const { digest: _d, ...changed } = bad;
    void _d;
    expect(() => parseConfiguration({ ...changed, digest: hash(changed) }, input, at)).toThrow();
    const getter = vi.fn(() => input);
    Object.defineProperty(packet, "request", { enumerable: true, get: getter });
    expect(() => parseMapping(packet, input, at)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() =>
      parseConfiguration({ ...c, profile: "BrandInventoryConfigurationReferencesV1" }, input, at),
    ).toThrow();
  });
  it("keeps legacy digest bodies and excludes legacy observation time while V2 binds its original clock", () => {
    const input = request(),
      raw = records(),
      legacy = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        operationReference: id(4),
        catalogIntentDigest: h,
      },
      c = buildInventoryConfigurationReferenceSnapshot(raw.configuration, legacy, at),
      m = buildInventorySkuMappingReferenceSnapshot(raw.mapping, c, legacy, at),
      { observedAt: _at, digest: _d, ...body } = c;
    void _at;
    void _d;
    expect(c.digest).toBe(hash(body));
    expect(m.digest).toBe(
      hash({
        request: legacy,
        profile: m.profile,
        coverage: m.coverage,
        consistency: m.consistency,
        applicability: m.applicability,
        sourceVersionKind: m.sourceVersionKind,
        generation: m.generation,
        configurationDigest: c.digest,
        mappings: m.mappings,
        items: m.items,
      }),
    );
    const later = "2026-10-03T12:00:00.001Z";
    expect(
      buildInventoryConfigurationReferenceSnapshot(
        { ...raw.configuration, observedAt: later },
        legacy,
        later,
      ).digest,
    ).toBe(c.digest);
    expect(
      buildConfiguration({ ...raw.configuration, observedAt: later }, input, later).digest,
    ).not.toBe(buildConfiguration(raw.configuration, input, at).digest);
  });
});
for (const kind of ["configuration", "mapping"] as const)
  describe(`${kind} V2 actual holder boundaries`, () => {
    it.each(["User", "System"] as const)(
      "holds complete empty data on the same transaction for %s through outer final guard",
      async (actorKind) => {
        const h = harness(kind, true, actorKind),
          work = vi.fn(
            async (
              s:
                | InventoryProductPublicationConfigurationReferenceSnapshotV2
                | InventoryProductPublicationSkuMappingReferenceSnapshotV2,
              tx: InventoryConfigurationReferenceTransaction,
            ) => {
              expect(tx).toBe(h.tx);
              expect(s.request).toEqual(h.input);
              return s;
            },
          );
        const source = await h.store.withCurrentSnapshot(h.input, work);
        expect(source.generation).toBe("0");
        expect(source.validUntil).toBe(h.input.validUntil);
        expect(work).toHaveBeenCalledTimes(1);
        await h.finish();
        expect(
          h.queries.some((q) => q.values[0] === `InventoryCatalogReferenceV1:${id(1)}:${id(2)}`),
        ).toBe(true);
      },
    );
    it("rejects foreign actor/scope before SQL or consumer", async () => {
      const h = harness(kind),
        work = vi.fn();
      await expect(
        h.store.withCurrentSnapshot({ ...h.input, brandReference: id(99) }, work),
      ).rejects.toThrow();
      expect(h.queries).toEqual([]);
      expect(work).not.toHaveBeenCalled();
    });
    it("poisons a caught nested reentry on the actual transaction", async () => {
      const h = harness(kind),
        nested = vi.fn();
      await expect(
        h.store.withCurrentSnapshot(h.input, async () => {
          await expect(h.store.withCurrentSnapshot(h.input, nested)).rejects.toThrow();
          return "caught";
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }));
      expect(nested).not.toHaveBeenCalled();
      await expect(h.finish()).rejects.toThrow(
        expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
      );
    });
    it("registers poison before initial denial even if the UoW swallows the failure", async () => {
      const h = harness(kind),
        work = vi.fn();
      h.setMode("swallow");
      h.setDenied();
      await expect(h.store.withCurrentSnapshot(h.input, work)).rejects.toThrow();
      expect(work).not.toHaveBeenCalled();
      expect(h.guards).toHaveLength(1);
      await expect(h.finish()).rejects.toThrow(
        expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
      );
    });
    it("rejects a runner that catches its second callback failure", async () => {
      const h = harness(kind);
      h.setMode("repeat");
      await expect(h.store.withCurrentSnapshot(h.input, async () => "value")).rejects.toThrow(
        expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
      );
    });
    it("keeps the original deadline through later async work and fails the synchronous final at equality", async () => {
      const h = harness(kind);
      await h.store.withCurrentSnapshot(h.input, async () => "tentative");
      await expect(h.finish(() => h.setClock(h.input.validUntil))).rejects.toThrow(
        expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
      );
    });
    it("rechecks generation and authority after consumer return and before outer commit", async () => {
      const h = harness(kind);
      await h.store.withCurrentSnapshot(h.input, async () => "tentative");
      h.setGeneration("6");
      await expect(h.finish()).rejects.toThrow(
        expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
      );
      const denied = harness(kind);
      await denied.store.withCurrentSnapshot(denied.input, async () => "tentative");
      denied.setDenied();
      await expect(denied.finish()).rejects.toThrow(
        expect.objectContaining({ code: "INVENTORY_ITEM_PERMISSION_DENIED" }),
      );
    });
    it("captures ports and refuses query substitution by the consumer", async () => {
      const h = harness(kind);
      h.options.clock.now = () => h.input.validUntil;
      h.options.authority.holdUntilTransactionCompletes = vi.fn(
        async (..._args: Parameters<typeof h.authority>) => {
          void _args;
          throw new Error("substituted");
        },
      );
      await h.store.withCurrentSnapshot(h.input, async () => "captured");
      await h.finish();
      const bad = harness(kind);
      await expect(
        bad.store.withCurrentSnapshot(bad.input, async () => {
          bad.tx.query = async () => ({ rows: [] });
        }),
      ).rejects.toThrow(expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }));
    });
  });
