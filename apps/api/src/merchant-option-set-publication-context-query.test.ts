import {
  createPublishingLifecycleRecord,
  createPublishingValidationEvidence,
  createPublishingScope,
  parsePublishingReference,
  parsePublishingCode,
  parsePublishingDigest,
  parsePublishingVersion,
} from "@bop/publishing";
import { parseCanonicalInstant } from "@bop/tenant";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  materializeFullOptionSetCreation,
  parseCatalogOptionSetEditorContent,
  type createPostgresCurrentFullOptionSetDraftStore,
  currentFullOptionSetDraftReviewFields,
  optionSetReviewRecordFields,
  createCatalogOptionSetContentReviewBinding,
  createCatalogOptionSetReviewRecord,
  type createPostgresOptionSetReviewContentStore,
} from "@rms/catalog";
import { createMerchantOptionSetPublicationContextQuery } from "./merchant-option-set-publication-context-query.js";
const mocks = vi.hoisted(() => ({
  scope: vi.fn(),
  store: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  review: vi.fn(),
  lifecycle: vi.fn(),
  originalReview: vi.fn(),
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
    readCurrentForReview: (command: unknown) => mocks.store(options, command),
  }),
  createPostgresOptionSetReviewContentStore: (options: unknown) => ({
    readCurrentReviewForDraft: (tx: unknown, command: unknown) =>
      mocks.review(options, tx, command),
  }),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: (runner: unknown) => ({
    resolveCurrentLifecycleMutation: (command: unknown) => mocks.lifecycle(runner, command),
    resolveRecordedOptionSetReviewForLifecycle: (command: unknown) =>
      mocks.originalReview(runner, command),
  }),
}));
beforeEach(() => vi.clearAllMocks());
const id = (n: number) => "01902421-7600-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z";
const after = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type Owner = Parameters<typeof createPostgresCurrentFullOptionSetDraftStore>[0];
type Tx = Parameters<Owner["authority"]["holdUntilTransactionCompletes"]>[0];
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

// Controlled owner/admission ports exercise the actual category host; this is not native IAM/SQL evidence.
function harness(
  expectedAggregateVersion: number | null = null,
  action: "Inspect" | "Validate" | "SubmitReview" | "Approve" | "Publish" = "Inspect",
) {
  const state = {
    now: at,
    deadline: until,
    capabilityDeadline: until,
    allowed: true,
    committed: false,
    commitFails: false,
  };
  const body = { optionSetReference: id(6), expectedAggregateVersion, action };
  const current = {
      assertCurrent: vi.fn(() => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return state.now;
      }),
      authorizeActionsWithDecisions: vi.fn(async (actions: readonly string[]) => {
        if (!state.allowed) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return actions.map((action) => ({
          effect: "Allow",
          reason: "ROLE_PERMISSION",
          source: "RolePermission",
          action,
          scopeKind: "Brand",
          policySnapshotReference: id(44),
          policyVersion: 1,
          audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
        }));
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
  const owner = async (o: Owner, command: Omit<typeof body, "action">) =>
    o.transactions.run(async (tx) => {
      expect(tx).toBe(actual);
      const { action: ignored, ...expected } = body;
      void ignored;
      expect(command).toEqual(expected);
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
          requiredFields: currentFullOptionSetDraftReviewFields,
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
        referenceEligibility: "NotEvaluated" as const,
        sourceOperationReference: id(7),
        sourceSnapshotTuple: {
          tenantReference: id(1),
          brandReference: id(2),
          optionSetReference: id(6),
          versionReference: id(8),
          aggregateVersion: 1,
          sourceDigest: parsed.sourceDigest,
          contentDigest: parsed.contentDigest,
          configurationDigest: parsed.configurationDigest,
        },
      };
    });
  mocks.store.mockImplementation(owner);
  mocks.originalReview.mockImplementation(async () => originalReviewFixture());
  mocks.review.mockImplementation(
    async (o: Parameters<typeof createPostgresOptionSetReviewContentStore>[0], tx: Tx) => {
      await o.authority.holdUntilTransactionCompletes(tx, {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User",
        permission: "catalog.manage",
        action: "catalog.option_set.read",
        purposeCode: "CATALOG_OPTION_SET_REVIEW_RECORD",
        phase: "Read",
        optionSetReference: id(6),
        requiredFields: optionSetReviewRecordFields,
        record: null,
        observedAt: state.now,
      });
      return null;
    },
  );

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
        typeof createMerchantOptionSetPublicationContextQuery
      >[0]["merchant"],
      authentication: authentication as unknown as Parameters<
        typeof createMerchantOptionSetPublicationContextQuery
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
    execute: () => createMerchantOptionSetPublicationContextQuery(options)(request),
  };
}

function reviewFixture() {
  const content = full(),
    { sourceAggregate, ...additional } = content,
    p = parseCatalogOptionSetEditorContent(sourceAggregate, additional),
    fingerprint = "sha256:" + "a".repeat(64),
    binding = createCatalogOptionSetContentReviewBinding({
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(6),
      versionReference: id(8),
      expectedAggregateVersion: 1,
      sourceDigest: p.sourceDigest,
      contentDigest: p.contentDigest,
      configurationDigest: p.configurationDigest,
      graphDigest: fingerprint,
      policyReference: id(31),
      policyVersion: 1,
      policyContentDigest: fingerprint,
      currentPolicyPublicationReference: id(32),
      originalIntentDigest: fingerprint,
      activationAt: at,
    }),
    record = createCatalogOptionSetReviewRecord({
      operationReference: id(33),
      sourceOperationReference: id(7),
      lifecycleReference: id(34),
      actorReference: id(35),
      auditReference: id(36),
      reasonCode: "AUTHORIZED_OPERATION",
      recordedAt: at,
      binding,
      content,
    }),
    lifecycle = createPublishingLifecycleRecord({
      lifecycleId: parsePublishingReference(id(34)),
      familyReference: parsePublishingReference(id(6)),
      configurationType: parsePublishingCode("CATALOG_OPTION_SET"),
      purposeCode: parsePublishingCode("CATALOG_OPTION_SET_PUBLICATION"),
      snapshotReference: parsePublishingReference(id(8)),
      snapshotDigest: parsePublishingDigest(binding.digest),
      scope: createPublishingScope({ kind: "Brand", brandReference: id(2), storeReference: null }),
      version: parsePublishingVersion(2),
      state: "InReview",
      validationEvidenceReference: parsePublishingReference(id(37)),
      approvalEvidenceReference: null,
      createdAt: parseCanonicalInstant(at),
      changedAt: parseCanonicalInstant(at),
    });
  return { record, lifecycle };
}
function originalReviewFixture(
  latestLifecycle = reviewFixture().lifecycle,
  latestOperation = id(38),
) {
  const f = reviewFixture();
  return Object.freeze({
    profile: "RecordedOptionSetReviewForLifecycleV1",
    reviewOperationReference: parsePublishingReference(id(38)),
    reviewLifecycle: f.lifecycle,
    submittedActorReference: parsePublishingReference(id(35)),
    submittedAt: parseCanonicalInstant(at),
    originalValidationEvidence: createPublishingValidationEvidence({
      evidenceReference: parsePublishingReference(id(37)),
      snapshotReference: f.lifecycle.snapshotReference,
      snapshotDigest: f.lifecycle.snapshotDigest,
      scope: f.lifecycle.scope,
      result: "Pass",
      checkedAt: parseCanonicalInstant(at),
      validUntil: parseCanonicalInstant(until),
      checkCodes: [parsePublishingCode("CURRENT_REFERENCES")],
    }),
    reviewPolicy: null,
    latestLifecycle,
    latestMutationOperationReference: parsePublishingReference(latestOperation),
    approvalOperationReference: null,
    originalApprovalEvidence: null,
    observedAt: parseCanonicalInstant(at),
    sourceLease: "RequiresCurrentOuterTransactionAuthority",
  });
}
// These are controlled owning ports with real public contract fixtures, not native SQL/IAM acceptance.
it.each([null, 1])(
  "returns truthful absence for current root %s only after actual host commit",
  async (version) => {
    const h = harness(version),
      r = await h.execute();
    expect(h.state.committed).toBe(true);
    expect(r.review).toEqual({ kind: "AbsentForCurrentDraft" });
    expect(r.draft.sourceOperationReference).toBe(id(7));
    expect(r.validUntil).toBe(until);
    expect(mocks.lifecycle).not.toHaveBeenCalled();
    expect(mocks.capability.mock.calls[0]?.[0].capabilityKey).toBe("catalog.cat_optionset_detail");
  },
);
it.each(["Validate", "SubmitReview", "Approve", "Publish"] as const)(
  "%s requests actual fine decisions and Edit Feature",
  async (action) => {
    const h = harness(null, action);
    const r = await h.execute();
    expect(r.action).toBe(action);
    expect(mocks.capability.mock.calls[0]?.[0].capabilityKey).toBe("catalog.cat_optionset_edit");
    const extra =
      action === "SubmitReview"
        ? ["catalog.option_set.submit", "publishing.review.submit"]
        : action === "Approve"
          ? ["publishing.review.approve"]
          : action === "Publish"
            ? ["catalog.option_set.publish", "publishing.release.publish"]
            : [];
    expect(h.current.authorizeActionsWithDecisions).toHaveBeenCalledWith([
      "catalog.manage",
      "catalog.option_set.read",
      ...extra,
    ]);
  },
);
it("discovers recorded current Review and its actual lifecycle, retaining independent submitter", async () => {
  const h = harness(),
    f = reviewFixture();
  mocks.review.mockResolvedValue(f.record);
  mocks.lifecycle.mockImplementation(
    async (runner: { run<T>(work: (tx: Tx) => Promise<T>): Promise<T> }, command: unknown) =>
      runner.run(async () => {
        expect(command).toMatchObject({ familyReference: id(6), lifecycleReference: id(34) });
        return { next: f.lifecycle, idempotencyKey: parsePublishingReference(id(38)) };
      }),
  );
  const r = await h.execute();
  expect(r.review).toMatchObject({
    kind: "Recorded",
    submittedActorReference: id(35),
    publishingReviewOperationReference: id(38),
    lifecycle: f.lifecycle,
  });
  expect(h.state.committed).toBe(true);
});
it.each([
  { action: "Create" },
  { expectedAggregateVersion: 0 },
  { expectedAggregateVersion: 1.5 },
  { optionSetReference: "bad" },
  { actorReference: id(4) },
  { content: {} },
  { observedAt: at },
])("closed body refuses %j before dependencies", async (change) => {
  const h = harness();
  Object.assign(h.request.command, change);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(h.authentication.authorize).not.toHaveBeenCalled();
});
it("explicit stale root is never replaced by latest", async () => {
  const h = harness(2);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_VERSION_CONFLICT" });
  expect(h.state.committed).toBe(false);
});
it.each(["brandReference", "storeReference"] as const)("rejects foreign %s", async (key) => {
  const h = harness();
  h.request.expectedScope[key] = id(99);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(mocks.store).not.toHaveBeenCalled();
});
it.each(["current", "capability"] as const)("requires actual %s deadline observer", async (key) => {
  const h = harness();
  mocks[key].mockReturnValue({ ...h[key], leaseDeadline: undefined });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("requires full decisions rather than legacy void", async () => {
  const h = harness();
  mocks.current.mockReturnValue({ ...h.current, authorizeActionsWithDecisions: undefined });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("shortens response to final real source lease", async () => {
  const h = harness();
  h.current.authorizeActionsWithDecisions.mockImplementation(async (actions) => {
    h.state.deadline = after(800);
    return actions.map((action) => ({
      effect: "Allow",
      reason: "ROLE_PERMISSION",
      source: "RolePermission",
      action,
      scopeKind: "Brand",
      policySnapshotReference: id(44),
      policyVersion: 1,
      audit: { effect: "Allow", reason: "ROLE_PERMISSION", source: "RolePermission" },
    }));
  });
  expect((await h.execute()).validUntil).toBe(after(800));
});
it("late source withdrawal refuses actual COMMIT", async () => {
  const h = harness();
  mocks.review.mockImplementation(async () => {
    h.state.allowed = false;
    return null;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(h.state.committed).toBe(false);
});
it("late host failure returns no context", async () => {
  const h = harness();
  h.state.commitFails = true;
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("authentication latency cannot renew original five seconds", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.state.now = after(5000);
    return { sessionReference: id(5) };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captured body and expected scope resist substitution across await", async () => {
  const h = harness();
  h.authentication.authorize.mockImplementation(async () => {
    h.request.command.optionSetReference = id(99);
    h.request.expectedScope.brandReference = id(99);
    return { sessionReference: id(5) };
  });
  mocks.store.mockImplementation(async (o: Owner, c: Omit<typeof h.body, "action">) => {
    h.request.command.optionSetReference = id(6);
    return h.owner(o, c);
  });
  expect((await h.execute()).draft.optionSetReference).toBe(id(6));
});
it("recorded Review with missing lifecycle fails closed, not Absent", async () => {
  const h = harness();
  mocks.review.mockResolvedValue(reviewFixture().record);
  mocks.lifecycle.mockResolvedValue(null);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("changed current Review before COMMIT is rejected", async () => {
  const h = harness();
  mocks.review.mockResolvedValueOnce(null).mockResolvedValue(reviewFixture().record);
  mocks.lifecycle.mockResolvedValue({
    next: reviewFixture().lifecycle,
    idempotencyKey: parsePublishingReference(id(38)),
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});

it.each(["sourceDigest", "contentDigest", "configurationDigest"])(
  "refuses altered current %s",
  async (key) => {
    const h = harness();
    mocks.store.mockImplementation(async (o: Owner, c: Omit<typeof h.body, "action">) => ({
      ...(await h.owner(o, c)),
      [key]: "sha256:" + "0".repeat(64),
    }));
    await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(h.state.committed).toBe(false);
  },
);
it("refuses foreign provenance tuple", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: Omit<typeof h.body, "action">) => {
    const r = await h.owner(o, c);
    return { ...r, sourceSnapshotTuple: { ...r.sourceSnapshotTuple, tenantReference: id(99) } };
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("refuses duplicate owning runner delegate", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner, c: Omit<typeof h.body, "action">) => {
    await h.owner(o, c);
    return h.owner(o, c);
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("captured admission port cannot be substituted after owning read", async () => {
  const h = harness();
  mocks.review.mockImplementation(async () => {
    h.current.leaseDeadline = vi.fn(() => until);
    return null;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("incomplete permission evidence cannot stand in for owning decision", async () => {
  const h = harness();
  h.current.authorizeActionsWithDecisions.mockResolvedValue([]);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("wrong owning field inventory is refused before source access", async () => {
  const h = harness();
  mocks.store.mockImplementation(async (o: Owner) =>
    o.transactions.run((tx) =>
      o.authority.holdUntilTransactionCompletes(tx, {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User",
        permission: "catalog.manage",
        action: "catalog.option_set.read",
        purposeCode: "CATALOG_OPTION_SET_DRAFT",
        requiredFields: ["internalCode"],
        optionSetReference: id(6),
        content: null,
        observedAt: at,
      }),
    ),
  );
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("expired Feature during read refuses final commit", async () => {
  const h = harness();
  h.state.capabilityDeadline = after(800);
  mocks.review.mockImplementation(async () => {
    h.state.now = after(800);
    return null;
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});

it("returns the actual latest Approve operation rather than guessing the original Review operation", async () => {
  const h = harness(),
    f = reviewFixture(),
    latest = parsePublishingReference(id(39)),
    approved = createPublishingLifecycleRecord({
      ...f.lifecycle,
      version: parsePublishingVersion(3),
      state: "Approved",
      approvalEvidenceReference: parsePublishingReference(id(40)),
    });
  mocks.review.mockResolvedValue(f.record);
  mocks.lifecycle.mockResolvedValue({ next: approved, idempotencyKey: latest });
  mocks.originalReview.mockResolvedValue(originalReviewFixture(approved, latest));
  const result = await h.execute();
  expect(result.review).toMatchObject({
    kind: "Recorded",
    operationReference: f.record.operationReference,
    latestMutationOperationReference: latest,
    publishingReviewOperationReference: id(38),
    lifecycle: approved,
  });
  expect(latest).not.toBe(f.record.operationReference);
  expect(h.state.committed).toBe(true);
});
it("rejects a recorded lifecycle without a valid actual latest mutation identity", async () => {
  const h = harness(),
    f = reviewFixture();
  mocks.review.mockResolvedValue(f.record);
  mocks.lifecycle.mockResolvedValue({ next: f.lifecycle, idempotencyKey: "invalid" });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});

it("rejects Catalog and Publishing submitter mismatch rather than inventing a linked Review", async () => {
  const h = harness(),
    f = reviewFixture();
  mocks.review.mockResolvedValue(f.record);
  mocks.lifecycle.mockResolvedValue({
    next: f.lifecycle,
    idempotencyKey: parsePublishingReference(id(38)),
  });
  mocks.originalReview.mockResolvedValue({
    ...originalReviewFixture(),
    submittedActorReference: parsePublishingReference(id(99)),
  });
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
it("rejects a current Catalog Review lacking actual Publishing Submit history", async () => {
  const h = harness(),
    f = reviewFixture();
  mocks.review.mockResolvedValue(f.record);
  mocks.lifecycle.mockResolvedValue({
    next: f.lifecycle,
    idempotencyKey: parsePublishingReference(id(38)),
  });
  mocks.originalReview.mockResolvedValue(null);
  await expect(h.execute()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(h.state.committed).toBe(false);
});
