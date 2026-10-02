import { beforeEach, expect, it, vi } from "vitest";
import {
  createPostgresProductValidationCandidateSource,
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
  bindCatalogProductValidationCandidate,
  CatalogError,
} from "../index.js";
const state = vi.hoisted(() => ({ factory: vi.fn(), load: vi.fn() }));
vi.mock("../infrastructure/persistence/product-lifecycle-store.js", async (original) => ({
  ...(await original<object>()),
  createPostgresProductLifecycleStore: (...args: unknown[]) => state.factory(...args),
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T12:50:00.000Z";
type Options = Parameters<typeof createPostgresProductValidationCandidateSource>[0];
type Transaction = Parameters<Options["authority"]["holdUntilTransactionCompletes"]>[0];
beforeEach(() => {
  state.factory.mockReset();
  state.load.mockReset();
});
function fixture() {
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_CODE",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(6),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(7),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC",
  };
  let now = at,
    rows: unknown[] = [{ candidate_matches: true, internal_code_unique: true }],
    deny = false;
  const reads: unknown[][] = [];
  const sql = vi.fn(async (sql: string, values: readonly unknown[]) => {
    if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes(" AS internal_code_unique")) {
      reads.push([...values]);
      return { rows };
    }
    return { rows: [] };
  });
  const tx = { query: sql as unknown as Transaction["query"] },
    hold = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(async () => {
      if (deny) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
  const options: Options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => now },
    authority: { holdUntilTransactionCompletes: hold },
    transactions: { run: async (work) => work(tx) },
  };
  state.factory.mockReturnValue({ load: state.load });
  state.load.mockResolvedValue(aggregate);
  const source = createPostgresProductValidationCandidateSource(options),
    work = vi.fn(
      async (value: Parameters<Parameters<typeof source.withCurrentCandidate>[1]>[0]) => value,
    );
  return {
    source,
    options,
    tx,
    sql,
    hold,
    command,
    aggregate,
    reads,
    work,
    setRows: (v: unknown[]) => {
      rows = v;
    },
    setNow: (v: string) => {
      now = v;
    },
    deny: () => {
      deny = true;
    },
    run: () => source.withCurrentCandidate(command, work),
  };
}
it("uses bounded owning code booleans before/after work; pure binding cannot provide uniqueness", async () => {
  const f = fixture(),
    result = await f.run();
  expect(result.internalCodeCheck).toEqual({ code: "InternalCode", outcome: "Pass" });
  expect(
    Object.hasOwn(
      bindCatalogProductValidationCandidate(f.command, f.aggregate, at),
      "internalCodeCheck",
    ),
  ).toBe(false);
  expect(f.reads).toEqual([
    [id(2), "SYNTHETIC_CODE", id(5)],
    [id(2), "SYNTHETIC_CODE", id(5)],
  ]);
  expect(result.publishValidation).toBe("Incomplete");
  expect(Object.isFrozen(result.internalCodeCheck)).toBe(true);
  expect(f.hold.mock.calls.length).toBeGreaterThan(4);
});
it("actual conflict boolean yields only the owning check, without SKU/qualification Pass", async () => {
  const f = fixture();
  f.setRows([{ candidate_matches: true, internal_code_unique: false }]);
  const result = await f.run();
  expect(result.internalCodeCheck.outcome).toBe("HardError");
  expect(result.skuPrerequisite).toBe("NoActiveMember");
  expect(result.eligibility).toBe("NotEvaluated");
});
it.each(
  [
    [],
    [{}, {}],
    [{ candidate_matches: false, internal_code_unique: true }],
    [{ candidate_matches: true, internal_code_unique: "true" }],
    [{ candidate_matches: true }],
  ].map((rows) => ({ rows })),
)("refuses missing/foreign/malformed owning SQL result $rows", async ({ rows }) => {
  const f = fixture();
  f.setRows(rows);
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
});
it("binds original root/digests before any uniqueness query", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentCandidate({ ...f.command, expectedProductAggregateVersion: 2 }, f.work),
  ).rejects.toThrow();
  expect(f.reads).toHaveLength(0);
  expect(f.work).not.toHaveBeenCalled();
});
it.each(["self", "uniqueness"])("refuses final changed %s after consumer work", async (mode) => {
  const f = fixture();
  await expect(
    f.source.withCurrentCandidate(f.command, async (value) => {
      f.setRows([{ candidate_matches: mode !== "self", internal_code_unique: mode === "self" }]);
      return value;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.reads).toHaveLength(2);
});
it("preserves current field denial after consumer work and original exclusive expiry", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentCandidate(f.command, async (value) => {
      f.deny();
      return value;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  const g = fixture();
  await expect(
    g.source.withCurrentCandidate(g.command, async (value) => {
      g.setNow("2026-10-02T12:50:30.000Z");
      return value;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("has no private code SQL when initial complete authority refuses", async () => {
  const f = fixture();
  f.deny();
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.sql).not.toHaveBeenCalled();
  expect(state.load).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
});
