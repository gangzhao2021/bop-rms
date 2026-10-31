import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import {
  bindCatalogProductValidationCandidateV2,
  assessCatalogProductContentPolicyV2,
  CatalogError,
  createPostgresProductValidationCandidateSourceV2,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogInstant,
  parseCatalogReference,
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductUniqueScopeAssessmentV2,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  type CatalogCurrentProductValidationCandidateV2,
  type CatalogProductUniqueScopeAssessmentV2,
  type ProductPublicationStoreOptionsV2,
} from "@rms/catalog";
import { createCurrentProductCandidateUniqueScopeSourceV2 } from "./current-product-candidate-unique-scope-v2.js";
import type { CurrentProductUniqueScopeSourceOptionsV2 } from "./current-product-unique-scope-v2.js";
const owners = vi.hoisted(() => ({
  candidate: vi.fn(),
  scope: vi.fn(),
  scopeRead: vi.fn(),
  option: vi.fn(),
  content: vi.fn(),
  optionFactory: vi.fn(),
  contentFactory: vi.fn(),
  variant: vi.fn(),
}));
vi.mock("./current-product-candidate-variant-mapping-v2.js", () => ({
  createCurrentProductCandidateVariantMappingSourceV2: () => ({
    withHeldCandidateAssessment: owners.variant,
  }),
}));
vi.mock("./current-product-candidate-option-rules-v2.js", () => ({
  createCurrentProductCandidateOptionRuleSourceV2: (options: unknown) => {
    owners.optionFactory(options);
    return { withHeldCandidateAssessment: owners.option };
  },
}));
vi.mock("./current-product-held-content-policy-v2.js", () => ({
  createCurrentProductHeldContentPolicySourceV2: (configuration: unknown) => {
    owners.contentFactory(configuration);
    return { withHeldAssessment: owners.content };
  },
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductValidationCandidateSourceV2: owners.candidate,
}));
vi.mock("./current-product-unique-scope-v2.js", () => ({
  createCurrentProductUniqueScopeSourceV2: owners.scope,
}));
type CandidateOptions = Parameters<typeof createPostgresProductValidationCandidateSourceV2>[0];
type Tx = Parameters<ProductPublicationStoreOptionsV2["sources"]["withHeldCurrentFacts"]>[0];
const id = (n: number) => "01902463-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T10:00:00.000Z",
  before = "2026-10-03T09:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
beforeEach(() => {
  owners.candidate.mockReset();
  owners.scope.mockReset();
  owners.scopeRead.mockReset();
  owners.option.mockReset();
  owners.content.mockReset();
  owners.optionFactory.mockReset();
  owners.contentFactory.mockReset();
  owners.variant.mockReset();
});
function fixture(
  complete = true,
  features: { binding?: boolean; option?: boolean; content?: boolean; variant?: boolean } = {},
) {
  let clock = at,
    mode = "normal",
    candidateMilliseconds = 30000,
    scopeMilliseconds = 5000;
  const order: string[] = [],
    binding = {
      bindingReference: id(60),
      optionSetReference: id(61),
      optionSetVersionReference: id(62),
      purpose: "CUSTOMIZATION",
      sortOrder: 0,
      enabledOptionReferences: [],
      defaultSelections: [],
      minimumSelectionOverride: null,
      maximumSelectionOverride: null,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    };
  const aggregate = parseProductAggregate({
      productReference: id(6),
      brandReference: id(2),
      internalCode: "SYNTHETIC_CURRENT",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 4,
      createdAt: before,
      createdByActorReference: id(3),
      updatedAt: before,
      draft: {
        versionReference: id(7),
        baseVersionReference: id(50),
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic complete candidate" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: features.binding ? [binding] : [],
        createdAt: before,
        updatedAt: before,
        ...(complete
          ? {
              editorContent: {
                profile: "CatalogProductEditorContentV1",
                localizedShortDescriptions: {},
                localizedDescriptions: {},
                preparationNotes: {},
                tagReferences: [],
                attributeValues: [],
                media: [],
                variantDimensions: [],
                variantCombinations: [],
                optionRules: features.binding
                  ? [
                      {
                        bindingReference: binding.bindingReference,
                        versionResolution: "Pinned",
                        pricingRule: null,
                        conditionalRule: null,
                        conflictRule: null,
                        variantCondition: [],
                      },
                    ]
                  : [],
                allergenReferences: [],
                nutritionProfile: null,
              },
            }
          : {}),
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    intentBody = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(50),
      previousPublicationOperationReference: id(52),
      expectedPreviousPublicationVersion: 3,
      previousIntentDigest: hash("old command"),
      previousScopeDigest: hash([selector, { ...selector, reference: id(21) }]),
      previousPeriodDigest: hash("old period"),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    replacementIntent = parseCatalogProductScopeReplacementIntent({
      ...intentBody,
      digest: hash(intentBody),
    }),
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(5),
      productReference: id(6),
      versionReference: id(7),
      expectedProductAggregateVersion: 4,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [selector],
      effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(before), effectiveUntil: null },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    }),
    input = { command, policyReference: id(8), policyVersion: 1 },
    tx: Tx = { query: vi.fn(async () => ({ rows: [] })) },
    candidateAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => {
        if (mode === "candidate-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
    },
    validationAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => {
        if (mode === "scope-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
    },
    historyAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => undefined),
    },
    tenantAuthority = { withCurrentBrandReferenceRead: vi.fn(), isCurrent: vi.fn() },
    categoryAssignments = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => undefined),
    },
    policyContent = parsePublishingProductPublicationPolicy({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(80),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA", "fr-CA"],
      mediaRequirement: "Required",
      effectiveFrom: before,
      effectiveUntil: null,
    }),
    policySource = {
      context: {
        tenantReference: parseCatalogReference(id(1)),
        brandReference: parseCatalogReference(id(2)),
        actorReference: parseCatalogReference(id(3)),
        actorKind: "User" as const,
      },
      withCurrentPolicy: vi.fn(async (_actual, request, work) => {
        order.push("policy enter");
        const policy = {
          content:
            mode === "wrong-policy-reference"
              ? { ...policyContent, policyReference: id(99) }
              : mode === "wrong-policy-version"
                ? { ...policyContent, policyVersion: 2 }
                : policyContent,
          currentPublicationReference: mode === "wrong-policy-head" ? id(99) : id(9),
          observedAt: request.observedAt,
          validUntil: new Date(Date.parse(at) + 5000).toISOString(),
        };
        const result = await work(policy);
        if (mode === "caught-double-policy") await work(policy).catch(() => undefined);
        if (mode === "policy-result") return {};
        order.push("policy exit");
        return result;
      }),
    },
    optionAuthority = {
      holdUntilTransactionCompletes: vi.fn(async () => ({
        observedAt: at,
        validUntil: new Date(Date.parse(at) + 3000).toISOString(),
      })),
    },
    contentPolicy = {
      configurationVersionReference: id(70),
      expectedBrandVersion: 1,
      brandAuthority: {
        async withCurrentContentRead<T>(
          _input: unknown,
          _fields: readonly string[],
          work: () => Promise<T>,
        ) {
          return work();
        },
        isCurrent: async () => true,
      },
    };
  // Synthetic acquisition adapters isolate the joined API boundary. Candidate
  // binding/content identity and the closed V2 scope proof parser are real.
  owners.candidate.mockImplementation((options: CandidateOptions) => ({
    async withCurrentCandidate<R>(
      c: unknown,
      work: (candidate: CatalogCurrentProductValidationCandidateV2, actual: Tx) => Promise<R>,
    ) {
      order.push("candidate enter");
      const parsed = parseProductPublicationCommandV2(c),
        observedAt = options.clock.now(),
        hold = () =>
          options.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: id(3),
            actorKind: "User",
            productReference: id(6),
            purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
            permission: "catalog.manage",
            owningAction: "catalog.product.validate",
            requiredFields: [] as unknown as Parameters<
              CandidateOptions["authority"]["holdUntilTransactionCompletes"]
            >[1]["requiredFields"],
            observedAt,
          });
      await hold();
      return options.transactions.run(async (actual) => {
        await options.categoryAssignments?.holdUntilTransactionCompletes(actual, {
          mode: "Read",
          aggregate,
        });
        const candidate: CatalogCurrentProductValidationCandidateV2 = {
          ...bindCatalogProductValidationCandidateV2(parsed, aggregate, observedAt),
          validUntil: parseCatalogInstant(
            new Date(Date.parse(observedAt) + candidateMilliseconds).toISOString(),
          ),
          internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
        };
        if (mode === "distinct-observations") clock = new Date(Date.parse(at) + 1000).toISOString();
        const result = await work(
          candidate,
          mode === "foreign-transaction" ? { query: vi.fn() } : actual,
        );
        if (mode === "double-candidate") await work(candidate, actual);
        if (mode === "caught-double-candidate")
          await work(candidate, actual).catch(() => undefined);
        if (mode === "late-candidate") clock = new Date(Date.parse(at) + 5000).toISOString();
        if (mode === "reverse-candidate") clock = before;
        await hold();
        options.clock.now();
        order.push("candidate exit");
        return mode === "candidate-result" ? ({ substituted: true } as R) : result;
      });
    },
  }));
  owners.scope.mockImplementation((options: CurrentProductUniqueScopeSourceOptionsV2) => ({
    async withCurrentAssessment<R>(
      actual: Tx,
      request: typeof input,
      work: (scope: CatalogProductUniqueScopeAssessmentV2) => Promise<R>,
    ) {
      order.push("scope enter");
      owners.scopeRead(actual, request);
      expect(actual).toBe(tx);
      expect(request.command).toEqual(command);
      const observedAt = options.clock.now();
      await options.validationAuthority.holdUntilTransactionCompletes(tx, {
        command,
        requiredPermissions: ["catalog.product.read", "catalog.product.validate"],
        requiredFields: [] as unknown as Parameters<
          CurrentProductUniqueScopeSourceOptionsV2["validationAuthority"]["holdUntilTransactionCompletes"]
        >[1]["requiredFields"],
        requiredScope: "FullBrandScope",
        observedAt,
      });
      const body = {
          profile: "CatalogProductUniqueScopeAssessmentV2",
          tenantReference: id(1),
          brandReference: id(2),
          productReference: id(6),
          versionReference: id(7),
          aggregateVersion: 4,
          contentDigest: command.contentDigest,
          configurationDigest: command.configurationDigest,
          originalIntentDigest: mode === "wrong-intent" ? hash("V1 downgrade") : hash(command),
          replacementIntentDigest:
            mode === "wrong-target" ? hash("another target") : command.replacementIntentDigest,
          sourceDigest: hash("synthetic coverage"),
          sourceRevision: "4",
          sourceHeadDigest: hash("synthetic heads"),
          registeredStoreDigest: hash("synthetic roster"),
          policyReference: id(8),
          policyVersion: 1,
          policyContentDigest: features.content
            ? publishingProductPublicationPolicyDigest(policyContent)
            : hash("synthetic policy"),
          policyPublicationReference: id(9),
          observedAt,
          validUntil: new Date(Date.parse(observedAt) + scopeMilliseconds).toISOString(),
          check: { code: "UniqueScope", outcome: "Pass" },
          findings: [],
          supportedTopology: "RegisteredBrandStoreOnly",
          equalRankResolution: "ExactStoreSelectorRetirementBound",
          sourceAuthority: "NotEvaluated",
          publishValidation: "Incomplete",
          eligibility: "NotEvaluated",
        },
        assessment = parseCatalogProductUniqueScopeAssessmentV2({ ...body, digest: hash(body) });
      const deliver = async () => {
        const result = await work(assessment);
        if (mode === "double-scope") await work(assessment);
        if (mode === "late-scope") clock = new Date(Date.parse(at) + 5000).toISOString();
        if (mode === "reverse-scope") clock = before;
        options.clock.now();
        order.push("scope exit");
        return mode === "scope-result" ? ({ substituted: true } as R) : result;
      };
      return features.content && mode !== "missing-policy"
        ? options.policySource.withCurrentPolicy(
            actual,
            {
              policyReference: request.policyReference,
              policyVersion: request.policyVersion,
              observedAt,
            },
            deliver,
          )
        : deliver();
    },
  }));
  owners.option.mockImplementation(async (actual, c, candidate, work) => {
    expect(actual).toBe(tx);
    expect(c).toEqual(command);
    order.push("option enter");
    const body = {
        profile: "CurrentProductCandidateOptionRulesV2",
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(6),
        versionReference: id(7),
        aggregateVersion: 4,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        originalIntentDigest: mode === "option-intent" ? hash("downgraded command") : hash(c),
        replacementIntentDigest:
          mode === "option-target" ? hash("other target") : c.replacementIntentDigest,
        candidateObservedAt: candidate.observedAt,
        candidateValidUntil: candidate.validUntil,
        bindingCount: 1,
        bindings: [
          {
            bindingReference: id(60),
            bindingDigest: hash(binding),
            rootOptionSetReference: id(61),
            rootVersionReference: id(62),
            graphDigest: hash("synthetic graph"),
            assessmentDigest: hash("synthetic assessment"),
            rules: {
              status:
                mode === "option-unsatisfiable"
                  ? "Unsatisfiable"
                  : mode === "option-unknown"
                    ? "Indeterminate"
                    : "Satisfiable",
            },
          },
        ],
        validUntil: new Date(Date.parse(at) + 3000).toISOString(),
        publishValidation: "Incomplete",
        referenceEligibility: "NotEvaluated",
        eligibility: "NotEvaluated",
      },
      proof = { ...body, digest: hash(body) },
      result = await work(proof);
    if (mode === "caught-double-option") await work(proof).catch(() => undefined);
    if (mode === "late-option") clock = new Date(Date.parse(at) + 3000).toISOString();
    order.push("option exit");
    return mode === "option-result" ? {} : result;
  });
  owners.content.mockImplementation(async (actual, c, candidate, policy, work) => {
    expect(actual).toBe(tx);
    expect(c).toEqual(command);
    expect(policy.content).toEqual(policyContent);
    order.push("content enter");
    const assessment = assessCatalogProductContentPolicyV2(
      c,
      candidate.aggregate,
      {
        tenantReference: id(1),
        brandReference: id(2),
        brandVersion: 1,
        configurationVersionReference: id(70),
        contentDigest: hash("synthetic Brand"),
        currentPublicationReference: id(71),
        supportedLocales: ["en-CA", "fr-CA"],
        originalIntentDigest: hash(c),
        observedAt: clock,
        validUntil: new Date(Date.parse(at) + 2000).toISOString(),
      },
      policy.content,
      {
        profile: "CatalogProductContentPolicyBindingV2",
        tenantReference: id(1),
        productReference: id(6),
        versionReference: id(7),
        expectedAggregateVersion: 4,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        originalIntentDigest: hash(c),
        replacementIntentDigest: c.replacementIntentDigest,
        observedAt: clock,
        validUntil: new Date(Date.parse(at) + 2000).toISOString(),
      },
    );
    const proof =
        mode === "content-target"
          ? { ...assessment, replacementIntentDigest: hash("another target") }
          : assessment,
      result = await work(proof);
    if (mode === "caught-double-content") await work(proof).catch(() => undefined);
    if (mode === "late-content") clock = new Date(Date.parse(at) + 2000).toISOString();
    if (mode === "content-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
    order.push("content exit");
    return mode === "content-result" ? {} : result;
  });
  owners.variant.mockImplementation(async (actual, c, _candidate, work) => {
    expect(actual).toBe(tx);
    expect(c).toEqual(command);
    return work({
      check: { code: "VariantMapping", outcome: mode === "variant-error" ? "HardError" : "Pass" },
      originalIntentDigest: hash(command),
      replacementIntentDigest: command.replacementIntentDigest,
      historyDigest: hash("synthetic held history"),
      observedAt: at,
      validUntil: "2026-10-03T10:00:01.000Z",
    });
  });
  const options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      candidateAuthority,
      validationAuthority,
      historyAuthority,
      tenantAuthority,
      categoryAssignments,
      policySource,
      clock: { now: () => clock },
      ...(features.option ? { optionAuthority } : {}),
      ...(features.content ? { contentPolicy } : {}),
      ...(features.variant ? { variantHistoryAuthority: historyAuthority } : {}),
    },
    source = createCurrentProductCandidateUniqueScopeSourceV2(options);
  return {
    source,
    options,
    input,
    tx,
    order,
    setMode: (value: string) => {
      mode = value;
    },
    setClock: (value: string) => {
      clock = value;
    },
    setLeases: (candidate: number, scope: number) => {
      candidateMilliseconds = candidate;
      scopeMilliseconds = scope;
    },
  };
}
it("binds full current V2 candidate and retains the complete original scope assessment", async () => {
  const f = fixture(),
    result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
  expect(result).toMatchObject({
    profile: "CurrentProductCandidateUniqueScopeV2",
    currentCandidate: "Bound",
    completeContent: "Present",
    originalIntentDigest: hash(f.input.command),
    replacementIntentDigest: f.input.command.replacementIntentDigest,
    skuPrerequisite: "NoActiveMember",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  });
  expect(result.scopeAssessmentDigest).toBe(result.scopeAssessment.digest);
  expect(result.scopeAssessment.profile).toBe("CatalogProductUniqueScopeAssessmentV2");
  expect(result.digest).not.toBe(result.scopeAssessment.digest);
  expect(result.digest).toBe(
    hash(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "digest"))),
  );
  expect(result.optionRulePrerequisite).toBe("NoMechanicalContradiction");
  expect(result).not.toHaveProperty("optionRulesAssessment");
  expect(owners.option).not.toHaveBeenCalled();
});
it("refuses real incomplete candidate binding before scope history or consumer", async () => {
  const f = fixture(false),
    work = vi.fn();
  await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(owners.scopeRead).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it("keeps distinct observations and minimum original candidate/scope/composition deadline", async () => {
  const f = fixture();
  f.setMode("distinct-observations");
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
  expect(result.candidateObservedAt).toBe(at);
  expect(result.observedAt).toBe("2026-10-03T10:00:01.000Z");
  expect(result.scopeAssessment.validUntil).toBe("2026-10-03T10:00:06.000Z");
  expect(result.validUntil).toBe("2026-10-03T10:00:05.000Z");
  const candidate = fixture();
  candidate.setLeases(2000, 5000);
  expect(
    (
      await candidate.source.withCurrentAssessment(
        candidate.tx,
        candidate.input,
        async (value) => value,
      )
    ).validUntil,
  ).toBe("2026-10-03T10:00:02.000Z");
  const scope = fixture();
  scope.setLeases(30000, 1000);
  expect(
    (await scope.source.withCurrentAssessment(scope.tx, scope.input, async (value) => value))
      .validUntil,
  ).toBe("2026-10-03T10:00:01.000Z");
});
it.each([
  "foreign-transaction",
  "wrong-intent",
  "wrong-target",
  "double-candidate",
  "caught-double-candidate",
  "double-scope",
  "candidate-result",
  "scope-result",
  "late-candidate",
  "reverse-candidate",
  "late-scope",
  "reverse-scope",
])("rejects %s and cannot reuse the failed transaction", async (mode) => {
  const f = fixture();
  f.setMode(mode);
  await expect(
    f.source.withCurrentAssessment(f.tx, f.input, async () => "value"),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  f.setMode("normal");
  await expect(f.source.withCurrentAssessment(f.tx, f.input, vi.fn())).rejects.toThrow();
});
it.each(["candidate-denial", "scope-denial"])(
  "preserves %s and does not invoke the consumer",
  async (mode) => {
    const f = fixture(),
      work = vi.fn();
    f.setMode(mode);
    await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(work).not.toHaveBeenCalled();
  },
);
it("captures configuration and detects query substitution or swallowed reentry", async () => {
  const f = fixture(),
    injected = vi.fn(async () => {
      throw new Error("MUTATED_PORT");
    });
  f.options.candidateAuthority.holdUntilTransactionCompletes = injected;
  f.options.validationAuthority.holdUntilTransactionCompletes = injected;
  f.options.categoryAssignments.holdUntilTransactionCompletes = injected;
  f.options.clock.now = () => before;
  expect(await f.source.withCurrentAssessment(f.tx, f.input, async () => "captured")).toBe(
    "captured",
  );
  expect(injected).not.toHaveBeenCalled();
  for (const mode of ["query", "reentry"]) {
    const g = fixture();
    await expect(
      g.source.withCurrentAssessment(g.tx, g.input, async () => {
        if (mode === "query") g.tx.query = vi.fn();
        else await g.source.withCurrentAssessment(g.tx, g.input, vi.fn()).catch(() => undefined);
        return "value";
      }),
    ).rejects.toThrow();
  }
});
it("rejects V1, supplied facts, foreign owners and getters before candidate acquisition", async () => {
  const base = fixture().input,
    legacy = Object.fromEntries(
      Object.entries(base.command).filter(
        ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
      ),
    ),
    invalid = [
      { ...base, command: legacy },
      ...["aggregate", "candidate", "coverage", "stores", "policy", "approval", "validation"].map(
        (key) => ({ ...base, [key]: {} }),
      ),
      ...["tenantReference", "brandReference", "actorReference"].map((key) => ({
        ...base,
        command: { ...base.command, [key]: id(99) },
      })),
      { ...base, policyVersion: 0 },
    ];
  for (const value of invalid) {
    const f = fixture();
    await expect(f.source.withCurrentAssessment(f.tx, value, vi.fn())).rejects.toThrow();
    expect(f.options.candidateAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  }
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.input, "command", { enumerable: true, get: getter });
  await expect(f.source.withCurrentAssessment(f.tx, f.input, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("nests synthetic Option and content owner adapters around one original policy and keeps each full proof", async () => {
  const f = fixture(true, { binding: true, option: true, content: true });
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (proof) => {
    f.order.push("consumer");
    return proof;
  });
  expect(result.optionRulePrerequisite).toBe("NoMechanicalContradiction");
  expect(result.optionRulesAssessment).toMatchObject({
    profile: "CurrentProductCandidateOptionRulesV2",
    bindingCount: 1,
    originalIntentDigest: hash(f.input.command),
    replacementIntentDigest: f.input.command.replacementIntentDigest,
  });
  expect(result.contentPolicyAssessment).toMatchObject({
    profile: "CatalogProductContentPolicyAssessmentV2",
    decision: "HardError",
    originalIntentDigest: hash(f.input.command),
    replacementIntentDigest: f.input.command.replacementIntentDigest,
    mediaReadiness: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(result.validUntil).toBe("2026-10-03T10:00:02.000Z");
  expect(result.scopeAssessment.validUntil).toBe("2026-10-03T10:00:05.000Z");
  expect(result.optionRulesAssessment?.validUntil).toBe("2026-10-03T10:00:03.000Z");
  expect(result.candidateValidUntil).toBe("2026-10-03T10:00:30.000Z");
  expect(result.digest).toBe(
    hash(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "digest"))),
  );
  expect(f.options.policySource.withCurrentPolicy).toHaveBeenCalledOnce();
  expect(owners.option).toHaveBeenCalledOnce();
  expect(owners.content).toHaveBeenCalledOnce();
  expect(f.order).toEqual([
    "candidate enter",
    "option enter",
    "scope enter",
    "policy enter",
    "content enter",
    "consumer",
    "content exit",
    "scope exit",
    "policy exit",
    "option exit",
    "candidate exit",
  ]);
});
it("preserves a known Option contradiction without claiming complete qualification", async () => {
  const f = fixture(true, { binding: true, option: true });
  f.setMode("option-unsatisfiable");
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (proof) => proof);
  expect(result.optionRulePrerequisite).toBe("Unsatisfiable");
  expect(result.optionRulesAssessment?.bindings[0]?.rules.status).toBe("Unsatisfiable");
  expect(result.publishValidation).toBe("Incomplete");
  expect(result.eligibility).toBe("NotEvaluated");
});
it("requires actual Option authority for a nonempty candidate and does not query scope", async () => {
  const f = fixture(true, { binding: true }),
    work = vi.fn();
  await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(owners.option).not.toHaveBeenCalled();
  expect(owners.scopeRead).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});
it.each([
  "option-intent",
  "option-target",
  "option-unknown",
  "wrong-policy-reference",
  "wrong-policy-version",
  "wrong-policy-head",
  "missing-policy",
  "content-target",
])("refuses joined %s before consumer without fallback", async (mode) => {
  const f = fixture(true, { binding: true, option: true, content: true }),
    work = vi.fn();
  f.setMode(mode);
  await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(work).not.toHaveBeenCalled();
});
it.each([
  "caught-double-option",
  "caught-double-policy",
  "caught-double-content",
  "option-result",
  "policy-result",
  "content-result",
  "late-option",
  "late-content",
])("rejects tentative joined %s and poisons failed transaction", async (mode) => {
  const f = fixture(true, { binding: true, option: true, content: true }),
    work = vi.fn(async () => "tentative");
  f.setMode(mode);
  await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(work).toHaveBeenCalledOnce();
  f.setMode("normal");
  await expect(f.source.withCurrentAssessment(f.tx, f.input, vi.fn())).rejects.toThrow();
});
it("preserves late content authority denial", async () => {
  const f = fixture(true, { content: true }),
    work = vi.fn(async () => "tentative");
  f.setMode("content-denial");
  await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  expect(work).toHaveBeenCalledOnce();
});
it("captures configured Option, policy and Brand ports before mutable option replacement", async () => {
  const f = fixture(true, { binding: true, option: true, content: true }),
    option = f.options.optionAuthority?.holdUntilTransactionCompletes,
    injection = vi.fn(async () => {
      throw Error("MUTATED_PORT");
    });
  if (!f.options.optionAuthority || !f.options.contentPolicy)
    throw Error("missing synthetic config");
  f.options.optionAuthority.holdUntilTransactionCompletes = injection;
  f.options.contentPolicy.configurationVersionReference = id(99);
  f.options.contentPolicy.brandAuthority.isCurrent = injection;
  f.options.policySource.withCurrentPolicy = injection;
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (proof) => proof);
  expect(result.contentPolicyAssessment?.brandSource.configurationVersionReference).toBe(id(70));
  expect(
    owners.optionFactory.mock.calls[0]?.[0].optionAuthority.holdUntilTransactionCompletes,
  ).not.toBe(injection);
  expect(owners.contentFactory.mock.calls.at(-1)?.[0].configurationVersionReference).toBe(id(70));
  expect(owners.contentFactory.mock.calls.at(-1)?.[0].brandAuthority.isCurrent).not.toBe(injection);
  expect(option).toBeTypeOf("function");
  expect(injection).not.toHaveBeenCalled();
});

it("keeps current permanent Variant identity results and the shortest source lease in the joined proof", async () => {
  const f = fixture(true, { variant: true, content: true });
  f.setMode("variant-error");
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
  expect(result.variantMappingAssessment?.check).toEqual({
    code: "VariantMapping",
    outcome: "HardError",
  });
  expect(result.validUntil).toBe("2026-10-03T10:00:01.000Z");
  expect(result.variantMappingPrerequisite).toBe("NoExplicitUnmappedCombination");
  expect(result.digest).toBe(
    hash(Object.fromEntries(Object.entries(result).filter(([key]) => key !== "digest"))),
  );
  expect(owners.variant).toHaveBeenCalledOnce();
});
it("does not create positive Variant identity evidence when the owner is not configured", async () => {
  const f = fixture();
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
  expect(result).not.toHaveProperty("variantMappingAssessment");
  expect(owners.variant).not.toHaveBeenCalled();
});
