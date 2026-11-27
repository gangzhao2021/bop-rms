import { beforeEach, expect, it, vi } from "vitest";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  createCatalogFullOptionSetPublicationMaterialization,
  parseCatalogOptionSetEditorContent,
  optionSetHistoryFields,
  optionSetHistoricalDraftFields,
  optionSetHistoricalFrozenFields,
  parseCatalogOptionSetHistoryRequest,
  parseCatalogOptionSetHistoricalDraftRequest,
  parseCatalogOptionSetHistoricalFrozenRequest,
  type OptionSetHistoryStoreOptions,
} from "@rms/catalog";
import {
  PublishingContractError,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
  parsePublishingInstant,
  createPublishingLifecycleRecord,
  createPublishingScope,
  optionSetPublicationHistoryFields,
  type OptionSetPublicationHistoryStoreOptions,
} from "@bop/publishing";
import { createMerchantOptionSetHistoryQuery } from "./merchant-option-set-history-query.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  store: vi.fn(),
  publishing: vi.fn(),
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
  createPostgresOptionSetHistoryStore: (o: unknown) => mocks.store(o),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresOptionSetPublicationHistoryStore: (o: unknown) => mocks.publishing(o),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-9700-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T12:00:00.000Z",
  until = "2026-10-04T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const listCommand = {
  optionSetReference: id(6),
  expectedAggregateVersion: null,
  before: null,
  limit: 10,
};
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

function view(action: "List" | "Draft", validUntil = until) {
  if (action === "List")
    return {
      profile: "CatalogOptionSetHistoryV1",
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(6),
      currentAggregateVersion: 1,
      entries: [
        {
          resultAggregateVersion: 1,
          operationReference: id(7),
          kind: "DraftSnapshot",
          action: "Create",
          occurredAt: at,
          availability: "Complete",
          versionReference: id(8),
          sourceAggregateVersion: 1,
          ...digests(),
          recordDigest: null,
        },
      ],
      nextBefore: null,
      observedAt: at,
      validUntil,
      publicationStatus: "NotEvaluated",
    };
  return {
    profile: "CatalogOptionSetHistoricalDraftV1",
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    originalTuple: {
      operationReference: id(7),
      versionReference: id(8),
      resultAggregateVersion: 1,
      action: "Create",
      intentDigest: "sha256:" + "a".repeat(64),
      occurredAt: at,
    },
    content: full(),
    ...digests(),
    observedAt: at,
    validUntil,
    referenceEligibility: "NotEvaluated",
  };
}
function digests() {
  const { sourceAggregate, ...details } = full();
  const parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details);
  return {
    sourceDigest: parsed.sourceDigest,
    contentDigest: parsed.contentDigest,
    configurationDigest: parsed.configurationDigest,
  };
}
function draftCommand() {
  const d = digests();
  return {
    optionSetReference: id(6),
    operationReference: id(7),
    versionReference: id(8),
    resultAggregateVersion: 1,
    expectedSourceDigest: d.sourceDigest,
    expectedContentDigest: d.contentDigest,
    expectedConfigurationDigest: d.configurationDigest,
  };
}
function decisions(actions: readonly string[]) {
  return Object.freeze(
    actions.map((action) =>
      Object.freeze({
        effect: "Allow" as const,
        reason: "ROLE_PERMISSION" as const,
        source: "RolePermission" as const,
        action: parseBusinessAction(action),
        scopeKind: "Brand" as const,
        policySnapshotReference: parsePolicyReference(id(20)),
        policyVersion: parsePolicyVersion(1),
        audit: Object.freeze({
          effect: "Allow" as const,
          reason: "ROLE_PERMISSION" as const,
          source: "RolePermission" as const,
        }),
      }),
    ),
  );
}

// Actual category transaction host and actual runtime holder, controlled owning source;
// no native SQL, encryption, or external grant evidence is claimed here.
function harness(action: "List" | "Draft" | "Frozen" | "Publishing" | "Compare" = "List") {
  const state = {
    now: at,
    allowed: true,
    committed: false,
    hostFailure: false,
    deadline: until,
    ownerFinal: false,
    omitGuard: false,
    lateShorten: false,
    lateWithdrawal: false,
    publishingFinal: false,
    omitPublishingGuard: false,
    publishingRuns: 0,
    publicationWithdrawal: false,
  };
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  mocks.scope.mockResolvedValue({
    tenantReference: id(1),
    actorReference: id(4),
    selectedStoreReference: id(3),
    context: { brand: { brandReference: id(2) } },
  });
  const current = {
    assertCurrent: () => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return state.now;
    },
    authorizeActions: vi.fn(async () => undefined),
    leaseDeadline: () => state.deadline,
    withCurrentStoreScope: vi.fn(),
  };
  const capability = {
    holdUntilCommit: vi.fn(async () => undefined),
    leaseDeadline: () => state.deadline,
    holdUntilCommitWithDecisions: vi.fn(async (actions: readonly string[]) => {
      if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return decisions(actions);
    }),
  };
  mocks.current.mockReturnValue(current);
  mocks.capability.mockReturnValue(capability);
  const command =
    action === "List"
      ? listCommand
      : action === "Draft"
        ? draftCommand()
        : action === "Frozen"
          ? frozenCommand()
          : action === "Publishing"
            ? { optionSetReference: id(6), before: null, limit: 10 }
            : {
                left: { kind: "Draft", command: draftCommand() },
                right: { kind: "Frozen", command: frozenCommand() },
              };
  const owner = async (o: OptionSetHistoryStoreOptions, body: unknown) =>
    o.transactions.run(async (actual) => {
      const selected =
        typeof body === "object" && body !== null && "before" in body
          ? "List"
          : typeof body === "object" && body !== null && "expectedRecordDigest" in body
            ? "Frozen"
            : "Draft";
      if (action !== "Compare" && action !== "Publishing") expect(body).toEqual(command);
      const result = (lease = until) =>
        selected === "Frozen" ? frozenView(lease) : view(selected, lease);
      let value = result();
      const input = {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User" as const,
        permission: "catalog.manage" as const,
        action: "catalog.option_set.history.read" as const,
        purposeCode: "CATALOG_OPTION_SET_HISTORY" as const,
        requiredFields:
          selected === "List"
            ? optionSetHistoryFields
            : selected === "Draft"
              ? optionSetHistoricalDraftFields
              : optionSetHistoricalFrozenFields,
        request:
          selected === "List"
            ? parseCatalogOptionSetHistoryRequest(body)
            : selected === "Draft"
              ? parseCatalogOptionSetHistoricalDraftRequest(body)
              : parseCatalogOptionSetHistoricalFrozenRequest(body),
        content: null as unknown,
        observedAt: at,
      };
      if (state.lateWithdrawal)
        await o.registerBeforeCommit(
          actual,
          async () => {
            state.allowed = false;
          },
          () => undefined,
        );
      if (!state.omitGuard)
        await o.registerBeforeCommit(
          actual,
          async () => {
            if (state.lateShorten) state.deadline = after(800);
            await o.authority.holdUntilTransactionCompletes(actual, { ...input, content: value });
          },
          () => {
            state.ownerFinal = true;
          },
        );
      const initialLease = await o.authority.holdUntilTransactionCompletes(actual, input);
      value = result(initialLease.validUntil);
      await actual.query("SELECT synthetic_history_source", []);
      const lease = await o.authority.holdUntilTransactionCompletes(actual, {
        ...input,
        content: value,
      });
      value = result(lease.validUntil);
      return value;
    });
  mocks.store.mockImplementation((o: OptionSetHistoryStoreOptions) => ({
    listHistory: (b: unknown) => owner(o, b),
    readHistoricalDraft: (b: unknown) => owner(o, b),
    readHistoricalFrozen: (b: unknown) => owner(o, b),
    assertFinalized: () => {
      if (!state.ownerFinal) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return state.deadline;
    },
  }));
  mocks.publishing.mockImplementation((o: OptionSetPublicationHistoryStoreOptions) => ({
    async list(
      actual: Parameters<OptionSetPublicationHistoryStoreOptions["registerBeforeCommit"]>[0],
      body: { familyReference: string; before: unknown; limit: number },
    ) {
      state.publishingRuns++;
      expect(body).toEqual({ familyReference: id(6), before: null, limit: 10 });
      const input = {
        tenantReference: id(1),
        brandReference: id(2),
        selectedStoreReference: id(3),
        actorReference: id(4),
        actorKind: "User" as const,
        familyReference: id(6),
        permission: "catalog.manage" as const,
        requiredPermissions: ["catalog.manage", "catalog.option_set.history.read"] as const,
        purposeCode: "CATALOG_OPTION_SET_PUBLICATION_HISTORY" as const,
        requiredFields: optionSetPublicationHistoryFields,
        observedAt: at,
        validUntil: until,
      };
      if (!state.omitPublishingGuard)
        await o.registerBeforeCommit(
          actual,
          async () => {
            await o.authority.holdUntilTransactionCompletes(actual, input);
          },
          () => {
            state.publishingFinal = true;
          },
        );
      if (state.publicationWithdrawal) {
        state.allowed = false;
        try {
          await o.authority.holdUntilTransactionCompletes(actual, input);
        } catch {
          throw new PublishingContractError("PUBLISHING_INPUT_INVALID");
        }
      }
      await o.authority.holdUntilTransactionCompletes(actual, input);
      return publishingView();
    },
    assertFinalized() {
      if (!state.publishingFinal) throw Error("Missing real Publishing final guard");
      return state.deadline;
    },
  }));
  const authentication = { authorize: vi.fn(async () => ({ sessionReference: id(5) })) };
  const merchant = {
    now: () => state.now,
    transactions: {
      async run<T>(work: (actual: typeof tx) => Promise<T>) {
        const result = await work(tx);
        if (state.hostFailure) throw Error("Synthetic commit failure");
        state.committed = true;
        return result;
      },
    },
  };
  const options = {
    merchant: merchant as unknown as Parameters<
      typeof createMerchantOptionSetHistoryQuery
    >[0]["merchant"],
    authentication: authentication as unknown as Parameters<
      typeof createMerchantOptionSetHistoryQuery
    >[0]["authentication"],
  };
  const request = {
    sessionCookie: "synthetic-session",
    csrf: "synthetic-csrf",
    expectedScope: { brandReference: id(2), storeReference: id(3) },
    command: { action, command },
  };
  return {
    state,
    tx,
    current,
    capability,
    authentication,
    merchant,
    options,
    request,
    owner,
    execute: () => createMerchantOptionSetHistoryQuery(options)(request),
  };
}
it.each(["List", "Draft"] as const)(
  "returns parsed %s owning history only after real outer host commit and source final",
  async (action) => {
    const h = harness(action);
    const result = await h.execute();
    expect(h.state.committed).toBe(true);
    expect(h.state.ownerFinal).toBe(true);
    expect(result).toMatchObject({
      profile: "CatalogOptionSetHistoryQueryResultV1",
      action,
      storeReference: id(3),
      actorReference: id(4),
      view: {
        tenantReference: id(1),
        brandReference: id(2),
        optionSetReference: id(6),
        validUntil: until,
      },
    });
    expect(h.current.authorizeActions).not.toHaveBeenCalled();
    expect(h.capability.holdUntilCommit).not.toHaveBeenCalled();
  },
);
it("rejects malformed initial request as InputInvalid before authentication", async () => {
  const h = harness();
  Reflect.set(h.request.command, "command", { ...listCommand, limit: 51 });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("rejects foreign selected Brand/Store intent", async () => {
  const h = harness();
  h.request.expectedScope.storeReference = id(99);
  await expect(h.execute()).rejects.toThrow();
  expect(mocks.store).not.toHaveBeenCalled();
});
it("does not return provisional borrowed source result when outer COMMIT fails", async () => {
  const h = harness();
  h.state.hostFailure = true;
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
it("missing owning final guards never become a successful API result", async () => {
  const h = harness();
  h.state.omitGuard = true;
  await expect(h.execute()).rejects.toThrow();
});
it("exposed observation is bounded by final shortened actual lease", async () => {
  const h = harness();
  h.state.lateShorten = true;
  const r = await h.execute();
  expect(r.view.validUntil).toBe(after(800));
});
it("late withdrawal in owning before-COMMIT guard prevents result and commit", async () => {
  const h = harness();
  h.state.lateWithdrawal = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it("rejects a source attempting a second transaction callback", async () => {
  const h = harness();
  mocks.store.mockImplementation((o: OptionSetHistoryStoreOptions) => ({
    listHistory: async (b: unknown) => {
      await h.owner(o, b);
      return h.owner(o, b);
    },
    assertFinalized: () => until,
  }));
  await expect(h.execute()).rejects.toThrow();
  expect(h.state.committed).toBe(false);
});
it("authentication failure and expired or backward original observation fail closed", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.state.now = until;
    return { sessionReference: id(5) };
  });
  await expect(h.execute()).rejects.toThrow();
  const p = harness();
  p.authentication.authorize.mockImplementation(async () => {
    p.state.now = after(-1);
    return { sessionReference: id(5) };
  });
  await expect(p.execute()).rejects.toThrow();
});
it("captures caller packet before awaited authentication", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    Reflect.set(h.request.command, "command", { ...listCommand, optionSetReference: id(99) });
    return { sessionReference: id(5) };
  });
  const result = await h.execute();
  if (result.action !== "List") throw Error("Expected List observation");
  expect(result.view.optionSetReference).toBe(id(6));
});

function frozenContent() {
  const content = full(),
    { sourceAggregate, ...details } = content,
    d = digests();
  return createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, details, {
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    versionReference: id(8),
    sourceAggregateVersion: 1,
    publicationOperationReference: id(10),
    publicationIntentDigest: "sha256:" + "a".repeat(64),
    successorDraftVersionReference: id(11),
    sealedAt: at,
    ...d,
  }).content;
}
function frozenCommand() {
  const content = frozenContent();
  return {
    ...draftCommand(),
    operationReference: id(10),
    resultAggregateVersion: 2,
    expectedRecordDigest: content.digest,
  };
}
function frozenView(validUntil = until) {
  const content = frozenContent();
  return {
    profile: "CatalogOptionSetHistoricalFrozenV1",
    tenantReference: id(1),
    brandReference: id(2),
    optionSetReference: id(6),
    originalTuple: {
      operationReference: id(10),
      versionReference: id(8),
      resultAggregateVersion: 2,
      action: "Publish",
      intentDigest: "sha256:" + "a".repeat(64),
      occurredAt: at,
    },
    content,
    ...digests(),
    recordDigest: content.digest,
    observedAt: at,
    validUntil,
    recordingStatus: "RecordedFrozen",
    referenceEligibility: "NotEvaluated",
  };
}

function publishingView() {
  const lifecycle = createPublishingLifecycleRecord({
    lifecycleId: parsePublishingReference(id(51)),
    familyReference: parsePublishingReference(id(6)),
    configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
    purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
    snapshotReference: parsePublishingReference(id(52)),
    snapshotDigest: parsePublishingDigest("sha256:" + "b".repeat(64)),
    scope: createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null }),
    version: parsePublishingVersion(1),
    state: "Draft",
    validationEvidenceReference: null,
    approvalEvidenceReference: null,
    createdAt: parsePublishingInstant(at),
    changedAt: parsePublishingInstant(at),
  });
  return {
    profile: "PublishingOptionSetHistoryV1",
    scope: {
      tenantReference: id(1),
      brandReference: id(2),
      selectedStoreReference: id(3),
      actorReference: id(4),
    },
    familyReference: id(6),
    entries: [
      {
        operationReference: id(50),
        lifecycleReference: lifecycle.lifecycleId,
        lifecycleVersion: lifecycle.version,
        operation: "CreateDraft",
        actorKind: "User",
        actorReference: id(54),
        occurredAt: lifecycle.changedAt,
        recordedAt: at,
        reasonCode: "PUBLISHING_DRAFT_CREATED",
        fromState: null,
        toState: lifecycle.state,
        snapshotReference: lifecycle.snapshotReference,
        snapshotDigest: lifecycle.snapshotDigest,
        releaseReference: null,
        releaseSequence: null,
        supersededReleaseReference: null,
        rollbackTargetReleaseReference: null,
      },
    ],
    nextBefore: null,
    observedAt: at,
    validUntil: until,
  };
}
it("reads real original Frozen content without substituting successor Draft or Published status", async () => {
  const h = harness("Frozen"),
    result = await h.execute();
  expect(result.action).toBe("Frozen");
  expect(result.view).toMatchObject({
    profile: "CatalogOptionSetHistoricalFrozenV1",
    recordingStatus: "RecordedFrozen",
    originalTuple: { operationReference: id(10), resultAggregateVersion: 2 },
    content: { supportedContent: { versionReference: id(8) } },
  });
  expect(h.state.ownerFinal).toBe(true);
});
it("Publishing joins actual authorized set then original publication headers under the same outer host", async () => {
  const h = harness("Publishing"),
    r = await h.execute();
  expect(h.merchant.transactions.run).toBeDefined();
  expect(h.state.committed).toBe(true);
  expect(h.state.publishingRuns).toBe(1);
  expect(h.state.publishingFinal).toBe(true);
  expect(r.view).toMatchObject({
    profile: "PublishingOptionSetHistoryV1",
    familyReference: id(6),
    entries: [{ actorReference: id(54) }],
  });
  expect(mocks.store).toHaveBeenCalledTimes(1);
});
it("does not accept a Publishing result when its actual final hooks are absent", async () => {
  const h = harness("Publishing");
  h.state.omitPublishingGuard = true;
  await expect(h.execute()).rejects.toThrow();
});
it("compares actual original Draft and Frozen content in one outer transaction and includes both sourceviews", async () => {
  const h = harness("Compare"),
    r = await h.execute();
  expect(r.action).toBe("Compare");
  expect(r.view).toMatchObject({
    profile: "CatalogOptionSetHistoryComparisonV1",
    left: { kind: "Draft", view: { originalTuple: { operationReference: id(7) } } },
    right: {
      kind: "Frozen",
      view: { originalTuple: { operationReference: id(10) }, recordingStatus: "RecordedFrozen" },
    },
    comparison: {
      businessContentChanged: false,
      publicationStatus: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    },
  });
  expect(h.state.committed).toBe(true);
  expect(h.tx.query).toHaveBeenCalledTimes(2);
});
it("rejects caller content or family input before authenticating", async () => {
  for (const action of ["Publishing", "Compare"] as const) {
    const h = harness(action);
    Reflect.set(
      h.request.command,
      "command",
      action === "Publishing"
        ? { optionSetReference: id(6), before: null, limit: 10, familyReference: id(99) }
        : {
            left: { kind: "Draft", command: draftCommand() },
            right: { kind: "Draft", command: draftCommand() },
            content: full(),
          },
    );
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(h.authentication.authorize).not.toHaveBeenCalled();
  }
});
it("comparison cannot cross sets or silently consume altered digest pins", async () => {
  const h = harness("Compare");
  Reflect.set(h.request.command, "command", {
    left: { kind: "Draft", command: draftCommand() },
    right: { kind: "Frozen", command: { ...frozenCommand(), optionSetReference: id(99) } },
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  const p = harness("Frozen");
  Reflect.set(p.request.command, "command", {
    ...frozenCommand(),
    expectedRecordDigest: "sha256:" + "f".repeat(64),
  });
  await expect(p.execute()).rejects.toThrow();
  expect(p.state.committed).toBe(false);
});
it("final comparison lease clamps both retained sourceviews after late shortening", async () => {
  const h = harness("Compare");
  h.state.lateShorten = true;
  const r = await h.execute();
  expect(r.view).toMatchObject({
    validUntil: after(800),
    left: { view: { validUntil: after(800) } },
    right: { view: { validUntil: after(800) } },
  });
});

it("retains actual IAM Denied even when the owning Publishing source bounds its callback error", async () => {
  const h = harness("Publishing");
  h.state.publicationWithdrawal = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it("missing authorized Catalog identity never invokes Publishing history", async () => {
  const h = harness("Publishing");
  mocks.store.mockImplementation(() => ({
    listHistory: async () => {
      throw new CatalogError("CATALOG_UNAVAILABLE");
    },
    assertFinalized: () => until,
  }));
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_UNAVAILABLE" });
  expect(mocks.publishing).not.toHaveBeenCalled();
});
it("a duplicate exact historical selection uses one actual owning read without inventing a second snapshot", async () => {
  const h = harness("Compare");
  Reflect.set(h.request.command, "command", {
    left: { kind: "Draft", command: draftCommand() },
    right: { kind: "Draft", command: draftCommand() },
  });
  const r = await h.execute();
  expect(r.view).toMatchObject({
    left: { kind: "Draft" },
    right: { kind: "Draft" },
    comparison: { businessContentChanged: false },
  });
  expect(h.tx.query).toHaveBeenCalledTimes(1);
});
