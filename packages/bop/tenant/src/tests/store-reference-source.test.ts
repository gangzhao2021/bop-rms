import { describe, expect, it } from "vitest";
import {
  parseTenantStoreReferenceRequest,
  parseTenantStoreReferenceSnapshot,
  parseTenantStoreLabelReferenceSnapshot,
  type TenantStoreReferenceSnapshot,
} from "../contracts/store-reference-source.js";
import {
  createPostgresTenantStoreReferenceSource,
  tenantStoreReferenceDigest,
} from "../infrastructure/persistence/store-reference-source.js";
const id = (n: number) => `018f3f7a-8b1c-7a11-8d01-${String(n).padStart(12, "0")}`;
const at = "2026-09-29T00:00:00.000Z";
const request = {
  brandReference: id(1),
  actorReference: id(2),
  purposeCode: "REFERENCE_REVIEW",
  originalIntentDigest: "sha256:" + "a".repeat(64),
  observedAt: at,
};
function fixture(): TenantStoreReferenceSnapshot {
  return {
    profile: "TenantStoreReferenceV1",
    brandReference: id(1),
    brandLifecycle: "Active",
    brandVersion: "9223372036854775807",
    generation: "1",
    referenceCount: "1",
    originalIntentDigest: request.originalIntentDigest,
    observedAt: at,
    references: [
      { storeReference: id(3), lifecycle: "Archived", version: "1", createdAt: at, updatedAt: at },
    ],
  };
}
describe("Tenant complete Store reference metadata", () => {
  it("preserves exact large revisions and immutable minimal metadata", () => {
    const parsed = parseTenantStoreReferenceSnapshot(fixture());
    expect(parsed.brandVersion).toBe("9223372036854775807");
    expect(parsed.references[0]?.lifecycle).toBe("Archived");
    expect(Object.isFrozen(parsed.references)).toBe(true);
    expect(tenantStoreReferenceDigest(parsed)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
  it("permits a proven zero Store Brand", () => {
    expect(
      parseTenantStoreReferenceSnapshot({ ...fixture(), referenceCount: "0", references: [] })
        .references,
    ).toEqual([]);
  });
  it("rejects omitted, extra, accessor and sparse facts without executing getters", () => {
    expect(() => parseTenantStoreReferenceRequest({ ...request, storeReference: id(3) })).toThrow(
      "TENANT_STORE_REFERENCE_INVALID",
    );
    let calls = 0;
    const input = { ...request };
    Object.defineProperty(input, "purposeCode", {
      enumerable: true,
      get() {
        calls++;
        return "REFERENCE_REVIEW";
      },
    });
    expect(() => parseTenantStoreReferenceRequest(input)).toThrow();
    expect(calls).toBe(0);
    const snapshot = fixture();
    const array = [...snapshot.references];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get() {
        calls++;
        return snapshot.references[0];
      },
    });
    expect(() => parseTenantStoreReferenceSnapshot({ ...snapshot, references: array })).toThrow();
    expect(calls).toBe(0);
    expect(() =>
      parseTenantStoreReferenceSnapshot({
        ...snapshot,
        referenceCount: "2",
        references: new Array(2),
      }),
    ).toThrow();
  });
  it("rejects count gaps, duplicate/unsorted IDs, resource overflow and malformed revisions", () => {
    const s = fixture();
    expect(() => parseTenantStoreReferenceSnapshot({ ...s, referenceCount: "2" })).toThrow();
    expect(() =>
      parseTenantStoreReferenceSnapshot({
        ...s,
        referenceCount: "2",
        references: [s.references[0], s.references[0]],
      }),
    ).toThrow();
    expect(() =>
      parseTenantStoreReferenceSnapshot({
        ...s,
        referenceCount: "10001",
        references: new Array(10001),
      }),
    ).toThrow();
    for (const revision of ["01", "-1", "9223372036854775808", 1])
      expect(() => parseTenantStoreReferenceSnapshot({ ...s, brandVersion: revision })).toThrow();
  });
  it("rejects future/microsecond metadata instead of truncating time", () => {
    const s = fixture();
    for (const updatedAt of ["2026-09-29T00:00:01.000Z", "2026-09-29T00:00:00.000001Z"])
      expect(() =>
        parseTenantStoreReferenceSnapshot({
          ...s,
          references: [{ ...s.references[0], updatedAt }],
        }),
      ).toThrow();
  });
  it("hashes lifecycle, generation and original intent separately", () => {
    const s = fixture();
    expect(tenantStoreReferenceDigest(s)).not.toBe(
      tenantStoreReferenceDigest({ ...s, generation: "2" }),
    );
    expect(tenantStoreReferenceDigest(s)).not.toBe(
      tenantStoreReferenceDigest({ ...s, originalIntentDigest: "sha256:" + "b".repeat(64) }),
    );
  });
  it("holds permission through transaction completion and refuses revocation after work", async () => {
    const order: string[] = [];
    let checks = 0;
    const source = createPostgresTenantStoreReferenceSource({
      brandReference: request.brandReference,
      transactions: {
        async run(work) {
          order.push("begin");
          const result = await work({
            async query(sql) {
              if (sql === "SHOW transaction_isolation")
                return { rows: [{ transaction_isolation: "read committed" }] };
              if (sql.includes("FROM bop_tenant.brand"))
                return {
                  rows: [
                    {
                      brand_id: id(1),
                      lifecycle: "Active",
                      version: "1",
                      updated_at: at,
                      precise: true,
                    },
                  ],
                };
              if (sql.includes("FROM bop_tenant.store_reference_generation"))
                return { rows: [{ brand_id: id(1), generation: "0", reference_count: "0" }] };
              return { rows: [] };
            },
          });
          order.push("commit");
          return result;
        },
      },
      authority: {
        async withCurrentBrandReferenceRead(_r, work) {
          order.push("hold");
          const result = await work();
          order.push("release");
          return result;
        },
        async isCurrent() {
          checks++;
          return checks < 3;
        },
      },
    });
    await expect(
      source.withCurrentSnapshot(request, async (s) => {
        expect(s.references).toEqual([]);
        order.push("work");
        return true;
      }),
    ).rejects.toThrow("TENANT_STORE_REFERENCE_UNAVAILABLE");
    expect(order).toEqual(["hold", "begin", "work"]);
  });
  it("denies mismatched Brand before SQL/authority and preserves generic errors", async () => {
    let calls = 0;
    const source = createPostgresTenantStoreReferenceSource({
      brandReference: id(1),
      transactions: {
        async run() {
          calls++;
          throw new Error("restricted database detail");
        },
      },
      authority: {
        async withCurrentBrandReferenceRead(_r, work) {
          calls++;
          return work();
        },
        async isCurrent() {
          return false;
        },
      },
    });
    await expect(
      source.withCurrentSnapshot({ ...request, brandReference: id(4) }, async () => true),
    ).rejects.toThrow("TENANT_STORE_REFERENCE_UNAVAILABLE");
    expect(calls).toBe(0);
  });
});

function labelFixture() {
  const value = fixture();
  return {
    ...value,
    profile: "TenantStoreLabelReferenceV1",
    references: value.references.map((reference) => ({
      ...reference,
      code: "TORONTO_01",
      displayName: "Toronto Store",
    })),
  };
}
describe("Tenant complete Store label references", () => {
  it("adds actual labels without changing the legacy metadata or detached immutable values", () => {
    const raw = labelFixture(),
      parsed = parseTenantStoreLabelReferenceSnapshot(raw);
    const first = raw.references[0];
    if (!first) throw Error("missing controlled label");
    first.displayName = "Changed input";
    expect(parsed.references[0]?.displayName).toBe("Toronto Store");
    expect(Object.isFrozen(parsed.references[0])).toBe(true);
    expect(parseTenantStoreReferenceSnapshot(fixture())).toEqual(fixture());
    expect(
      parseTenantStoreLabelReferenceSnapshot({ ...raw, referenceCount: "0", references: [] })
        .references,
    ).toEqual([]);
  });
  it("refuses forged, incomplete, extra, accessor and sparse label documents", () => {
    const raw = labelFixture(),
      first = raw.references[0];
    if (!first) throw Error("missing controlled label");
    for (const reference of [
      { ...first, code: "lowercase" },
      { ...first, displayName: " " },
      { ...first, displayName: "x".repeat(161) },
      { ...first, code: "" },
      { ...first, unmasked: true },
    ])
      expect(() =>
        parseTenantStoreLabelReferenceSnapshot({ ...raw, references: [reference] }),
      ).toThrow();
    expect(() =>
      parseTenantStoreLabelReferenceSnapshot({ ...raw, references: fixture().references }),
    ).toThrow();
    expect(() =>
      parseTenantStoreLabelReferenceSnapshot({ ...raw, references: Array(1) }),
    ).toThrow();
    let calls = 0;
    const getter = Object.defineProperty({ ...first }, "displayName", {
      enumerable: true,
      get() {
        calls++;
        return "unsafe";
      },
    });
    expect(() =>
      parseTenantStoreLabelReferenceSnapshot({ ...raw, references: [getter] }),
    ).toThrow();
    expect(calls).toBe(0);
  });
  function sourceFixture() {
    const order: string[] = [],
      statements: string[] = [];
    let displayName = "Toronto Store",
      generation = "1",
      labelStore = id(3),
      labelVersion = "1",
      deniedAt = 0,
      checks = 0;
    const tx = {
      async query(sql: string) {
        statements.push(sql);
        if (sql === "SHOW transaction_isolation")
          return { rows: [{ transaction_isolation: "read committed" }] };
        if (sql.includes("FROM bop_tenant.brand"))
          return {
            rows: [
              { brand_id: id(1), lifecycle: "Active", version: "1", updated_at: at, precise: true },
            ],
          };
        if (sql.includes("FROM bop_tenant.store_reference_generation"))
          return { rows: [{ brand_id: id(1), generation, reference_count: "1" }] };
        if (sql.includes("FROM bop_tenant.store_reference_projection")) {
          const base = {
            brand_id: id(1),
            store_id: id(3),
            lifecycle: "Archived",
            version: "1",
            created_at: at,
            updated_at: at,
            precise: true,
          };
          return {
            rows: [
              sql.includes("code,display_name")
                ? {
                    ...base,
                    store_id: labelStore,
                    version: labelVersion,
                    code: "TORONTO_01",
                    display_name: displayName,
                  }
                : base,
            ],
          };
        }
        return { rows: [] };
      },
    };
    const source = createPostgresTenantStoreReferenceSource({
      brandReference: id(1),
      transactions: {
        async run(work) {
          order.push("begin");
          const result = await work(tx);
          order.push("commit");
          return result;
        },
      },
      authority: {
        async withCurrentBrandReferenceRead(_request, work) {
          order.push("hold");
          const result = await work();
          order.push("release");
          return result;
        },
        async isCurrent(actual) {
          expect(actual).toBe(tx);
          checks++;
          return deniedAt !== checks;
        },
      },
    });
    return {
      source,
      tx,
      order,
      statements,
      label(value: string) {
        displayName = value;
      },
      identity(value: string) {
        labelStore = value;
      },
      version(value: string) {
        labelVersion = value;
      },
      generation(value: string) {
        generation = value;
      },
      deny(at: number) {
        deniedAt = at;
      },
    };
  }
  it("acquires genuine authority through COMMIT and reads complete labels under the same generation barrier", async () => {
    const f = sourceFixture();
    const result = await f.source.withCurrentLabelSnapshot(request, async (snapshot) => {
      f.order.push("work");
      expect(snapshot.references[0]?.displayName).toBe("Toronto Store");
      expect(snapshot.references[0]?.lifecycle).toBe("Archived");
      return snapshot;
    });
    expect(result.generation).toBe("1");
    expect(result.referenceCount).toBe("1");
    expect(f.order).toEqual(["hold", "begin", "work", "commit", "release"]);
    expect(f.statements.filter((sql) => sql.includes("code,display_name"))).toHaveLength(2);
  });
  it("refuses label drift, metadata mismatches, changed generation and current authority withdrawal", async () => {
    const changed = sourceFixture();
    await expect(
      changed.source.withCurrentLabelSnapshot(request, async () => {
        changed.label("Changed Store");
        return true;
      }),
    ).rejects.toThrow("TENANT_STORE_REFERENCE_UNAVAILABLE");
    for (const mismatch of ["identity", "version"] as const) {
      const f = sourceFixture();
      f[mismatch](mismatch === "identity" ? id(9) : "2");
      await expect(f.source.withCurrentLabelSnapshot(request, async () => true)).rejects.toThrow(
        "TENANT_STORE_REFERENCE_UNAVAILABLE",
      );
      expect(f.order).not.toContain("commit");
    }
    const head = sourceFixture();
    await expect(
      head.source.withCurrentLabelSnapshot(request, async () => {
        head.generation("2");
        return true;
      }),
    ).rejects.toThrow();
    const denied = sourceFixture();
    denied.deny(3);
    await expect(
      denied.source.withCurrentLabelSnapshot(request, async () => true),
    ).rejects.toThrow();
    expect(denied.order).not.toContain("commit");
  });
  it("keeps the legacy public read free of labels and additional label queries", async () => {
    const f = sourceFixture();
    const value = await f.source.withCurrentSnapshot(request, async (snapshot) => snapshot);
    expect(value.profile).toBe("TenantStoreReferenceV1");
    expect(value.references[0]).not.toHaveProperty("displayName");
    expect(f.statements.filter((sql) => sql.includes("code,display_name"))).toEqual([]);
    expect(tenantStoreReferenceDigest(value)).toBe(
      tenantStoreReferenceDigest({ ...value, references: [...value.references] }),
    );
  });
  it("rejects label-source query-port replacement even after callback work", async () => {
    const f = sourceFixture();
    await expect(
      f.source.withCurrentLabelSnapshot(request, async () => {
        f.tx.query = async () => ({ rows: [] });
        return true;
      }),
    ).rejects.toThrow("TENANT_STORE_REFERENCE_UNAVAILABLE");
    expect(f.order).not.toContain("commit");
  });
});
