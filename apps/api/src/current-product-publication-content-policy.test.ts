import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterializationV2,
  productPublicationCheckCodes,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  parseCatalogProductPublicationReplacementIntent,
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  type ProductPublicationApprovalV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationVersionV2,
} from "@rms/catalog";
import { type WarningAcknowledgementQualificationInput } from "./product-publication-qualification-context.js";
import {
  createPostgresTenantBrandConfigurationContentSource,
  tenantBrandConfigurationRequiredFields,
  type TenantBrandConfigurationContentRequest,
} from "@bop/tenant";
import {
  createPostgresPublishingMutationStore,
  parsePublishingProductPublicationPolicy,
} from "@bop/publishing";
import { CatalogError } from "@rms/catalog";
import {
  createCurrentBrandConfigurationContentSource,
  type CurrentBrandConfigurationContent,
} from "./current-brand-configuration-content.js";
import { createCurrentProductPublicationContentPolicySource } from "./current-product-publication-content-policy.js";
import { currentProductPolicyFields } from "./current-product-publication-policy.js";
// Pure fixtures exercise actual owning parsers/planner, not database provenance,
// permission, processing qualification or an actual current policy holder.
const id = (n: number) => "01902440-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  due = "2026-10-03T13:00:00.000Z",
  expiry = "2026-10-04T12:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, -1),
  utcOffsetMinutes: 0,
});
const selector = {
  level: "Store",
  reference: id(30),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
};
function originalAggregate() {
  return {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_CONTEXT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic context" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
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
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  };
}
function replacement(exact = false) {
  const body = exact
    ? {
        profile: "CatalogProductExactStoreSelectorReplacementV1",
        mode: "PermanentSelectorRetirement",
        previousVersionReference: id(40),
        previousPublicationOperationReference: id(41),
        expectedPreviousPublicationVersion: 3,
        previousIntentDigest: hash("old intent"),
        previousScopeDigest: hash([selector]),
        previousPeriodDigest: hash("old period"),
        previousSelectorIndex: 0,
        previousSelectorDigest: hash(selector),
      }
    : { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseCatalogProductPublicationReplacementIntent({ ...body, digest: hash(body) });
}
function initial(exact = false, future = false) {
  const aggregate = parseProductAggregate(originalAggregate()),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    replacementIntent = replacement(exact),
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(8),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [selector],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: boundary(future ? due : at),
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_CONTEXT",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    });
  return {
    command,
    aggregate,
    current: null as ProductPublicationVersionV2 | null,
    content: null,
    observedAt: at,
  };
}
type Input = ReturnType<typeof initial>;
function facts(
  input: Input,
  approval: ProductPublicationApprovalV2 | null,
): ProductPublicationFactsV2 {
  const c = input.command,
    pending = ["Validate", "SubmitReview", "Reject", "CancelScheduledPublish"].includes(c.action);
  return {
    now: input.observedAt,
    productAggregateVersion: input.aggregate.aggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: c.replacementIntentDigest,
      evidenceReference: id(100 + c.expectedPublicationVersion),
      productAggregateVersion: input.aggregate.aggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(20),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome: code === "ApprovalPolicy" && pending ? "Pending" : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: input.observedAt,
      validUntil: expiry,
    },
    approval: pending ? null : approval,
    reviewReference: c.action === "SubmitReview" ? id(21) : null,
    replacement: null,
  };
}
function applied(input: Input, approval: ProductPublicationApprovalV2 | null = null) {
  const publication = planCatalogProductPublicationV2(
    input.command,
    input.current,
    facts(input, approval),
  );
  const aggregate =
    publication.state === "Published"
      ? createCatalogProductPublicationMaterializationV2(input.aggregate, publication).successor
      : parseProductAggregate({
          ...input.aggregate,
          aggregateVersion: input.aggregate.aggregateVersion + 1,
          updatedAt: input.observedAt,
        });
  return { publication, aggregate };
}
function following(
  input: Input,
  action: ProductPublicationCommandV2["action"],
  approval: ProductPublicationApprovalV2 | null = null,
  patch: Partial<ProductPublicationCommandV2> = {},
): Input {
  const result = applied(input, approval);
  return {
    command: parseProductPublicationCommandV2({
      ...input.command,
      action,
      expectedProductAggregateVersion: result.aggregate.aggregateVersion,
      expectedPublicationVersion: result.publication.publicationVersion,
      operationReference: id(200 + result.publication.publicationVersion),
      actorReference: action === "Approve" || action === "Reject" ? id(9) : id(3),
      actorKind: action === "ActivateScheduled" ? "System" : "User",
      scheduleReference: [
        "SchedulePublish",
        "ReschedulePublish",
        "CancelScheduledPublish",
        "ActivateScheduled",
      ].includes(action)
        ? id(22)
        : null,
      successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(action)
        ? id(23)
        : null,
      ...patch,
    }),
    aggregate: result.aggregate,
    current: result.publication,
    content: null,
    observedAt: input.observedAt,
  };
}
function review(exact = false, future = false) {
  const validate = initial(exact, future),
    submit = following(validate, "SubmitReview"),
    approve = following(submit, "Approve");
  const current = approve.current;
  if (
    !current ||
    !current.reviewReference ||
    current.reviewVersion === null ||
    !current.submittedByActorReference
  )
    throw Error("Missing synthetic review");
  const approval: ProductPublicationApprovalV2 = {
    profile: "CatalogProductPublicationApprovalV2",
    replacementIntentDigest: current.replacementIntentDigest,
    evidenceReference: approve.command.operationReference,
    reviewReference: current.reviewReference,
    reviewVersion: current.reviewVersion,
    requestedByActorReference: current.submittedByActorReference,
    approvedByActorReference: approve.command.actorReference,
    contentDigest: current.contentDigest,
    configurationDigest: current.configurationDigest,
    scopeDigest: current.scopeDigest,
    periodDigest: current.periodDigest,
    policyReference: current.policyReference,
    policyVersion: current.policyVersion,
    approvedAt: at,
    validUntil: expiry,
  };
  return { validate, submit, approve, approval };
}

const deadline = (observedAt: string, milliseconds = 3000) =>
  new Date(Date.parse(observedAt) + milliseconds).toISOString();
const humanAt = "2026-10-03T14:00:00.000Z";
function acknowledgementFixture(exact = false): WarningAcknowledgementQualificationInput {
  const input = initial(exact),
    base = facts(input, null),
    f = {
      ...base,
      validation: {
        ...base.validation,
        validUntil: deadline(at),
        checks: base.validation.checks.map((check) =>
          check.code === "ChangeImpact" ? { ...check, outcome: "Warning" as const } : check,
        ),
      },
    };
  const current = planCatalogProductPublicationV2(input.command, null, f),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_REFERENCE_GAP",
          outcome: "Warning",
          subjectReference: id(80),
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_REFERENCE",
          sourceDigest: hash("source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant"),
          observedAt: at,
          validUntil: deadline(at),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: input.command,
      publication: current,
      validation: f.validation,
      details,
      recordedAt: at,
    }),
    aggregate = parseProductAggregate({ ...input.aggregate, aggregateVersion: 11 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(60),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 11,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: humanAt,
    });
  return {
    command,
    aggregate,
    current,
    report,
    observedAt: deadline(humanAt, 10),
    validUntil: deadline(humanAt, 2000),
  };
}
vi.mock("@bop/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/tenant")>()),
  createPostgresTenantBrandConfigurationContentSource: vi.fn(),
}));
vi.mock("@bop/publishing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: vi.fn(),
}));
vi.mock("./current-brand-configuration-content.js", () => ({
  createCurrentBrandConfigurationContentSource: vi.fn(),
}));
// Public owning factories are controlled here; native acceptance covers actual
// Tenant/Publishing rows, lock acquisition and rollback with these same ports.
function fixture() {
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  let clock = at,
    current = true,
    policyDenied = false,
    committed = false;
  let brandPatch: Partial<CurrentBrandConfigurationContent> = {};
  let policy = parsePublishingProductPublicationPolicy({
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(1),
    brandReference: id(2),
    familyReference: id(19),
    policyReference: id(20),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: null,
  });
  const guards: { guard: () => Promise<void>; finalAssert: () => void }[] = [];
  const brandFor = (
    request: TenantBrandConfigurationContentRequest,
  ): CurrentBrandConfigurationContent => ({
    profile: "CurrentBrandConfigurationContentV1",
    tenantReference: id(1),
    brandReference: id(2),
    brandVersion: 1,
    configurationVersionReference: id(50),
    configurationVersion: 1,
    contentDigest: hash("actual synthetic brand"),
    originalPublicationReference: id(51),
    currentPublicationReference: id(52),
    defaultLocale: "en-CA",
    supportedLocales: ["en-CA", "fr-CA"],
    overrideAllowedFieldCodes: [],
    hardRequirementFieldCodes: ["RECIPE.VERSION"],
    catalogSourceReference: id(53),
    platformTemplateReference: id(54),
    effectiveFrom: at,
    effectiveUntil: null,
    originalIntentDigest: request.originalIntentDigest,
    observedAt: request.observedAt,
    validUntil: request.validUntil,
    eligibility: "NotEvaluated",
    ...brandPatch,
  });
  vi.mocked(createPostgresTenantBrandConfigurationContentSource).mockImplementation((options) => ({
    async withRecordedConfiguration(request, work) {
      return options.authority.withCurrentContentRead(
        request,
        tenantBrandConfigurationRequiredFields,
        () =>
          options.transactions.run(async (actual) => {
            expect(actual).toBe(tx);
            expect(
              await options.authority.isCurrent(
                actual,
                request,
                tenantBrandConfigurationRequiredFields,
              ),
            ).toBe(true);
            const result = await work(null as never, actual);
            expect(
              await options.authority.isCurrent(
                actual,
                request,
                tenantBrandConfigurationRequiredFields,
              ),
            ).toBe(true);
            return result;
          }),
      );
    },
  }));
  vi.mocked(createCurrentBrandConfigurationContentSource).mockImplementation((recorded) => ({
    async withCurrentContent(request, work) {
      return recorded.withRecordedConfiguration(request, async (_unused, actual) =>
        work(brandFor(request), actual),
      );
    },
  }));
  const policyReads = vi.fn();
  vi.mocked(createPostgresPublishingMutationStore).mockImplementation(
    (transactions) =>
      ({
        async resolveCurrentProductPublicationPolicy(input: unknown) {
          const request = input as {
            policyReference: string;
            policyVersion: number;
            observedAt: string;
          };
          policyReads(request);
          return transactions.run(async (actual) => {
            expect(actual).toBe(tx);
            return {
              content: policy,
              observedAt: request.observedAt,
              current: { release: { releaseId: id(55) } },
            } as Awaited<
              ReturnType<
                ReturnType<
                  typeof createPostgresPublishingMutationStore
                >["resolveCurrentProductPublicationPolicy"]
              >
            >;
          });
        },
      }) as ReturnType<typeof createPostgresPublishingMutationStore>,
  );
  type Options = Parameters<typeof createCurrentProductPublicationContentPolicySource>[0];
  const holdPackets = vi.fn(),
    currentPackets = vi.fn(),
    policyPackets = vi.fn();
  const brandAuthority: Options["brandAuthority"] = {
    async withCurrentContentRead(actual, input, work) {
      expect(this).toBe(brandAuthority);
      expect(actual).toBe(tx);
      holdPackets(input);
      return work();
    },
    async isCurrent(actual, input) {
      expect(this).toBe(brandAuthority);
      expect(actual).toBe(tx);
      currentPackets(input);
      return current;
    },
  };
  const policyAuthority: Options["policyAuthority"] = {
    async holdUntilTransactionCompletes(actual, input) {
      expect(this).toBe(policyAuthority);
      expect(actual).toBe(tx);
      policyPackets(input);
      if (policyDenied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  };
  const options: Options = {
    transaction: tx,
    clock: {
      now() {
        expect(this).toBe(options.clock);
        return clock;
      },
    },
    configurationVersionReference: id(50),
    expectedBrandVersion: 1,
    policyReference: id(20),
    policyVersion: 1,
    brandAuthority,
    policyAuthority,
    registerBeforeCommit(actual, guard, finalAssert) {
      expect(this).toBe(options);
      expect(actual).toBe(tx);
      guards.push({ guard, finalAssert });
    },
  };
  const source = createCurrentProductPublicationContentPolicySource(options);
  const commit = async () => {
    for (const entry of guards) await entry.guard();
    for (const entry of guards) expect(entry.finalAssert()).toBeUndefined();
    committed = true;
  };
  return {
    source,
    options,
    tx,
    guards,
    commit,
    policyReads,
    holdPackets,
    currentPackets,
    policyPackets,
    setClock: (value: string) => {
      clock = value;
    },
    denyBrand: () => {
      current = false;
    },
    denyPolicy: () => {
      policyDenied = true;
    },
    setBrand: (patch: Partial<CurrentBrandConfigurationContent>) => {
      brandPatch = patch;
    },
    setPolicy: (patch: Readonly<Record<string, unknown>>) => {
      policy = parsePublishingProductPublicationPolicy({ ...policy, ...patch });
    },
    committed: () => committed,
  };
}
beforeEach(() => vi.resetAllMocks());
it("uses actual current Brand and policy in one caller transaction and only assesses locale/presence rules", async () => {
  const f = fixture(),
    input = initial();
  const proof = await f.source.withPublication(input, deadline(at), async (value) => value);
  expect(proof.check).toEqual({ code: "DefaultLocaleName", outcome: "Pass" });
  expect(proof.requiredMediaPresence).toEqual({ code: "RequiredMediaPresence", outcome: "Pass" });
  expect(proof).toMatchObject({
    originalIntentDigest: hash(input.command),
    replacementIntentDigest: input.command.replacementIntentDigest,
    validUntil: deadline(at),
    brandFieldRequirements: "NotEvaluated",
    mediaReadiness: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(proof.assessment.brandFieldRequirements).toBe("NotEvaluated");
  expect(proof.brand.hardRequirementFieldCodes).toEqual(["RECIPE.VERSION"]);
  expect(proof.findings).toEqual([]);
  expect(proof.sources).toHaveLength(2);
  expect(f.guards).toHaveLength(1);
  await f.commit();
  expect(f.committed()).toBe(true);
  expect(f.policyReads).toHaveBeenCalledTimes(1); // retained owner SHARE locks; no repeated full query.
  expect(f.holdPackets).toHaveBeenLastCalledWith(
    expect.objectContaining({
      command: input.command,
      actorKind: "User",
      purposeCode: input.command.purposeCode,
      request: expect.objectContaining({
        purposeCode: "CATALOG_PRODUCT_CONTENT",
        originalIntentDigest: hash(input.command),
        validUntil: deadline(at),
      }),
      requiredFields: tenantBrandConfigurationRequiredFields,
    }),
  );
  expect(f.policyPackets).toHaveBeenLastCalledWith(
    expect.objectContaining({
      command: input.command,
      requiredFields: currentProductPolicyFields,
      observedAt: at,
      validUntil: deadline(at),
    }),
  );
});
it.each([
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "CancelScheduledPublish",
  "ReschedulePublish",
  "ActivateScheduled",
] as const)("preserves real %s action and current policy selection", async (action) => {
  const f = fixture(),
    sequence = review(false, true),
    scheduled = following(sequence.approve, "SchedulePublish", sequence.approval);
  let input: Input;
  if (action === "SubmitReview") input = sequence.submit;
  else if (action === "Approve") input = sequence.approve;
  else if (action === "Reject")
    input = {
      ...sequence.approve,
      command: parseProductPublicationCommandV2({ ...sequence.approve.command, action }),
    };
  else if (action === "Publish" || action === "SchedulePublish")
    input = following(sequence.approve, action, sequence.approval);
  else input = following(scheduled, action, sequence.approval);
  // A server fallback selector cannot override the policy frozen by the current head.
  Object.assign(f.options, { policyReference: id(900), policyVersion: 9 });
  const proof = await f.source.withPublication(input, deadline(at), async (value) => value);
  expect(proof.originalIntentDigest).toBe(hash(input.command));
  expect(f.policyReads).toHaveBeenCalledWith({
    policyReference: id(20),
    policyVersion: 1,
    observedAt: at,
  });
  expect(f.holdPackets).toHaveBeenCalledWith(
    expect.objectContaining({
      command: input.command,
      actorKind: action === "ActivateScheduled" ? "System" : "User",
      purposeCode: input.command.purposeCode,
    }),
  );
  await f.commit();
});
it("retains independent Ack purpose/full hash and may read after the displayed report lease", async () => {
  const f = fixture(),
    input = acknowledgementFixture();
  f.setClock(input.observedAt);
  const proof = await f.source.withAcknowledgement(input, async (value) => value);
  expect(input.report.validation.validUntil < input.observedAt).toBe(true);
  expect(proof.originalIntentDigest).toBe(hash(input.command));
  expect(proof.validUntil).toBe(input.validUntil);
  expect(f.holdPackets).toHaveBeenCalledWith(
    expect.objectContaining({
      command: input.command,
      actorKind: "User",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    }),
  );
  await f.commit();
});
it.each(["locale", "name"])(
  "returns a real DefaultLocaleName HardError finding for %s",
  async (mode) => {
    const f = fixture();
    if (mode === "locale") f.setBrand({ defaultLocale: "fr-CA", supportedLocales: ["fr-CA"] });
    else f.setPolicy({ requiredLocales: ["en-CA", "fr-CA"] });
    const proof = await f.source.withPublication(initial(), deadline(at), async (value) => value);
    expect(proof.check.outcome).toBe("HardError");
    expect(
      proof.findings.some(
        (finding) =>
          finding.checkCode === "DefaultLocaleName" &&
          finding.outcome === "HardError" &&
          finding.references.length === 2,
      ),
    ).toBe(true);
    await f.commit();
  },
);
it("required absent media is only a presence prerequisite, never a fabricated MediaReady check", async () => {
  const f = fixture();
  f.setPolicy({ mediaRequirement: "Required" });
  const proof = await f.source.withPublication(initial(), deadline(at), async (value) => value);
  expect(proof.check.outcome).toBe("Pass");
  expect(proof.requiredMediaPresence.outcome).toBe("HardError");
  expect(proof.mediaReadiness).toBe("NotEvaluated");
  expect(proof.findings).toEqual([]);
  await f.commit();
});
it.each(["brand", "policy"])(
  "keeps the minimum original %s expiry through final commit",
  async (owner) => {
    const f = fixture(),
      end = deadline(at, 1000);
    if (owner === "brand") f.setBrand({ effectiveUntil: end, validUntil: end });
    else f.setPolicy({ effectiveUntil: end });
    const proof = await f.source.withPublication(initial(), deadline(at), async (value) => value);
    expect(proof.validUntil).toBe(end);
    f.setClock(end);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.committed()).toBe(false);
  },
);
it.each(["brand", "policy"])(
  "late %s denial rejects outer commit with the safe owning error",
  async (owner) => {
    const f = fixture();
    let consumers = 0;
    await f.source.withPublication(initial(), deadline(at), async () => {
      consumers++;
    });
    if (owner === "brand") f.denyBrand();
    else f.denyPolicy();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(consumers).toBe(1);
    expect(f.committed()).toBe(false);
  },
);
it("a later host async guard cannot exhaust an already checked source lease", async () => {
  const f = fixture();
  let consumers = 0;
  await f.source.withPublication(initial(), deadline(at), async () => {
    consumers++;
  });
  f.guards.push({
    guard: async () => {
      f.setClock(deadline(at));
    },
    finalAssert: () => undefined,
  });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(consumers).toBe(1);
  expect(f.committed()).toBe(false);
});
it("detects a partial clock rollback above the original observation", async () => {
  const f = fixture();
  await f.source.withPublication(initial(), deadline(at), async () => {
    f.setClock(deadline(at, 2));
  });
  f.setClock(deadline(at, 1));
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["invalid clock", "changed query", "bad binding"])(
  "poisons caught early %s failures through outer commit",
  async (mode) => {
    const f = fixture(),
      input = initial();
    let consumers = 0;
    if (mode === "invalid clock") f.setClock("not an instant");
    if (mode === "changed query") f.tx.query = vi.fn(async () => ({ rows: [] }));
    const raw =
      mode === "bad binding"
        ? { ...input, command: { ...input.command, contentDigest: hash("foreign") } }
        : input;
    await expect(
      f.source.withPublication(raw as Input, deadline(at), async () => {
        consumers++;
      }),
    ).rejects.toThrow();
    f.setClock(at);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(consumers).toBe(0);
    expect(f.committed()).toBe(false);
  },
);
it("caught same-source reentry poisons the actual transaction", async () => {
  const f = fixture();
  let outer = 0,
    inner = 0;
  await expect(
    f.source.withPublication(initial(), deadline(at), async () => {
      outer++;
      await expect(
        f.source.withPublication(initial(), deadline(at), async () => {
          inner++;
        }),
      ).rejects.toThrow();
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(outer).toBe(1);
  expect(inner).toBe(0);
  expect(f.committed()).toBe(false);
});
it("captures configured ports and selectors before consumer mutation", async () => {
  const f = fixture();
  await f.source.withPublication(initial(), deadline(at), async () => {
    f.options.brandAuthority.isCurrent = async () => {
      throw Error("replacement must not run");
    };
    f.options.policyAuthority.holdUntilTransactionCompletes = async () => {
      throw Error("replacement must not run");
    };
    Object.assign(f.options, { configurationVersionReference: id(999), expectedBrandVersion: 9 });
  });
  await f.commit();
  expect(f.committed()).toBe(true);
});
it("does not accept absent, duplicated or substituted Brand holder callbacks", async () => {
  for (const mode of ["absent", "duplicate", "substituted"] as const) {
    const f = fixture();
    let consumers = 0;
    f.options.brandAuthority.withCurrentContentRead = async (_tx, _input, work) => {
      if (mode === "absent") return undefined as never;
      const result = await work();
      if (mode === "duplicate") {
        try {
          await work();
        } catch {
          /* a malicious holder cannot hide failure */
        }
      }
      return mode === "substituted" ? ({} as never) : result;
    };
    const source = createCurrentProductPublicationContentPolicySource(f.options);
    await expect(
      source.withPublication(initial(), deadline(at), async () => {
        consumers++;
      }),
    ).rejects.toThrow();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(consumers).toBe(mode === "absent" ? 0 : 1);
    expect(f.committed()).toBe(false);
  }
});
it("detaches Brand metadata and refuses accessors without invoking them", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(1));
  // Inject the accessor at the source boundary, before the safe detached copy.
  vi.mocked(createCurrentBrandConfigurationContentSource).mockImplementation(() => ({
    async withCurrentContent(_request, work) {
      return work(
        Object.defineProperty({}, "tenantReference", {
          enumerable: true,
          get: getter,
        }) as CurrentBrandConfigurationContent,
        f.tx,
      );
    },
  }));
  await expect(
    f.source.withPublication(initial(), deadline(at), async () => undefined),
  ).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toThrow();
});
it("refuses incomplete Product content before acquiring any owning facts", async () => {
  const f = fixture(),
    input = initial(),
    raw = structuredClone(input.aggregate);
  Reflect.deleteProperty(raw.draft, "editorContent");
  const aggregate = parseProductAggregate(raw),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const command = parseProductPublicationCommandV2({
    ...input.command,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
  });
  await expect(
    f.source.withPublication({ ...input, command, aggregate }, deadline(at), async () => undefined),
  ).rejects.toThrow();
  expect(f.policyReads).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toThrow();
});

it("revalidation can select a changed current policy, while Ack cannot transplant that policy", async () => {
  const f = fixture(),
    first = initial(),
    previous = applied(first);
  const input: Input = {
    ...first,
    aggregate: previous.aggregate,
    current: previous.publication,
    command: parseProductPublicationCommandV2({
      ...first.command,
      operationReference: id(400),
      expectedProductAggregateVersion: previous.aggregate.aggregateVersion,
      expectedPublicationVersion: previous.publication.publicationVersion,
    }),
  };
  f.setPolicy({ policyReference: id(90), policyVersion: 2 });
  Object.assign(f.options, { policyReference: id(90), policyVersion: 2 });
  const source = createCurrentProductPublicationContentPolicySource(f.options);
  const proof = await source.withPublication(input, deadline(at), async (value) => value);
  expect(proof.policy.content.policyReference).toBe(id(90));
  expect(f.policyReads).toHaveBeenLastCalledWith({
    policyReference: id(90),
    policyVersion: 2,
    observedAt: at,
  });
  await f.commit();
  const ack = acknowledgementFixture();
  f.setClock(ack.observedAt);
  await expect(source.withAcknowledgement(ack, async () => undefined)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.policyReads).toHaveBeenLastCalledWith({
    policyReference: id(20),
    policyVersion: 1,
    observedAt: ack.observedAt,
  });
});
it("unrelated Brand governance and configuration refreshes do not change relevant locale facts", async () => {
  const f = fixture(),
    input = initial();
  const first = await f.source.withPublication(input, deadline(at), async (value) => value);
  f.setBrand({
    brandVersion: 2,
    configurationVersionReference: id(60),
    configurationVersion: 2,
    currentPublicationReference: id(61),
    originalPublicationReference: id(62),
    contentDigest: hash("different source metadata"),
    hardRequirementFieldCodes: ["OTHER.FIELD"],
    platformTemplateReference: id(63),
    supportedLocales: ["fr-CA", "en-CA"],
  });
  Object.assign(f.options, { expectedBrandVersion: 2, configurationVersionReference: id(60) });
  const second = await createCurrentProductPublicationContentPolicySource(
    f.options,
  ).withPublication(input, deadline(at), async (value) => value);
  expect(second.sources[0]?.sourceDigest).not.toBe(first.sources[0]?.sourceDigest);
  expect(second.sources[0]?.generation).not.toBe(first.sources[0]?.generation);
  expect(second.sources[0]?.relevantReferenceDigest).toBe(
    first.sources[0]?.relevantReferenceDigest,
  );
  expect(second.check).toEqual(first.check);
  await f.commit();
});
