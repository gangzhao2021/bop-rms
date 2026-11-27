import { expect, it, vi } from "vitest";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import {
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogOptionSetEditorContent,
} from "../contracts/option-set-editor-content.js";
import { CatalogError } from "../contracts/product.js";
import { parseCatalogOptionSetHistoricalFrozenResult } from "../contracts/option-set-history.js";
import {
  createPostgresOptionSetHistoryStore,
  optionSetHistoricalDraftFields,
  optionSetHistoricalFrozenFields,
  type OptionSetHistoryStoreOptions,
} from "../infrastructure/persistence/option-set-history-store.js";
import type { ProductLifecycleTransaction as Transaction } from "../infrastructure/persistence/product-lifecycle-store.js";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T00:00:00.000Z",
  until = "2026-10-05T00:00:05.000Z",
  hash = "sha256:" + "a".repeat(64);
function full(revision = 1) {
  const first = materializeFullOptionSetCreation(
    {
      internalCode: "HISTORY",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Original" },
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
            localizedNames: { "en-CA": "One" },
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
      operationReference: id(9),
      occurredAt: at,
      reasonCode: "SYNTHETIC_CONFIGURATION",
    },
    {
      brandReference: id(11),
      actorReference: id(12),
      allocations: {
        optionSetReference: id(1),
        versionReference: id(2),
        options: [{ stableCode: "ONE", optionReference: id(3) }],
      },
    },
  );
  const { sourceAggregate, ...details } = first.content;
  return parseCatalogOptionSetEditorContent(
    {
      ...sourceAggregate,
      aggregateVersion: revision,
      draft: {
        ...sourceAggregate.draft,
        localizedNames: { "en-CA": revision === 1 ? "Original" : "Changed" },
      },
    },
    details,
  );
}
function fixture() {
  const state = {
    clock: at,
    lease: until,
    revision: 2,
    denied: false,
    coherent: true,
    missing: false,
    skipGuard: false,
    repeatGuard: false,
    skipFinal: false,
    committed: false,
    swallow: false,
  };
  const calls: { sql: string; values: readonly unknown[] }[] = [],
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  let selected = full();
  const { sourceAggregate, ...additional } = selected.content;
  const sealed = createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, additional, {
    tenantReference: id(10),
    brandReference: id(11),
    optionSetReference: id(1),
    versionReference: id(2),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(20),
    publicationIntentDigest: hash,
    successorDraftVersionReference: id(21),
    sealedAt: at,
    sourceDigest: selected.sourceDigest,
    contentDigest: selected.contentDigest,
    configurationDigest: selected.configurationDigest,
  }).content;
  let frozen: unknown = sealed;
  let onContent: (() => Promise<void> | void) | undefined;
  let entries: unknown[] = [1, 2].reverse().map((n) => ({
    entry: {
      resultAggregateVersion: n,
      operationReference: id(n + 8),
      kind: "DraftSnapshot",
      action: n === 1 ? "Create" : "ReplaceDraft",
      occurredAt: at,
      availability: "Complete",
      versionReference: id(2),
      sourceAggregateVersion: n,
      sourceDigest: full(n).sourceDigest,
      contentDigest: full(n).contentDigest,
      configurationDigest: full(n).configurationDigest,
      recordDigest: null,
    },
    coherent: true,
  }));
  const tx: Transaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      calls.push({ sql, values });
      let rows: unknown[] = [];
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      if (sql.startsWith("SELECT aggregate_version"))
        rows = [{ aggregate_version: state.revision }];
      if (sql.includes("OptionSetHistoryRosterV1")) rows = entries;
      if (sql.includes("OptionSetHistoricalDraftV1"))
        rows = state.missing
          ? []
          : [
              {
                content: selected.content,
                original: {
                  operationReference: id(9),
                  versionReference: id(2),
                  resultAggregateVersion: 1,
                  action: "Create",
                  intentDigest: hash,
                  occurredAt: at,
                },
                source_digest: selected.sourceDigest,
                content_digest: selected.contentDigest,
                configuration_digest: selected.configurationDigest,
                coherent: state.coherent,
              },
            ];
      if (sql.includes("OptionSetHistoricalFrozenV1"))
        rows = state.missing
          ? []
          : [
              {
                content: frozen,
                original: {
                  operationReference: id(20),
                  versionReference: id(2),
                  resultAggregateVersion: 2,
                  action: "Publish",
                  intentDigest: hash,
                  occurredAt: at,
                },
                source_digest: sealed.sourceDigest,
                content_digest: sealed.contentDigest,
                configuration_digest: sealed.configurationDigest,
                record_digest: sealed.digest,
                coherent: state.coherent,
              },
            ];
      return { rows: rows as readonly Row[] };
    },
  };
  const hold = vi.fn(
    async (
      actual: Transaction,
      input: Parameters<
        OptionSetHistoryStoreOptions["authority"]["holdUntilTransactionCompletes"]
      >[1],
    ) => {
      expect(actual).toBe(tx);
      if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      if (input.content !== null) await onContent?.();
      return { observedAt: input.observedAt, validUntil: state.lease };
    },
  );
  const options: OptionSetHistoryStoreOptions = {
    tenantReference: id(10),
    brandReference: id(11),
    actorReference: id(12),
    clock: { now: () => state.clock },
    originalObservedAt: at,
    originalValidUntil: until,
    authority: { holdUntilTransactionCompletes: hold },
    registerBeforeCommit(actual, guard, final) {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    },
    transactions: {
      async run(work) {
        const result = await work(tx);
        if (!state.skipGuard)
          for (const guard of guards) {
            if (state.swallow) await guard().catch(() => undefined);
            else await guard();
            if (state.repeatGuard) await guard();
          }
        if (!state.skipFinal) for (const final of finals) final();
        state.committed = true;
        return result;
      },
    },
  };
  const store = createPostgresOptionSetHistoryStore(options);
  return {
    state,
    sealed,
    frozenContent: (value: unknown) => {
      frozen = value;
    },
    frozen: {
      optionSetReference: id(1),
      operationReference: id(20),
      versionReference: id(2),
      resultAggregateVersion: 2,
      expectedSourceDigest: sealed.sourceDigest,
      expectedContentDigest: sealed.contentDigest,
      expectedConfigurationDigest: sealed.configurationDigest,
      expectedRecordDigest: sealed.digest,
    },
    calls,
    tx,
    options,
    hold,
    store,
    late: (hook: () => Promise<void> | void) => {
      onContent = hook;
    },
    entries: (v: unknown[]) => {
      entries = v;
    },
    selected: (v: ReturnType<typeof full>) => {
      selected = v;
    },
    request: { optionSetReference: id(1), expectedAggregateVersion: null, before: null, limit: 2 },
    draft: {
      optionSetReference: id(1),
      operationReference: id(9),
      versionReference: id(2),
      resultAggregateVersion: 1,
      expectedSourceDigest: selected.sourceDigest,
      expectedContentDigest: selected.contentDigest,
      expectedConfigurationDigest: selected.configurationDigest,
    },
  };
}
it("returns real controlled immutable headers and same-version edit revisions, never snapshot bodies", async () => {
  const f = fixture(),
    r = await f.store.listHistory(f.request);
  expect(r.entries.map((e) => e.resultAggregateVersion)).toEqual([2, 1]);
  expect(r.entries.map((e) => e.versionReference)).toEqual([id(2), id(2)]);
  expect(f.state.committed).toBe(true);
  expect(f.calls.some((c) => c.sql.includes("snapshot_json content"))).toBe(false);
  expect(f.calls.find((c) => c.sql.includes("RosterV1"))?.values.at(-1)).toBe(3);
  expect(
    f.hold.mock.calls.every(
      ([, i]) =>
        i.action === "catalog.option_set.history.read" &&
        i.purposeCode === "CATALOG_OPTION_SET_HISTORY",
    ),
  ).toBe(true);
});
it("reads the exact old Draft unchanged after later edits under current authority", async () => {
  const f = fixture(),
    r = await f.store.readHistoricalDraft(f.draft);
  expect(r.content.sourceAggregate.aggregateVersion).toBe(1);
  expect(r.content.sourceAggregate.draft.localizedNames["en-CA"]).toBe("Original");
  expect(r.referenceEligibility).toBe("NotEvaluated");
  expect(
    f.hold.mock.calls.some(([, i]) => i.requiredFields === optionSetHistoricalDraftFields),
  ).toBe(true);
  expect(f.calls.find((c) => c.sql.includes("HistoricalDraftV1"))?.values).toEqual([
    id(10),
    id(11),
    id(1),
    id(9),
    id(2),
    1,
  ]);
});
it("uses limit+1 only as a continuation signal and preserves the complete seek tuple", async () => {
  const f = fixture();
  const r = await f.store.listHistory({ ...f.request, limit: 1 });
  expect(r.entries).toHaveLength(1);
  expect(r.nextBefore).toEqual({
    resultAggregateVersion: 2,
    operationReference: id(10),
    kind: "DraftSnapshot",
  });
});
it("refuses continuation when the current root changed", async () => {
  const f = fixture();
  await expect(
    f.store.listHistory({
      ...f.request,
      expectedAggregateVersion: 1,
      before: { resultAggregateVersion: 1, operationReference: id(9), kind: "DraftSnapshot" },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(f.state.committed).toBe(false);
});
it.each(["scope", "digest", "coherence", "missing"])(
  "refuses historical %s substitution instead of returning another snapshot",
  async (kind) => {
    const f = fixture();
    if (kind === "scope") {
      const p = full();
      f.selected(
        parseCatalogOptionSetEditorContent(
          {
            ...p.content.sourceAggregate,
            brandReference: id(99),
            draft: {
              ...p.content.sourceAggregate.draft,
              options: p.content.sourceAggregate.draft.options.map((o) => ({
                ...o,
                brandReference: id(99),
              })),
            },
          },
          (({ sourceAggregate, ...d }) => {
            void sourceAggregate;
            return d;
          })(p.content),
        ),
      );
    }
    if (kind === "coherence") f.state.coherent = false;
    if (kind === "missing") f.state.missing = true;
    await expect(
      f.store.readHistoricalDraft(
        kind === "digest" ? { ...f.draft, expectedSourceDigest: hash } : f.draft,
      ),
    ).rejects.toBeDefined();
    expect(f.state.committed).toBe(false);
  },
);
it.each(["permission", "expiry", "query", "port", "reentry"])(
  "refuses late %s and cannot commit swallowed failures",
  async (kind) => {
    const f = fixture();
    f.late(async () => {
      if (kind === "permission") f.state.denied = true;
      if (kind === "expiry") f.state.clock = until;
      if (kind === "query") f.tx.query = async () => ({ rows: [] });
      if (kind === "port") f.options.clock.now = () => at;
      if (kind === "reentry") await f.store.readHistoricalDraft(f.draft).catch(() => undefined);
    });
    await expect(f.store.readHistoricalDraft(f.draft)).rejects.toBeDefined();
    expect(f.state.committed).toBe(false);
  },
);
it.each(["skipGuard", "repeatGuard", "skipFinal"] as const)(
  "requires actual exactly-once completed host guards: %s",
  async (kind) => {
    const f = fixture();
    f.state[kind] = true;
    if (kind === "skipFinal") {
      await f.store.listHistory(f.request);
      expect(() => f.store.assertFinalized()).toThrow();
    } else await expect(f.store.listHistory(f.request)).rejects.toBeDefined();
  },
);
it("missing both borrowed host hooks cannot pass post-COMMIT final assertion", async () => {
  const f = fixture();
  f.state.skipGuard = true;
  f.state.skipFinal = true;
  await f.store.listHistory(f.request);
  expect(() => f.store.assertFinalized()).toThrow();
});
it("successful actual host guards expose the original shortest final lease", async () => {
  const f = fixture();
  await f.store.listHistory(f.request);
  expect(f.store.assertFinalized()).toBe(until);
});
it("narrows reported lease to the actual authority rather than renewing the original five seconds", async () => {
  const f = fixture();
  f.state.lease = "2026-10-05T00:00:03.000Z";
  expect((await f.store.listHistory(f.request)).validUntil).toBe(f.state.lease);
});
it("retains SQL/shared source locks and prohibits database mutations", async () => {
  const f = fixture();
  await f.store.listHistory(f.request);
  expect(f.calls.some((c) => c.sql.includes("pg_advisory_xact_lock_shared"))).toBe(true);
  expect(f.calls.some((c) => c.sql.endsWith("FOR SHARE"))).toBe(true);
  expect(f.calls.every((c) => !/^\s*(?:INSERT|UPDATE|DELETE|ALTER|CREATE)/iu.test(c.sql))).toBe(
    true,
  );
});
it("a swallowed final authority failure remains poisoned at synchronous completion", async () => {
  const f = fixture();
  let holds = 0;
  f.late(() => {
    if (++holds === 1) f.state.denied = true;
  });
  f.state.swallow = true;
  await expect(f.store.listHistory(f.request)).rejects.toBeDefined();
  expect(f.state.committed).toBe(false);
});
it("actual legacy absence is visible while a present incoherent snapshot is refused", async () => {
  const f = fixture();
  f.entries([
    {
      entry: {
        resultAggregateVersion: 1,
        operationReference: id(9),
        kind: "OperationOnly",
        action: "Create",
        occurredAt: at,
        availability: "UnavailableLegacy",
        versionReference: null,
        sourceAggregateVersion: null,
        sourceDigest: null,
        contentDigest: null,
        configurationDigest: null,
        recordDigest: null,
      },
      coherent: true,
    },
  ]);
  expect((await f.store.listHistory(f.request)).entries[0]?.availability).toBe("UnavailableLegacy");
  const corrupt = fixture();
  corrupt.entries([{ entry: {}, coherent: false }]);
  await expect(corrupt.store.listHistory(corrupt.request)).rejects.toBeDefined();
});
it("every real query uses remaining original timeout, including isolation and root/source locks", async () => {
  const f = fixture();
  f.state.clock = "2026-10-05T00:00:04.000Z";
  await f.store.listHistory(f.request);
  const timeouts = f.calls.filter((c) => c.sql.includes("set_config('lock_timeout'"));
  expect(timeouts.length).toBeGreaterThan(3);
  expect(timeouts.every((c) => c.values[0] === "1000")).toBe(true);
  expect(f.calls.some((c) => c.sql.includes("transaction_isolation"))).toBe(true);
});
it("retains both Frozen and successor Draft headers from the same operation as separate tuples", async () => {
  const f = fixture();
  const p = full(2);
  const base = {
    resultAggregateVersion: 2,
    operationReference: id(10),
    action: "Publish",
    occurredAt: at,
    availability: "Complete",
    sourceDigest: p.sourceDigest,
    contentDigest: p.contentDigest,
    configurationDigest: p.configurationDigest,
  };
  f.entries([
    {
      entry: {
        ...base,
        kind: "FrozenSeal",
        versionReference: id(4),
        sourceAggregateVersion: 1,
        recordDigest: hash,
      },
      coherent: true,
    },
    {
      entry: {
        ...base,
        kind: "DraftSnapshot",
        versionReference: id(2),
        sourceAggregateVersion: 2,
        recordDigest: null,
      },
      coherent: true,
    },
  ]);
  expect(
    (await f.store.listHistory(f.request)).entries.map((e) => [
      e.operationReference,
      e.kind,
      e.versionReference,
    ]),
  ).toEqual([
    [id(10), "FrozenSeal", id(4)],
    [id(10), "DraftSnapshot", id(2)],
  ]);
});
it("rejects corruption even in the look-ahead row instead of issuing a misleading continuation", async () => {
  const f = fixture();
  f.entries([
    {
      entry: {
        resultAggregateVersion: 2,
        operationReference: id(10),
        kind: "DraftSnapshot",
        action: "ReplaceDraft",
        occurredAt: at,
        availability: "Complete",
        versionReference: id(2),
        sourceAggregateVersion: 2,
        sourceDigest: hash,
        contentDigest: hash,
        configurationDigest: hash,
        recordDigest: null,
      },
      coherent: true,
    },
    { entry: {}, coherent: true },
  ]);
  await expect(f.store.listHistory({ ...f.request, limit: 1 })).rejects.toBeDefined();
});

// The controlled transport supplies the actual SQL coherence outcome; these
// predicates bind historical metadata to the owning immutable root, not its
// current editable name or Options.
it.each([
  "s.aggregate_version>=f.result_aggregate_version",
  "f.snapshot_json#>>'{sourceAggregate,internalCode}'=s.internal_code",
  "f.snapshot_json#>>'{sourceAggregate,createdByActorReference}'=s.created_by_actor_id::text",
  "date_trunc('milliseconds',s.created_at)=s.created_at",
  "f.snapshot_json#>>'{sourceAggregate,createdAt}'=to_char(s.created_at AT TIME ZONE 'UTC'",
])("refuses historical immutable-root incoherence: %s", async (predicate) => {
  const f = fixture();
  f.state.coherent = false;
  await expect(f.store.readHistoricalDraft(f.draft)).rejects.toBeDefined();
  const selected = f.calls.find((call) => call.sql.includes("OptionSetHistoricalDraftV1"));
  expect(selected?.sql).toContain(
    "JOIN rms_catalog.option_set s ON s.brand_id=f.brand_id AND s.option_set_id=f.option_set_id",
  );
  expect(selected?.sql).toContain(predicate);
  expect(f.state.committed).toBe(false);
});

it("reads exact recorded Frozen full editor content without claiming Published or today eligibility", async () => {
  const f = fixture();
  const result = await f.store.readHistoricalFrozen(f.frozen);
  expect(result.content).toEqual(f.sealed);
  expect(result.content.editorContent.sourceAggregate.aggregateVersion).toBe(1);
  expect(result.originalTuple.resultAggregateVersion).toBe(2);
  expect(result.recordingStatus).toBe("RecordedFrozen");
  expect(result.referenceEligibility).toBe("NotEvaluated");
  expect(
    f.hold.mock.calls.some(([, input]) => input.requiredFields === optionSetHistoricalFrozenFields),
  ).toBe(true);
  expect(f.store.assertFinalized()).toBe(until);
  const query = f.calls.find((call) => call.sql.includes("OptionSetHistoricalFrozenV1"));
  expect(query?.values).toEqual([id(10), id(11), id(1), id(20), id(2), 2]);
  expect(query?.sql).toContain("v.status='Frozen'");
  expect(query?.sql).toContain("date_trunc('milliseconds',s.created_at)=s.created_at");
});
it.each([
  "operationReference",
  "versionReference",
  "resultAggregateVersion",
  "expectedSourceDigest",
  "expectedContentDigest",
  "expectedConfigurationDigest",
  "expectedRecordDigest",
])("rejects Frozen selection retargeting %s", async (field) => {
  const f = fixture();
  const replacement =
    field === "resultAggregateVersion"
      ? 3
      : field.startsWith("expected")
        ? "sha256:" + "b".repeat(64)
        : id(99);
  await expect(
    f.store.readHistoricalFrozen({ ...f.frozen, [field]: replacement }),
  ).rejects.toBeDefined();
  expect(f.state.committed).toBe(false);
});
it.each([
  "missing",
  "coherent",
  "tamperedRecord",
  "tamperedEditor",
  "latePermission",
  "expired",
  "queryReplacement",
  "skipHooks",
])("rejects Frozen %s without inventing historical content", async (kind) => {
  const f = fixture();
  if (kind === "missing") f.state.missing = true;
  if (kind === "coherent") f.state.coherent = false;
  if (kind === "tamperedRecord") f.frozenContent({ ...f.sealed, digest: hash });
  if (kind === "tamperedEditor") f.frozenContent({ ...f.sealed, editorContent: full(2).content });
  if (kind === "latePermission")
    f.late(() => {
      f.state.denied = true;
    });
  if (kind === "expired")
    f.late(() => {
      f.state.clock = until;
    });
  if (kind === "queryReplacement")
    f.late(() => {
      f.tx.query = async () => ({ rows: [] });
    });
  if (kind === "skipHooks") {
    f.state.skipGuard = true;
    f.state.skipFinal = true;
    await f.store.readHistoricalFrozen(f.frozen);
    expect(() => f.store.assertFinalized()).toThrow();
  } else {
    await expect(f.store.readHistoricalFrozen(f.frozen)).rejects.toBeDefined();
    expect(f.state.committed).toBe(false);
  }
});

it.each([
  "scope",
  "action",
  "intent",
  "time",
  "sourceRevision",
  "recordDigest",
  "publicationClaim",
  "leaseExtension",
])("rejects forged Frozen result %s through the owning public parser", async (kind) => {
  const f = fixture();
  const result = await f.store.readHistoricalFrozen(f.frozen);
  const changed = {
    ...result,
    ...(kind === "scope" ? { brandReference: id(99) } : {}),
    ...(kind === "recordDigest" ? { recordDigest: hash } : {}),
    ...(kind === "publicationClaim" ? { recordingStatus: "Published" } : {}),
    ...(kind === "leaseExtension" ? { validUntil: "2026-10-05T00:00:05.001Z" } : {}),
    originalTuple: {
      ...result.originalTuple,
      ...(kind === "action" ? { action: "ReplaceDraft" } : {}),
      ...(kind === "intent" ? { intentDigest: "sha256:" + "b".repeat(64) } : {}),
      ...(kind === "time" ? { occurredAt: "2026-10-05T00:00:00.001Z" } : {}),
      ...(kind === "sourceRevision" ? { resultAggregateVersion: 1 } : {}),
    },
  };
  expect(() => parseCatalogOptionSetHistoricalFrozenResult(changed, f.frozen)).toThrow();
});
