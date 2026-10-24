import { expect, it, vi } from "vitest";
import { CatalogError } from "../contracts/product.js";
import { materializeFullOptionSetCreation } from "../contracts/option-set-full-create.js";
import {
  createPostgresFullOptionSetPublicationSourceAdmissionStore,
  createCatalogFullOptionSetContentSealIntent,
  fullOptionSetPublicationSourceAdmissionFields,
  type FullOptionSetPublicationSourceAction,
  type FullOptionSetPublicationSourceAuthority,
} from "../infrastructure/persistence/option-set-full-draft-store.js";
import {
  parseCatalogOptionSetEditorContent,
  createCatalogFullOptionSetPublicationMaterialization,
} from "../contracts/option-set-editor-content.js";
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
const until = "2026-10-05T00:00:05.000Z";
function fixture(action: FullOptionSetPublicationSourceAction = "SubmitReview") {
  const content = prepared().content,
    { sourceAggregate, ...details } = content;
  const original = parseCatalogOptionSetEditorContent(sourceAggregate, details);
  const request = {
    optionSetReference: id(1),
    versionReference: id(2),
    expectedAggregateVersion: 1,
    sourceDigest: original.sourceDigest,
    contentDigest: original.contentDigest,
    configurationDigest: original.configurationDigest,
  };
  const sealCommand = {
    ...request,
    operationReference: id(90),
    occurredAt: at,
    reasonCode: command.reasonCode,
  };
  const sealIntent = createCatalogFullOptionSetContentSealIntent({
    ...scope,
    command: sealCommand,
  });
  const plan = createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, details, {
    tenantReference: scope.tenantReference,
    brandReference: scope.brandReference,
    optionSetReference: id(1),
    versionReference: id(2),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(90),
    publicationIntentDigest: sealIntent,
    successorDraftVersionReference: id(91),
    sealedAt: at,
    sourceDigest: original.sourceDigest,
    contentDigest: original.contentDigest,
    configurationDigest: original.configurationDigest,
  });
  const state = {
    now: at,
    until,
    denied: false,
    committed: false,
    content,
    sealExists: false,
    sourceOperation: command.operationReference,
    incoherent: false,
    missingFrozen: false,
    duplicateRunner: false,
    substitutedRunner: false,
    expireDuringReviewLock: false,
  };
  const queries: { sql: string; values: readonly unknown[] }[] = [];
  const guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [];
  const inputs: Parameters<
    FullOptionSetPublicationSourceAuthority["holdUntilTransactionCompletes"]
  >[1][] = [];
  const tx: ProductLifecycleTransaction = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      queries.push({ sql, values });
      if (
        state.expireDuringReviewLock &&
        values[0] ===
          "CatalogOptionCurrentReview:" +
            scope.tenantReference +
            ":" +
            scope.brandReference +
            ":" +
            id(1)
      )
        state.now = until;
      let rows: unknown[] = [];
      const { sourceAggregate: current, ...currentDetails } = state.content;
      const actual = parseCatalogOptionSetEditorContent(current, currentDetails);
      if (sql.includes("current_setting('bop.tenant_id',true) tenant"))
        rows = [
          {
            tenant: scope.tenantReference,
            brand: scope.brandReference,
            store: null,
            isolation: "read committed",
          },
        ];
      else if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.startsWith("SELECT jsonb_build_object"))
        rows = [{ aggregate: current, details: currentDetails, coherent: !state.incoherent }];
      else if (sql.includes("FROM rms_catalog.option_set_draft_content_snapshot f JOIN")) {
        if (sql.includes("WHERE f.operation_id=$1"))
          rows = [{ snapshot: content, coherent: !state.incoherent }];
        else
          rows = [
            {
              snapshot: state.content,
              source_digest: actual.sourceDigest,
              content_digest: actual.contentDigest,
              configuration_digest: actual.configurationDigest,
              intent_digest: sealIntent,
              coherent: !state.incoherent,
              sourceOperationReference: state.sourceOperation,
              sourceTenantReference: scope.tenantReference,
              sourceBrandReference: scope.brandReference,
              sourceOptionSetReference: id(1),
              sourceVersionReference: current.draft.versionReference,
              sourceAggregateVersion: current.aggregateVersion,
            },
          ];
      } else if (
        sql.includes("FROM rms_catalog.option_set_publication_content p") &&
        state.sealExists &&
        !state.missingFrozen
      ) {
        rows = [
          {
            snapshot: plan.content,
            coherent: !state.incoherent,
            metadata: {
              tenantReference: scope.tenantReference,
              brandReference: scope.brandReference,
              optionSetReference: id(1),
              versionReference: id(2),
              publicationOperationReference: id(90),
              publicationIntentDigest: sealIntent,
              successorDraftVersionReference: id(91),
              sourceAggregateVersion: 1,
              resultAggregateVersion: 2,
              sealedAt: at,
              sourceDigest: original.sourceDigest,
              contentDigest: original.contentDigest,
              configurationDigest: original.configurationDigest,
              recordDigest: plan.content.digest,
            },
          },
        ];
      } else if (sql.includes("count(*)::text")) rows = [{ n: "1", conflicts: "0" }];
      else if (sql.startsWith("SELECT option_set_id")) rows = [{ option_set_id: id(1) }];
      else if (sql.startsWith("SELECT option_set_version_id"))
        rows = [{ option_set_version_id: current.draft.versionReference }];
      return { rows: rows as readonly Row[], rowCount: rows.length };
    },
  };
  const lease = async (actual: ProductLifecycleTransaction, input: { observedAt: string }) => {
    expect(actual).toBe(tx);
    if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return { observedAt: input.observedAt, validUntil: state.until };
  };
  const options: Parameters<typeof createPostgresFullOptionSetPublicationSourceAdmissionStore>[0] =
    {
      ...scope,
      action,
      operationReference: id(80),
      reasonCode: command.reasonCode,
      originalObservedAt: at,
      originalValidUntil: until,
      clock: { now: () => state.now },
      transactions: {
        async run<T>(work: (actual: ProductLifecycleTransaction) => Promise<T>) {
          const result = await work(tx);
          if (state.duplicateRunner) await work(tx);
          for (const guard of guards) await guard();
          for (const final of finals) final();
          if (state.substitutedRunner) throw new Error("controlled result substitution");
          state.committed = true;
          return result;
        },
      },
      authority: {
        async holdUntilTransactionCompletes(actual, input) {
          inputs.push(input);
          return lease(actual, input);
        },
      },
      currentDraftAuthority: { holdUntilTransactionCompletes: lease },
      registerBeforeCommit: async (actual, guard, final) => {
        expect(actual).toBe(tx);
        guards.push(guard);
        finals.push(final);
      },
      ...(action === "Publish"
        ? { sealCommand, frozenAuthority: { holdUntilTransactionCompletes: lease } }
        : {}),
    };
  const receipt = {
    status: "Applied",
    content: plan.content,
    successorDraftVersionReference: id(91),
    operationReference: id(90),
    referenceEligibility: "NotEvaluated",
  };
  const apply = () => {
    state.content = plan.successorEditorContent;
    state.sourceOperation = id(90);
    state.sealExists = true;
  };
  return {
    options,
    request,
    state,
    inputs,
    tx,
    queries,
    guards,
    finals,
    receipt,
    apply,
    store: () => createPostgresFullOptionSetPublicationSourceAdmissionStore(options),
  };
}
// Actual public parsers/materialization and owning query kernels with controlled
// SQL/authority fixtures. Native source/SRE contention remains a separate gate.
it.each(["SubmitReview", "Approve"] as const)(
  "%s holds only its canonical permission and shared original source",
  async (action) => {
    const f = fixture(action);
    await f.store().withOriginalSource(f.request, async (source) => {
      const sourceLock = f.queries.findIndex(
        (q) => q.values[0] === "CatalogFullOptionSource:" + scope.brandReference + ":" + id(1),
      );
      const reviewLocks = f.queries.filter(
        (q) =>
          q.values[0] ===
          "CatalogOptionCurrentReview:" +
            scope.tenantReference +
            ":" +
            scope.brandReference +
            ":" +
            id(1),
      );
      if (action === "SubmitReview") {
        expect(reviewLocks).toHaveLength(1);
        expect(reviewLocks[0]?.sql).toBe("SELECT pg_advisory_xact_lock(hashtextextended($1,0))");
        const reviewLock = f.queries.findIndex((q) => q === reviewLocks[0]);
        expect(reviewLock).toBeGreaterThan(sourceLock);
        expect(f.queries[reviewLock - 1]).toEqual({
          sql: "SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout',$1,true)",
          values: ["5000"],
        });
      } else expect(reviewLocks).toHaveLength(0);
      expect(source.current.content).toEqual(f.state.content);
      expect(source.current.sourceOperationReference).toBe(command.operationReference);
      expect(source.sealIdentity).toBeNull();
      expect(source.referenceEligibility).toBe("NotEvaluated");
      return "ordinary callback";
    });
    expect(f.state.committed).toBe(true);
    expect(
      f.inputs.every(
        (input) =>
          input.action ===
          (action === "SubmitReview" ? "catalog.option_set.submit" : "catalog.option_set.read"),
      ),
    ).toBe(true);
    expect(
      f.inputs.every(
        (input) => input.requiredFields === fullOptionSetPublicationSourceAdmissionFields,
      ),
    ).toBe(true);
    expect(
      f.queries
        .filter(
          (q) => q.values[0] === "CatalogFullOptionSource:" + scope.brandReference + ":" + id(1),
        )
        .every((q) => q.sql.includes("lock_shared")),
    ).toBe(true);
    expect(f.queries.some((q) => q.values[0] === "CatalogFullOptionOperation:" + id(90))).toBe(
      false,
    );
    expect(f.queries.some((q) => /^(INSERT|UPDATE|DELETE)/.test(q.sql))).toBe(false);
  },
);
it("refuses an expired Submit current-Review lock before reading source or entering Publishing work", async () => {
  const f = fixture("SubmitReview");
  f.state.expireDuringReviewLock = true;
  const work = vi.fn(async () => "Publishing callback");
  await expect(f.store().withOriginalSource(f.request, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(work).not.toHaveBeenCalled();
  expect(f.state.committed).toBe(false);
  expect(f.queries.some((q) => q.sql.startsWith("SELECT jsonb_build_object"))).toBe(false);
});
it("Publish takes exact Seal operation then exclusive source before callback and allows only its owning successor", async () => {
  const f = fixture("Publish");
  await f.store().withOriginalSource(f.request, async (source) => {
    const op = f.queries.findIndex((q) => q.values[0] === "CatalogFullOptionOperation:" + id(90));
    const lock = f.queries.findIndex(
      (q) => q.values[0] === "CatalogFullOptionSource:" + scope.brandReference + ":" + id(1),
    );
    expect(op).toBeGreaterThan(-1);
    expect(lock).toBeGreaterThan(op);
    expect(f.queries[lock]?.sql).not.toContain("lock_shared");
    expect(
      f.queries.some(
        (q) =>
          q.values[0] ===
          "CatalogOptionCurrentReview:" +
            scope.tenantReference +
            ":" +
            scope.brandReference +
            ":" +
            id(1),
      ),
    ).toBe(false);
    expect(source.sealIdentity?.operationReference).toBe(id(90));
    f.apply();
    const proof = await source.admitOwnSeal(f.receipt);
    expect(proof.successor.sourceOperationReference).toBe(id(90));
    expect(proof.successor.content.sourceAggregate.aggregateVersion).toBe(2);
  });
  expect(f.state.committed).toBe(true);
  expect(f.inputs.every((input) => input.action === "catalog.option_set.publish")).toBe(true);
});
it.each([
  "extra-cas",
  "wrong-receipt",
  "missing-receipt",
  "twice",
  "missing-frozen",
  "late-denied",
  "clock-expiry",
  "current-port-change",
  "query-change",
])("refuses exact owning Publish source on %s", async (failure) => {
  const f = fixture("Publish");
  await expect(
    f.store().withOriginalSource(f.request, async (source) => {
      if (failure === "missing-receipt") return;
      f.apply();
      if (failure === "missing-frozen") f.state.missingFrozen = true;
      await source.admitOwnSeal(
        failure === "wrong-receipt" ? { ...f.receipt, operationReference: id(99) } : f.receipt,
      );
      if (failure === "twice") await source.admitOwnSeal(f.receipt);
      if (failure === "extra-cas")
        f.state.content = {
          ...f.state.content,
          sourceAggregate: { ...f.state.content.sourceAggregate, aggregateVersion: 3 },
        };
      if (failure === "late-denied") f.state.denied = true;
      if (failure === "clock-expiry") f.state.now = until;
      if (failure === "current-port-change")
        f.options.currentDraftAuthority.holdUntilTransactionCompletes = async () => ({
          observedAt: at,
          validUntil: until,
        });
      if (failure === "query-change") f.tx.query = async () => ({ rows: [] });
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.state.committed).toBe(false);
});
it.each(["root", "original-op", "late-denied", "rollback-clock", "lease", "nonpublish-seal"])(
  "keeps an original read-only action pinned through COMMIT: %s",
  async (failure) => {
    const f = fixture();
    await expect(
      f.store().withOriginalSource(f.request, async (source) => {
        if (failure === "root") f.apply();
        if (failure === "original-op") f.state.sourceOperation = id(99);
        if (failure === "late-denied") f.state.denied = true;
        if (failure === "rollback-clock") f.state.now = "2026-10-04T23:59:59.999Z";
        if (failure === "lease") f.state.until = at;
        if (failure === "nonpublish-seal") await source.admitOwnSeal(f.receipt);
      }),
    ).rejects.toBeInstanceOf(CatalogError);
    expect(f.state.committed).toBe(false);
  },
);
it.each([
  { ...fixture().request, eligibility: "Pass" },
  { ...fixture().request, expectedAggregateVersion: 0 },
  { ...fixture().request, sourceDigest: "unknown" },
  { ...fixture().request, optionSetReference: id(99) },
])("refuses malformed or foreign original request before a usable callback", async (request) => {
  const f = fixture(),
    work = vi.fn();
  await expect(f.store().withOriginalSource(request, work)).rejects.toBeInstanceOf(CatalogError);
  expect(work).not.toHaveBeenCalled();
});
it("requires original five-second window and each genuine port at construction", () => {
  const f = fixture();
  for (const change of [
    { originalValidUntil: "2026-10-05T00:00:05.001Z" },
    { action: "CallerSelected" },
    { sealCommand: {} },
    { frozenAuthority: {} },
    { authority: {} },
    { currentDraftAuthority: {} },
    { registerBeforeCommit: undefined },
  ]) {
    expect(() =>
      createPostgresFullOptionSetPublicationSourceAdmissionStore({
        ...f.options,
        ...change,
      } as never),
    ).toThrow(CatalogError);
  }
  expect(f.queries).toHaveLength(0);
});
it("rejects unexpected registration results and swallowed guard failures", async () => {
  const f = fixture();
  const options = { ...f.options, registerBeforeCommit: async () => 1 };
  await expect(
    createPostgresFullOptionSetPublicationSourceAdmissionStore(options as never).withOriginalSource(
      f.request,
      async () => undefined,
    ),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.state.committed).toBe(false);
});
it("uses only remaining original-window statement/lock budgets in the new source path", async () => {
  const f = fixture();
  f.state.now = "2026-10-05T00:00:03.000Z";
  await f.store().withOriginalSource(f.request, async () => undefined);
  const values = f.queries.filter((q) => q.sql.includes("set_config('statement_timeout'"));
  expect(values.length).toBeGreaterThan(0);
  expect(
    values.every((q) => !q.sql.includes("60000") && q.values.some((value) => value === "2000")),
  ).toBe(true);
});

it("keeps a swallowed wrong owning receipt poisoned through the original host", async () => {
  const f = fixture("Publish");
  await expect(
    f.store().withOriginalSource(f.request, async (source) => {
      f.apply();
      try {
        await source.admitOwnSeal({ ...f.receipt, operationReference: id(99) });
      } catch (error) {
        expect(error).toBeInstanceOf(CatalogError);
      }
      return "consumer attempted to swallow refusal";
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  expect(f.state.committed).toBe(false);
});
it("never invokes a request accessor", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(1)),
    request = { ...f.request };
  Object.defineProperty(request, "optionSetReference", { enumerable: true, get: getter });
  await expect(f.store().withOriginalSource(request, async () => undefined)).rejects.toBeInstanceOf(
    CatalogError,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(f.queries).toHaveLength(0);
});
it("refuses an early final guard and repeated original admission", async () => {
  const f = fixture(),
    owner = f.store();
  await expect(
    owner.withOriginalSource(f.request, async () => {
      const guard = f.guards[0];
      expect(guard).toBeDefined();
      if (!guard) throw Error("missing synthetic original guard");
      await guard();
    }),
  ).rejects.toBeInstanceOf(CatalogError);
  await expect(owner.withOriginalSource(f.request, async () => undefined)).rejects.toBeInstanceOf(
    CatalogError,
  );
  expect(f.state.committed).toBe(false);
});
