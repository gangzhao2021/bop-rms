import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import {
  CatalogError,
  bindCatalogProductPublicationQualificationContext,
  buildCatalogProductPublicationValidationReport,
  composeCatalogProductPublicationValidation,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCompositionCheckCodes,
  type CatalogProductPublicationQualificationInput,
  type CatalogProductWarningAcknowledgementQualificationInput,
  type CatalogProductPublicationValidationFinding,
  type CatalogProductPublicationValidationSourceEvidence,
  type ProductPublicationFactsV2,
} from "@rms/catalog";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createMerchantProductPublicationSources,
  type MerchantProductPublicationSourcesConfiguration,
} from "./merchant-product-publication-sources.js";
import type { MerchantProductPublicationSourceFactoryV2Input } from "./merchant-product-publication-command-v2.js";

const leaves = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("./current-product-publication-content-policy.js", () => ({
  createCurrentProductPublicationContentPolicySource: (options: unknown) =>
    leaves.create("policy", options),
}));
vi.mock("./current-product-publication-scope.js", () => ({
  createCurrentProductPublicationScopeSource: (options: unknown) => leaves.create("scope", options),
}));
vi.mock("./current-product-publication-variant-mapping.js", () => ({
  createCurrentProductPublicationVariantMappingSource: (options: unknown) =>
    leaves.create("variant", options),
}));
vi.mock("./current-product-publication-option-selection.js", () => ({
  createCurrentProductPublicationOptionSelectionSource: (options: unknown) =>
    leaves.create("options", options),
}));
vi.mock("./current-product-publication-tax-resolution.js", () => ({
  createCurrentProductPublicationTaxResolutionSource: (options: unknown) =>
    leaves.create("tax", options),
}));
vi.mock("./merchant-product-publication-media.js", () => ({
  createMerchantProductPublicationMediaSource: (options: unknown) =>
    leaves.create("media", options),
}));
vi.mock("./current-product-publication-registered-content.js", () => ({
  createCurrentProductPublicationRegisteredContentSource: (options: unknown) =>
    leaves.create("registered", options),
}));
vi.mock("./merchant-product-publication-reference-source-v2.js", () => ({
  createMerchantProductPublicationReferenceSourceV2: (options: unknown) =>
    leaves.create("references", options),
  createMerchantProductWarningAcknowledgementReferenceSource: (options: unknown) =>
    leaves.create("references", options),
}));

type Configuration = MerchantProductPublicationSourcesConfiguration;
type Host = MerchantProductPublicationSourceFactoryV2Input;
type Tx = Host["transaction"];
type SourceName =
  "policy" | "scope" | "variant" | "options" | "media" | "tax" | "registered" | "references";
const names: readonly SourceName[] = [
  "policy",
  "scope",
  "variant",
  "options",
  "media",
  "tax",
  "registered",
  "references",
];
const id = (n: number) => `019a2421-0061-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-10-03T12:00:00.000Z",
  plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const source = (
  name: string,
  observedAt: string,
  validUntil: string,
): CatalogProductPublicationValidationSourceEvidence => ({
  sourceCode: name === "policy" ? "PRODUCT_PUBLICATION_POLICY" : name.toUpperCase(),
  sourceDigest: hash({ name, observedAt }),
  relevantReferenceDigest: hash({ name }),
  generation: null,
  observedAt,
  validUntil,
});
function finding(
  code: "TaxResolution" | "ChangeImpact",
  outcome: "HardError" | "Warning",
): CatalogProductPublicationValidationFinding {
  return {
    checkCode: code,
    ruleCode: "CONTROLLED_" + code.toUpperCase(),
    outcome,
    subjectReference: id(1),
    reasonCode: "CONTROLLED_ORCHESTRATION",
    references: [],
  };
}
function policyContent() {
  return parsePublishingProductPublicationPolicy({
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(10),
    brandReference: id(2),
    familyReference: id(19),
    policyReference: id(20),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
    approvalPolicy: "Required",
    warningOverrideAllowed: true,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: plus(at, 86400000),
  });
}
function publication(): CatalogProductPublicationQualificationInput {
  const aggregate = parseProductAggregate({
      productReference: id(1),
      brandReference: id(2),
      internalCode: "COMPOSED_TEST",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(4),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Controlled source composition" },
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        skus: [
          {
            skuReference: id(5),
            productReference: id(1),
            brandReference: id(2),
            skuCode: "ONE",
            lifecycle: "Active",
            localizedNames: { "en-CA": "One" },
            variantSelections: [],
            unitOfSale: "EA",
            unitQuantity: "1",
            createdAt: at,
            createdByActorReference: id(3),
          },
        ],
        optionBindings: [],
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
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(11),
      productReference: id(1),
      versionReference: id(4),
      expectedProductAggregateVersion: 1,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(12), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: {
          instant: plus(at, 3600000),
          localDateTime: plus(at, 3600000).slice(0, -1),
          utcOffsetMinutes: 0,
        },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "CONTROLLED_COMPOSITION",
      replacementIntent: { ...body, digest: hash(body) },
      replacementIntentDigest: hash(body),
    });
  return { command, aggregate, current: null, content: null, observedAt: at };
}
function acknowledgement(): CatalogProductWarningAcknowledgementQualificationInput {
  const p = publication(),
    c = p.command,
    context = bindCatalogProductPublicationQualificationContext(p, plus(at, 5000)),
    composed = composeCatalogProductPublicationValidation({
      context,
      policy: {
        content: policyContent(),
        currentPublicationReference: id(23),
        observedAt: at,
        validUntil: plus(at, 5000),
      },
      evidenceReference: id(21),
      checks: productPublicationCompositionCheckCodes.map((code) => ({
        code,
        outcome: code === "ChangeImpact" ? "Warning" : "Pass",
      })),
      details: {
        coverage: "Complete",
        impact: "Recorded",
        findings: [finding("ChangeImpact", "Warning")],
        sources: [...names, "business"].map((name) => source(name, at, plus(at, 5000))),
      },
      assessedAt: at,
    }),
    validation = composed.validation,
    current = planCatalogProductPublicationV2(c, null, {
      now: at,
      productAggregateVersion: 1,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: validation.scopeDigest,
      periodDigest: validation.periodDigest,
      validation,
      approval: null,
      reviewReference: null,
      replacement: null,
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: c,
      publication: current,
      validation,
      details: composed.details,
      recordedAt: at,
    }),
    aggregate = parseProductAggregate({ ...p.aggregate, aggregateVersion: 2 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: c.tenantReference,
      brandReference: c.brandReference,
      actorReference: c.actorReference,
      actorKind: "User",
      operationReference: id(22),
      productReference: c.productReference,
      versionReference: c.versionReference,
      expectedProductAggregateVersion: 2,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "REVIEWED_CONTROLLED_WARNING",
      occurredAt: plus(at, 10000),
    });
  return {
    command,
    aggregate,
    current,
    report,
    observedAt: plus(at, 10000),
    validUntil: plus(at, 15000),
  };
}
beforeEach(() => {
  leaves.create.mockReset();
});

/** Controlled leaf acquisition and policy assessment, with actual owning command,
 * context, report and final validation composition. This is no SQL/IAM proof and
 * does not choose the still-pending backdate or SKU-008 business policy. */
function fixture(ack = false, hostLeaseMilliseconds = 5000) {
  let sourceFailure: { error: unknown } | undefined;
  const input = ack ? acknowledgement() : publication(),
    observedAt = input.observedAt,
    deadline = plus(observedAt, 5000),
    transaction: Tx = { query: vi.fn(async () => ({ rows: [] })) },
    guards: { async: () => Promise<void>; final: () => void }[] = [],
    state = {
      now: observedAt,
      mode: "normal",
      leaf: "policy" as SourceName,
      taxError: false,
      warning: ack,
      leafDeadline: deadline,
      policyActive: false,
      consumers: 0,
      mediaAt: observedAt,
      requiredMediaMissing: false,
      mutateReferenceAuthority: false,
      yieldScope: false,
      scopeYielded: false,
      wrapSourceErrors: false,
      denyWrappedSourceErrors: false,
    },
    reads: { name: SourceName; command: unknown; kind: string }[] = [],
    policy = {
      content: policyContent(),
      currentPublicationReference: id(23),
      observedAt,
      validUntil: deadline,
    },
    editorContentAuthority = vi.fn(async () => undefined),
    registerBeforeCommit: Host["registerBeforeCommit"] = async (actual, guard, finalAssert) => {
      expect(actual).toBe(transaction);
      if (typeof finalAssert !== "function") throw new Error("Required final assertion");
      guards.push({ async: guard, final: finalAssert });
    },
    host = {
      transaction,
      command: input.command,
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      storeReference: id(12),
      sessionReference: id(13),
      clock: { now: () => state.now },
      originalValidUntil: plus(observedAt, hostLeaseMilliseconds),
      authorizeMediaAccess: vi.fn(async () => undefined),
      registerBeforeCommit,
    };
  const changedReferenceHold = vi.fn(async () => {
      throw new Error("Changed reference authority must not run");
    }),
    originalReferenceHold = vi.fn(async function (this: unknown): Promise<void> {
      expect(this).toBe(referenceAuthority);
      expect(state.policyActive).toBe(true);
    }),
    referenceAuthority = { holdUntilTransactionCompletes: originalReferenceHold },
    referenceConfiguration = Object.fromEntries(
      [
        "historyAuthority",
        "availabilityAuthority",
        "bundleAuthority",
        "menuAuthority",
        "recipeAuthority",
        "recipeInventoryAuthority",
        "inventoryAuthority",
        "pricingAuthority",
        "priceBookAuthority",
        "optionPriceAuthority",
        "promotionAuthority",
      ].map((key) => [key, referenceAuthority]),
    );
  function proof(name: SourceName) {
    const sourceAt = name === "media" ? state.mediaAt : observedAt,
      timing = { observedAt: sourceAt, validUntil: state.leafDeadline },
      evidence = {
        ...timing,
        findings: [] as CatalogProductPublicationValidationFinding[],
        sources: [source(name, sourceAt, state.leafDeadline)],
      };
    switch (name) {
      case "policy":
        return {
          ...evidence,
          policy,
          check: { code: "DefaultLocaleName", outcome: "Pass" },
          requiredMediaPresence: { outcome: state.requiredMediaMissing ? "HardError" : "Pass" },
        };
      case "scope":
        return {
          ...evidence,
          check: { code: "UniqueScope", outcome: "Pass" },
          publishableSkuCheck: { code: "PublishableSku", outcome: "Pass" },
          coverage: {},
        };
      case "variant":
        return {
          ...evidence,
          check: { code: "VariantMapping", outcome: "Pass" },
          referenceProvenance: {},
        };
      case "options":
        return { ...evidence, check: { code: "OptionSelection", outcome: "Pass" } };
      case "media":
        return { ...evidence, check: { code: "MediaReady", outcome: "Pass" } };
      case "tax":
        return {
          ...evidence,
          check: { code: "TaxResolution", outcome: state.taxError ? "HardError" : "Pass" },
          findings: state.taxError ? [finding("TaxResolution", "HardError")] : [],
        };
      case "registered":
        return evidence;
      case "references":
        return { ...timing, referenceEvidence: [source(name, observedAt, state.leafDeadline)] };
    }
  }
  leaves.create.mockImplementation(
    (
      name: SourceName,
      options: {
        transaction: Tx;
        request?: { command: unknown };
        historyAuthority?: { holdUntilTransactionCompletes(tx: Tx, input: unknown): Promise<void> };
      },
    ) => {
      expect(options.transaction).toBe(transaction);
      async function invoke(kind: string, args: unknown[]) {
        const callback = args.at(-1);
        if (typeof callback !== "function") throw new Error("Expected held source callback");
        const actual = name === "references" ? options.request : (args[0] as { command: unknown });
        reads.push({ name, command: actual?.command, kind });
        if (name === state.leaf && sourceFailure) throw sourceFailure.error;
        if (name === state.leaf && state.mode === "omit") return undefined;
        if (name === "policy") state.policyActive = true;
        if (name === "policy" && state.mutateReferenceAuthority)
          Object.assign(referenceAuthority, {
            holdUntilTransactionCompletes: changedReferenceHold,
          });
        try {
          if (name === "scope" && state.yieldScope) {
            await Promise.resolve();
            state.scopeYielded = true;
          }
          if (name === "references" && state.mutateReferenceAuthority) {
            if (!options.historyAuthority) throw new Error("Missing captured history authority");
            await options.historyAuthority.holdUntilTransactionCompletes(
              transaction,
              options.request,
            );
          }
          const result: unknown = await callback(
            proof(name),
            ...(name === "references"
              ? [state.mode === "foreign-reference-tx" ? { query: vi.fn() } : transaction]
              : []),
          );
          if (name === state.leaf && state.mode === "repeat")
            await callback(proof(name), ...(name === "references" ? [transaction] : [])).catch(
              () => undefined,
            );
          if (name === state.leaf && state.mode === "late-denial")
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          return name === state.leaf && state.mode === "substitute" ? {} : result;
        } catch (error) {
          if (state.wrapSourceErrors && name !== state.leaf) {
            if (error instanceof CatalogError && error.code === "CATALOG_PERMISSION_DENIED")
              throw error;
            if (state.denyWrappedSourceErrors && name === "variant")
              throw new CatalogError("CATALOG_PERMISSION_DENIED");
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          }
          if (name === state.leaf && state.mode === "map-consumer-error")
            throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          if (name === state.leaf && state.mode === "consumer-permission-denial")
            throw new CatalogError("CATALOG_PERMISSION_DENIED");
          throw error;
        } finally {
          if (name === "policy") state.policyActive = false;
        }
      }
      return {
        editorContentAuthority,
        withPublication: (...args: unknown[]) => invoke("Publication", args),
        withAcknowledgement: (...args: unknown[]) => invoke("WarningAcknowledgement", args),
        withCurrentImpactReferences: (...args: unknown[]) =>
          invoke(ack ? "WarningAcknowledgement" : "Publication", args),
      };
    },
  );
  const businessPolicy: Configuration["businessPolicy"] = {
    async withAssessment(actual, request, work) {
      expect(actual).toBe(transaction);
      expect(request.context.command).toEqual(input.command);
      expect(request.context.originalIntentDigest).toBe(hash(input.command));
      expect(state.policyActive).toBe(true);
      const result = await work({
        originalIntentDigest: request.context.originalIntentDigest,
        aggregateSnapshotDigest: request.context.aggregateSnapshotDigest,
        policyReference: policy.content.policyReference,
        policyVersion: policy.content.policyVersion,
        checks: [
          { code: "EffectivePeriod", outcome: "Pass" },
          { code: "ChangeImpact", outcome: state.warning ? "Warning" : "Pass" },
        ],
        findings: state.warning ? [finding("ChangeImpact", "Warning")] : [],
        sources: [source("business", observedAt, state.leafDeadline)],
        observedAt,
        validUntil: state.leafDeadline,
      });
      return result;
    },
  };
  // Only leaf constructors are replaced; the empty selectors below never reach
  // production owners. They cannot serve as deployable configuration.
  const configuration = {
    contentPolicy: {},
    scope: {},
    variant: {},
    options: {},
    tax: {},
    registeredContent: {},
    publicationReferences: referenceConfiguration,
    acknowledgementReferences: referenceConfiguration,
    evidenceReference: () => id(30),
    reviewReference: () => id(31),
    businessPolicy,
  } as unknown as Configuration;
  const factories = createMerchantProductPublicationSources(configuration);
  const entry = ack
    ? factories.acknowledgement({
        ...host,
        command: (input as CatalogProductWarningAcknowledgementQualificationInput).command,
      })
    : factories.publication({
        ...host,
        command: (input as CatalogProductPublicationQualificationInput).command,
      });
  async function run(
    work: (result: unknown, details?: unknown) => Promise<unknown> = async (result) => result,
    actual = transaction,
    value = input,
  ) {
    if ("withHeldCurrentObservation" in entry.sources)
      return entry.sources.withHeldCurrentObservation(
        actual,
        value as CatalogProductWarningAcknowledgementQualificationInput,
        async (observation) => {
          state.consumers++;
          return work(observation);
        },
      );
    return entry.sources.withHeldCurrentFacts(
      actual,
      value as CatalogProductPublicationQualificationInput,
      async (facts, details) => {
        state.consumers++;
        return work(facts, details);
      },
    );
  }
  async function commit() {
    for (const guard of guards) await guard.async();
    for (const guard of guards) guard.final();
  }
  return {
    input,
    state,
    reads,
    guards,
    host,
    transaction,
    entry,
    run,
    failSource(error: unknown) {
      sourceFailure = { error };
    },
    commit,
    policy,
    deadline,
    factories,
    configuration,
    editorContentAuthority,
    originalReferenceHold,
    changedReferenceHold,
  };
}

it.each([false, true])(
  "preserves actual Publication/Ack intent through one held source chain: %s",
  async (ack) => {
    const f = fixture(ack);
    expect(f.reads).toEqual([]);
    expect(f.guards).toHaveLength(0);
    const result = await f.run(async (value, details) => {
      expect(f.state.policyActive).toBe(true);
      const validation = (
        value as {
          validation: {
            checks: readonly { code: string; outcome: string }[];
            warningAcknowledgement: unknown;
          };
        }
      ).validation;
      expect(validation.checks).toHaveLength(12);
      expect(validation.warningAcknowledgement).toBeNull();
      expect(validation.checks).toContainEqual({ code: "ApprovalPolicy", outcome: "Pending" });
      if (!ack) {
        expect(details).toMatchObject({ coverage: "Complete", impact: "Recorded" });
        if (!("withCurrentPolicy" in f.entry.sources))
          throw new Error("Publication policy port missing");
        expect(
          await f.entry.sources.withCurrentPolicy(
            f.transaction,
            { policyReference: id(20), policyVersion: 1, observedAt: f.input.observedAt },
            async (policy) => policy,
          ),
        ).toBe(f.policy);
      }
      return value;
    });
    expect(result).toBeDefined();
    if (ack) {
      const input = f.input as CatalogProductWarningAcknowledgementQualificationInput;
      expect(input.report.validation.validUntil < input.observedAt).toBe(true);
      expect(result).toMatchObject({
        acknowledgementIntentDigest: hash(input.command),
        acknowledgementOperationReference: input.command.operationReference,
      });
    }
    expect(f.state.consumers).toBe(1);
    expect(f.reads.map((read) => read.name)).toEqual(names);
    expect(
      f.reads.every(
        (read) => canonicalizeRfc8785(read.command) === canonicalizeRfc8785(f.input.command),
      ),
    ).toBe(true);
    expect(
      f.reads.every((read) => read.kind === (ack ? "WarningAcknowledgement" : "Publication")),
    ).toBe(true);
    await f.commit();
  },
);

it("preserves source HardError, actual Warning and derived HardErrorsCleared", async () => {
  const f = fixture();
  f.state.taxError = true;
  f.state.warning = true;
  await f.run(async (value, details) => {
    expect(value).toMatchObject({
      validation: {
        checks: expect.arrayContaining([
          { code: "TaxResolution", outcome: "HardError" },
          { code: "ChangeImpact", outcome: "Warning" },
          { code: "HardErrorsCleared", outcome: "HardError" },
          { code: "ApprovalPolicy", outcome: "Pending" },
        ]),
        warningAcknowledgement: null,
      },
    });
    expect(details).toMatchObject({
      findings: expect.arrayContaining([
        finding("TaxResolution", "HardError"),
        finding("ChangeImpact", "Warning"),
      ]),
    });
    return value;
  });
  await f.commit();
});

it.each(["omit", "repeat", "substitute"])(
  "poisons missing/repeated/changed source consumer result: %s",
  async (mode) => {
    const f = fixture();
    f.state.mode = mode;
    await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.state.consumers).toBe(mode === "omit" ? 0 : 1);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it.each(["command", "transaction", "foreign-reference-tx", "extended-deadline"])(
  "rejects changed source binding: %s",
  async (mode) => {
    const f = fixture();
    if (mode === "foreign-reference-tx") f.state.mode = mode;
    if (mode === "extended-deadline") f.state.leafDeadline = plus(f.deadline, 1);
    const input = f.input as CatalogProductPublicationQualificationInput,
      value =
        mode === "command"
          ? { ...input, command: { ...input.command, reasonCode: "CHANGED" } }
          : input;
    await expect(
      f.run(undefined, mode === "transaction" ? { query: vi.fn() } : f.transaction, value),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.state.consumers).toBe(0);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it("retains a shorter owner deadline through final commit after a later asynchronous guard", async () => {
  const f = fixture();
  f.state.leafDeadline = plus(f.input.observedAt, 1000);
  await f.run(async (value) => {
    expect(value).toMatchObject({ validation: { validUntil: f.state.leafDeadline } });
    return value;
  });
  await f.host.registerBeforeCommit(
    f.transaction,
    async () => {
      f.state.now = f.state.leafDeadline;
    },
    () => undefined,
  );
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.consumers).toBe(1);
});

it("retains current permission denial after the consumer and poisons a caught failure", async () => {
  const f = fixture();
  f.state.mode = "late-denial";
  f.state.leaf = "tax";
  await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.state.consumers).toBe(1);
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it.each([false, true])(
  "preserves the exact bounded dependency source error and poisons its holder: acknowledgement=%s",
  async (ack) => {
    const f = fixture(ack),
      failure = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    f.state.leaf = "tax";
    f.failSource(failure);
    await expect(f.run()).rejects.toBe(failure);
    expect(f.state.consumers).toBe(0);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it.each([
  new Error("Controlled unknown source failure"),
  new CatalogError("CATALOG_INPUT_INVALID"),
])("normalizes a source error outside the preserved bounded codes: %s", async (failure) => {
  const f = fixture();
  f.state.leaf = "tax";
  f.failSource(failure);
  let observed: unknown;
  await expect(
    f.run().catch((error: unknown) => {
      observed = error;
      throw error;
    }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(observed).not.toBe(failure);
  expect(f.state.consumers).toBe(0);
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it.each([false, true])(
  "retains the earliest exact nested dependency through outer source transformations: acknowledgement=%s",
  async (ack) => {
    const f = fixture(ack),
      original = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    f.state.leaf = "tax";
    f.state.wrapSourceErrors = true;
    f.failSource(original);
    await expect(f.run()).rejects.toBe(original);
    expect(f.state.consumers).toBe(0);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it("keeps permission denial ahead of the earliest nested source dependency", async () => {
  const f = fixture();
  f.state.leaf = "tax";
  f.state.wrapSourceErrors = true;
  f.state.denyWrappedSourceErrors = true;
  f.failSource(new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"));
  await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.state.consumers).toBe(0);
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it("keeps the actual consumer conflict ahead of transformed nested source dependencies", async () => {
  const f = fixture(),
    conflict = new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
  f.state.leaf = "tax";
  f.state.mode = "map-consumer-error";
  f.state.wrapSourceErrors = true;
  await expect(
    f.run(async () => {
      throw conflict;
    }),
  ).rejects.toBe(conflict);
  expect(f.state.consumers).toBe(1);
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it.each([false, true])(
  "retains an actual CurrentPublished version conflict through outer source normalization: acknowledgement=%s",
  async (ack) => {
    const f = fixture(ack),
      conflict = new CatalogError("CATALOG_VERSION_CONFLICT");
    f.state.leaf = "options";
    f.state.wrapSourceErrors = true;
    f.failSource(conflict);
    await expect(f.run()).rejects.toBe(conflict);
    expect(f.state.consumers).toBe(0);
    expect(f.reads.map((read) => read.name)).toEqual(["policy", "scope", "variant", "options"]);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it("does not turn an unknown source error with a conflict-shaped code into a version conflict", async () => {
  const f = fixture(),
    unknown = Object.assign(new Error("Controlled unclassified source error"), {
      code: "CATALOG_VERSION_CONFLICT",
    });
  f.state.leaf = "options";
  f.state.wrapSourceErrors = true;
  f.failSource(unknown);
  await expect(f.run()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(f.state.consumers).toBe(0);
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it("retains the original held policy while an asynchronous scope source yields before the writer", async () => {
  const f = fixture(false);
  f.state.yieldScope = true;
  const sources = f.entry.sources;
  if (!("withCurrentPolicy" in sources)) throw new Error("Publication policy port missing");
  await f.run(async () => {
    expect(f.state.scopeYielded).toBe(true);
    expect(f.state.policyActive).toBe(true);
    const policy = await sources.withCurrentPolicy(
      f.transaction,
      { policyReference: id(20), policyVersion: 1, observedAt: f.input.observedAt },
      async (held) => held,
    );
    expect(policy).toBe(f.policy);
    return policy;
  });
  expect(f.state.policyActive).toBe(false);
  expect(f.reads.filter((read) => read.name === "policy")).toHaveLength(1);
  await f.commit();
});

it("cannot reacquire a cached current policy after its original held callback", async () => {
  const f = fixture();
  await f.run();
  if (!("withCurrentPolicy" in f.entry.sources)) throw new Error("Publication policy port missing");
  const consumer = vi.fn(async () => undefined);
  await expect(
    f.entry.sources.withCurrentPolicy(
      f.transaction,
      { policyReference: id(20), policyVersion: 1, observedAt: f.input.observedAt },
      consumer,
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(consumer).not.toHaveBeenCalled();
  expect(f.reads.filter((read) => read.name === "policy")).toHaveLength(1);
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});

it("does not read qualification during construction, so owning original replay needs no source refresh", () => {
  const f = fixture();
  expect(f.reads).toEqual([]);
  expect(f.guards).toHaveLength(0);
  expect(f.transaction.query).not.toHaveBeenCalled();
  expect(f.host.authorizeMediaAccess).not.toHaveBeenCalled();
  expect("editorContentAuthority" in f.entry && f.entry.editorContentAuthority).toBe(
    f.editorContentAuthority,
  );
});

it.each(["query", "clock-rollback", "caught-reentry"])(
  "poisons changed transaction/clock or caught reentry: %s",
  async (mode) => {
    const f = fixture();
    await expect(
      f.run(async (value) => {
        if (mode === "query") f.transaction.query = vi.fn(async () => ({ rows: [] }));
        if (mode === "clock-rollback") {
          f.state.now = plus(f.input.observedAt, 2);
          if (!("withCurrentPolicy" in f.entry.sources))
            throw new Error("Publication policy port missing");
          await f.entry.sources.withCurrentPolicy(
            f.transaction,
            { policyReference: id(20), policyVersion: 1, observedAt: f.input.observedAt },
            async () => undefined,
          );
          f.state.now = plus(f.input.observedAt, 1);
        }
        if (mode === "caught-reentry") await f.run().catch(() => undefined);
        return value;
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(f.state.consumers).toBe(1);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it("captures the business assessment receiver instead of accepting later option mutation", async () => {
  const f = fixture(),
    changed = vi.fn(async () => {
      throw new Error("Changed assessment must not run");
    });
  Object.assign(f.configuration.businessPolicy, { withAssessment: changed });
  await f.run();
  await f.commit();
  expect(changed).not.toHaveBeenCalled();
});

it.each([false, true])(
  "accepts later Media observation at composition completion without renewing the Publication/Ack lease: %s",
  async (ack) => {
    const f = fixture(ack);
    f.state.mediaAt = plus(f.input.observedAt, 2);
    f.state.now = f.state.mediaAt;
    await f.run(async (value, details) => {
      expect(value).toMatchObject({
        validation: {
          checkedAt: f.input.observedAt,
          validUntil: f.deadline,
          checks: expect.arrayContaining([{ code: "MediaReady", outcome: "Pass" }]),
        },
      });
      const recordedDetails = ack ? (value as { details: unknown }).details : details;
      expect(recordedDetails).toMatchObject({
        sources: expect.arrayContaining([
          expect.objectContaining({
            sourceCode: "MEDIA",
            observedAt: f.state.mediaAt,
            validUntil: f.deadline,
          }),
        ]),
      });
      expect(value).toMatchObject(
        ack ? { observedAt: f.state.mediaAt, validUntil: f.deadline } : { now: f.input.observedAt },
      );
      return value;
    });
    expect(f.state.consumers).toBe(1);
    await f.commit();
  },
);

it("captures delayed reference holder methods before an earlier source mutates their configuration", async () => {
  const f = fixture();
  f.state.mutateReferenceAuthority = true;
  await f.run();
  await f.commit();
  expect(f.originalReferenceHold).toHaveBeenCalledTimes(1);
  expect(f.changedReferenceHold).not.toHaveBeenCalled();
});

it.each(["map-consumer-error", "consumer-permission-denial"])(
  "preserves the actual consumer conflict through bounded source errors with current denial precedence: %s",
  async (mode) => {
    const f = fixture(),
      conflict = new CatalogError("CATALOG_LIFECYCLE_CONFLICT");
    f.state.mode = mode;
    const outcome = f.run(async () => {
      throw conflict;
    });
    if (mode === "map-consumer-error") await expect(outcome).rejects.toBe(conflict);
    else await expect(outcome).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
    expect(f.state.consumers).toBe(1);
    await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  },
);

it("records missing required Media as a policy-bound hard finding rather than unavailable", async () => {
  const f = fixture();
  f.state.requiredMediaMissing = true;
  f.policy.content = parsePublishingProductPublicationPolicy({
    ...f.policy.content,
    mediaRequirement: "Required",
  });
  await f.run(async (value, details) => {
    expect(value).toMatchObject({
      validation: {
        checks: expect.arrayContaining([
          { code: "MediaReady", outcome: "HardError" },
          { code: "HardErrorsCleared", outcome: "HardError" },
        ]),
      },
    });
    expect(details).toMatchObject({
      coverage: "Complete",
      findings: expect.arrayContaining([
        expect.objectContaining({
          checkCode: "MediaReady",
          outcome: "HardError",
          references: expect.arrayContaining([
            expect.objectContaining({
              sourceCode: "PRODUCT_PUBLICATION_POLICY",
              resourceReference: id(20),
            }),
          ]),
        }),
      ]),
    });
    const input = f.input as CatalogProductPublicationQualificationInput,
      facts = value as ProductPublicationFactsV2,
      publication = planCatalogProductPublicationV2(input.command, input.current, facts),
      report = buildCatalogProductPublicationValidationReport({
        command: input.command,
        publication,
        validation: facts.validation,
        details: parseCatalogProductPublicationValidationDetails(details),
        recordedAt: f.state.now,
      });
    expect(publication.validationDecision).toBe("HardError");
    expect(report.details.coverage).toBe("Complete");
    return value;
  });
  expect(f.state.consumers).toBe(1);
  await f.commit();
});

it("narrows the later owning Ack lease to the original authenticated host deadline without changing intent", async () => {
  const f = fixture(true, 4000),
    original = canonicalizeRfc8785(f.input),
    outer = plus(f.input.observedAt, 4000);
  f.state.leafDeadline = outer;
  f.policy.validUntil = outer;
  const observation = (await f.run()) as {
    validUntil: string;
    acknowledgementIntentDigest: string;
  };
  expect(observation.validUntil).toBe(outer);
  expect(observation.acknowledgementIntentDigest).toBe(hash(f.input.command));
  expect(canonicalizeRfc8785(f.input)).toBe(original);
  expect(f.reads).toHaveLength(8);
  f.state.now = outer;
  await expect(f.commit()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
