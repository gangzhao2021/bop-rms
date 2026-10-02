import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  availabilityReferenceSourceFields,
  buildAvailabilityReferenceSourceSnapshot,
  parseAvailabilityReferenceSourceRequest,
  parseAvailabilityReferenceSourceSnapshot,
  createPostgresAvailabilityReferenceSourceStore,
  type AvailabilityReferenceSourceRequest,
  type AvailabilityReferenceTransaction,
} from "../index.js";
const id = (n: number) => `01902413-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request: AvailabilityReferenceSourceRequest = {
  purposeCode: "CATALOG_LIFECYCLE_AVAILABILITY_SOURCE_READ",
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
function rule() {
  return {
    ruleReference: id(10),
    brandReference: id(1),
    sellableType: "Product",
    sellableReference: id(11),
    storeReference: null as string | null,
    aggregateVersion: 1,
    lifecycle: "Draft",
    effectiveFrom: "2027-01-01T12:00:00.000Z",
    effectiveUntil: null as string | null,
    updatedAt: at,
    precise: true,
  };
}
function raw() {
  return { generation: "1" as string | null, rootCount: "1", observedAt: at, rules: [rule()] };
}
const denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
const build = (value: unknown, input = request, now = at) =>
  buildAvailabilityReferenceSourceSnapshot(value, input, now);
describe("owning complete Brand Availability references", () => {
  it("keeps future and Store references, every existing lifecycle/type, and stable data digest", () => {
    const value = raw();
    value.rules = [];
    for (const [i, lifecycle] of ["Draft", "Active", "Inactive", "Archived"].entries())
      value.rules.push({
        ...rule(),
        ruleReference: id(10 + i),
        sellableType: ["Product", "Sku", "Bundle"][i % 3] ?? "Product",
        lifecycle,
        storeReference: id(20 + i),
      });
    value.rootCount = "4";
    const result = build(value);
    expect(result.rules.map((r) => r.lifecycle)).toEqual([
      "Draft",
      "Active",
      "Inactive",
      "Archived",
    ]);
    expect(result.applicability).toBe("Unavailable");
    expect(Object.isFrozen(result.rules[0])).toBe(true);
    value.rules.reverse();
    expect(
      build(
        { ...value, observedAt: "2026-09-29T12:00:01.000Z" },
        request,
        "2026-09-29T12:00:01.000Z",
      ).digest,
    ).toBe(result.digest);
    expect(parseAvailabilityReferenceSourceSnapshot(result, request, at)).toEqual(result);
    expect(build({ ...value, generation: "2" }).digest).not.toBe(result.digest);
  });
  it("distinguishes true empty from missing nonempty generation and partial counts", () => {
    expect(build({ ...raw(), generation: null, rootCount: "0", rules: [] }).generation).toBe("0");
    for (const value of [
      { ...raw(), generation: null },
      { ...raw(), rootCount: "2" },
      { ...raw(), rootCount: "01" },
      { ...raw(), generation: "9223372036854775808" },
      { ...raw(), generation: "-1" },
    ])
      expect(() => build(value)).toThrow(denied);
  });
  it("rejects mismatched original intent and forged public metadata/digest", () => {
    const empty = build({ ...raw(), generation: null, rootCount: "0", rules: [] });
    expect(() =>
      parseAvailabilityReferenceSourceSnapshot({ ...empty, generation: null }, request, at),
    ).toThrow(denied);
    const source = build(raw());
    for (const value of [
      { ...source, coverage: "Partial" },
      { ...source, applicability: "Available" },
      { ...source, generation: "2" },
      { ...source, digest: "sha256:" + "b".repeat(64) },
      { ...source, request: { ...request, operationReference: id(90) } },
    ])
      expect(() => parseAvailabilityReferenceSourceSnapshot(value, request, at)).toThrow(denied);
  });
  it.each([
    "foreign",
    "duplicate",
    "type",
    "lifecycle",
    "version",
    "precision",
    "period",
    "updated",
  ])("rejects invalid %s data", (kind) => {
    const value = raw(),
      r = value.rules[0];
    if (!r) throw new Error("fixture missing");
    if (kind === "foreign") r.brandReference = id(90);
    if (kind === "duplicate") {
      value.rules.push({ ...r });
      value.rootCount = "2";
    }
    if (kind === "type") r.sellableType = "Unknown";
    if (kind === "lifecycle") r.lifecycle = "Published";
    if (kind === "version") r.aggregateVersion = 0;
    if (kind === "precision") r.precise = false;
    if (kind === "period") r.effectiveUntil = r.effectiveFrom;
    if (kind === "updated") r.updatedAt = "2026-09-29T12:00:00.001Z";
    expect(() => build(value)).toThrow(denied);
  });
  it("rejects executable request, driver rows, sparse/overbudget arrays and stale clocks", () => {
    const getter = vi.fn(() => request.catalogIntentDigest),
      intent = { ...request };
    Object.defineProperty(intent, "catalogIntentDigest", { enumerable: true, get: getter });
    expect(() => parseAvailabilityReferenceSourceRequest(intent)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    const value = raw();
    Object.defineProperty(value.rules, "0", { enumerable: true, get: getter });
    expect(() => build(value)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    expect(() => build({ ...raw(), rules: Array(1) })).toThrow(denied);
    expect(() => build({ ...raw(), rules: Array(10001), rootCount: "10001" })).toThrow(denied);
    expect(() => build(raw(), request, "2026-09-29T12:00:05.001Z")).toThrow(denied);
    expect(() => build(raw(), request, "2026-09-29T11:59:59.999Z")).toThrow(denied);
  });
});
function fixture() {
  let now = at,
    generation = "1";
  const query = vi.fn(async (sql: string, values: readonly unknown[]) => {
    void values;
    return {
      rows: sql.includes("transaction_isolation")
        ? [{ isolation: "read committed" }]
        : sql.includes("jsonb_build_object")
          ? [{ source: raw() }]
          : sql.includes("AS generation")
            ? [{ generation }]
            : [],
    };
  });
  const tx = { query } as unknown as AvailabilityReferenceTransaction;
  const hold = vi.fn(async (transaction: AvailabilityReferenceTransaction, input: unknown) => {
    expect(transaction).toBe(tx);
    expect(input).toMatchObject({
      request,
      permission: "catalog.manage",
      requiredScope: "FullBrandScope",
      requiredFields: availabilityReferenceSourceFields,
    });
  });
  const run = vi.fn(async (work: (tx: AvailabilityReferenceTransaction) => Promise<unknown>) =>
    work(tx),
  );
  const options = {
    tenantReference: id(30),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => now },
    transactions: {
      run: run as <T>(work: (tx: AvailabilityReferenceTransaction) => Promise<T>) => Promise<T>,
    },
    authority: { holdUntilTransactionCompletes: hold },
  };
  return {
    query,
    tx,
    hold,
    run,
    options,
    setNow: (value: string) => {
      now = value;
    },
    setGeneration: (value: string) => {
      generation = value;
    },
    store: createPostgresAvailabilityReferenceSourceStore(options),
  };
}
describe("Availability writer-fenced callback", () => {
  it("holds the exact Brand barrier before reading and rechecks generation/authority after consumer", async () => {
    const f = fixture();
    expect(
      await f.store.withCurrentSnapshot(request, async (snapshot) => {
        expect(snapshot.rules).toHaveLength(1);
        expect(f.hold).toHaveBeenCalledTimes(2);
        return "result";
      }),
    ).toBe("result");
    expect(f.hold).toHaveBeenCalledTimes(3);
    const lock = f.query.mock.calls.findIndex(([sql]) =>
        sql.includes("pg_advisory_xact_lock_shared"),
      ),
      read = f.query.mock.calls.findIndex(([sql]) => sql.includes("jsonb_build_object"));
    expect(lock).toBeLessThan(read);
    expect(f.query.mock.calls[lock]?.[1]).toEqual(["CatalogAvailabilityReferenceV1:" + id(1)]);
  });
  it("denies foreign actor and required current full-Brand fields before SQL", async () => {
    const f = fixture();
    await expect(
      f.store.withCurrentSnapshot({ ...request, actorReference: id(90) }, async () => null),
    ).rejects.toThrow(denied);
    expect(f.run).not.toHaveBeenCalled();
    f.hold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await expect(f.store.withCurrentSnapshot(request, async () => null)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }),
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each(["generation", "clock", "latePermission", "callback"])(
    "rejects %s after consumer",
    async (kind) => {
      const f = fixture();
      await expect(
        f.store.withCurrentSnapshot(request, async () => {
          if (kind === "generation") f.setGeneration("2");
          if (kind === "clock") f.setNow("2026-09-29T12:00:05.001Z");
          if (kind === "latePermission")
            f.hold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
          if (kind === "callback") throw new Error("private source error");
          return "not released";
        }),
      ).rejects.toThrow(
        expect.objectContaining({
          code:
            kind === "latePermission"
              ? "CATALOG_PERMISSION_DENIED"
              : "CATALOG_DEPENDENCY_UNAVAILABLE",
        }),
      );
    },
  );
  it("refuses stale isolation, missing/substituted/repeated runner results and driver errors", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{ isolation: "repeatable read" }] } as never);
    await expect(f.store.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.run.mockResolvedValueOnce({ value: null });
    await expect(f.store.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.run.mockImplementationOnce(async (work) => {
      await work(f.tx);
      return { value: null };
    });
    await expect(f.store.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.run.mockImplementationOnce(async (work) => {
      await work(f.tx);
      return work(f.tx);
    });
    await expect(f.store.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.query.mockRejectedValueOnce(new Error("private driver data"));
    await expect(f.store.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
  });
});
