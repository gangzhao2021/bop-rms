import { expect, it, vi } from "vitest";
import { CatalogError } from "../contracts/product.js";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import { createPostgresCurrentFullOptionSetDraftStore } from "../infrastructure/persistence/option-set-full-draft-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T00:00:00.000Z",
  scope = { tenantReference: id(11), brandReference: id(10), actorReference: id(40) };
const command = {
  internalCode: "SYNTHETIC_CHOICES",
  draft: {
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic choices" },
    localizedDescriptions: {},
    displayStyle: "MultiChoice",
    minimumSelection: 0,
    maximumSelection: 1,
    allowRepeatedOption: false,
    perOptionMaximumQuantity: 1,
    maximumTotalQuantity: 1,
    options: [
      {
        stableCode: "ONE",
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic one" },
        localizedDescriptions: {},
        sortOrder: 0,
        defaultEligible: false,
        triggeredOptionSetReference: null,
        conflictOptionCodes: [],
      },
    ],
  },
  additionalContent: {
    profile: "CatalogOptionSetEditorContentV1",
    optionDetails: [
      {
        stableCode: "ONE",
        quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
        media: null,
        pricingRule: null,
        consumption: null,
        triggeredOptionSetVersionReference: null,
      },
    ],
    conditionalRules: [],
    conflictRules: [],
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
  },
  operationReference: id(30),
  occurredAt: at,
  reasonCode: "SYNTHETIC_CONFIGURATION",
};
const prepared = () =>
  materializeFullOptionSetCreation(command, {
    brandReference: scope.brandReference,
    actorReference: scope.actorReference,
    allocations: {
      optionSetReference: id(1),
      versionReference: id(2),
      options: [{ stableCode: "ONE", optionReference: id(3) }],
    },
  });
// Controlled owning SQL packets use authentic full-content materialization;
// native PostgreSQL/source-barrier evidence is a separate coordinator gate.
function fixture() {
  const p = prepared(),
    { sourceAggregate, ...details } = p.content;
  const state = {
    originalReads: 0,
    deny: false,
    lateDeny: false,
    change: false,
    missing: false,
    duplicate: false,
    coherent: true,
    clock: at,
    override: {} as Record<string, unknown>,
  };
  const holds: Parameters<
    Parameters<
      typeof createPostgresCurrentFullOptionSetDraftStore
    >[0]["authority"]["holdUntilTransactionCompletes"]
  >[1][] = [];
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    heldTx: unknown[] = [];
  const transaction: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.startsWith("SELECT jsonb_build_object"))
        rows = [{ aggregate: sourceAggregate, details, coherent: true }];
      else if (sql.includes("FROM rms_catalog.option_set_draft_content_snapshot f JOIN")) {
        state.originalReads++;
        const original = {
          snapshot: p.content,
          source_digest: p.sourceDigest,
          content_digest: p.contentDigest,
          configuration_digest: p.configurationDigest,
          intent_digest: "sha256:" + "a".repeat(64),
          coherent: state.coherent,
          ...(sql.includes('"sourceOperationReference"')
            ? {
                sourceOperationReference:
                  state.change && state.originalReads > 1 ? id(31) : command.operationReference,
                sourceTenantReference: scope.tenantReference,
                sourceBrandReference: scope.brandReference,
                sourceOptionSetReference: id(1),
                sourceVersionReference: id(2),
                sourceAggregateVersion: 1,
              }
            : {}),
          ...state.override,
        };
        rows = state.missing ? [] : state.duplicate ? [original, original] : [original];
      } else if (sql.includes("count(*)::text")) rows = [{ n: "1", conflicts: "0" }];
      else if (sql.startsWith("SELECT option_set_id")) rows = [{ option_set_id: id(1) }];
      else if (sql.startsWith("SELECT option_set_version_id"))
        rows = [{ option_set_version_id: id(2) }];
      return { rows: rows as readonly Row[] };
    },
  };
  const run = vi.fn();
  async function runTransaction<T>(
    work: (tx: ProductLifecycleTransaction) => Promise<T>,
  ): Promise<T> {
    run();
    return work(transaction);
  }
  const options = {
    ...scope,
    clock: { now: () => state.clock },
    transactions: { run: runTransaction },
    authority: {
      async holdUntilTransactionCompletes(
        tx: ProductLifecycleTransaction,
        input: (typeof holds)[number],
      ) {
        heldTx.push(tx);
        holds.push(input);
        if (state.deny || (state.lateDeny && holds.length > 1))
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return { observedAt: input.observedAt, validUntil: "2026-10-05T00:00:05.000Z" };
      },
    },
  };
  const store = createPostgresCurrentFullOptionSetDraftStore(options),
    request = { optionSetReference: id(1), expectedAggregateVersion: 1 };
  return { p, state, holds, calls, heldTx, transaction, run, store, request };
}
it("reads the actual original operation and full immutable snapshot tuple in the same locked host", async () => {
  const f = fixture(),
    result = await f.store.readCurrentForReview(f.request);
  expect(result.sourceOperationReference).toBe(command.operationReference);
  expect(result.sourceSnapshotTuple).toEqual({
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(1),
    versionReference: id(2),
    aggregateVersion: 1,
    sourceDigest: f.p.sourceDigest,
    contentDigest: f.p.contentDigest,
    configurationDigest: f.p.configurationDigest,
  });
  expect(result.content).toEqual(f.p.content);
  expect(result.referenceEligibility).toBe("NotEvaluated");
  expect(f.state.originalReads).toBe(2);
  expect(f.run).toHaveBeenCalledTimes(1);
  expect(f.heldTx.every((tx) => tx === f.transaction)).toBe(true);
  expect(Object.isFrozen(result.sourceSnapshotTuple)).toBe(true);
  expect(f.calls.find((c) => c.sql.includes("pg_advisory_xact_lock_shared"))?.values).toEqual([
    "CatalogFullOptionSource:" + scope.brandReference + ":" + id(1),
  ]);
  expect(
    f.calls
      .filter((c) => c.sql.includes("FROM rms_catalog.option_set_draft_content_snapshot f JOIN"))
      .every(
        (c) =>
          JSON.stringify(c.values) ===
          JSON.stringify([id(1), scope.brandReference, scope.tenantReference, 1, id(2), at]),
      ),
  ).toBe(true);
});
it("authorizes explicit provenance fields through every existing read hold", async () => {
  const f = fixture();
  await f.store.readCurrentForReview(f.request);
  expect(f.holds).toHaveLength(3);
  for (const held of f.holds)
    expect(held).toMatchObject({
      ...scope,
      action: "catalog.option_set.read",
      purposeCode: "CATALOG_OPTION_SET_DRAFT",
      requiredFields: expect.arrayContaining([
        "sourceOperationReference",
        "sourceSnapshotTuple",
        "optionDetails",
        "scopeSet",
      ]),
    });
});
it("preserves the exact existing readCurrent result without provenance requirements or SQL columns", async () => {
  const f = fixture(),
    result = await f.store.readCurrent(f.request);
  expect(Object.keys(result).sort()).toEqual(
    [
      "content",
      "sourceDigest",
      "contentDigest",
      "configurationDigest",
      "observedAt",
      "validUntil",
      "referenceEligibility",
    ].sort(),
  );
  expect(result.content).toEqual(f.p.content);
  expect(f.holds.every((h) => !h.requiredFields.includes("sourceOperationReference"))).toBe(true);
  expect(
    f.calls
      .filter((c) => c.sql.includes("FROM rms_catalog.option_set_draft_content_snapshot f JOIN"))
      .every((c) => !c.sql.includes('"sourceOperationReference"')),
  ).toBe(true);
});
it("refuses provenance changing between the two coherent reads even when full content is unchanged", async () => {
  const f = fixture();
  f.state.change = true;
  await expect(f.store.readCurrentForReview(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.state.originalReads).toBe(2);
});
it.each(["missing", "duplicate"] as const)(
  "refuses %s original snapshot rather than synthesizing its operation",
  async (kind) => {
    const f = fixture();
    f.state[kind] = true;
    await expect(f.store.readCurrentForReview(f.request)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it.each([
  { sourceOperationReference: "unknown" },
  { sourceTenantReference: id(90) },
  { sourceBrandReference: id(90) },
  { sourceOptionSetReference: id(90) },
  { sourceVersionReference: id(90) },
  { sourceAggregateVersion: 2 },
  { sourceAggregateVersion: "1" },
  { source_digest: "sha256:" + "b".repeat(64) },
  { configuration_digest: "sha256:" + "b".repeat(64) },
])("refuses mismatched original provenance %j", async (override) => {
  const f = fixture();
  f.state.override = override;
  await expect(f.store.readCurrentForReview(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("rejects broken snapshot-operation coherence", async () => {
  const f = fixture();
  f.state.coherent = false;
  await expect(f.store.readCurrentForReview(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("does not query when the additional provenance fields are denied", async () => {
  const f = fixture();
  f.state.deny = true;
  await expect(f.store.readCurrentForReview(f.request)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(f.calls).toEqual([]);
});
it("does not release original provenance after late permission refusal", async () => {
  const f = fixture();
  f.state.lateDeny = true;
  await expect(f.store.readCurrentForReview(f.request)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
it("rejects a stale expected root", async () => {
  const f = fixture();
  await expect(
    f.store.readCurrentForReview({ ...f.request, expectedAggregateVersion: 2 }),
  ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
});
it("rejects mixed caller provenance without dispatch", async () => {
  const f = fixture();
  await expect(
    f.store.readCurrentForReview({ ...f.request, sourceOperationReference: id(30) }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.run).not.toHaveBeenCalled();
});
