import { createHash } from "node:crypto";
import { canonicalizeRfc8785 } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { createPostgresCatalogAllergenCoverageSource } from "../infrastructure/persistence/recipe-allergen-coverage-source.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => `01900000-0000-7000-8000-${n.toString().padStart(12, "0")}`;
const scope = { tenantReference: id(1), brandReference: id(2) },
  at = "2026-09-28T00:00:00.000Z";
const request = () => ({
  actorReference: id(3),
  purpose: "RecipeProjectionBuild",
  observedAtUtc: at,
});
const coverage = () => ({
  family: "Allergen",
  ...scope,
  snapshotReference: id(4),
  digest: `sha256:${createHash("sha256")
    .update(canonicalizeRfc8785({ family: "Allergen", ...scope, dependencies: [] }))
    .digest("hex")}`,
  complete: true,
  dependencies: [],
});
function setup(allowed = true) {
  const query = vi.fn<
      (sql: string, values: readonly unknown[]) => Promise<{ rows: readonly unknown[] }>
    >(async (sql) => ({
      rows: sql.startsWith("SELECT coverage_json")
        ? [{ coverage: coverage(), capturedAtUtc: at }]
        : sql.startsWith("SELECT EXISTS")
          ? [{ conflict: false }]
          : [],
    })),
    authorize = vi.fn(async () => allowed),
    generateReference = vi.fn(() => id(5));
  const source = createPostgresCatalogAllergenCoverageSource({
    scope,
    runner: {
      run: async (work) => {
        const tx: ProductLifecycleTransaction = {
          query: async <Row>(sql: string, values: readonly unknown[]) => ({
            rows: (await query(sql, values)).rows as readonly Row[],
          }),
        };
        return work(tx);
      },
    },
    authorize,
    generateReference,
  });
  return { source, query, authorize, generateReference };
}
describe("Catalog-owned Allergen full history", () => {
  it("reuses immutable complete empty owner history with current statement snapshots", async () => {
    const { source, query, generateReference } = setup();
    const read = await source.capture(request());
    expect(read.coverage).toEqual(coverage());
    expect(Object.isFrozen(read.coverage.dependencies)).toBe(true);
    expect(query.mock.calls[0]?.[0]).toBe("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    expect(generateReference).not.toHaveBeenCalled();
  });
  it("denies authority before any private collection read or lock", async () => {
    const { source, query } = setup(false);
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_PERMISSION_DENIED",
    });
    expect(
      query.mock.calls.some(
        ([sql]) =>
          sql.includes("FROM rms_catalog") || sql.startsWith("LOCK") || sql.startsWith("INSERT"),
      ),
    ).toBe(false);
  });
  it("rejects caller scope injection and hostile request getters before query", async () => {
    const { source, query } = setup();
    for (const value of [
      { ...request(), tenantReference: id(99) },
      { ...request(), actorReference: "bad" },
      { ...request(), observedAtUtc: "invalid" },
    ])
      await expect(source.capture(value)).rejects.toMatchObject({
        code: "ALLERGEN_SOURCE_INPUT_INVALID",
      });
    const getter = vi.fn(() => {
        throw Error();
      }),
      input = request();
    Object.defineProperty(input, "purpose", { get: getter });
    await expect(source.capture(input)).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_INPUT_INVALID",
    });
    expect(getter).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("holds actual configuration collections through callback and rechecks authority", async () => {
    const { source, query, authorize } = setup();
    const read = await source.capture(request());
    expect(
      await source.withCurrent(request(), read, async () => {
        expect(
          query.mock.calls.some(
            ([sql]) =>
              sql ===
              "LOCK TABLE rms_catalog.allergen_registry_version,rms_catalog.allergen_registry_entry,rms_catalog.allergen_source_evidence,rms_catalog.allergen_source_assertion IN SHARE MODE",
          ),
        ).toBe(true);
        return "read";
      }),
    ).toBe("read");
    expect(authorize).toHaveBeenCalledTimes(4);
    authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(source.withCurrent(request(), read, async () => "private")).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_PERMISSION_DENIED",
    });
  });
  it("bounds callback errors and rejects foreign or forged seals", async () => {
    const { source, authorize } = setup();
    const read = await source.capture(request());
    await expect(
      source.withCurrent(request(), read, async () => {
        throw Error("synthetic detail");
      }),
    ).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_UNAVAILABLE",
      message: "Allergen coverage is unavailable",
    });
    authorize.mockClear();
    await expect(
      source.withCurrent(
        request(),
        { ...read, coverage: { ...read.coverage, brandReference: id(99) } },
        async () => null,
      ),
    ).rejects.toMatchObject({ code: "ALLERGEN_SOURCE_INPUT_INVALID" });
    expect(authorize).not.toHaveBeenCalled();
  });
  it("rejects excessive source versions without truncating", async () => {
    const { source, query, generateReference } = setup();
    query.mockImplementation(async (sql) => ({
      rows: sql.includes("FROM rms_catalog.allergen_registry_version")
        ? Array.from({ length: 2049 }, () => ({}))
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_UNAVAILABLE",
    });
    expect(generateReference).not.toHaveBeenCalled();
    expect(query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  });
  it("rejects row accessors and unavailable transaction isolation safely", async () => {
    const { source, query, authorize } = setup();
    query.mockRejectedValueOnce(Error("synthetic existing snapshot"));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_UNAVAILABLE",
    });
    expect(authorize).not.toHaveBeenCalled();
    const getter = vi.fn(() => {
        throw Error();
      }),
      values: unknown[] = [];
    Object.defineProperty(values, "0", { get: getter, enumerable: true });
    query.mockImplementation(async () => ({ rows: values }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_UNAVAILABLE",
    });
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects historical conflicts before returning an exact existing seal", async () => {
    const { source, query, generateReference } = setup();
    query.mockImplementation(async (sql) => ({
      rows: sql.startsWith("SELECT EXISTS")
        ? [{ conflict: true }]
        : sql.startsWith("SELECT coverage_json")
          ? [{ coverage: coverage(), capturedAtUtc: at }]
          : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_INTEGRITY_CONFLICT",
    });
    expect(generateReference).not.toHaveBeenCalled();
  });
  it("rejects missing registry children and orphan assertions before capture", async () => {
    const { source, query, generateReference } = setup();
    const registry = {
      reference: id(10),
      jurisdiction: "ON",
      digest: `sha256:${"a".repeat(64)}`,
      reviewed: at,
      reviewer: id(3),
      status: "Invalidated",
      precise: true,
    };
    query.mockImplementation(async (sql) => ({
      rows: sql.includes("FROM rms_catalog.allergen_registry_version") ? [registry] : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_UNAVAILABLE",
    });
    query.mockImplementation(async (sql) => ({
      rows: sql.includes("FROM rms_catalog.allergen_source_assertion")
        ? [{ evidence: id(15), registry: id(10), reference: id(11), classification: "Unverified" }]
        : [],
    }));
    await expect(source.capture(request())).rejects.toMatchObject({
      code: "ALLERGEN_SOURCE_UNAVAILABLE",
    });
    expect(generateReference).not.toHaveBeenCalled();
  });
});
