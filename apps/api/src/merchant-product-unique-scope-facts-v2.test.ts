import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parsePublishingProductPublicationPolicy,
  publishingProductPublicationPolicyDigest,
} from "@bop/publishing";
import { tenantBrandConfigurationRequiredFields } from "@bop/tenant";
import {
  CatalogError,
  parseCatalogInstant,
  parseCatalogReference,
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  parseCatalogProductUniqueScopeAssessmentV2,
  productPublicationCheckCodes,
  productPublicationWriteFieldsV2,
  productPublicationSourceFieldsV2,
  productVariantHistoryFields,
  productValidationCandidateFieldsV2,
  frozenFullOptionSetContentFields,
  type ProductPublicationFactsV2,
  type CatalogProductContentPolicyAssessmentV2,
} from "@rms/catalog";
import type { createCurrentProductCandidateUniqueScopeSourceV2 } from "./current-product-candidate-unique-scope-v2.js";
import {
  currentProductPolicyFields,
  type createCurrentProductPublicationPolicySource,
  type CurrentProductPublicationPolicy,
} from "./current-product-publication-policy.js";
import {
  createMerchantProductUniqueScopeFactsV2,
  captureMerchantProductUniqueScopeConfigurationV2,
} from "./merchant-product-unique-scope-facts-v2.js";
type SourceOptions = Parameters<typeof createCurrentProductCandidateUniqueScopeSourceV2>[0];
type PolicyOptions = Parameters<typeof createCurrentProductPublicationPolicySource>[0];
type Options = Parameters<typeof createMerchantProductUniqueScopeFactsV2>[0];
type JoinedWork = Parameters<
  ReturnType<typeof createCurrentProductCandidateUniqueScopeSourceV2>["withCurrentAssessment"]
>[2];
const owners = vi.hoisted(() => ({
  joined: {} as SourceOptions,
  policy: {} as PolicyOptions,
  run: vi.fn(),
  policyRun: vi.fn(),
}));
vi.mock("./current-product-candidate-unique-scope-v2.js", () => ({
  createCurrentProductCandidateUniqueScopeSourceV2: (options: SourceOptions) => {
    owners.joined = options;
    return { withCurrentAssessment: (...args: unknown[]) => owners.run(...args) };
  },
}));
vi.mock("./current-product-publication-policy.js", async (original) => ({
  ...(await original<object>()),
  createCurrentProductPublicationPolicySource: (options: PolicyOptions) => {
    owners.policy = options;
    return { withCurrentPolicy: (...args: unknown[]) => owners.policyRun(...args) };
  },
}));
const id = (n: number) => "01902437-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T10:00:00.000Z",
  plus = (s: number) => new Date(Date.parse(at) + s * 1000).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
beforeEach(() => {
  owners.run.mockReset();
  owners.policyRun.mockReset();
});
function fixture(validationValiditySeconds = 30, none = false, variant = false, details?: unknown) {
  let clock = at,
    mode = "normal",
    brandCurrent = true,
    policyReads = 0;
  const tx = { query: vi.fn(async () => ({ rows: [] })) },
    selector = { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
    target = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: id(40),
      previousPublicationOperationReference: id(41),
      expectedPreviousPublicationVersion: 3,
      previousIntentDigest: hash("old command"),
      previousScopeDigest: hash("old scope"),
      previousPeriodDigest: hash("old period"),
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(selector),
    },
    intent = none
      ? {
          profile: "CatalogProductNoReplacementIntentV1",
          mode: "None",
          digest: hash({ profile: "CatalogProductNoReplacementIntentV1", mode: "None" }),
        }
      : { ...target, digest: hash(target) },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
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
      contentDigest: hash("content"),
      configurationDigest: hash("configuration"),
      scopeSet: [selector],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: intent.digest,
      evidenceReference: id(7),
      productAggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome: ["MediaReady", "HardErrorsCleared"].includes(code)
          ? "HardError"
          : code === "TaxResolution"
            ? "Warning"
            : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: plus(validationValiditySeconds),
    }),
    context = {
      tenantReference: command.tenantReference,
      brandReference: command.brandReference,
      actorReference: command.actorReference,
    },
    heldPolicy: CurrentProductPublicationPolicy = {
      content: parsePublishingProductPublicationPolicy({
        profile: "PublishingProductPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(9),
        policyReference: id(8),
        policyVersion: 1,
        scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
        approvalPolicy: "Required",
        warningOverrideAllowed: false,
        requiredLocales: ["en-CA"],
        mediaRequirement: "Optional",
        effectiveFrom: at,
        effectiveUntil: null,
      }),
      currentPublicationReference: parseCatalogReference(id(10)),
      observedAt: parseCatalogInstant(at),
      validUntil: parseCatalogInstant(plus(30)),
    },
    scopeBody = {
      profile: "CatalogProductUniqueScopeAssessmentV2",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      versionReference: id(6),
      aggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      originalIntentDigest: hash(command),
      replacementIntentDigest: intent.digest,
      sourceDigest: hash("complete coverage"),
      sourceRevision: "4",
      sourceHeadDigest: hash("immutable heads"),
      registeredStoreDigest: hash("roster"),
      policyReference: id(8),
      policyVersion: 1,
      policyContentDigest: publishingProductPublicationPolicyDigest(heldPolicy.content),
      policyPublicationReference: id(10),
      observedAt: at,
      validUntil: plus(5),
      check: { code: "UniqueScope", outcome: "Pass" },
      findings: [],
      supportedTopology: "RegisteredBrandStoreOnly",
      equalRankResolution: none ? "NoReplacementRequested" : "ExactStoreSelectorRetirementBound",
      sourceAuthority: "NotEvaluated",
      publishValidation: "Incomplete",
      eligibility: "NotEvaluated",
    },
    scopeAssessment = parseCatalogProductUniqueScopeAssessmentV2({
      ...scopeBody,
      digest: hash(scopeBody),
    }),
    contentBody = {
      profile: "CatalogProductContentPolicyAssessmentV2",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      versionReference: id(6),
      aggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      originalIntentDigest: hash(command),
      replacementIntentDigest: intent.digest,
      observedAt: at,
      validUntil: plus(3),
      brandSource: {
        brandVersion: 1,
        configurationVersionReference: id(50),
        contentDigest: hash("brand"),
        currentPublicationReference: id(51),
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
      ].map((code) => ({ code, outcome: code === "RequiredProductNames" ? "HardError" : "Pass" })),
      decision: "HardError",
      sourceAuthority: "NotEvaluated",
      publishValidation: "Incomplete",
      mediaReadiness: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
      brandFieldRequirements: "NotEvaluated",
      eligibility: "NotEvaluated",
    },
    contentPolicyAssessment = {
      ...contentBody,
      digest: hash(contentBody),
      // This joined-owner double is revalidated by the real Catalog merge below.
    } as unknown as CatalogProductContentPolicyAssessmentV2,
    proof = {
      ...scopeAssessment,
      profile: "CurrentProductCandidateUniqueScopeV2",
      currentCandidate: "Bound",
      scopeAssessment,
      scopeAssessmentDigest: scopeAssessment.digest,
      candidateObservedAt: at,
      candidateValidUntil: plus(30),
      validUntil: plus(3),
      completeContent: "Present",
      skuPrerequisite: "NoActiveMember",
      variantMappingPrerequisite: "NoExplicitUnmappedCombination",
      optionSelectionPrerequisite: "NoExplicitDefaultBoundsViolation",
      optionRulePrerequisite: "Unsatisfiable",
      internalCodeCheck: { code: "InternalCode", outcome: "Pass" },
      contentPolicyAssessment,
    },
    candidate = {
      ...context,
      actorKind: "User" as const,
      productReference: id(5),
      permission: "catalog.manage" as const,
      owningAction: "catalog.product.validate" as const,
      purposeCode: command.purposeCode,
      requiredFields: productValidationCandidateFieldsV2,
      observedAt: at,
    },
    history = {
      ...context,
      actorKind: "User" as const,
      productReference: id(5),
      permission: "catalog.manage" as const,
      owningActions: ["catalog.product.history.read"] as const,
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE" as const,
      requiredFields: productPublicationSourceFieldsV2,
      observedAt: at,
    },
    policyPacket = {
      ...context,
      actorKind: "User" as const,
      policyReference: id(8),
      purposeCode: command.purposeCode,
      requiredFields: currentProductPolicyFields,
      observedAt: at,
    },
    roster = {
      brandReference: id(2),
      actorReference: id(3),
      purposeCode: command.purposeCode,
      originalIntentDigest: hash(command),
      observedAt: at,
    },
    brandPacket = {
      ...context,
      purposeCode: "CATALOG_PRODUCT_CONTENT" as const,
      configurationVersionReference: id(50),
      expectedBrandVersion: 1,
      originalIntentDigest: hash(command),
      observedAt: at,
      validUntil: plus(3),
    },
    optionPacket = {
      ...context,
      actorKind: "User" as const,
      permission: "catalog.manage" as const,
      action: "catalog.option_set.read" as const,
      purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT" as const,
      optionSetReference: id(60),
      versionReference: id(61),
      // The owning frozen-content authority is also called before its content read.
      content: null,
      requiredFields: frozenFullOptionSetContentFields,
      observedAt: at,
      command,
      originalIntentDigest: hash(command),
      replacementIntentDigest: intent.digest,
    };
  proof.digest = hash(
    Object.fromEntries(Object.entries(proof).filter(([key]) => key !== "digest")),
  );
  const variantAuthority = {
    holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => undefined),
  };
  if (variant)
    Object.assign(proof, {
      variantMappingAssessment: {
        check: { code: "VariantMapping", outcome: "HardError" },
        originalIntentDigest: hash(command),
        replacementIntentDigest: command.replacementIntentDigest,
        historyDigest: hash("synthetic history"),
        observedAt: at,
        validUntil: plus(3),
      },
    });
  const configuration: Options["configuration"] = {
    ...(variant ? { variantHistoryAuthority: variantAuthority } : {}),
    candidateAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    historyAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    policyAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    optionAuthority: {
      holdUntilTransactionCompletes: vi.fn(async (_actual, packet) => ({
        observedAt: packet.observedAt,
        validUntil: plus(2),
      })),
    },
    tenantAuthority: {
      withCurrentBrandReferenceRead: async (_packet, work) => work(),
      isCurrent: vi.fn(async () => true),
    },
    contentPolicy: {
      configurationVersionReference: id(50),
      expectedBrandVersion: 1,
      brandAuthority: {
        async withCurrentContentRead(_packet, _fields, work) {
          const result = await work();
          if (mode === "brand-double-swallowed") {
            try {
              await work();
            } catch {
              /* Deliberately swallow the callback violation. */
            }
          }
          return result;
        },
        isCurrent: vi.fn(async () => brandCurrent),
      },
    },
  };
  const facts: ProductPublicationFactsV2 = {
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
    },
    admission = vi.fn<Options["assertAdmission"]>(async () => undefined),
    remaining: Options["sources"]["withHeldCurrentFacts"] = async (_actual, _input, work) => {
      const result = await work(facts, details);
      if (mode === "remaining-double-swallowed") {
        try {
          await work(facts);
        } catch {
          /* Deliberately swallow the callback violation. */
        }
      }
      if (mode === "swallow-authority") {
        try {
          await owners.joined.candidateAuthority.holdUntilTransactionCompletes(tx, candidate);
        } catch {
          /* Deliberately swallow late denial. */
        }
      }
      return mode === "remaining-result" ? ({ substituted: true } as never) : result;
    },
    options: Options = {
      configuration,
      transaction: tx,
      command,
      sources: {
        withHeldCurrentFacts: remaining,
        withCurrentPolicy: async (_actual, _input, work) => work(heldPolicy),
      },
      validationAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
      clock: { now: () => clock },
      assertAdmission: admission,
    };
  owners.policyRun.mockImplementation(
    async (
      actual: typeof tx,
      _input: unknown,
      work: (value: CurrentProductPublicationPolicy) => Promise<unknown>,
    ) => {
      policyReads++;
      await owners.policy.authority.holdUntilTransactionCompletes(actual, policyPacket);
      const value =
        mode === "nested-policy-changed" && policyReads > 1
          ? { ...heldPolicy, currentPublicationReference: parseCatalogReference(id(99)) }
          : heldPolicy;
      const result = await work(value);
      if (mode === "policy-double-swallowed") {
        try {
          await work(value);
        } catch {
          /* Deliberately swallow the callback violation. */
        }
      }
      return result;
    },
  );
  const guard = createMerchantProductUniqueScopeFactsV2(options);
  // Only owner acquisition is controlled here. V2 command/receipt/assessment
  // parsers and the complete Catalog policy/candidate/content merges are real.
  owners.run.mockImplementation(async (actual: typeof tx, _input: unknown, work: JoinedWork) => {
    await owners.joined.candidateAuthority.holdUntilTransactionCompletes(actual, candidate);
    await owners.joined.validationAuthority.holdUntilTransactionCompletes(actual, {
      command,
      requiredPermissions: ["catalog.product.read", "catalog.product.validate"],
      requiredFields: productPublicationWriteFieldsV2,
      requiredScope: "FullBrandScope",
      observedAt: at,
    });
    await owners.joined.historyAuthority.holdUntilTransactionCompletes(actual, history);
    await owners.joined.variantHistoryAuthority?.holdUntilTransactionCompletes(actual, {
      ...context,
      purposeCode: "CATALOG_PRODUCT_VARIANT_IDENTITY_HISTORY",
      permission: "catalog.product.history.read",
      request: {
        productReference: command.productReference,
        expectedAggregateVersion: command.expectedProductAggregateVersion,
        originalIntentDigest: hash(command),
      },
      requiredFields: productVariantHistoryFields,
      observedAt: at,
    });
    await owners.joined.optionAuthority?.holdUntilTransactionCompletes(actual, optionPacket);
    return owners.joined.tenantAuthority.withCurrentBrandReferenceRead(roster, async () => {
      await owners.joined.tenantAuthority.isCurrent(actual, roster);
      return owners.joined.policySource.withCurrentPolicy(
        actual,
        { policyReference: id(8), policyVersion: 1, observedAt: at },
        async () => {
          const content = owners.joined.contentPolicy;
          if (!content) throw Error("Missing synthetic Brand holder");
          return content.brandAuthority.withCurrentContentRead(
            brandPacket,
            tenantBrandConfigurationRequiredFields,
            async () => {
              await content.brandAuthority.isCurrent(
                actual,
                brandPacket,
                tenantBrandConfigurationRequiredFields,
              );
              const result = await work(proof as never);
              if (mode === "joined-double-swallowed") {
                try {
                  await work(proof as never);
                } catch {
                  /* Deliberately swallow the callback violation. */
                }
              }
              return result;
            },
          );
        },
      );
    });
  });
  const work = vi.fn(async (value: ProductPublicationFactsV2, capturedDetails?: unknown) => {
      void capturedDetails;
      return value;
    }),
    input = { command, aggregate: {} as never, current: null, content: null, observedAt: at };
  return {
    tx,
    options,
    configuration,
    variantAuthority,
    command,
    validation,
    facts,
    proof,
    scopeAssessment,
    heldPolicy,
    candidate,
    history,
    optionPacket,
    roster,
    brandPacket,
    guard,
    work,
    remaining,
    admission,
    input,
    run: () => guard.sources.withHeldCurrentFacts(tx, input, work),
    setClock: (value: string) => {
      clock = value;
    },
    setMode: (value: string) => {
      mode = value;
    },
    denyBrand: () => {
      brandCurrent = false;
    },
  };
}
it("merges negative owning prerequisites while retaining independent errors, warnings, full target and earliest original lease", async () => {
  const f = fixture(),
    bytes = canonicalizeRfc8785(f.scopeAssessment),
    result = await f.run();
  for (const code of [
    "DefaultLocaleName",
    "PublishableSku",
    "OptionSelection",
    "MediaReady",
    "HardErrorsCleared",
  ])
    expect(result.validation.checks.find((check) => check.code === code)?.outcome).toBe(
      "HardError",
    );
  expect(result.validation.checks.find((check) => check.code === "TaxResolution")?.outcome).toBe(
    "Warning",
  );
  expect(result.validation.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
  expect(result.validation.evidenceReference).toBe(f.validation.evidenceReference);
  expect(result.validation.validUntil).toBe(plus(2));
  expect(f.work).toHaveBeenCalledTimes(1);
  expect(canonicalizeRfc8785(f.scopeAssessment)).toBe(bytes);
  expect(f.admission.mock.calls.some(([, option]) => option === true)).toBe(true);
  await f.guard.assertCurrent();
  f.setClock(plus(2));
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});
it("retains a shorter original remaining-validation lease in the final guard", async () => {
  const f = fixture(1);
  const result = await f.run();
  expect(result.validation.validUntil).toBe(plus(1));
  await f.guard.assertCurrent();
  f.setClock(plus(1));
  await expect(f.guard.assertCurrent()).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("exposes a synchronous original-lease assertion without reacquiring current facts", async () => {
  const f = fixture(1);
  await f.run();
  const admissionCalls = f.admission.mock.calls.length,
    sourceCalls = owners.run.mock.calls.length,
    policyCalls = owners.policyRun.mock.calls.length;
  expect(f.guard.assertLeaseCurrent()).toBeUndefined();
  f.setClock(plus(1));
  expect(() => f.guard.assertLeaseCurrent()).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  f.setClock(at);
  expect(() => f.guard.assertLeaseCurrent()).toThrowError(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(f.admission).toHaveBeenCalledTimes(admissionCalls);
  expect(owners.run).toHaveBeenCalledTimes(sourceCalls);
  expect(owners.policyRun).toHaveBeenCalledTimes(policyCalls);
});
it.each([
  "target",
  "command",
  "scope-digest",
  "policy",
  "brand",
  "option",
  "history",
  "missing-content",
])("rejects %s substitution before the facts consumer", async (mode) => {
  const f = fixture();
  if (mode === "target") f.proof.replacementIntentDigest = hash("another target");
  if (mode === "command")
    f.proof.originalIntentDigest = hash({ ...f.command, operationReference: id(99) });
  if (mode === "scope-digest")
    f.proof.scopeAssessment = { ...f.scopeAssessment, digest: hash("wrong") };
  if (mode === "policy") f.proof.policyContentDigest = hash("another policy");
  if (mode === "brand") f.brandPacket.originalIntentDigest = hash("another command");
  if (mode === "option") f.optionPacket.replacementIntentDigest = hash("another target");
  if (mode === "history") f.history.productReference = id(99);
  if (mode === "missing-content") Object.assign(f.proof, { contentPolicyAssessment: undefined });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
});
it.each([
  "remaining-double-swallowed",
  "joined-double-swallowed",
  "brand-double-swallowed",
  "policy-double-swallowed",
  "remaining-result",
])("cannot regain success after %s", async (mode) => {
  const f = fixture();
  f.setMode(mode);
  await expect(f.run()).rejects.toThrow();
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});
it("retains late permission denial even when the remaining source swallows it", async () => {
  const f = fixture();
  f.setMode("swallow-authority");
  f.work.mockImplementation(async (facts) => {
    vi.mocked(f.configuration.candidateAuthority.holdUntilTransactionCompletes).mockRejectedValue(
      new CatalogError("CATALOG_PERMISSION_DENIED"),
    );
    return facts;
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  await expect(f.guard.assertCurrent()).rejects.toThrow();
});
it.each(["expiry", "backward", "query", "reentry"])(
  "rejects late %s and poisons the guard",
  async (mode) => {
    const f = fixture();
    f.work.mockImplementation(async (facts) => {
      if (mode === "expiry") f.setClock(plus(2));
      if (mode === "backward") f.setClock(plus(-1));
      if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
      if (mode === "reentry")
        await f.guard.sources
          .withHeldCurrentFacts(f.tx, f.input, async () => undefined)
          .catch(() => undefined);
      return facts;
    });
    await expect(f.run()).rejects.toThrow();
    await expect(f.guard.assertCurrent()).rejects.toThrow();
  },
);
it("serves the writer's nested current policy only while held, with same original policy and final authority", async () => {
  const f = fixture(),
    nested = vi.fn(async (policy: unknown) => policy);
  f.work.mockImplementation(async (facts) => {
    const policy = await f.guard.sources.withCurrentPolicy(
      f.tx,
      { policyReference: id(8), policyVersion: 1, observedAt: at },
      nested,
    );
    expect(policy).toEqual(f.heldPolicy);
    return facts;
  });
  await f.run();
  expect(nested).toHaveBeenCalledTimes(1);
  expect(owners.policyRun).toHaveBeenCalledTimes(2);
  f.denyBrand();
  await expect(f.guard.assertCurrent()).rejects.toThrow();
  const g = fixture();
  g.setMode("nested-policy-changed");
  g.work.mockImplementation(async (facts) => {
    await g.guard.sources
      .withCurrentPolicy(
        g.tx,
        { policyReference: id(8), policyVersion: 1, observedAt: at },
        async () => undefined,
      )
      .catch(() => undefined);
    return facts;
  });
  await expect(g.run()).rejects.toThrow();
});
it("captures configured ports and requires Brand configuration and exact V2 admission", async () => {
  const f = fixture(),
    injected = vi.fn(async () => {
      throw Error("MUTATED_PORT");
    });
  Object.assign(f.options.sources, { withHeldCurrentFacts: injected });
  Object.assign(f.options.validationAuthority, { holdUntilTransactionCompletes: injected });
  Object.assign(f.configuration.candidateAuthority, { holdUntilTransactionCompletes: injected });
  Object.assign(f.configuration.contentPolicy.brandAuthority, { isCurrent: injected });
  Object.assign(f.options.clock, { now: () => plus(-1) });
  await f.run();
  expect(injected).not.toHaveBeenCalled();
  expect(() =>
    captureMerchantProductUniqueScopeConfigurationV2({
      ...f.configuration,
      contentPolicy: undefined,
    } as never),
  ).toThrow();
  const get = vi.fn();
  expect(() =>
    createMerchantProductUniqueScopeFactsV2({
      ...f.options,
      command: Object.defineProperty({ ...f.command }, "replacementIntent", {
        get,
        enumerable: true,
      }),
    }),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  const g = fixture();
  await g.run();
  await expect(g.run()).rejects.toThrow();
});

it.each([false, true])(
  "None facts retain independent negative checks and actual scope conflicts (overlap=%s)",
  async (overlap) => {
    const f = fixture(30, true);
    if (overlap) {
      const original = Object.fromEntries(
          Object.entries(f.scopeAssessment).filter(([key]) => key !== "digest"),
        ),
        body = {
          ...original,
          check: { code: "UniqueScope", outcome: "HardError" },
          findings: [
            {
              reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
              versionReference: id(40),
              selectorIndex: 0,
              counterpartIndex: 0,
            },
          ],
        },
        assessment = parseCatalogProductUniqueScopeAssessmentV2({ ...body, digest: hash(body) });
      Object.assign(f.proof, {
        check: assessment.check,
        findings: assessment.findings,
        scopeAssessment: assessment,
        scopeAssessmentDigest: assessment.digest,
      });
      f.proof.digest = hash(
        Object.fromEntries(Object.entries(f.proof).filter(([key]) => key !== "digest")),
      );
    }
    const result = await f.run();
    expect(result.validation.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
    expect(f.proof.equalRankResolution).toBe("NoReplacementRequested");
    expect(result.validation.checks.find((check) => check.code === "UniqueScope")?.outcome).toBe(
      overlap ? "HardError" : "Pass",
    );
    expect(result.validation.checks.find((check) => check.code === "MediaReady")?.outcome).toBe(
      "HardError",
    );
    expect(result.validation.checks.find((check) => check.code === "TaxResolution")?.outcome).toBe(
      "Warning",
    );
    expect(result.validation.validUntil).toBe(plus(2));
    expect(f.work).toHaveBeenCalledTimes(1);
  },
);

it("merges permanent identity contradiction even when every explicit current combination maps", async () => {
  const f = fixture(30, false, true),
    result = await f.run();
  expect(f.proof.variantMappingPrerequisite).toBe("NoExplicitUnmappedCombination");
  expect(result.validation.checks.find((v) => v.code === "VariantMapping")?.outcome).toBe(
    "HardError",
  );
  expect(result.validation.checks.find((v) => v.code === "HardErrorsCleared")?.outcome).toBe(
    "HardError",
  );
  expect(result.validation.checks.find((v) => v.code === "TaxResolution")?.outcome).toBe("Warning");
  expect(f.variantAuthority.holdUntilTransactionCompletes).toHaveBeenCalled();
  f.variantAuthority.holdUntilTransactionCompletes.mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.guard.assertCurrent()).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
});
it("does not clear independent Variant validation errors on a positive history assessment", async () => {
  const f = fixture(30, false, true);
  Object.assign(f.proof, {
    variantMappingAssessment: {
      check: { code: "VariantMapping", outcome: "Pass" },
      originalIntentDigest: hash(f.command),
      replacementIntentDigest: f.command.replacementIntentDigest,
      historyDigest: hash("synthetic history"),
      observedAt: at,
      validUntil: plus(3),
    },
  });
  Object.assign(f.facts, {
    validation: {
      ...f.validation,
      checks: f.validation.checks.map((v) =>
        v.code === "VariantMapping" ? { ...v, outcome: "HardError" } : v,
      ),
    },
  });
  const result = await f.run();
  expect(result.validation.checks.find((v) => v.code === "VariantMapping")?.outcome).toBe(
    "HardError",
  );
});
it("rejects unbound history evidence even with a valid scope proof", async () => {
  const f = fixture(30, false, true);
  Object.assign(f.proof, {
    variantMappingAssessment: {
      check: { code: "VariantMapping", outcome: "Pass" },
      originalIntentDigest: hash("another command"),
      replacementIntentDigest: f.command.replacementIntentDigest,
      historyDigest: hash("synthetic history"),
      observedAt: at,
      validUntil: plus(3),
    },
  });
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
});

it("preserves independent report details while refining owning validation checks", async () => {
  const details = { coverage: "ChecksOnly", impact: "NotRecorded" };
  const f = fixture(30, false, false, details);
  await f.run();
  expect(f.work).toHaveBeenCalledTimes(1);
  const captured = f.work.mock.calls[0]?.[1];
  expect(captured).toEqual(details);
  expect(captured).not.toBe(details);
  details.impact = "SYNTHETIC_LATE_MUTATION";
  expect(captured).toEqual({ coverage: "ChecksOnly", impact: "NotRecorded" });
});
