import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import {
  CatalogError,
  assessCatalogProductContentPolicy,
  contentRegistryFields,
  buildCatalogProductPublicationValidationReport,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductContentRegistry,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  productEditorContentFields,
  productEditorContentReferenceChecks,
  type createPostgresProductContentRegistryStore,
  type CatalogProductPublicationValidationFinding,
  type ProductPublicationFactsV2,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput,
  bindWarningAcknowledgementQualificationInput,
  type PublicationQualificationInput,
  type ProductPublicationQualificationContext,
  type WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";
import {
  createCurrentProductPublicationRegisteredContentSource,
  type ProductPublicationRegisteredContentProofs,
} from "./current-product-publication-registered-content.js";
import type { CurrentBrandConfigurationContent } from "./current-brand-configuration-content.js";
import type { MerchantProductPublicationContentAuthorityV2Input } from "./merchant-product-publication-content-authority-v2.js";

type OwnerOptions = Parameters<typeof createPostgresProductContentRegistryStore>[0];
type Options = Parameters<typeof createCurrentProductPublicationRegisteredContentSource>[0];
type Tx = Options["transaction"];
const owner = vi.hoisted(() => ({ mode: "normal", create: vi.fn(), read: vi.fn() }));
// Only the owning database acquisition is controlled. Full context, policy,
// registry/reference rules and report parsers are real; this is not SQL/IAM proof.
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductContentRegistryStore(options: OwnerOptions) {
    owner.create(options);
    return {
      async withCurrentRegistry<T>(
        observation: { originalIntentDigest: string; observedAt: string; validUntil: string },
        work: (value: unknown, actual: Tx) => Promise<T>,
      ): Promise<T> {
        return options.transactions.run(async (tx) => {
          const registry = parseCatalogProductContentRegistry(await owner.read()),
            auth = {
              tenantReference: options.tenantReference,
              brandReference: options.brandReference,
              actorReference: options.actorReference,
              actorKind: options.actorKind,
              purposeCode: "CATALOG_PRODUCT_CONTENT_REGISTRY",
              permission: "catalog.manage",
              action: "catalog.content-registry.read",
              registry,
              requiredFields: contentRegistryFields,
              observedAt: options.clock.now(),
            } as Parameters<OwnerOptions["authority"]["holdUntilTransactionCompletes"]>[1];
          if (owner.mode === "authority-fields") Object.assign(auth, { requiredFields: [] });
          await options.authority.holdUntilTransactionCompletes(tx, { ...auth, registry: null });
          await options.authority.holdUntilTransactionCompletes(tx, auth);
          if (owner.mode === "skip") return undefined as T;
          const packet = {
            registry,
            snapshotDigest: hash(registry),
            observation,
            eligibility: "NotEvaluated",
          };
          if (owner.mode === "packet-hash") packet.snapshotDigest = hash("wrong registry");
          const actual = owner.mode === "foreign" ? { query: vi.fn() } : tx;
          let result: T;
          try {
            result = await work(packet, actual);
          } catch (error) {
            if (owner.mode !== "swallow") throw error;
            return undefined as T;
          }
          if (owner.mode === "repeat") {
            try {
              await work(packet, tx);
            } catch {
              /* A caught error must still poison the holder. */
            }
          }
          await options.authority.holdUntilTransactionCompletes(tx, auth);
          return owner.mode === "substitute" ? ({} as T) : result;
        });
      },
    };
  },
}));
const id = (n: number) => "01902449-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString(),
  until = plus(at, 3000);
function publication(
  modes: readonly ("Pinned" | "CurrentPublished")[] = [],
): PublicationQualificationInput {
  const bindings = modes.map((_, index) => ({
    bindingReference: id(900 + index),
    optionSetReference: id(100 + index),
    optionSetVersionReference: id(200 + index),
    purpose: "CUSTOMIZATION",
    sortOrder: index,
    enabledOptionReferences: [id(300 + index)],
    defaultSelections: [{ optionReference: id(300 + index), quantity: 1 }],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: ["WEB"],
    storeOverrideAllowed: false,
  }));
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_REGISTERED_CONTENT",
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
        localizedNames: { "en-CA": "Synthetic registered content" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: bindings,
        createdAt: at,
        updatedAt: at,
        editorContent: {
          profile: "CatalogProductEditorContentV1",
          localizedShortDescriptions: {},
          localizedDescriptions: {},
          preparationNotes: {},
          tagReferences: [id(90)],
          attributeValues: [
            { attributeReference: id(91), type: "Text", value: "Actual typed content" },
          ],
          media: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: bindings.map((binding, index) => ({
            bindingReference: binding.bindingReference,
            versionResolution: modes[index],
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          })),
          allergenReferences: [],
          nutritionProfile: null,
        },
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
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
      expectedProductAggregateVersion: 7,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(30), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_REGISTERED_CONTENT",
      replacementIntent: { ...none, digest: hash(none) },
      replacementIntentDigest: hash(none),
    });
  return { command, aggregate, current: null, content: null, observedAt: at };
}
function registry() {
  return parseCatalogProductContentRegistry({
    profile: "CatalogProductContentRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(80),
    versionReference: id(81),
    registryVersion: 1,
    defaultLocale: "en-CA",
    previousSnapshotDigest: null,
    registeredAt: at,
    tags: [
      {
        tagReference: id(90),
        code: "SYNTHETIC_TAG",
        localizedNames: { "en-CA": "Synthetic tag" },
        lifecycle: "Active",
      },
    ],
    attributes: [
      {
        attributeReference: id(91),
        code: "SYNTHETIC_TEXT",
        localizedNames: { "en-CA": "Synthetic text" },
        lifecycle: "Active",
        type: "Text",
        maximumLength: 100,
      },
    ],
  });
}
function sourceEvidence(
  code: string,
  c: ProductPublicationQualificationContext,
  deadline: string = c.validUntil,
) {
  return {
    sourceCode: code,
    sourceDigest: hash(code),
    generation: "1",
    relevantReferenceDigest: hash({ code, semantics: "SYNTHETIC" }),
    observedAt: c.observedAt,
    validUntil: deadline,
  };
}
function finding(
  code: CatalogProductPublicationValidationFinding["checkCode"],
): CatalogProductPublicationValidationFinding {
  return {
    checkCode: code,
    ruleCode: "SYNTHETIC_BOUND_RULE",
    outcome: "HardError",
    subjectReference: id(5),
    reasonCode: "SYNTHETIC_BOUND_NEGATIVE",
    references: [],
  };
}
function proofs(
  c: ProductPublicationQualificationContext,
  opts: { requiredMedia?: boolean; requiredFrench?: boolean; deadline?: string } = {},
): ProductPublicationRegisteredContentProofs {
  const deadline = opts.deadline ?? c.validUntil,
    brand: CurrentBrandConfigurationContent = {
      profile: "CurrentBrandConfigurationContentV1",
      tenantReference: id(1),
      brandReference: id(2),
      brandVersion: 1,
      configurationVersionReference: id(50),
      configurationVersion: 1,
      contentDigest: hash("synthetic Brand"),
      originalPublicationReference: id(51),
      currentPublicationReference: id(52),
      defaultLocale: "en-CA",
      supportedLocales: ["en-CA", "fr-CA"],
      overrideAllowedFieldCodes: [],
      hardRequirementFieldCodes: [],
      catalogSourceReference: id(53),
      platformTemplateReference: id(54),
      effectiveFrom: at,
      effectiveUntil: null,
      originalIntentDigest: c.originalIntentDigest,
      observedAt: c.observedAt,
      validUntil: c.validUntil,
      eligibility: "NotEvaluated",
    },
    policy = parsePublishingProductPublicationPolicy({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(19),
      policyReference: id(20),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: opts.requiredFrench ? ["en-CA", "fr-CA"] : ["en-CA"],
      mediaRequirement: opts.requiredMedia ? "Required" : "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    }),
    assessment = assessCatalogProductContentPolicy(
      c.aggregate,
      {
        tenantReference: brand.tenantReference,
        brandReference: brand.brandReference,
        brandVersion: brand.brandVersion,
        configurationVersionReference: brand.configurationVersionReference,
        contentDigest: brand.contentDigest,
        currentPublicationReference: brand.currentPublicationReference,
        supportedLocales: brand.supportedLocales,
        originalIntentDigest: c.originalIntentDigest,
        observedAt: c.observedAt,
        validUntil: brand.validUntil,
      },
      policy,
      {
        tenantReference: c.tenantReference,
        productReference: c.productReference,
        versionReference: c.versionReference,
        expectedAggregateVersion: c.aggregateVersion,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        originalIntentDigest: c.originalIntentDigest,
        observedAt: c.observedAt,
        validUntil: deadline,
      },
    ),
    common = {
      originalIntentDigest: c.originalIntentDigest,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      observedAt: c.observedAt,
      validUntil: deadline,
    },
    localeError = assessment.checks.some(
      (check) => check.code !== "RequiredMediaPresence" && check.outcome === "HardError",
    ),
    requiredMediaPresence = assessment.checks.find(
      (check) => check.code === "RequiredMediaPresence",
    );
  if (!requiredMediaPresence) throw new Error("Missing real policy assessment");
  return {
    policy: {
      ...common,
      replacementIntentDigest: c.replacementIntentDigest,
      brand,
      policy: {
        content: policy,
        currentPublicationReference: id(55),
        observedAt: c.observedAt,
        validUntil: deadline,
      },
      assessment,
      check: { code: "DefaultLocaleName", outcome: localeError ? "HardError" : "Pass" },
      requiredMediaPresence,
      findings: localeError ? [finding("DefaultLocaleName")] : [],
      sources: [
        sourceEvidence("BRAND_CONTENT_POLICY", c, deadline),
        sourceEvidence("PRODUCT_PUBLICATION_POLICY", c, deadline),
      ],
      brandFieldRequirements: "NotEvaluated",
      mediaReadiness: "NotEvaluated",
      publishValidation: "Incomplete",
    },
    media: {
      ...common,
      replacementIntentDigest: c.replacementIntentDigest,
      check: { code: "MediaReady", outcome: "Pass" },
      findings: [],
      sources: [sourceEvidence("MEDIA_READINESS", c, deadline)],
    },
    options: {
      ...common,
      check: { code: "OptionSelection", outcome: "Pass" },
      findings: [],
      sources: [sourceEvidence("PINNED_OPTION_RULES", c, deadline)],
    },
    variant: {
      ...common,
      check: { code: "VariantMapping", outcome: "Pass" },
      findings: [],
      historyDigest: hash("VARIANT_IDENTITY_HISTORY"),
      sources: [sourceEvidence("VARIANT_IDENTITY_HISTORY", c, deadline)],
      // A controlled already-held leaf result. The holder intentionally does not
      // reparse the large provenance graph; its owning source tests cover that.
      referenceProvenance:
        {} as ProductPublicationRegisteredContentProofs["variant"]["referenceProvenance"],
    },
  };
}
function acknowledgement(): WarningAcknowledgementQualificationInput {
  const input = publication(),
    c = input.command,
    f: ProductPublicationFactsV2 = {
      now: at,
      productAggregateVersion: 7,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      approval: null,
      reviewReference: null,
      replacement: null,
      validation: {
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: c.replacementIntentDigest,
        evidenceReference: id(70),
        productAggregateVersion: 7,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        policyReference: id(20),
        policyVersion: 1,
        approvalPolicy: "Required",
        checks: productPublicationCheckCodes.map((code) => ({
          code,
          outcome:
            code === "ApprovalPolicy" ? "Pending" : code === "ChangeImpact" ? "Warning" : "Pass",
        })),
        warningAcknowledgement: null,
        checkedAt: at,
        validUntil: until,
      },
    },
    current = planCatalogProductPublicationV2(c, null, f),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [{ ...finding("ChangeImpact"), outcome: "Warning" }],
      sources: [
        sourceEvidence("SYNTHETIC_VALIDATION", bindPublicationQualificationInput(input, until)),
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: c,
      publication: current,
      validation: f.validation,
      details,
      recordedAt: at,
    }),
    observedAt = plus(at, 7200000),
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
      occurredAt: observedAt,
    });
  return { command, aggregate, current, report, observedAt, validUntil: plus(observedAt, 2000) };
}
function fixture() {
  let time = at;
  const tx = { query: vi.fn(async () => ({ rows: [] })) },
    guards: { guard: () => Promise<void>; final: () => void }[] = [],
    hold = vi.fn(
      async (
        actual: Tx,
        input: Parameters<Options["registryAuthority"]["holdUntilTransactionCompletes"]>[1],
      ): Promise<void> => {
        void actual;
        void input;
      },
    ),
    options: Options = {
      transaction: tx,
      clock: { now: () => time },
      registryAuthority: { holdUntilTransactionCompletes: hold },
      registerBeforeCommit: async (actual, guard, final) => {
        expect(actual).toBe(tx);
        guards.push({ guard, final });
      },
    },
    source = createCurrentProductPublicationRegisteredContentSource(options);
  return {
    tx,
    guards,
    hold,
    options,
    source,
    setTime: (value: string) => {
      time = value;
    },
    async commit() {
      for (const item of guards) await item.guard();
      for (const item of guards) item.final();
    },
  };
}
function editor(
  input: PublicationQualificationInput,
  mode: "Read" | "Publish",
  aggregate = input.aggregate,
): MerchantProductPublicationContentAuthorityV2Input {
  return {
    mode,
    aggregate,
    requiredFields: productEditorContentFields,
    requiredReferenceChecks: mode === "Read" ? [] : productEditorContentReferenceChecks,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(30),
    actorReference: id(3),
    sessionReference: id(40),
    productReference: id(5),
    operationReference: input.command.operationReference,
    permission: "catalog.manage",
    owningAction: "catalog.product.read",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    command: input.command,
    originalIntentDigest: hash(input.command),
    replacementIntentDigest: input.command.replacementIntentDigest,
    observedAt: input.observedAt,
    validUntil: plus(input.observedAt, 5000),
  };
}
beforeEach(() => {
  owner.mode = "normal";
  owner.create.mockClear();
  owner.read.mockReset();
  owner.read.mockResolvedValue(registry());
});

it("holds the actual registry and all eight references around Publish, then accepts the actual resulting Read", async () => {
  const s = fixture(),
    input = publication(),
    c = bindPublicationQualificationInput(input, until);
  await s.source.editorContentAuthority(s.tx, editor(input, "Read"));
  expect(owner.create).not.toHaveBeenCalled();
  const result = await s.source.withPublication(input, until, proofs(c), async (value) => {
    await s.source.editorContentAuthority(s.tx, editor(input, "Publish"));
    await s.source.editorContentAuthority(
      s.tx,
      editor(input, "Read", parseProductAggregate({ ...input.aggregate, aggregateVersion: 8 })),
    );
    return value;
  });
  expect(result.registeredContent.checks).toEqual(["TagRegistry", "AttributeRegistry"]);
  expect(result.requiredReferenceChecks).toEqual(productEditorContentReferenceChecks);
  expect(result.findings).toEqual([]);
  expect(result.sources).toEqual([
    expect.objectContaining({
      sourceCode: "CONTENT_REGISTRY",
      sourceDigest: hash(registry()),
      validUntil: until,
    }),
  ]);
  await s.commit();
  expect(s.guards).toHaveLength(1);
  expect(s.hold).toHaveBeenLastCalledWith(
    s.tx,
    expect.objectContaining({
      command: input.command,
      originalIntentDigest: hash(input.command),
      requestValidUntil: until,
      registry: registry(),
    }),
  );
  expect(s.tx.query).not.toHaveBeenCalled();
});
it.each([
  { modes: ["Pinned"], codes: ["PINNED_OPTION_RULES"] },
  { modes: ["CurrentPublished"], codes: ["CURRENT_PUBLISHED_OPTION_RULES"] },
  {
    modes: ["Pinned", "CurrentPublished"],
    codes: ["PINNED_OPTION_RULES", "CURRENT_PUBLISHED_OPTION_RULES"],
  },
] as const)("accepts the actual held $modes binding source inventory", async ({ modes, codes }) => {
  const s = fixture(),
    input = publication(modes),
    c = bindPublicationQualificationInput(input, until),
    p = proofs(c);
  const actual = {
    ...p,
    options: { ...p.options, sources: codes.map((code) => sourceEvidence(code, c)) },
  };
  await s.source.withPublication(input, until, actual, async (value) => {
    await s.source.editorContentAuthority(s.tx, editor(input, "Publish"));
    return value;
  });
  await s.commit();
  expect(owner.read).toHaveBeenCalled();
});
it.each([
  { modes: ["CurrentPublished"], codes: ["PINNED_OPTION_RULES"] },
  { modes: ["Pinned"], codes: ["CURRENT_PUBLISHED_OPTION_RULES"] },
  { modes: ["Pinned", "CurrentPublished"], codes: ["CURRENT_PUBLISHED_OPTION_RULES"] },
  { modes: ["CurrentPublished"], codes: ["PINNED_OPTION_RULES", "CURRENT_PUBLISHED_OPTION_RULES"] },
  {
    modes: ["Pinned", "CurrentPublished"],
    codes: ["CURRENT_PUBLISHED_OPTION_RULES", "CURRENT_PUBLISHED_OPTION_RULES"],
  },
  { modes: ["CurrentPublished"], codes: [] },
] as const)(
  "rejects wrong, missing, extra or duplicate source groups for $modes: $codes",
  async ({ modes, codes }) => {
    const s = fixture(),
      input = publication(modes),
      c = bindPublicationQualificationInput(input, until),
      p = proofs(c);
    await expect(
      s.source.withPublication(
        input,
        until,
        { ...p, options: { ...p.options, sources: codes.map((code) => sourceEvidence(code, c)) } },
        async () => undefined,
      ),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(owner.read).not.toHaveBeenCalled();
  },
);
it("rejects a correct CurrentPublished inventory whose held content header drifted", async () => {
  const s = fixture(),
    input = publication(["CurrentPublished"]),
    c = bindPublicationQualificationInput(input, until),
    p = proofs(c);
  await expect(
    s.source.withPublication(
      input,
      until,
      {
        ...p,
        options: {
          ...p.options,
          contentDigest: hash("different content"),
          sources: [sourceEvidence("CURRENT_PUBLISHED_OPTION_RULES", c)],
        },
      },
      async () => undefined,
    ),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(owner.read).not.toHaveBeenCalled();
});
it("reads an immutable original result without acquiring today's registry or qualifications", async () => {
  const s = fixture(),
    input = publication(),
    successor = parseProductAggregate({
      ...input.aggregate,
      aggregateVersion: 21,
      draft: { ...input.aggregate.draft, versionReference: id(66), baseVersionReference: id(6) },
    });
  await s.source.editorContentAuthority(s.tx, editor(input, "Read", successor));
  await s.commit();
  expect(owner.create).not.toHaveBeenCalled();
  expect(s.hold).not.toHaveBeenCalled();
});
for (const kind of ["media", "options", "variant"] as const) {
  it(`preserves real ${kind} HardError without blocking Validate's report holder`, async () => {
    const s = fixture(),
      input = publication(),
      p = proofs(bindPublicationQualificationInput(input, until)),
      leaf = p[kind];
    const changed = {
      ...p,
      [kind]: {
        ...leaf,
        check: { ...leaf.check, outcome: "HardError" },
        findings: [finding(leaf.check.code)],
      },
    } as ProductPublicationRegisteredContentProofs;
    await s.source.withPublication(input, until, changed, async () =>
      s.source.editorContentAuthority(s.tx, editor(input, "Publish")),
    );
    await s.commit();
  });
}
for (const option of [{ requiredMedia: true }, { requiredFrench: true }]) {
  it(`preserves actual content-policy negative ${Object.keys(option)[0]}`, async () => {
    const s = fixture(),
      input = publication(),
      p = proofs(bindPublicationQualificationInput(input, until), option);
    expect(
      option.requiredMedia ? p.policy.requiredMediaPresence.outcome : p.policy.check.outcome,
    ).toBe("HardError");
    await s.source.withPublication(input, until, p, async () =>
      s.source.editorContentAuthority(s.tx, editor(input, "Publish")),
    );
    await s.commit();
  });
}
it("preserves the earliest proof lease and denies an outer final assertion at its exact expiry", async () => {
  const s = fixture(),
    input = publication(),
    shorter = plus(at, 1000),
    p = proofs(bindPublicationQualificationInput(input, until), { deadline: shorter });
  const result = await s.source.withPublication(input, until, p, async (value) => value);
  expect(result.validUntil).toBe(shorter);
  for (const g of s.guards) await g.guard();
  s.setTime(shorter);
  expect(() => s.guards.forEach((g) => g.final())).toThrow(CatalogError);
});
it("keeps independent Ack purpose/full command and permits the old displayed report's historical lease", async () => {
  const s = fixture(),
    input = acknowledgement(),
    c = bindWarningAcknowledgementQualificationInput(input);
  s.setTime(input.observedAt);
  const result = await s.source.withAcknowledgement(input, proofs(c), async (value) => value);
  await s.commit();
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(s.hold).toHaveBeenLastCalledWith(
    s.tx,
    expect.objectContaining({
      command: input.command,
      commandPurposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      requestValidUntil: input.validUntil,
    }),
  );
});
for (const invalid of ["inactive-tag", "attribute-too-long"] as const) {
  it(`does not fabricate a twelve-check finding for registry integrity failure ${invalid}`, async () => {
    const s = fixture(),
      input = publication(),
      r = registry(),
      work = vi.fn();
    owner.read.mockResolvedValue(
      invalid === "inactive-tag"
        ? { ...r, tags: r.tags.map((tag) => ({ ...tag, lifecycle: "Inactive" })) }
        : {
            ...r,
            attributes: r.attributes.map((attribute) => ({ ...attribute, maximumLength: 1 })),
          },
    );
    await expect(
      s.source.withPublication(
        input,
        until,
        proofs(bindPublicationQualificationInput(input, until)),
        work,
      ),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(work).not.toHaveBeenCalled();
    await expect(s.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  });
}
it("does not claim unevaluated Brand hard requirements are satisfied", async () => {
  const s = fixture(),
    input = publication(),
    p = proofs(bindPublicationQualificationInput(input, until));
  await expect(
    s.source.withPublication(
      input,
      until,
      {
        ...p,
        policy: {
          ...p.policy,
          brand: { ...p.policy.brand, hardRequirementFieldCodes: ["UNANSWERED.REQUIREMENT"] },
        },
      },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(owner.create).not.toHaveBeenCalled();
});
for (const field of ["Safety", "Nutrition"] as const)
  it(`refuses populated ${field} references without pretending they were evaluated`, async () => {
    const s = fixture(),
      base = publication(),
      content = base.aggregate.draft.editorContent;
    if (!content) throw new Error("Expected full content");
    const aggregate = parseProductAggregate({
        ...base.aggregate,
        draft: {
          ...base.aggregate.draft,
          editorContent: {
            ...content,
            ...(field === "Safety"
              ? { allergenReferences: [id(95)] }
              : { nutritionProfile: { reference: id(95), versionReference: id(96) } }),
          },
        },
      }),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      input = {
        ...base,
        aggregate,
        command: parseProductPublicationCommandV2({
          ...base.command,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
        }),
      };
    await expect(
      s.source.withPublication(
        input,
        until,
        proofs(bindPublicationQualificationInput(input, until)),
        vi.fn(),
      ),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(owner.create).not.toHaveBeenCalled();
  });
it("refuses expired observations and a later read cannot refresh the original lease", async () => {
  const s = fixture(),
    input = publication(),
    c = bindPublicationQualificationInput(input, until);
  await s.source.withPublication(input, until, proofs(c), async () => undefined);
  s.setTime(until);
  await expect(
    s.source.editorContentAuthority(s.tx, {
      ...editor(input, "Read"),
      observedAt: until,
      validUntil: plus(until, 5000),
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  await expect(s.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
for (const mode of ["skip", "repeat", "foreign", "substitute", "packet-hash", "authority-fields"]) {
  it(`poisons the outer transaction after owning callback violation ${mode}`, async () => {
    owner.mode = mode;
    const s = fixture(),
      input = publication();
    await expect(
      s.source.withPublication(
        input,
        until,
        proofs(bindPublicationQualificationInput(input, until)),
        async () => "not committed",
      ),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    await expect(s.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  });
}
it("does not let a swallowed consumer failure or reentry restore the transaction", async () => {
  owner.mode = "swallow";
  const s = fixture(),
    input = publication(),
    p = proofs(bindPublicationQualificationInput(input, until));
  await expect(
    s.source.withPublication(input, until, p, async () => {
      await expect(s.source.withPublication(input, until, p, vi.fn())).rejects.toHaveProperty(
        "code",
        "CATALOG_DEPENDENCY_UNAVAILABLE",
      );
      return "caught";
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  await expect(s.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("retains actual permission denial through the outer guard", async () => {
  const s = fixture(),
    input = publication();
  await s.source.withPublication(
    input,
    until,
    proofs(bindPublicationQualificationInput(input, until)),
    async () => undefined,
  );
  s.hold.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(s.commit()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
});
it("rejects a substituted query and incomplete Publish reference check list", async () => {
  const s = fixture(),
    input = publication();
  await s.source.withPublication(
    input,
    until,
    proofs(bindPublicationQualificationInput(input, until)),
    async () => undefined,
  );
  await expect(
    s.source.editorContentAuthority(s.tx, {
      ...editor(input, "Publish"),
      requiredReferenceChecks: [],
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  await expect(s.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  const other = fixture();
  await other.source.withPublication(
    input,
    until,
    proofs(bindPublicationQualificationInput(input, until)),
    async () => undefined,
  );
  other.tx.query = vi.fn(async () => ({ rows: [] }));
  await expect(other.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("captures proof descriptors, ports and command before the first await", async () => {
  const s = fixture(),
    original = publication(),
    input = structuredClone(original),
    p = proofs(bindPublicationQualificationInput(input, until)),
    promise = s.source.withPublication(input, until, p, async (value) => value);
  Object.assign(input.command, { operationReference: id(99) });
  Object.assign(p.media, { originalIntentDigest: hash("mutated") });
  Object.assign(s.options.registryAuthority, {
    holdUntilTransactionCompletes: vi.fn(async () => {
      throw new Error("Replaced port");
    }),
  });
  const result = await promise;
  await s.commit();
  expect(result.originalIntentDigest).toBe(hash(original.command));
  expect(s.hold).toHaveBeenCalled();
});
it("refuses proof getters and mismatched command receipts before acquiring the registry", async () => {
  const input = publication(),
    p = proofs(bindPublicationQualificationInput(input, until)),
    getter = vi.fn(() => p.media);
  const s = fixture();
  await expect(
    s.source.withPublication(
      input,
      until,
      {
        ...p,
        get media() {
          return getter();
        },
      },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(getter).not.toHaveBeenCalled();
  expect(owner.create).not.toHaveBeenCalled();
  const other = fixture();
  await expect(
    other.source.withPublication(
      input,
      until,
      { ...p, media: { ...p.media, replacementIntentDigest: hash("other target") } },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
it("keeps unrelated registry additions out of the semantic reference digest", async () => {
  const input = publication(),
    p = proofs(bindPublicationQualificationInput(input, until)),
    first = fixture(),
    r = registry(),
    a = await first.source.withPublication(input, until, p, async (value) => value);
  await first.commit();
  owner.read.mockResolvedValue({
    ...r,
    registryVersion: 2,
    versionReference: id(82),
    previousSnapshotDigest: hash(r),
    tags: [
      ...r.tags,
      {
        tagReference: id(92),
        code: "UNRELATED_TAG",
        localizedNames: { "en-CA": "Unrelated" },
        lifecycle: "Active",
      },
    ],
  });
  const second = fixture(),
    b = await second.source.withPublication(input, until, p, async (value) => value);
  await second.commit();
  expect(a.sources[0]?.sourceDigest).not.toBe(b.sources[0]?.sourceDigest);
  expect(a.sources[0]?.relevantReferenceDigest).toBe(b.sources[0]?.relevantReferenceDigest);
});
