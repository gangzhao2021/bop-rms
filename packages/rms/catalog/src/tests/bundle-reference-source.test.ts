import { describe, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildBundleReferenceSourceSnapshot,
  parseBundleReferenceSourceRequest,
  parseBundleReferenceSourceSnapshot,
  createPostgresBundleReferenceSourceStore,
  bundleReferenceSourceFields,
  type BundleReferenceSourceRequest,
  type BundleReferenceTransaction,
} from "../index.js";
const id = (n: number) => `01902414-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-29T12:00:00.000Z";
const request: BundleReferenceSourceRequest = {
  purposeCode: "CATALOG_LIFECYCLE_BUNDLE_SOURCE_READ",
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
function raw() {
  return {
    generation: "4" as string | null,
    observedAt: at,
    counts: { bundles: "1", versions: "2", groups: "2", members: "2" },
    bundles: [
      {
        bundleReference: id(4),
        brandReference: id(1),
        aggregateVersion: 1,
        lifecycle: "Draft",
        currentVersionReference: id(5),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [
      {
        bundleVersionReference: id(5),
        bundleReference: id(4),
        brandReference: id(1),
        versionStatus: "Draft",
        versionUpdatedAt: at,
        publishedAt: null as string | null,
        validationDigest: null as string | null,
        precise: true,
      },
      {
        bundleVersionReference: id(6),
        bundleReference: id(4),
        brandReference: id(1),
        versionStatus: "Published",
        versionUpdatedAt: at,
        publishedAt: at as string | null,
        validationDigest: ("sha256:" + "b".repeat(64)) as string | null,
        precise: true,
      },
    ],
    groups: [
      {
        groupReference: id(7),
        bundleVersionReference: id(5),
        bundleReference: id(4),
        brandReference: id(1),
      },
      {
        groupReference: id(8),
        bundleVersionReference: id(6),
        bundleReference: id(4),
        brandReference: id(1),
      },
    ],
    members: [
      {
        groupReference: id(7),
        bundleVersionReference: id(5),
        bundleReference: id(4),
        brandReference: id(1),
        sellableType: "Product",
        sellableReference: id(10),
      },
      {
        groupReference: id(8),
        bundleVersionReference: id(6),
        bundleReference: id(4),
        brandReference: id(1),
        sellableType: "Sku",
        sellableReference: id(11),
      },
    ],
  };
}
const build = (value: unknown, input = request, now = at) =>
    buildBundleReferenceSourceSnapshot(value, input, now),
  denied = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
describe("complete owning Bundle stored reference graph", () => {
  it("keeps current Draft and old Published graphs, empty root/version, and stable data SHA", () => {
    const value = raw();
    value.bundles.push({
      ...value.bundles[0],
      bundleReference: id(30),
      currentVersionReference: id(31),
    } as (typeof value.bundles)[number]);
    value.versions.push({
      ...value.versions[0],
      bundleVersionReference: id(31),
      bundleReference: id(30),
    } as (typeof value.versions)[number]);
    value.counts.bundles = "2";
    value.counts.versions = "3";
    const result = build(value);
    expect(result.bundles).toHaveLength(2);
    expect(result.versions).toHaveLength(3);
    expect(result.groups).toHaveLength(2);
    expect(result.applicability).toBe("Unavailable");
    expect(parseBundleReferenceSourceSnapshot(result, request, at)).toEqual(result);
    expect(Object.isFrozen(result.members[0])).toBe(true);
    value.versions.reverse();
    value.members.reverse();
    expect(
      build(
        { ...value, observedAt: "2026-09-29T12:00:01.000Z" },
        request,
        "2026-09-29T12:00:01.000Z",
      ).digest,
    ).toBe(result.digest);
    expect(build({ ...value, generation: "5" }).digest).not.toBe(result.digest);
  });
  it("accepts genuine empty but refuses nonempty missing generation and exact count gaps", () => {
    const empty = {
      ...raw(),
      generation: null,
      counts: { bundles: "0", versions: "0", groups: "0", members: "0" },
      bundles: [],
      versions: [],
      groups: [],
      members: [],
    };
    expect(build(empty).generation).toBe("0");
    expect(() =>
      parseBundleReferenceSourceSnapshot({ ...build(empty), generation: null }, request, at),
    ).toThrow(denied);
    for (const value of [
      { ...raw(), generation: null },
      { ...raw(), generation: "9223372036854775808" },
      { ...raw(), counts: { ...raw().counts, members: "3" } },
      { ...raw(), counts: { ...raw().counts, bundles: "01" } },
    ])
      expect(() => build(value)).toThrow(denied);
  });
  it.each([
    "pointer",
    "activeDraft",
    "brand",
    "rootDuplicate",
    "versionParent",
    "versionDuplicate",
    "groupParent",
    "memberParent",
    "memberDuplicate",
    "type",
    "precision",
    "publication",
  ])("denies invalid %s coherence", (kind) => {
    const value = raw(),
      root = value.bundles[0],
      version = value.versions[0],
      group = value.groups[0],
      member = value.members[0];
    if (!root || !version || !group || !member) throw new Error("fixture missing");
    if (kind === "pointer") root.currentVersionReference = id(99);
    if (kind === "activeDraft") root.lifecycle = "Published";
    if (kind === "brand") group.brandReference = id(99);
    if (kind === "rootDuplicate") {
      value.bundles.push({ ...root });
      value.counts.bundles = "2";
    }
    if (kind === "versionParent") version.bundleReference = id(99);
    if (kind === "versionDuplicate") {
      value.versions.push({ ...version });
      value.counts.versions = "3";
    }
    if (kind === "groupParent") group.bundleVersionReference = id(99);
    if (kind === "memberParent") member.bundleVersionReference = id(6);
    if (kind === "memberDuplicate") {
      value.members.push({ ...member });
      value.counts.members = "3";
    }
    if (kind === "type") member.sellableType = "Bundle";
    if (kind === "precision") version.precise = false;
    if (kind === "publication") version.publishedAt = at;
    expect(() => build(value)).toThrow(denied);
  });
  it("allows Published current version only for current Published/Suspended/Discontinued roots", () => {
    for (const lifecycle of ["Published", "Suspended", "Discontinued"]) {
      const value = raw(),
        root = value.bundles[0];
      if (!root) throw new Error("fixture missing");
      root.lifecycle = lifecycle;
      root.currentVersionReference = id(6);
      expect(build(value).bundles[0]?.lifecycle).toBe(lifecycle);
    }
  });
  it("rejects wrong original request/digest/metadata, stale clock and executable arrays", () => {
    const result = build(raw());
    for (const value of [
      { ...result, generation: "9" },
      { ...result, request: { ...request, operationReference: id(99) } },
      { ...result, coverage: "Partial" },
      { ...result, digest: "sha256:" + "c".repeat(64) },
    ])
      expect(() => parseBundleReferenceSourceSnapshot(value, request, at)).toThrow(denied);
    expect(() => build(raw(), request, "2026-09-29T12:00:05.001Z")).toThrow(denied);
    expect(() => build(raw(), request, "2026-09-29T11:59:59.999Z")).toThrow(denied);
    const getter = vi.fn(() => id(1)),
      intent = { ...request };
    Object.defineProperty(intent, "brandReference", { enumerable: true, get: getter });
    expect(() => parseBundleReferenceSourceRequest(intent)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
    const value = raw();
    Object.defineProperty(value.members, "0", { enumerable: true, get: getter });
    expect(() => build(value)).toThrow(denied);
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses sparse arrays and the combined graph row budget without truncation", () => {
    expect(() => build({ ...raw(), groups: Array(1) })).toThrow(denied);
    expect(() =>
      build({
        ...raw(),
        bundles: Array(3000).fill(raw().bundles[0]),
        versions: Array(3000).fill(raw().versions[0]),
        groups: Array(3000).fill(raw().groups[0]),
        members: Array(3000).fill(raw().members[0]),
        counts: { bundles: "3000", versions: "3000", groups: "3000", members: "3000" },
      }),
    ).toThrow(denied);
  });
});
function fixture() {
  let now = at,
    generation = "4";
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
  const tx = { query } as unknown as BundleReferenceTransaction;
  const hold = vi.fn(async (actual: BundleReferenceTransaction, input: unknown) => {
    expect(actual).toBe(tx);
    expect(input).toMatchObject({
      request,
      permission: "catalog.manage",
      requiredScope: "FullBrandScope",
      requiredFields: bundleReferenceSourceFields,
    });
  });
  const run = vi.fn(async (work: (tx: BundleReferenceTransaction) => Promise<unknown>) => work(tx));
  const options = {
    tenantReference: id(20),
    brandReference: id(1),
    actorReference: id(2),
    clock: { now: () => now },
    transactions: {
      run: run as <T>(work: (tx: BundleReferenceTransaction) => Promise<T>) => Promise<T>,
    },
    authority: { holdUntilTransactionCompletes: hold },
  };
  return {
    query,
    tx,
    hold,
    run,
    options,
    source: createPostgresBundleReferenceSourceStore(options),
    setNow: (value: string) => {
      now = value;
    },
    setGeneration: (value: string) => {
      generation = value;
    },
  };
}
describe("Bundle graph callback lifetime", () => {
  it("fences the whole Brand before snapshot and rereads generation after final authority", async () => {
    const f = fixture();
    expect(
      await f.source.withCurrentSnapshot(request, async (snapshot) => {
        expect(snapshot.members).toHaveLength(2);
        expect(f.hold).toHaveBeenCalledTimes(2);
        return "value";
      }),
    ).toBe("value");
    expect(f.hold).toHaveBeenCalledTimes(3);
    const lock = f.query.mock.calls.findIndex(([sql]) =>
        sql.includes("pg_advisory_xact_lock_shared"),
      ),
      read = f.query.mock.calls.findIndex(([sql]) => sql.includes("jsonb_build_object"));
    expect(lock).toBeLessThan(read);
    expect(f.query.mock.calls[lock]?.[1]).toEqual(["CatalogBundleReferenceV1:" + id(1)]);
  });
  it("refuses foreign actor and independent full-Brand field denial before SQL", async () => {
    const f = fixture();
    await expect(
      f.source.withCurrentSnapshot({ ...request, actorReference: id(99) }, async () => null),
    ).rejects.toThrow(denied);
    expect(f.run).not.toHaveBeenCalled();
    f.hold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await expect(f.source.withCurrentSnapshot(request, async () => null)).rejects.toThrow(
      expect.objectContaining({ code: "CATALOG_PERMISSION_DENIED" }),
    );
    expect(f.query).not.toHaveBeenCalled();
  });
  it.each(["mutation", "clock", "permission", "callback"])("denies late %s", async (kind) => {
    const f = fixture();
    await expect(
      f.source.withCurrentSnapshot(request, async () => {
        if (kind === "mutation") f.setGeneration("5");
        if (kind === "clock") f.setNow("2026-09-29T12:00:05.001Z");
        if (kind === "permission")
          f.hold.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
        if (kind === "callback") throw new Error("synthetic private failure");
        return "never escape";
      }),
    ).rejects.toThrow(
      expect.objectContaining({
        code:
          kind === "permission" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      }),
    );
  });
  it("rejects stale isolation, bypass/substituted/repeated runner and driver errors", async () => {
    const f = fixture();
    f.query.mockResolvedValueOnce({ rows: [{ isolation: "repeatable read" }] } as never);
    await expect(f.source.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.run.mockResolvedValueOnce({ value: null });
    await expect(f.source.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.run.mockImplementationOnce(async (work) => {
      await work(f.tx);
      return { value: null };
    });
    await expect(f.source.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.run.mockImplementationOnce(async (work) => {
      await work(f.tx);
      return work(f.tx);
    });
    await expect(f.source.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
    f.query.mockRejectedValueOnce(new Error("private driver"));
    await expect(f.source.withCurrentSnapshot(request, async () => null)).rejects.toThrow(denied);
  });
});
