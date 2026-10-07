import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  parseCatalogOptionSetEditorContent,
  type createPostgresCurrentFullOptionSetDraftStore,
} from "@rms/catalog";
import { createMerchantOptionSetCurrentPublicationQuery } from "./merchant-option-set-current-publication-query.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  publishing: vi.fn(),
  graph: vi.fn(),
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => mocks.scope }));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (o: unknown) => mocks.current(o),
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (o: unknown) => mocks.capability(o),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresCurrentFullOptionSetDraftStore: (options: unknown) => ({
    readCurrent: (command: unknown) => mocks.store(options, command),
  }),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: (runner: unknown, tenant: unknown, scope: unknown) => ({
    resolveCurrentOptionSetPublicationStatus: (input: unknown) =>
      mocks.publishing(runner, tenant, scope, input),
  }),
}));
vi.mock("./current-published-option-set-graph.js", () => ({
  createCurrentPublishedOptionSetGraphSource: (options: unknown) => mocks.graph(options),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Owner = Parameters<typeof createPostgresCurrentFullOptionSetDraftStore>[0];
type Tx = Parameters<Owner["authority"]["holdUntilTransactionCompletes"]>[0];
const fields = [
  "optionSetReference",
  "versionReference",
  "defaultLocale",
  "localizedNames",
  "localizedDescriptions",
  "displayStyle",
  "minimumSelection",
  "maximumSelection",
  "allowRepeatedOption",
  "perOptionMaximumQuantity",
  "maximumTotalQuantity",
  "options",
  "optionDetails",
  "conditionalRules",
  "conflictRules",
  "scopeSet",
  "effectivePeriod",
];
function creation() {
  return {
    internalCode: "SYNTH_CHOICES",
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
          stableCode: "CHOICE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic choice" },
          localizedDescriptions: {},
          sortOrder: 0,
          defaultEligible: true,
          triggeredOptionSetReference: null,
          conflictOptionCodes: [],
        },
      ],
    },
    additionalContent: {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [
        {
          stableCode: "CHOICE",
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
    operationReference: id(7),
    occurredAt: at,
    reasonCode: "INITIAL_CONFIGURATION",
  };
}
function full() {
  return materializeFullOptionSetCreation(creation(), {
    brandReference: id(2),
    actorReference: id(4),
    allocations: {
      optionSetReference: id(6),
      versionReference: id(8),
      options: [{ stableCode: "CHOICE", optionReference: id(9) }],
    },
  }).content;
}

// Controlled source ports exercise the actual runtime holder/category host; this is not native IAM/SQL evidence.
function harness(expectedAggregateVersion: number | null = null) {
  const state = {
    now: at,
    deadline: until,
    capabilityDeadline: until,
    allowed: true,
    committed: false,
    commitFails: false,
  };
  const body = { optionSetReference: id(6), expectedAggregateVersion };
  const current = {
      assertCurrent: vi.fn(() => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return state.now;
      }),
      authorizeActions: vi.fn(async () => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
      leaseDeadline: vi.fn(() => state.deadline),
      withCurrentStoreScope: vi.fn(),
    },
    capability = {
      holdUntilCommit: vi.fn(async () => undefined),
      leaseDeadline: vi.fn(() => state.capabilityDeadline),
    };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  let actual: Tx | undefined;
  mocks.scope.mockImplementation(async (tx: Tx) => {
    actual = tx;
    return {
      tenantReference: id(1),
      actorReference: id(4),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
    };
  });
  const owner = async (o: Owner, command: typeof body) =>
    o.transactions.run(async (tx) => {
      expect(tx).toBe(actual);
      expect(command).toEqual(body);
      const content = full(),
        { sourceAggregate, ...details } = content,
        parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details),
        input = {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User" as const,
          permission: "catalog.manage" as const,
          action: "catalog.option_set.read" as const,
          purposeCode: "CATALOG_OPTION_SET_DRAFT" as const,
          requiredFields: [
            "internalCode",
            "brandReference",
            "lifecycle",
            "aggregateVersion",
            "createdAt",
            "createdByActorReference",
            "updatedAt",
            ...fields,
          ],
          optionSetReference: command.optionSetReference,
          observedAt: at,
          content: null as unknown,
        };
      await o.authority.holdUntilTransactionCompletes(tx, input);
      await tx.query("SELECT synthetic_source_port", []);
      if (command.expectedAggregateVersion !== null && command.expectedAggregateVersion !== 1)
        throw new CatalogError("CATALOG_VERSION_CONFLICT");
      const lease = await o.authority.holdUntilTransactionCompletes(tx, { ...input, content });
      return {
        content: parsed.content,
        sourceDigest: parsed.sourceDigest,
        contentDigest: parsed.contentDigest,
        configurationDigest: parsed.configurationDigest,
        observedAt: at,
        validUntil: lease.validUntil,
        referenceEligibility: "NotEvaluated",
      };
    });
  mocks.store.mockImplementation(owner);
  mocks.publishing.mockImplementation(async (runner, tenant, scope, input) => {
    expect(tenant).toBe(id(1));
    expect(scope).toMatchObject({ kind: "Brand", brandReference: id(2), storeReference: null });
    expect(input.familyReference).toBe(id(6));
    return runner.run(async (tx: Tx) => {
      expect(tx).toBe(actual);
      return Object.freeze({
        outcome: "Absent",
        latestRecordedLifecycle: null,
        lastReleaseReference: null,
        observedAt: state.now,
      });
    });
  });
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) },
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    merchant = {
      now: () => state.now,
      transactions: {
        async run<T>(work: (t: typeof tx) => Promise<T>) {
          const value = await work(tx);
          if (state.commitFails) throw Error("Synthetic late host failure");
          state.committed = true;
          return value;
        },
      },
    },
    options = {
      merchant: merchant as unknown as Parameters<
        typeof createMerchantOptionSetCurrentPublicationQuery
      >[0]["merchant"],
      authentication: authentication as unknown as Parameters<
        typeof createMerchantOptionSetCurrentPublicationQuery
      >[0]["authentication"],
    },
    request = {
      sessionCookie: "synthetic-session",
      csrf: "synthetic-csrf",
      expectedScope: { brandReference: id(2), storeReference: id(3) },
      command: body,
    };
  return {
    state,
    body,
    current,
    capability,
    authentication,
    merchant,
    options,
    request,
    owner,
    tx,
    execute: () => createMerchantOptionSetCurrentPublicationQuery(options)(request),
  };
}
it("reads scoped genuine absent publication independently of history admission after actual COMMIT", async () => {
  const h = harness();
  const r = await h.execute();
  expect(h.state.committed).toBe(true);
  expect(r).toMatchObject({
    profile: "CatalogOptionSetCurrentPublicationResultV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    optionSetReference: id(6),
    currentAggregateVersion: 1,
    publicationState: "Absent",
    currentLifecycleReference: null,
    lastReleaseReference: null,
    release: null,
    published: null,
    observedAt: at,
    validUntil: until,
  });
  expect(h.current.authorizeActions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.option_set.read",
  ]);
  expect(mocks.graph).not.toHaveBeenCalled();
  expect(mocks.publishing).toHaveBeenCalledTimes(2);
});
it("source failure remains unavailable rather than guessed absent", async () => {
  const h = harness();
  mocks.publishing.mockRejectedValue(Error("Synthetic source failure"));
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("actual non-current release retains references without showing it as current Published", async () => {
  const h = harness();
  mocks.publishing.mockResolvedValue({
    outcome: "NotCurrentlyPublished",
    lifecycle: { lifecycleId: id(20) },
    lastReleaseReference: id(21),
    observedAt: at,
  });
  expect(await h.execute()).toMatchObject({
    publicationState: "NotCurrentlyPublished",
    currentLifecycleReference: id(20),
    lastReleaseReference: id(21),
    release: null,
    published: null,
  });
  expect(mocks.graph).not.toHaveBeenCalled();
});
it("an absent status cannot change at the final observation", async () => {
  const h = harness();
  mocks.publishing
    .mockResolvedValueOnce({
      outcome: "Absent",
      latestRecordedLifecycle: null,
      lastReleaseReference: null,
      observedAt: at,
    })
    .mockResolvedValueOnce({
      outcome: "NotCurrentlyPublished",
      lifecycle: { lifecycleId: id(20) },
      lastReleaseReference: id(21),
      observedAt: at,
    });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("explicit stale root preserves conflict before publication source reads", async () => {
  const h = harness(2);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(mocks.publishing).not.toHaveBeenCalled();
});
it.each(["brandReference", "storeReference"] as const)(
  "refuses mismatched selected %s",
  async (key) => {
    const h = harness();
    h.request.expectedScope[key] = id(90);
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(mocks.publishing).not.toHaveBeenCalled();
  },
);
it.each([
  { actorReference: id(90) },
  { tenantReference: id(90) },
  { familyReference: id(90) },
  { policyReference: id(90) },
])("rejects caller-owned source substitution %j before authentication", async (extra) => {
  const h = harness();
  h.request.command = { ...h.body, ...extra };
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("actual Feature lease is shortened in the returned observation", async () => {
  const h = harness();
  h.state.capabilityDeadline = after(800);
  expect((await h.execute()).validUntil).toBe(after(800));
});
it("late read permission withdrawal prevents COMMIT", async () => {
  const h = harness();
  mocks.publishing.mockImplementation(async () => {
    h.state.allowed = false;
    return {
      outcome: "Absent",
      latestRecordedLifecycle: null,
      lastReleaseReference: null,
      observedAt: at,
    };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it("the actual host may refuse COMMIT without returning publication content", async () => {
  const h = harness();
  h.state.commitFails = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("authentication cannot renew the original five-second observation", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.state.now = after(5000);
    return { sessionReference: id(5) };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(mocks.publishing).not.toHaveBeenCalled();
});
function publishedHarness() {
  const h = harness();
  const proof = {
    release: {
      releaseId: id(21),
      sequence: 1,
      createdAt: at,
      sourceLifecycleId: id(20),
      snapshotReference: id(8),
      snapshotDigest: "sha256:" + "1".repeat(64),
    },
    lifecycle: { lifecycleId: id(20), version: 4 },
    approvalDisposition: "Approved",
    observedAt: at,
  };
  mocks.publishing.mockImplementation(async (_r, _t, _s, input) => ({
    outcome: "Published",
    proof: { ...proof, observedAt: input.observedAt },
    observedAt: input.observedAt,
  }));
  const graph = {
    profile: "CurrentPublishedOptionSetGraphV1",
    graph: {
      brandReference: id(2),
      rootOptionSetReference: id(6),
      rootVersionReference: id(8),
      contents: [full()],
    },
    sourceRecords: [
      {
        optionSetReference: id(6),
        versionReference: id(8),
        publicationReference: id(21),
        releaseRecordDigest: "sha256:" + "2".repeat(64),
        sealRecordDigest: "sha256:" + "3".repeat(64),
        approvalDisposition: "Approved",
      },
    ],
    graphDigest: "sha256:" + "4".repeat(64),
    rules: { status: "Satisfiable", reason: null, searchNodes: 1 },
    originalObservedAt: at,
    observedAt: at,
    validUntil: until,
    sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  };
  let finalized = false;
  mocks.graph.mockImplementation((o) => ({
    async withCurrentGraph(request: unknown, work: (value: unknown) => Promise<unknown>) {
      expect(request).toEqual({ optionSetReference: id(6), versionReference: id(8) });
      await o.registerBeforeCommit(
        o.transaction,
        async () => {
          expect(h.state.allowed).toBe(true);
        },
        () => {
          finalized = true;
        },
      );
      return work(graph);
    },
    assertFinalized() {
      expect(finalized).toBe(true);
      expect(h.state.committed).toBe(true);
      return h.state.capabilityDeadline;
    },
  }));
  return { h, graph, proof };
}
it("joins the actual release to current Frozen graph and returns only minimal release provenance", async () => {
  const { h, graph } = publishedHarness();
  const r = await h.execute();
  expect(r).toMatchObject({
    publicationState: "Published",
    published: {
      content: graph.graph.contents[0],
      sourceRecords: graph.sourceRecords,
      graphDigest: graph.graphDigest,
      referenceEligibility: "NotEvaluated",
      eligibility: "NotEvaluated",
    },
    release: {
      publicationReference: id(21),
      releaseSequence: 1,
      releasedAt: at,
      lifecycleReference: id(20),
      lifecycleVersion: 4,
      snapshotReference: id(8),
      approvalDisposition: "Approved",
    },
  });
  expect(r).not.toHaveProperty("status");
  expect(r).not.toHaveProperty("proof");
  expect(r).not.toHaveProperty("audit");
});
it("a substituted release identity cannot be joined to current content", async () => {
  const { h, graph } = publishedHarness();
  const rootRecord = graph.sourceRecords[0];
  if (!rootRecord) throw Error("Missing synthetic root record");
  rootRecord.publicationReference = id(90);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("actual finalized graph lease cannot be extended by the response", async () => {
  const { h } = publishedHarness();
  h.state.capabilityDeadline = after(800);
  expect((await h.execute()).published?.validUntil).toBe(after(800));
});
