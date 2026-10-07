import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  assessCatalogOptionSetContentPolicy,
  evaluateCatalogOptionSetRuleSatisfiability,
  parseCatalogOptionSetEditorContent,
  parseCatalogInstant,
  createCatalogOptionSetReviewRecord,
  createCatalogOptionSetContentReviewBinding,
  optionSetReviewRecordFields,
  currentFullOptionSetDraftReviewFields,
  type createPostgresOptionSetReviewContentStore,
} from "@rms/catalog";
import { parseBrandReference } from "@bop/tenant";
import { parseBusinessAction, parsePolicyReference, parsePolicyVersion } from "@bop/permission";
import { createMerchantCategoryTransactions } from "./merchant-category-transactions.js";
import { createCurrentOptionSetPublicationValidationSource } from "./current-option-set-publication-validation.js";

// Composition protocols with real Catalog parsing/rules, not native owner,
// session, Permission or ordinary-command acceptance.
const owners = vi.hoisted(() => ({
  graph: vi.fn(),
  brand: vi.fn(),
  references: vi.fn(),
  recipe: vi.fn(),
  media: vi.fn(),
  review: vi.fn(),
  graphSeal: vi.fn(),
  reviewSeal: vi.fn(),
}));
vi.mock("./current-option-set-publication-draft-graph.js", () => ({
  createCurrentOptionSetPublicationDraftGraphSource: owners.graph,
}));
vi.mock("./current-option-set-publication-brand-policy.js", () => ({
  createCurrentOptionSetPublicationBrandPolicySource: owners.brand,
}));
vi.mock("./current-option-set-publication-price-inventory.js", () => ({
  createCurrentOptionSetPublicationPriceInventorySource: owners.references,
}));
vi.mock("./current-option-set-publication-recipe.js", () => ({
  createCurrentOptionSetPublicationRecipeSource: owners.recipe,
}));
vi.mock("./current-option-set-publication-media.js", () => ({
  createCurrentOptionSetPublicationMediaSource: owners.media,
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<object>()),
  createPostgresOptionSetReviewContentStore: owners.review,
}));
type Options = Parameters<typeof createCurrentOptionSetPublicationValidationSource>[0];
const id = (n: number) => "01902421-8871-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
function content() {
  return parseCatalogOptionSetEditorContent(
    {
      optionSetReference: id(10),
      brandReference: id(2),
      internalCode: "EMPTY_SET",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(4),
      draft: {
        versionReference: id(11),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic set" },
        localizedDescriptions: {},
        displayStyle: "Quantity",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: true,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [],
        createdAt: at,
        updatedAt: at,
      },
    },
    {
      profile: "CatalogOptionSetEditorContentV1",
      optionDetails: [],
      conditionalRules: [],
      conflictRules: [],
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
    },
  );
}
interface Control {
  policyVersion: number;
  extraRecord: boolean;
  now: string;
  lease: string;
  requiredLocales: string[];
  hardFields: string[];
  referenceOutcome: "Pass" | "HardError" | "Indeterminate";
  recipeOutcome: "Pass" | "HardError" | "Indeterminate";
  mediaOutcome: "Pass" | "HardError";
  scopeOutcome: "Pass" | "HardError" | "Indeterminate";
  lateDenial: boolean;
  omitGraph: boolean;
  twice: boolean;
  wrongReturn: boolean;
  foreignBinding: boolean;
}
let state: Control;
let selectedReview: ReturnType<typeof createCatalogOptionSetReviewRecord> | null = null;
beforeEach(() => {
  vi.clearAllMocks();
  selectedReview = null;
  state = {
    policyVersion: 1,
    extraRecord: false,
    now: at,
    lease: until,
    requiredLocales: ["en-CA"],
    hardFields: [],
    referenceOutcome: "Pass",
    recipeOutcome: "Pass",
    mediaOutcome: "Pass",
    scopeOutcome: "Pass",
    lateDenial: false,
    omitGraph: false,
    twice: false,
    wrongReturn: false,
    foreignBinding: false,
  };
  owners.review.mockImplementation(
    (options: Parameters<typeof createPostgresOptionSetReviewContentStore>[0]) => ({
      admitOwnSeal: owners.reviewSeal.mockImplementation(
        async (tx: Options["transaction"], receipt: unknown) => {
          void tx;
          void receipt;
          if (!options.publicationSeal) throw Error("missing fixed Review seal identity");
          return { validUntil: state.lease };
        },
      ),
      async readCurrentReviewForDraft(
        tx: Options["transaction"],
        request: { optionSetReference: string; expectedAggregateVersion: number },
      ) {
        const record = selectedReview;
        const fields = {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(4),
          actorKind: "User" as const,
          permission: "catalog.manage" as const,
          action: "catalog.option_set.read" as const,
          optionSetReference: request.optionSetReference,
          observedAt: state.now,
        };
        if (!options.currentDraftAuthority) throw Error("missing actual draft authority");
        await options.currentDraftAuthority.holdUntilTransactionCompletes(tx, {
          ...fields,
          purposeCode: "CATALOG_OPTION_SET_DRAFT",
          requiredFields: currentFullOptionSetDraftReviewFields,
          content: content().content,
        });
        await options.authority.holdUntilTransactionCompletes(tx, {
          ...fields,
          purposeCode: "CATALOG_OPTION_SET_REVIEW_RECORD",
          requiredFields: optionSetReviewRecordFields,
          record,
          phase: "Read",
        });
        await options.registerBeforeCommit(
          tx,
          async () => {
            if (selectedReview !== record) throw Error("controlled actual review changed");
            await options.authority.holdUntilTransactionCompletes(tx, {
              ...fields,
              observedAt: state.now,
              purposeCode: "CATALOG_OPTION_SET_REVIEW_RECORD",
              requiredFields: optionSetReviewRecordFields,
              record,
              phase: "Read",
            });
          },
          () => {
            if (selectedReview !== record) throw Error("controlled actual review changed");
          },
        );
        return record;
      },
    }),
  );
  owners.graph.mockImplementation((options: Options) => ({
    admitOwnSeal: owners.graphSeal.mockImplementation(async (receipt: unknown) => {
      void receipt;
      if (!options.publicationSeal) throw Error("missing fixed Graph seal identity");
      return { validUntil: state.lease };
    }),
    async withCurrentGraph(_request: unknown, consume: (packet: unknown) => Promise<unknown>) {
      void _request;
      if (state.omitGraph) return undefined;
      const parsed = content(),
        graph = {
          brandReference: id(2),
          rootOptionSetReference: id(10),
          rootVersionReference: id(11),
          contents: [parsed.content],
        };
      const packet = {
        profile: "CurrentOptionSetPublicationDraftGraphV1",
        graph,
        sourceRecords: [],
        sourceOperationReference: id(12),
        sourceSnapshotTuple: {
          tenantReference: id(1),
          brandReference: id(2),
          optionSetReference: id(10),
          versionReference: id(11),
          aggregateVersion: 1,
          sourceDigest: parsed.sourceDigest,
          contentDigest: parsed.contentDigest,
          configurationDigest: parsed.configurationDigest,
        },
        aggregateVersion: 1,
        sourceDigest: parsed.sourceDigest,
        contentDigest: parsed.contentDigest,
        configurationDigest: parsed.configurationDigest,
        graphDigest: evaluateCatalogOptionSetRuleSatisfiability(graph).graphDigest,
        originalObservedAt: options.originalObservedAt,
        observedAt: state.now,
        validUntil: options.originalValidUntil,
      };
      const result = await consume(packet);
      if (state.twice) await consume(packet);
      return state.wrongReturn ? "substituted result" : result;
    },
  }));
  owners.brand.mockImplementation(() => ({
    async withCurrentAssessment(
      input: { graph: { graph: unknown }; binding: Record<string, unknown> },
      consume: (packet: unknown) => Promise<unknown>,
    ) {
      const policy = {
        profile: "PublishingOptionSetPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(20),
        policyReference: id(21),
        policyVersion: state.policyVersion,
        scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
        approvalPolicy: "Required",
        warningOverrideAllowed: false,
        requiredLocales: state.requiredLocales,
        mediaRequirement: "Optional",
        effectiveFrom: at,
        effectiveUntil: null,
      };
      const packet = {
        operationReference: id(9),
        binding: input.binding,
        policy: { currentPublicationReference: id(22), content: policy },
        contentPolicy: assessCatalogOptionSetContentPolicy(
          input.graph.graph,
          policy,
          input.binding,
        ),
        brandConfiguration: { hardRequirementFieldCodes: state.hardFields },
        brandScope: {
          checks: [{ code: "ScopeTopology", outcome: state.scopeOutcome }],
          missingSources: state.scopeOutcome === "Indeterminate" ? ["RegionMembership"] : [],
        },
        validUntil: state.lease,
      };
      const result = await consume(packet);
      if (state.lateDenial) throw Error("controlled late Brand withdrawal");
      return result;
    },
  }));
  for (const [factory, key] of [
    [owners.references, "referenceOutcome"],
    [owners.recipe, "recipeOutcome"],
  ] as const) {
    factory.mockImplementation(() => ({
      async withCurrentAssessment(
        input: { binding: unknown },
        consume: (packet: unknown) => Promise<unknown>,
      ) {
        return consume({
          operationReference: id(9),
          binding: state.foreignBinding ? {} : input.binding,
          validUntil: state.lease,
          standaloneReferenceAssessment: {
            phase: "OptionSetPublication",
            decision: state[key],
            checks: [
              {
                code: "ActualPinnedReferences",
                optionSetReference: id(10),
                optionReference: id(50),
                reference: id(51),
                outcome: state[key],
                reasonCode: "ActualPinnedReferences",
              },
            ],
          },
        });
      },
    }));
  }
  owners.media.mockImplementation(() => ({
    async withCurrentAssessment(
      input: { binding: unknown },
      consume: (packet: unknown) => Promise<unknown>,
    ) {
      return consume({
        operationReference: id(9),
        binding: input.binding,
        validUntil: state.lease,
        nodes: [{ check: { outcome: state.mediaOutcome } }],
      });
    },
  }));
});
function fixture(configure?: (options: Options) => void) {
  let committed = false;
  const host = createMerchantCategoryTransactions({
    async run(work) {
      const result = await work({ query: async () => ({ rows: [] }) });
      committed = true;
      return result;
    },
  });
  const run = async <T>(
    work: Parameters<
      ReturnType<typeof createCurrentOptionSetPublicationValidationSource>["withCurrentValidation"]
    >[1],
    recorded = false,
    afterValidation?: (
      source: ReturnType<typeof createCurrentOptionSetPublicationValidationSource>,
    ) => Promise<void>,
  ) =>
    host.transactions.run(async (tx) => {
      const options: Options = {
        transaction: tx,
        tenantReference: id(1),
        brandReference: id(2),
        storeReference: id(3),
        actorReference: id(4),
        sessionReference: id(5),
        operationReference: id(9),
        originalObservedAt: recorded ? state.now : at,
        originalValidUntil: recorded ? state.lease : until,
        ...(afterValidation
          ? {
              publicationSeal: {
                operationReference: id(70),
                publicationIntentDigest: digest,
                occurredAt: state.now,
              },
            }
          : {}),
        clock: { now: () => state.now },
        registerBeforeCommit: host.registerBeforeCommit,
        currentAuthorization: {
          authorizeActions: async () => undefined,
          assertCurrent: () => parseCatalogInstant(state.now),
          leaseDeadline: () => state.lease,
          async withCurrentStoreScope() {
            throw Error("not an authority fixture");
          },
        },
        capability: { holdUntilCommit: async () => undefined, leaseDeadline: () => state.lease },
        events: { generateReference: () => id(99) },
        policyReference: id(21),
        policyVersion: 1,
        brandConfigurationVersionReference: id(30),
        expectedBrandVersion: 1,
        mediaScope: {
          kind: "Brand",
          brandReference: parseBrandReference(id(2)),
          storeReference: null,
        },
      };
      configure?.(options);
      const source = createCurrentOptionSetPublicationValidationSource(options);
      const p = content();
      const input = {
        graphRequest: {
          optionSetReference: id(10),
          versionReference: id(11),
          expectedAggregateVersion: 1,
          sourceDigest: p.sourceDigest,
          contentDigest: p.contentDigest,
          configurationDigest: p.configurationDigest,
        },
        originalIntentDigest: digest,
        activationAt: at,
      };
      if (recorded) {
        const record = selectedReview;
        if (!record) throw Error("fixture missing expected review");
        const result = await source.withCurrentRecordedReviewValidation(
          {
            graphRequest: input.graphRequest,
            originalIntentDigest: "sha256:" + "b".repeat(64),
            expectedReviewOperationReference: record.operationReference,
            expectedReviewRecordDigest: record.digest,
            expectedReviewBindingDigest: record.binding.digest,
            ...(state.extraRecord ? { record } : {}),
          },
          work,
        );
        if (afterValidation) await afterValidation(source);
        return result as T;
      }
      const result = await source.withCurrentValidation(input, work);
      if (afterValidation) await afterValidation(source);
      return result as T;
    });
  return { run, committed: () => committed };
}
function fullReviewDecisions(actions: readonly string[]) {
  return Object.freeze(
    actions.map((action) =>
      Object.freeze({
        effect: "Allow" as const,
        reason: "ROLE_PERMISSION" as const,
        source: "RolePermission" as const,
        action: parseBusinessAction(action),
        scopeKind: "Brand" as const,
        policySnapshotReference: parsePolicyReference(id(50)),
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
it("takes fresh combined Review decisions at every owning checkpoint without the standalone capability/fine double read", async () => {
  await recordedFixture();
  const standalone = vi.fn(async () => undefined),
    combined = vi.fn(async (actions: readonly string[]) => fullReviewDecisions(actions));
  const f = fixture((options) => {
    Object.defineProperty(options.currentAuthorization, "authorizeActions", { value: standalone });
    Object.defineProperty(options.capability, "holdUntilCommit", { value: standalone });
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      configurable: true,
      value: combined,
    });
  });
  await f.run(async (packet) => packet, true);
  expect(f.committed()).toBe(true);
  expect(standalone).not.toHaveBeenCalled();
  expect(combined.mock.calls.length).toBeGreaterThanOrEqual(4);
  for (const [actions] of combined.mock.calls)
    expect(actions).toEqual(["catalog.manage", "catalog.option_set.read"]);
});
it("rereads actual combined authority before COMMIT and refuses a late withdrawal", async () => {
  await recordedFixture();
  let withdrawn = false;
  const combined = vi.fn(async (actions: readonly string[]) => {
    if (withdrawn) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return fullReviewDecisions(actions);
  });
  const f = fixture((options) =>
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", { value: combined }),
  );
  await expect(
    f.run(async (packet) => {
      withdrawn = true;
      return packet;
    }, true),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.committed()).toBe(false);
  expect(combined.mock.calls.length).toBeGreaterThanOrEqual(2);
});
it("keeps the actual shortened combined lease and refuses a non-Brand Allow", async () => {
  await recordedFixture();
  const shortened = "2026-10-05T12:01:02.000Z";
  const f = fixture((options) =>
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: async (actions: readonly string[]) => {
        state.lease = shortened;
        return fullReviewDecisions(actions);
      },
    }),
  );
  await f.run(async (packet) => {
    expect(packet.validUntil).toBe(shortened);
  }, true);
  const wrongScope = fixture((options) =>
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: async (actions: readonly string[]) =>
        fullReviewDecisions(actions).map((decision) => ({ ...decision, scopeKind: "Store" })),
    }),
  );
  await expect(wrongScope.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(wrongScope.committed()).toBe(false);
});
it("rejects malformed present combined ports and absence-to-presence drift instead of changing admission routes", async () => {
  await recordedFixture();
  const malformed = fixture((options) =>
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", { value: true }),
  );
  await expect(malformed.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  let capability: Options["capability"] | undefined;
  const changed = fixture((options) => {
    capability = options.capability;
  });
  await expect(
    changed.run(async (packet) => {
      if (!capability) throw Error("fixture");
      Object.defineProperty(capability, "holdUntilCommitWithDecisions", {
        value: fullReviewDecisions,
      });
      return packet;
    }, true),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(changed.committed()).toBe(false);
});
it("rejects incomplete combined decision provenance and accessor arrays without executing the accessor", async () => {
  await recordedFixture();
  let accessed = false;
  const malformed = fixture((options) =>
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: async (actions: readonly string[]) =>
        fullReviewDecisions(actions).map((decision) => ({
          ...decision,
          audit: { effect: "Allow", reason: "EXPLICIT_ALLOW", source: "ExplicitAllow" },
        })),
    }),
  );
  await expect(malformed.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  const accessor = fixture((options) =>
    Object.defineProperty(options.capability, "holdUntilCommitWithDecisions", {
      value: async () =>
        Object.defineProperty([undefined, undefined], "0", {
          enumerable: true,
          get() {
            accessed = true;
            throw Error("getter");
          },
        }),
    }),
  );
  await expect(accessor.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(accessed).toBe(false);
});
it("holds one actual graph producer while composing all four review checks and immutable exact review intent", async () => {
  const f = fixture();
  await f.run(async (packet) => {
    expect(packet.decision).toBe("Pass");
    expect(packet.checks).toEqual(
      ["CURRENT_REFERENCES", "PUBLISHING_POLICY", "RULE_SATISFIABILITY", "SCOPE_TOPOLOGY"].map(
        (code) => ({ code, outcome: "Pass" }),
      ),
    );
    expect(packet.reviewBinding.activationAt).toBe(at);
    expect(packet.reviewBinding.currentPolicyPublicationReference).toBe(id(22));
    expect(packet.sourceOperationReference).toBe(id(12));
    expect(packet.independentApproval).toBe("NotEvaluated");
    expect(packet.saleEligibility).toBe("NotEvaluated");
    expect(Object.isFrozen(packet.content)).toBe(true);
    expect(
      Object.values(packet.sourceAssessmentDigests).every((value) =>
        /^sha256:[0-9a-f]{64}$/.test(value),
      ),
    ).toBe(true);
  });
  expect(f.committed()).toBe(true);
  for (const owner of [owners.graph, owners.brand, owners.references, owners.recipe, owners.media])
    expect(owner).toHaveBeenCalledOnce();
  expect(owners.review).not.toHaveBeenCalled();
  expect(owners.graphSeal).not.toHaveBeenCalled();
  expect(owners.reviewSeal).not.toHaveBeenCalled();
});
it.each(["referenceOutcome", "recipeOutcome", "mediaOutcome"] as const)(
  "keeps independent %s HardError instead of overriding it with valid policy",
  async (key) => {
    state[key] = "HardError";
    await fixture().run(async (packet) => {
      expect(packet.decision).toBe("HardError");
      expect(packet.checks.find((c) => c.code === "CURRENT_REFERENCES")?.outcome).toBe("HardError");
    });
  },
);
it("reports actual text policy failure and preserves concrete missing topology or Brand requirement owners", async () => {
  state.requiredLocales = ["fr-CA"];
  state.scopeOutcome = "Indeterminate";
  state.hardFields = ["MISSING_REQUIRED_SOURCE"];
  await fixture().run(async (packet) => {
    expect(packet.decision).toBe("HardError");
    expect(packet.findings).toContainEqual(
      expect.objectContaining({
        checkCode: "SCOPE_TOPOLOGY",
        ruleCode: "RegionMembership",
        outcome: "Indeterminate",
      }),
    );
    expect(packet.findings).toContainEqual(
      expect.objectContaining({
        checkCode: "PUBLISHING_POLICY",
        ruleCode: "BrandHardRequirement:MISSING_REQUIRED_SOURCE",
        outcome: "Indeterminate",
      }),
    );
  });
});
it("preserves the original activation and shortest source lease while real factory clocks advance", async () => {
  state.now = "2026-10-05T12:00:01.000Z";
  state.lease = "2026-10-05T12:00:03.000Z";
  await fixture().run(async (packet) => {
    expect(packet.originalObservedAt).toBe(at);
    expect(packet.reviewBinding.activationAt).toBe(at);
    expect(packet.validUntil).toBe(state.lease);
  });
});
it.each(["lateDenial", "omitGraph", "twice", "wrongReturn", "foreignBinding"] as const)(
  "does not commit after a held source protocol fails: %s",
  async (key) => {
    state[key] = true;
    const f = fixture();
    await expect(f.run(async () => "tentative write")).rejects.toBeDefined();
    expect(f.committed()).toBe(false);
  },
);
it("refuses a shortest-lease expiry swallowed by the consumer before COMMIT", async () => {
  state.lease = "2026-10-05T12:00:02.000Z";
  const f = fixture();
  await expect(
    f.run(async () => {
      state.now = state.lease;
      return "tentative write";
    }),
  ).rejects.toBeDefined();
  expect(f.committed()).toBe(false);
});

async function recordedFixture(activationAt = at) {
  const f = fixture();
  await f.run(async (packet) => {
    const { profile, digest: oldDigest, ...preimage } = packet.reviewBinding;
    void profile;
    void oldDigest;
    selectedReview = createCatalogOptionSetReviewRecord({
      operationReference: id(60),
      sourceOperationReference: packet.sourceOperationReference,
      lifecycleReference: id(61),
      actorReference: id(4),
      auditReference: id(62),
      reasonCode: "AUTHORIZED_OPERATION",
      recordedAt: at,
      binding: createCatalogOptionSetContentReviewBinding({ ...preimage, activationAt }),
      content: packet.content,
    });
  });
  const record = selectedReview;
  if (!record) throw Error("fixture");
  state.now = "2026-10-05T12:01:00.000Z";
  state.lease = "2026-10-05T12:01:05.000Z";
  return { f, record };
}
it("keeps the actual recorded Review target immutable while qualifying at the new command origin", async () => {
  const { f, record } = await recordedFixture();
  await f.run(async (packet) => {
    expect(packet.reviewBinding).toEqual(record.binding);
    expect(packet.recordedReview).toEqual(record);
    expect(packet.qualifiedActivationAt).toBe(state.now);
    expect(packet.qualificationBinding.originalIntentDigest).toBe("sha256:" + "b".repeat(64));
    expect(packet.reviewBinding.originalIntentDigest).toBe(digest);
    expect(packet.qualificationBinding.activationAt).toBe(state.now);
    expect(packet.validUntil).toBe(state.lease);
  }, true);
});
it("preserves the exact future reviewed activation", async () => {
  const future = "2026-10-05T13:00:00.000Z",
    { f, record } = await recordedFixture(future);
  await f.run(async (packet) => {
    expect(packet.qualifiedActivationAt).toBe(future);
    expect(packet.reviewBinding.digest).toBe(record.binding.digest);
  }, true);
});
it("refuses a changed actual Review before COMMIT and preserves the original fresh five-second cap", async () => {
  const { f } = await recordedFixture();
  await expect(
    f.run(async (packet) => {
      selectedReview = null;
      return packet;
    }, true),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  state.now = at;
  state.lease = until;
  const next = await recordedFixture();
  await expect(
    next.f.run(async (packet) => {
      state.now = state.lease;
      return packet;
    }, true),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});

it("rejects changed actual policy rather than retargeting the original Review", async () => {
  const { f } = await recordedFixture();
  state.policyVersion = 2;
  await expect(f.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("rejects actual Review source-operation mismatch", async () => {
  const { f, record } = await recordedFixture();
  const { profile, digest: oldDigest, ...input } = record;
  void profile;
  void oldDigest;
  selectedReview = createCatalogOptionSetReviewRecord({
    ...input,
    sourceOperationReference: id(999),
  });
  await expect(f.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});

it("refuses a caller-supplied Review record even alongside exact identity expectations", async () => {
  const { f } = await recordedFixture();
  state.extraRecord = true;
  await expect(f.run(async (packet) => packet, true)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});

it("forwards actual own Seal only after completed initial qualification", async () => {
  const f = fixture(),
    receipt = { controlledSealReceipt: true };
  await f.run(
    async () => undefined,
    false,
    async (source) => {
      await source.admitOwnSeal(receipt);
    },
  );
  expect(owners.graphSeal).toHaveBeenCalledWith(receipt);
  expect(owners.reviewSeal).not.toHaveBeenCalled();
  expect(f.committed()).toBe(true);
});
it("forwards the same original Seal to actual recorded Review and graph owners", async () => {
  const { f } = await recordedFixture();
  const receipt = { controlledSealReceipt: true };
  await f.run(
    async () => undefined,
    true,
    async (source) => {
      await source.admitOwnSeal(receipt);
    },
  );
  expect(owners.graphSeal).toHaveBeenCalledWith(receipt);
  expect(owners.reviewSeal).toHaveBeenCalledWith(expect.anything(), receipt);
  expect(f.committed()).toBe(true);
});
it("poisons repeated original Seal admission", async () => {
  const f = fixture();
  await expect(
    f.run(
      async () => undefined,
      false,
      async (source) => {
        await source.admitOwnSeal({});
        await source.admitOwnSeal({});
      },
    ),
  ).rejects.toBeDefined();
  expect(f.committed()).toBe(false);
});
