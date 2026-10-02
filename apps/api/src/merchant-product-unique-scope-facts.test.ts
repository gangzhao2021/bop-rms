import { publishingProductPublicationPolicyDigest } from "@bop/publishing";
import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  productPublicationCheckCodes,
  productPublicationWriteFields,
  productPublicationSourceFields,
  productValidationCandidateFields,
  frozenFullOptionSetContentFields,
} from "@rms/catalog";
import { tenantBrandConfigurationRequiredFields } from "@bop/tenant";
import type { createCurrentProductCandidateUniqueScopeSource } from "./current-product-candidate-unique-scope.js";
import {
  currentProductPolicyFields,
  type createCurrentProductPublicationPolicySource,
} from "./current-product-publication-policy.js";
import { createMerchantProductUniqueScopeFacts } from "./merchant-product-unique-scope-facts.js";
type SourceOptions = Parameters<typeof createCurrentProductCandidateUniqueScopeSource>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
const mock = vi.hoisted(() => ({
  scope: {} as SourceOptions,
  policy: {} as PolicyOptions,
  run: vi.fn(),
  policyRun: vi.fn(),
}));
vi.mock("./current-product-candidate-unique-scope.js", () => ({
  createCurrentProductCandidateUniqueScopeSource: (options: SourceOptions) => {
    mock.scope = options;
    return { withCurrentAssessment: (...args: unknown[]) => mock.run(...args) };
  },
}));
vi.mock("./current-product-publication-policy.js", async (original) => ({
  ...(await original<object>()),
  createCurrentProductPublicationPolicySource: (options: PolicyOptions) => {
    mock.policy = options;
    return { withCurrentPolicy: (...args: unknown[]) => mock.policyRun(...args) };
  },
}));
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T11:00:00.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
beforeEach(() => {
  mock.run.mockReset();
  mock.policyRun.mockReset();
});
function fixture(contentConfigured = false) {
  let clock = at;
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const command = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: "sha256:" + "a".repeat(64),
    configurationDigest: "sha256:" + "b".repeat(64),
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
  });
  const validation = parseProductPublicationValidation({
    evidenceReference: id(7),
    productAggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: hash(command.scopeSet),
    periodDigest: hash(command.effectivePeriod),
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "Required",
    checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: "2026-10-02T11:00:30.000Z",
  });
  const context = { tenantReference: id(1), brandReference: id(2), actorReference: id(3) };
  const candidate = {
    ...context,
    actorKind: "User" as const,
    productReference: id(5),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.validate" as const,
    purposeCode: command.purposeCode,
    requiredFields: productValidationCandidateFields,
    observedAt: at,
  };
  const history = {
    ...context,
    productReference: id(5),
    permission: "catalog.manage" as const,
    owningAction: "catalog.product.history.read" as const,
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE" as const,
    requiredFields: productPublicationSourceFields,
    observedAt: at,
  };
  const policy = {
    ...context,
    actorKind: "User" as const,
    policyReference: id(8),
    purposeCode: command.purposeCode,
    requiredFields: currentProductPolicyFields,
    observedAt: at,
  };
  const roster = {
    brandReference: id(2),
    actorReference: id(3),
    purposeCode: command.purposeCode,
    originalIntentDigest: hash(command),
    observedAt: at,
  };
  const proof = {
    ...context,
    productReference: id(5),
    versionReference: id(6),
    aggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    originalIntentDigest: hash(command),
    policyReference: id(8),
    policyVersion: 1,
    observedAt: at,
    validUntil: "2026-10-02T11:00:05.000Z",
    check: { code: "UniqueScope", outcome: "HardError" },
    currentCandidate: "Bound",
    skuPrerequisite: "ActiveMemberPresent",
    variantMappingPrerequisite: "NoExplicitUnmappedCombination",
    optionSelectionPrerequisite: "NoExplicitDefaultBoundsViolation",
    optionRulePrerequisite: "NoMechanicalContradiction",
    internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
  };
  type Options = Parameters<typeof createMerchantProductUniqueScopeFacts>[0];
  const configuration: Options["configuration"] = {
    ...(contentConfigured
      ? {
          contentPolicy: {
            configurationVersionReference: id(40),
            expectedBrandVersion: 1,
            brandAuthority: {
              withCurrentContentRead: vi.fn(async (_r, _f, work) => work()),
              isCurrent: vi.fn(async () => true),
            },
          },
        }
      : {}),
    optionAuthority: {
      holdUntilTransactionCompletes: vi.fn(async (_tx, input) => ({
        observedAt: input.observedAt,
        validUntil: "2026-10-02T11:00:04.000Z",
      })),
    },
    candidateAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    historyAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    policyAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    tenantAuthority: {
      withCurrentBrandReferenceRead: vi.fn(async (_request, work) => work()),
      isCurrent: vi.fn(async () => true),
    },
  };
  const admission = vi.fn<Options["assertAdmission"]>(async () => undefined),
    remaining = vi.fn<Options["sources"]["withHeldCurrentFacts"]>(async (_tx, _input, work) =>
      work({
        now: at,
        productAggregateVersion: 1,
        contentDigest: command.contentDigest,
        configurationDigest: command.configurationDigest,
        scopeDigest: validation.scopeDigest,
        periodDigest: validation.periodDigest,
        validation,
        approval: null,
        reviewReference: null,
        replacement: null,
      }),
    );
  const options: Options = {
    configuration,
    transaction: tx,
    command,
    sources: { withHeldCurrentFacts: remaining as Options["sources"]["withHeldCurrentFacts"] },
    validationAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    clock: { now: () => clock },
    assertAdmission: admission,
  };
  const heldPolicy = {
    content: {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(20),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    },
    currentPublicationReference: id(21),
    observedAt: at,
    validUntil: "2026-10-02T11:00:30.000Z",
  };
  Object.assign(proof, {
    policyContentDigest: publishingProductPublicationPolicyDigest(heldPolicy.content),
    policyPublicationReference: heldPolicy.currentPublicationReference,
  });
  const brandPacket = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    purposeCode: "CATALOG_PRODUCT_CONTENT" as const,
    configurationVersionReference: id(40),
    expectedBrandVersion: 1,
    originalIntentDigest: hash(command),
    observedAt: at,
    validUntil: "2026-10-02T11:00:03.000Z",
  };
  if (contentConfigured) {
    const body = {
      profile: "CatalogProductContentPolicyAssessmentV1",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      versionReference: id(6),
      aggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      originalIntentDigest: hash(command),
      observedAt: at,
      validUntil: brandPacket.validUntil,
      brandSource: {
        brandVersion: 1,
        configurationVersionReference: id(40),
        contentDigest: hash("brand"),
        currentPublicationReference: id(41),
      },
      policyReference: id(8),
      policyVersion: 1,
      policyContentDigest: publishingProductPublicationPolicyDigest(heldPolicy.content),
      approvalPolicy: "Required",
      warningOverrideAllowed: false,
      checks: [
        "SupportedLocales",
        "RequiredProductNames",
        "CompleteContent",
        "RequiredMediaPresence",
      ].map((code) => ({
        code,
        outcome:
          code === "RequiredProductNames" || code === "RequiredMediaPresence"
            ? "HardError"
            : "Pass",
      })),
      decision: "HardError",
      sourceAuthority: "NotEvaluated",
      publishValidation: "Incomplete",
      mediaReadiness: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
      brandFieldRequirements: "NotEvaluated",
      eligibility: "NotEvaluated",
    };
    Object.assign(proof, {
      contentPolicyAssessment: { ...body, digest: hash(body) },
      validUntil: brandPacket.validUntil,
    });
  }
  mock.policyRun.mockImplementation(
    async (actual: typeof tx, _input: unknown, work: (value: unknown) => Promise<unknown>) => {
      await mock.policy.authority.holdUntilTransactionCompletes(actual, policy);
      return work(heldPolicy);
    },
  );
  const guard = createMerchantProductUniqueScopeFacts(options);
  type Work = Parameters<
    ReturnType<typeof createCurrentProductCandidateUniqueScopeSource>["withCurrentAssessment"]
  >[2];
  mock.run.mockImplementation(async (actual: typeof tx, _input: unknown, work: Work) => {
    await mock.scope.candidateAuthority.holdUntilTransactionCompletes(actual, candidate);
    await mock.scope.validationAuthority.holdUntilTransactionCompletes(actual, {
      command,
      requiredPermissions: ["catalog.product.read", "catalog.product.validate"],
      requiredFields: productPublicationWriteFields,
      requiredScope: "FullBrandScope",
      observedAt: at,
    });
    await mock.scope.historyAuthority.holdUntilTransactionCompletes(actual, history);
    return mock.scope.tenantAuthority.withCurrentBrandReferenceRead(roster, async () => {
      await mock.scope.tenantAuthority.isCurrent(actual, roster);
      return mock.scope.policySource.withCurrentPolicy(
        actual,
        {
          policyReference: id(8),
          policyVersion: 1,
          observedAt: at,
        },
        async () => {
          if (mock.scope.contentPolicy)
            return mock.scope.contentPolicy.brandAuthority.withCurrentContentRead(
              brandPacket,
              tenantBrandConfigurationRequiredFields,
              async () => {
                await mock.scope.contentPolicy?.brandAuthority.isCurrent(
                  actual,
                  brandPacket,
                  tenantBrandConfigurationRequiredFields,
                );
                return work(proof as never);
              },
            );
          return work(proof as never);
        },
      );
    });
  });
  const work = vi.fn(
    async (facts: Parameters<Parameters<Options["sources"]["withHeldCurrentFacts"]>[2]>[0]) =>
      facts,
  );
  const input = { command, aggregate: {} as never, current: null, content: null, observedAt: at };
  return {
    guard,
    tx,
    configuration,
    admission,
    remaining,
    options,
    work,
    input,
    proof,
    heldPolicy,
    validation,
    candidate,
    history,
    policy,
    roster,
    brandPacket,
    clock: (at: string) => {
      clock = at;
    },
    run: () => guard.sources.withHeldCurrentFacts(tx, input, work),
  };
}
it("configured current Brand rules merge only hard failures and retain earliest lease/final authority", async () => {
  const f = fixture(true),
    r = await f.run();
  expect(r.validation.checks.find((c) => c.code === "DefaultLocaleName")?.outcome).toBe(
    "HardError",
  );
  expect(r.validation.checks.find((c) => c.code === "MediaReady")?.outcome).toBe("HardError");
  expect(r.validation.validUntil).toBe(f.brandPacket.validUntil);
  const holder = f.configuration.contentPolicy?.brandAuthority.isCurrent;
  if (!holder) throw Error("missing synthetic holder");
  const prior = vi.mocked(holder).mock.calls.length;
  Object.assign(f.configuration, {
    contentPolicy: {
      configurationVersionReference: id(99),
      expectedBrandVersion: 99,
      brandAuthority: { isCurrent: vi.fn(async () => false) },
    },
  });
  await f.guard.assertCurrent();
  expect(holder).toHaveBeenCalledTimes(prior + 1);
  vi.mocked(holder).mockResolvedValueOnce(false);
  await expect(f.guard.assertCurrent()).rejects.toThrow();
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});
it("configured missing Brand proof refuses, while absent configuration cannot accept a supplied proof", async () => {
  let f = fixture(true);
  Object.assign(f.proof, { contentPolicyAssessment: undefined });
  await expect(f.run()).rejects.toThrow();
  expect(f.work).not.toHaveBeenCalled();
  f = fixture();
  Object.assign(f.proof, { contentPolicyAssessment: {} });
  await expect(f.run()).rejects.toThrow();
  expect(f.work).not.toHaveBeenCalled();
});
it.each([
  "tenantReference",
  "brandReference",
  "actorReference",
  "configurationVersionReference",
  "expectedBrandVersion",
  "originalIntentDigest",
  "purposeCode",
])("Brand %s mismatch refuses before its holder", async (key) => {
  const f = fixture(true);
  Object.assign(f.brandPacket, { [key]: key === "expectedBrandVersion" ? 2 : id(99) });
  await expect(f.run()).rejects.toThrow();
  expect(
    f.configuration.contentPolicy?.brandAuthority.withCurrentContentRead,
  ).not.toHaveBeenCalled();
  expect(f.work).not.toHaveBeenCalled();
});
it("Brand repeated swallowed callback and unknown current result cannot regain success", async () => {
  let f = fixture(true);
  const reader = f.configuration.contentPolicy?.brandAuthority.withCurrentContentRead;
  if (!reader) throw Error("missing holder");
  vi.mocked(reader).mockImplementationOnce(async (_r, _fields, work) => {
    const value = await work();
    try {
      await work();
    } catch {
      /* deliberately swallowed */
    }
    return value;
  });
  await expect(f.run()).rejects.toThrow();
  f = fixture(true);
  const holder = f.configuration.contentPolicy?.brandAuthority.isCurrent;
  if (!holder) throw Error("missing holder");
  vi.mocked(holder).mockResolvedValueOnce(undefined as never);
  await expect(f.run()).rejects.toThrow();
  expect(f.work).not.toHaveBeenCalled();
});
it("final native guard retains the original Brand intersection deadline", async () => {
  const f = fixture(true);
  await f.run();
  f.clock(f.brandPacket.validUntil);
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});
it("uses actual bound scope check, preserving mandatory remaining facts and held fields through outer COMMIT", async () => {
  const f = fixture(),
    result = await f.run();
  expect(result.validation.checks.find((x) => x.code === "UniqueScope")?.outcome).toBe("HardError");
  expect(result.validation.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  expect(result.validation.validUntil).toBe(f.proof.validUntil);
  expect(f.work).toHaveBeenCalledTimes(1);
  expect(mock.run).toHaveBeenCalledTimes(1);
  await f.guard.assertCurrent();
  expect(f.tx.query).not.toHaveBeenCalled();
  expect(f.admission.mock.calls.every(([required]) => required === true)).toBe(true);
});
it.each(["candidateAuthority", "historyAuthority", "policyAuthority"] as const)(
  "retains current independent %s after the owning source callback closes",
  async (key) => {
    const f = fixture();
    await f.run();
    vi.mocked(f.configuration[key].holdUntilTransactionCompletes).mockRejectedValue(
      new CatalogError("CATALOG_PERMISSION_DENIED"),
    );
    await expect(f.guard.assertCurrent()).rejects.toHaveProperty(
      "code",
      "CATALOG_PERMISSION_DENIED",
    );
    await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);
it("retains current complete roster fields and explicit boolean admission", async () => {
  const f = fixture();
  await f.run();
  vi.mocked(f.configuration.tenantAuthority.isCurrent).mockResolvedValue(false);
  await expect(f.guard.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
});
it("retains original shorter source expiry and monotonic ceiling through COMMIT", async () => {
  const f = fixture();
  f.proof.validUntil = "2026-10-02T11:00:02.000Z";
  await f.run();
  f.clock(f.proof.validUntil);
  await expect(f.guard.assertCurrent()).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  const g = fixture();
  await g.run();
  g.clock("2026-10-02T11:00:03.000Z");
  await g.guard.assertCurrent();
  g.clock("2026-10-02T11:00:02.000Z");
  await expect(g.guard.assertCurrent()).rejects.toThrow();
});
it("original recovery has current ordinary admission without any candidate/history/roster/policy acquisition", async () => {
  const f = fixture();
  await f.guard.assertCurrent();
  expect(f.admission).toHaveBeenCalledWith(false);
  expect(mock.run).not.toHaveBeenCalled();
  expect(f.remaining).not.toHaveBeenCalled();
  expect(f.configuration.tenantAuthority.isCurrent).not.toHaveBeenCalled();
});
it("captures original configured source holders and clock/admission", async () => {
  const f = fixture();
  Object.assign(f.options, {
    assertAdmission: async () => {
      throw Error("REBOUND");
    },
    clock: { now: () => "invalid" },
  });
  f.configuration.candidateAuthority.holdUntilTransactionCompletes = async () => {
    throw Error("REBOUND");
  };
  await expect(f.run()).resolves.toBeDefined();
});
it.each([
  "foreign-tx",
  "query",
  "mode",
  "repeat-source",
  "skip-source",
  "nonvoid-holder",
  "wrong-candidate",
  "wrong-fields",
])("refuses %s without renewed authority or extra consumer", async (kind) => {
  const f = fixture();
  const run = mock.run.getMockImplementation();
  if (!run) throw Error("SYNTHETIC_MISSING_IMPLEMENTATION");
  if (kind === "foreign-tx") {
    await expect(
      f.guard.sources.withHeldCurrentFacts({ ...f.tx }, f.input, f.work),
    ).rejects.toThrow();
    return;
  }
  if (kind === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
  if (kind === "mode")
    Object.assign(f.input, { command: { ...f.input.command, action: "Approve" } });
  if (kind === "repeat-source")
    mock.run.mockImplementation(async (tx, input, work) => {
      await run(tx, input, work);
      return run(tx, input, work);
    });
  if (kind === "skip-source") mock.run.mockResolvedValue(undefined);
  if (kind === "nonvoid-holder")
    vi.mocked(f.configuration.candidateAuthority.holdUntilTransactionCompletes).mockResolvedValue(
      {} as never,
    );
  if (kind === "wrong-candidate") f.proof.contentDigest = "sha256:" + "c".repeat(64);
  if (kind === "wrong-fields") Object.assign(f.candidate, { requiredFields: [] });
  await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.work.mock.calls.length).toBeLessThanOrEqual(1);
});
it("refuses a repeated roster callback after tentative consumer work", async () => {
  const f = fixture();
  f.configuration.tenantAuthority.withCurrentBrandReferenceRead = async (_request, work) => {
    await work();
    return work();
  };
  const g = createMerchantProductUniqueScopeFacts(f.options);
  await expect(g.sources.withHeldCurrentFacts(f.tx, f.input, f.work)).rejects.toThrow();
  expect(f.work).toHaveBeenCalledTimes(1);
});
it("refuses source native denial and catches expiry during holder await", async () => {
  const f = fixture();
  f.admission.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.work).not.toHaveBeenCalled();
  const g = fixture();
  vi.mocked(g.configuration.historyAuthority.holdUntilTransactionCompletes).mockImplementation(
    async () => {
      g.clock("2026-10-02T11:00:05.000Z");
    },
  );
  await expect(g.run()).rejects.toThrow();
});

it.each([
  "approval",
  "release",
  "digest",
  "observation",
  "expiry",
  "missing-callback",
  "invalid-reference",
  "invalid-time",
  "expired-policy",
  "future-policy",
])("refuses actual held policy %s mismatch before writer", async (kind) => {
  const f = fixture();
  if (kind === "approval") {
    f.heldPolicy.content.approvalPolicy = "NotRequired";
    Object.assign(f.proof, {
      policyContentDigest: publishingProductPublicationPolicyDigest(f.heldPolicy.content),
    });
  }
  if (kind === "release") f.heldPolicy.currentPublicationReference = id(99);
  if (kind === "digest")
    Object.assign(f.proof, { policyContentDigest: "sha256:" + "f".repeat(64) });
  if (kind === "observation") f.heldPolicy.observedAt = "2026-10-02T11:00:00.001Z";
  if (kind === "expiry") f.heldPolicy.validUntil = "2026-10-02T11:00:01.000Z";
  if (kind === "invalid-reference") f.heldPolicy.currentPublicationReference = "invalid";
  if (kind === "invalid-time") f.heldPolicy.validUntil = "invalid";
  if (kind === "expired-policy") f.heldPolicy.validUntil = at;
  if (kind === "future-policy") f.heldPolicy.content.effectiveFrom = "2026-10-02T11:00:00.001Z";
  if (kind === "missing-callback")
    mock.run.mockImplementation(async (_tx, _input, work) => work(f.proof));
  await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.work).not.toHaveBeenCalled();
});
it("accepts actual NotRequired only when independent full validation agrees; no approval check is manufactured", async () => {
  const f = fixture();
  f.heldPolicy.content.approvalPolicy = "NotRequired";
  Object.assign(f.proof, {
    policyContentDigest: publishingProductPublicationPolicyDigest(f.heldPolicy.content),
  });
  const run = f.remaining.getMockImplementation();
  if (!run) throw Error("SYNTHETIC_MISSING_IMPLEMENTATION");
  f.remaining.mockImplementation(async (tx, input, work) =>
    run(tx, input, async (facts) =>
      work({
        ...facts,
        validation: parseProductPublicationValidation({
          ...facts.validation,
          approvalPolicy: "NotRequired",
        }),
      }),
    ),
  );
  const result = await f.run();
  expect(result.validation.approvalPolicy).toBe("NotRequired");
  expect(result.validation.checks.find((x) => x.code === "ApprovalPolicy")).toEqual(
    f.validation.checks.find((x) => x.code === "ApprovalPolicy"),
  );
  expect(mock.policyRun).toHaveBeenCalledTimes(1);
});

for (const allowed of [false, true])
  it(`binds Warning override to actual current policy (${allowed})`, async () => {
    const f = fixture();
    f.heldPolicy.content.warningOverrideAllowed = allowed;
    Object.assign(f.proof, {
      policyContentDigest: publishingProductPublicationPolicyDigest(f.heldPolicy.content),
    });
    const warningAcknowledgement = {
      actorReference: id(3),
      reasonCode: "SYNTHETIC_WARNING",
      warningCodes: ["MediaReady"],
    };
    const previous = f.remaining.getMockImplementation();
    if (!previous) throw Error("expected existing remaining facts fixture");
    f.remaining.mockImplementation((tx, input, work) =>
      previous(tx, input, (facts) =>
        work({
          ...facts,
          validation: parseProductPublicationValidation({
            ...f.validation,
            checks: f.validation.checks.map((c) => ({
              ...c,
              outcome: c.code === "MediaReady" ? "Warning" : "Pass",
            })),
            warningAcknowledgement,
          }),
        }),
      ),
    );

    if (allowed) {
      const result = await f.run();
      expect(result.validation.warningAcknowledgement).toEqual(warningAcknowledgement);
      expect(result.validation.checks).toContainEqual({ code: "MediaReady", outcome: "Warning" });
    } else {
      await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
      expect(f.work).not.toHaveBeenCalled();
    }
  });

it("ordinary actual no-Active-SKU observation downgrades supplied Pass in the owning receipt", async () => {
  const f = fixture();
  f.proof.skuPrerequisite = "NoActiveMember";
  await f.guard.sources.withHeldCurrentFacts(f.tx, f.input, async (facts) => {
    expect(facts.validation.checks.find((x) => x.code === "PublishableSku")?.outcome).toBe(
      "HardError",
    );
    expect(facts.validation.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe(
      "HardError",
    );
    return "recorded";
  });
  await f.guard.assertCurrent();
});
it("ordinary missing/unknown SKU prerequisite fails closed without consumer work", async () => {
  const f = fixture();
  Object.assign(f.proof, { skuPrerequisite: "Unknown" });
  const work = vi.fn();
  await expect(f.guard.sources.withHeldCurrentFacts(f.tx, f.input, work)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(work).not.toHaveBeenCalled();
});

it("ordinary actual code conflict produces owning HardError rather than supplied Pass", async () => {
  const f = fixture();
  Object.assign(f.proof.internalCodeCheck, { outcome: "HardError" });
  const result = await f.run();
  expect(result.validation.checks.find((x) => x.code === "InternalCode")?.outcome).toBe(
    "HardError",
  );
  expect(result.validation.checks.find((x) => x.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  await f.guard.assertCurrent();
});
it("ordinary absent actual code check refuses without consumer work", async () => {
  const f = fixture();
  Reflect.deleteProperty(f.proof, "internalCodeCheck");
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
});

it("ordinary held unmapped Variant refuses supplied Pass without turning Active SKU into mapping qualification", async () => {
  const f = fixture();
  f.proof.variantMappingPrerequisite = "UnmappedCombinationPresent";
  const r = await f.run();
  expect(r.validation.checks.find((c) => c.code === "VariantMapping")?.outcome).toBe("HardError");
  expect(r.validation.checks.find((c) => c.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  await f.guard.assertCurrent();
});
it.each(["Unavailable", undefined])(
  "ordinary unavailable Variant content %s refuses before consumer",
  async (value) => {
    const f = fixture();
    Object.assign(f.proof, { variantMappingPrerequisite: value });
    await expect(f.run()).rejects.toThrow();
    expect(f.work).not.toHaveBeenCalled();
  },
);
it("actual explicit Option default violation downgrades ordinary Validate and retains admission guard", async () => {
  const f = fixture();
  f.proof.optionSelectionPrerequisite = "ExplicitDefaultBoundsViolated";
  const r = await f.run();
  expect(r.validation.checks.find((c) => c.code === "OptionSelection")?.outcome).toBe("HardError");
  expect(r.validation.checks.find((c) => c.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  await f.guard.assertCurrent();
});
it.each(["Unavailable", undefined])(
  "ordinary unavailable Option observation %s refuses before consumer",
  async (value) => {
    const f = fixture();
    Object.assign(f.proof, { optionSelectionPrerequisite: value });
    await expect(f.run()).rejects.toThrow();
    expect(f.work).not.toHaveBeenCalled();
  },
);

function optionPacket() {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User" as const,
    permission: "catalog.manage" as const,
    action: "catalog.option_set.read" as const,
    purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
    requiredFields: frozenFullOptionSetContentFields,
    optionSetReference: id(30),
    versionReference: id(31),
    content: null,
    observedAt: at,
  };
}
it("captured Option authority adds fine native admission and original shortest lease to final guard", async () => {
  const f = fixture();
  f.proof.optionRulePrerequisite = "Unsatisfiable";
  mock.run.mockImplementationOnce(async (actual, _input, work) => {
    await mock.scope.optionAuthority?.holdUntilTransactionCompletes(actual, optionPacket());
    await mock.scope.policySource.withCurrentPolicy(
      actual,
      { policyReference: id(8), policyVersion: 1, observedAt: at },
      async () => undefined,
    );
    return work(f.proof);
  });
  const original = f.configuration.optionAuthority?.holdUntilTransactionCompletes;
  if (!original) throw new Error("missing synthetic holder");
  const result = await f.run();
  expect(result.validation.checks.find((c) => c.code === "OptionSelection")?.outcome).toBe(
    "HardError",
  );
  expect(f.admission).toHaveBeenCalledWith(true, true);
  expect(result.validation.validUntil).toBe("2026-10-02T11:00:04.000Z");
  Object.assign(f.configuration, {
    optionAuthority: {
      holdUntilTransactionCompletes: vi.fn(async () => {
        throw new Error("replacement must not run");
      }),
    },
  });
  const callsBeforeGuard = vi.mocked(original).mock.calls.length;
  await f.guard.assertCurrent();
  expect(original).toHaveBeenCalledTimes(callsBeforeGuard + 1);
  f.clock("2026-10-02T11:00:04.000Z");
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});
it("late Option permission denial latches failure after consumer work", async () => {
  const f = fixture();
  mock.run.mockImplementationOnce(async (actual, _input, work) => {
    await mock.scope.optionAuthority?.holdUntilTransactionCompletes(actual, optionPacket());
    await mock.scope.policySource.withCurrentPolicy(
      actual,
      { policyReference: id(8), policyVersion: 1, observedAt: at },
      async () => undefined,
    );
    return work(f.proof);
  });
  await f.run();
  const holder = f.configuration.optionAuthority?.holdUntilTransactionCompletes;
  if (!holder) throw new Error("missing synthetic holder");
  vi.mocked(holder).mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.guard.assertCurrent()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});

it.each(["changed observation", "expired lease"])(
  "malformed original Option lease %s refuses before consumer",
  async (mode) => {
    const f = fixture(),
      holder = f.configuration.optionAuthority?.holdUntilTransactionCompletes;
    if (!holder) throw new Error("missing synthetic holder");
    vi.mocked(holder).mockResolvedValueOnce({
      observedAt: mode === "changed observation" ? "2026-10-02T11:00:00.001Z" : at,
      validUntil: mode === "expired lease" ? at : "2026-10-02T11:00:04.000Z",
    });
    mock.run.mockImplementationOnce(async (actual, _input, work) => {
      await mock.scope.optionAuthority?.holdUntilTransactionCompletes(actual, optionPacket());
      return work(f.proof);
    });
    await expect(f.run()).rejects.toThrow();
    expect(f.work).not.toHaveBeenCalled();
  },
);
