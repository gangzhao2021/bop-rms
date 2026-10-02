import { describe, expect, it } from "vitest";
import {
  parseTenantStoreReferenceRequest,
  parseTenantStoreReferenceSnapshot,
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
