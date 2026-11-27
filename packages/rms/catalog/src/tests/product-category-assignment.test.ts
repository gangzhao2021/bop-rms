import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseProductAggregate,
  createPostgresProductCategoryAssignmentAuthority,
} from "../index.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T08:00:00.000Z";
function fixture() {
  const aggregate = parseProductAggregate({
    productReference: id(20),
    brandReference: id(1),
    internalCode: "CLASSIFIED",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(21),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [id(10)], primaryCategoryReference: id(10) },
    },
  });
  let result: unknown = {
    rows: [{ category_reference: id(10), brand_reference: id(1), lifecycle: "Active" }],
  };
  let isolation = "read committed";
  const query = vi.fn(async (sql: string) =>
    sql.includes("transaction_isolation")
      ? { rows: [{ isolation }] }
      : sql.includes("FROM rms_catalog.category")
        ? result
        : { rows: [] },
  );
  const hold = vi.fn(async () => ({ allowedLifecycles: ["Active"] as const }));
  const options = {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(3),
    clock: { now: () => at },
    holdPolicyUntilTransactionCompletes: hold,
  };
  return {
    aggregate,
    query,
    hold,
    authority: createPostgresProductCategoryAssignmentAuthority(options),
    tx: { query } as ProductLifecycleTransaction,
    options,
    setRows: (value: unknown) => {
      result = value;
    },
    setIsolation: (value: string) => {
      isolation = value;
    },
  };
}
describe("held actual Product Category assignment facts", () => {
  it("requires a current policy holder without granting defaults", () => {
    const f = fixture();
    expect(() =>
      createPostgresProductCategoryAssignmentAuthority({
        ...f.options,
        holdPolicyUntilTransactionCompletes: undefined,
      } as never),
    ).toThrow(CatalogError);
  });
  it("holds permission/Phase and resets own RLS context before actual selected facts", async () => {
    const f = fixture();
    await f.authority.holdUntilTransactionCompletes(f.tx, {
      mode: "Write",
      aggregate: f.aggregate,
    });
    expect(f.hold).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({
        tenantReference: id(4),
        brandReference: id(1),
        actorReference: id(3),
        purposeCode: "CATALOG_PRODUCT_CATEGORY_MUTATION",
        permission: "catalog.product.manage",
        referencedPermission: "catalog.manage",
        requiredFields: [
          "categoryClassification",
          "categoryReferences",
          "primaryCategoryReference",
        ],
      }),
    );
    const calls = f.query.mock.calls.map((call) => call[0]);
    expect(calls).toHaveLength(4);
    expect(calls[1]).toContain("bop.store_id");
    expect(calls[2]).toContain("pg_advisory_xact_lock");
    expect(calls[3]).toContain("FOR SHARE");
  });
  it("authorizes original reads without revalidating later Category lifecycle", async () => {
    const f = fixture();
    await f.authority.holdUntilTransactionCompletes(f.tx, { mode: "Read", aggregate: f.aggregate });
    expect(f.hold).toHaveBeenCalledWith(
      f.tx,
      expect.objectContaining({ purposeCode: "CATALOG_PRODUCT_CATEGORY_ACCESS" }),
    );
    expect(f.query.mock.calls.some((call) => call[0].includes("FROM rms_catalog.category"))).toBe(
      false,
    );
  });
  it("rejects stale repeatable-read facts before Category SQL", async () => {
    const f = fixture();
    f.setIsolation("repeatable read");
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, { mode: "Write", aggregate: f.aggregate }),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.query).toHaveBeenCalledTimes(1);
  });
  it("never invokes input or driver row getters", async () => {
    const f = fixture(),
      getter = vi.fn(() => "Write");
    const input = { aggregate: f.aggregate };
    Object.defineProperty(input, "mode", { enumerable: true, get: getter });
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, input as never),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(getter).not.toHaveBeenCalled();
    expect(f.hold).not.toHaveBeenCalled();
    const row = { brand_reference: id(1), lifecycle: "Active" };
    Object.defineProperty(row, "category_reference", { enumerable: true, get: getter });
    f.setRows({ rows: [row] });
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, { mode: "Write", aggregate: f.aggregate }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(getter).not.toHaveBeenCalled();
  });
  it("bounds malformed or missing actual selected facts", async () => {
    for (const rows of [
      [],
      [{ category_reference: id(10), brand_reference: id(2), lifecycle: "Active" }],
      [{ category_reference: id(10), brand_reference: id(1), lifecycle: "Active", grant: true }],
    ]) {
      const f = fixture();
      f.setRows({ rows });
      await expect(
        f.authority.holdUntilTransactionCompletes(f.tx, { mode: "Write", aggregate: f.aggregate }),
      ).rejects.toBeInstanceOf(CatalogError);
    }
  });
  it("bounds raw policy-provider failure before SQL", async () => {
    const f = fixture();
    f.hold.mockRejectedValueOnce(new Error("synthetic private provider detail"));
    await expect(
      f.authority.holdUntilTransactionCompletes(f.tx, { mode: "Write", aggregate: f.aggregate }),
    ).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
      message: "catalog is unavailable",
    });
    expect(f.query).not.toHaveBeenCalled();
  });
});
