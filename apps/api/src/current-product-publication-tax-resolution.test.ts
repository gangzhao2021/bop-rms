import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  buildCatalogProductPublicationValidationReport,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  parseCatalogProductTaxClassificationRegistry,
  taxClassificationRegistryFields,
  type ProductPublicationFactsV2,
  type createPostgresProductTaxClassificationRegistryStore,
} from "@rms/catalog";
import { createCurrentProductPublicationTaxResolutionSource } from "./current-product-publication-tax-resolution.js";
import type {
  PublicationQualificationInput,
  WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";
type OwnerOptions = Parameters<typeof createPostgresProductTaxClassificationRegistryStore>[0];
type Options = Parameters<typeof createCurrentProductPublicationTaxResolutionSource>[0];
const owner = vi.hoisted(() => ({
  mode: "normal",
  options: vi.fn(),
  registry: vi.fn(),
  guard: vi.fn(),
  final: vi.fn(),
}));
// Controlled registry boundary; actual Catalog parsing/resolution and context run.
// Native acceptance covers the existing owner SQL and its real final guards.
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductTaxClassificationRegistryStore(options: OwnerOptions) {
    owner.options(options);
    return {
      withCurrentRegistry: async <T>(
        observation: unknown,
        work: (source: unknown, tx: Options["transaction"]) => Promise<T>,
      ) => {
        return options.transactions.run(async (tx) => {
          const registry = owner.registry();
          const hold = () =>
            options.authority.holdUntilTransactionCompletes(tx, {
              tenantReference: options.tenantReference,
              brandReference: options.brandReference,
              actorReference: options.actorReference,
              actorKind: options.actorKind,
              purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
              permission: "catalog.manage",
              action: "catalog.tax-classification.read",
              mode: "Read",
              registry,
              requiredFields: taxClassificationRegistryFields,
              observedAt: options.clock.now(),
            });
          await options.registerBeforeCommit(
            tx,
            async () => {
              owner.guard();
              await hold();
            },
            () => {
              owner.final();
            },
          );
          await hold();
          if (owner.mode === "skip") return undefined;
          const source = {
            registry,
            snapshotDigest: hash(registry),
            observation,
            sourceAuthority: "CurrentTransactionHeld",
          };
          const actual = owner.mode === "foreign" ? { query: vi.fn() } : tx;
          const result = await work(source, actual);
          if (owner.mode === "repeat") {
            try {
              await work(source, tx);
            } catch {
              /* caught owner bug */
            }
          }
          await hold();
          return owner.mode === "substitute" ? {} : result;
        });
      },
    };
  },
}));
const id = (n: number) => "01902445-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString();
function binding(n: number) {
  return {
    bindingReference: id(900 + n),
    optionSetReference: id(100 + n),
    optionSetVersionReference: id(200 + n),
    purpose: "CUSTOMIZATION",
    sortOrder: n,
    enabledOptionReferences: [id(300 + n)],
    defaultSelections: [{ optionReference: id(300 + n), quantity: 1 }],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [],
    excludedSkuReferences: [],
    channelCodes: ["WEB"],
    storeOverrideAllowed: false,
  };
}
function publication(count = 0): PublicationQualificationInput {
  const bindings = Array.from({ length: count }, (_, i) => binding(i)),
    aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_OPTION_PRODUCT",
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
        localizedNames: { "en-CA": "Synthetic pinned option fixture" },
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
          tagReferences: [],
          attributeValues: [],
          media: [],
          variantDimensions: [],
          variantCombinations: [],
          optionRules: bindings.map((b) => ({
            bindingReference: b.bindingReference,
            versionResolution: "Pinned",
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
    intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
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
      scopeSet: [
        { level: "Store", reference: id(30), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
      ],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: { instant: at, localDateTime: at.slice(0, -1), utcOffsetMinutes: 0 },
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_OPTION_SOURCE",
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    });
  return { command, aggregate, current: null, content: null, observedAt: at };
}
function acknowledgement(): WarningAcknowledgementQualificationInput {
  const input = publication(),
    c = input.command,
    facts: ProductPublicationFactsV2 = {
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
        evidenceReference: id(50),
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
        validUntil: plus(at, 3000),
      },
    },
    current = planCatalogProductPublicationV2(c, null, facts),
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
          sourceDigest: hash("controlled source"),
          generation: "1",
          relevantReferenceDigest: hash("controlled relevant references"),
          observedAt: at,
          validUntil: plus(at, 3000),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: c,
      publication: current,
      validation: facts.validation,
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
    observedAt: plus(humanAt, 10),
    validUntil: plus(humanAt, 2000),
  };
}

function registry(lifecycle: "Active" | "Inactive" | "Retired" = "Active", hasDefault = true) {
  return parseCatalogProductTaxClassificationRegistry({
    profile: "CatalogProductTaxClassificationRegistryV1",
    tenantReference: id(1),
    brandReference: id(2),
    registryReference: id(1000),
    versionReference: id(1001),
    registryVersion: 1,
    defaultLocale: "en-CA",
    previousSnapshotDigest: null,
    registeredAt: at,
    definitions: [
      {
        classificationReference: id(1002),
        code: "STANDARD",
        localizedNames: { "en-CA": "Synthetic classification" },
        lifecycle,
      },
    ],
    defaultClassificationReference: hasDefault && lifecycle === "Active" ? id(1002) : null,
  });
}
function setup(input = publication()) {
  let time = input.observedAt;
  const tx = { query: vi.fn() },
    guards: { guard: () => Promise<void>; final: () => void }[] = [],
    authority = { holdUntilTransactionCompletes: vi.fn(async () => undefined) };
  const options = {
    transaction: tx,
    clock: { now: () => time },
    authority,
    registerBeforeCommit: vi.fn(async (_tx, guard, final) => {
      expect(_tx).toBe(tx);
      guards.push({ guard, final });
    }),
  } satisfies Options;
  const source = createCurrentProductPublicationTaxResolutionSource(options);
  return {
    tx,
    input,
    source,
    guards,
    authority,
    options,
    setTime: (value: string) => {
      time = value;
    },
    run: () => source.withPublication(input, plus(input.observedAt, 2000), async (value) => value),
    commit: async () => {
      for (const g of guards) await g.guard();
      for (const g of guards) g.final();
    },
  };
}
function explicit(reference: string | null) {
  const input = publication(),
    aggregate = parseProductAggregate({
      ...input.aggregate,
      draft: { ...input.aggregate.draft, taxClassificationReference: reference },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  return {
    ...input,
    aggregate,
    command: parseProductPublicationCommandV2({
      ...input.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    }),
  };
}
beforeEach(() => {
  owner.mode = "normal";
  owner.options.mockReset();
  owner.registry.mockReset().mockReturnValue(registry());
  owner.guard.mockReset();
  owner.final.mockReset();
});
it.each([null, id(1002)])(
  "resolves the actual Brand default / explicit identity %s and holds original intent",
  async (reference) => {
    const f = setup(explicit(reference)),
      result = await f.run();
    expect(result.check).toEqual({ code: "TaxResolution", outcome: "Pass" });
    expect(result.findings).toEqual([]);
    expect(result.originalIntentDigest).toBe(hash(f.input.command));
    expect(result.validUntil).toBe(plus(at, 2000));
    expect(f.guards).toHaveLength(1);
    await f.commit();
    expect(owner.guard).toHaveBeenCalledTimes(1);
    expect(owner.final).toHaveBeenCalledTimes(1);
    expect(f.authority.holdUntilTransactionCompletes).toHaveBeenLastCalledWith(
      f.tx,
      expect.objectContaining({
        command: f.input.command,
        commandPurposeCode: f.input.command.purposeCode,
        originalIntentDigest: hash(f.input.command),
        actorKind: "User",
        requestObservedAt: at,
        requestValidUntil: plus(at, 2000),
        purposeCode: "CATALOG_PRODUCT_TAX_CLASSIFICATION_REGISTRY",
      }),
    );
  },
);
it.each(["Inactive", "Retired"] as const)(
  "reports proved %s classification as a bounded HardError",
  async (lifecycle) => {
    owner.registry.mockReturnValue(registry(lifecycle));
    const f = setup(explicit(id(1002))),
      result = await f.run();
    await f.commit();
    expect(result.check.outcome).toBe("HardError");
    expect(result.findings[0]?.reasonCode).toBe("TAX_CLASSIFICATION_" + lifecycle.toUpperCase());
    expect(result.findings[0]?.references[0]).toMatchObject({
      resourceReference: id(1002),
      versionReference: null,
    });
    expect(JSON.stringify(result)).not.toContain("Synthetic classification");
  },
);
it.each(["missing", "unknown"])(
  "reports actual %s classification without inventing a default",
  async (mode) => {
    owner.registry.mockReturnValue(registry("Active", false));
    const f = setup(explicit(mode === "unknown" ? id(9999) : null)),
      result = await f.run();
    await f.commit();
    expect(result.check.outcome).toBe("HardError");
    expect(result.findings[0]?.reasonCode).toBe(
      mode === "unknown" ? "TAX_CLASSIFICATION_UNKNOWN" : "TAX_DEFAULT_MISSING",
    );
  },
);
it("preserves an independent Ack command and fresh original Ack observation", async () => {
  const input = acknowledgement(),
    f = setup();
  f.setTime(input.observedAt);
  const result = await f.source.withAcknowledgement(input, async (value) => value);
  await f.commit();
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(result.validUntil).toBe(input.validUntil);
  expect(f.authority.holdUntilTransactionCompletes).toHaveBeenLastCalledWith(
    f.tx,
    expect.objectContaining({
      command: input.command,
      commandPurposeCode: input.command.purposeCode,
      requestObservedAt: input.observedAt,
      requestValidUntil: input.validUntil,
    }),
  );
});
it("does not invalidate relevant identity evidence for unrelated registry generation or label changes", async () => {
  const first = setup(),
    a = await first.run();
  await first.commit();
  const r = registry();
  owner.registry.mockReturnValue(
    parseCatalogProductTaxClassificationRegistry({
      ...r,
      versionReference: id(1010),
      registryVersion: 2,
      previousSnapshotDigest: hash(r),
      definitions: [
        { ...r.definitions[0], localizedNames: { "en-CA": "Corrected label" } },
        {
          classificationReference: id(1011),
          code: "UNRELATED",
          localizedNames: { "en-CA": "Unrelated" },
          lifecycle: "Active",
        },
      ],
    }),
  );
  const second = setup(),
    b = await second.run();
  await second.commit();
  expect(a.sources[0]?.sourceDigest).not.toBe(b.sources[0]?.sourceDigest);
  expect(a.sources[0]?.relevantReferenceDigest).toBe(b.sources[0]?.relevantReferenceDigest);
});
it("rejects authority withdrawn only at outer commit", async () => {
  const f = setup();
  await f.run();
  f.authority.holdUntilTransactionCompletes.mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(owner.final).not.toHaveBeenCalled();
});
it("rechecks original exclusive deadline after all asynchronous guards", async () => {
  const f = setup();
  await f.run();
  await f.guards[0]?.guard();
  f.setTime(plus(at, 2000));
  expect(() => f.guards[0]?.final()).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
});
it.each(["rollback", "invalid", "expired", "query"])(
  "poisons outer commit on %s clock/query after successful read",
  async (mode) => {
    const f = setup();
    await f.run();
    if (mode === "query") f.tx.query = vi.fn();
    else
      f.setTime(
        mode === "rollback" ? plus(at, -1) : mode === "invalid" ? "invalid" : plus(at, 2000),
      );
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each(["skip", "repeat", "substitute", "foreign"])(
  "rejects %s owner callback and keeps the outer poison guard",
  async (mode) => {
    owner.mode = mode;
    const f = setup();
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("registers a rejecting guard even when malformed input is caught by its caller", async () => {
  const f = setup();
  await expect(
    f.source.withPublication(
      { ...f.input, observedAt: "invalid" },
      plus(at, 2000),
      async (value) => value,
    ),
  ).rejects.toThrow();
  expect(f.guards).toHaveLength(1);
  await expect(f.commit()).rejects.toThrow();
});
it("retains detached input and captured authority across the first host await", async () => {
  const input = structuredClone(publication()),
    f = setup(input),
    original = structuredClone(input.command);
  f.options.registerBeforeCommit.mockImplementationOnce(async (_tx, guard, final) => {
    Object.assign(input.command, { actorReference: id(9999) });
    f.authority.holdUntilTransactionCompletes = vi.fn(async () => {
      throw Error("replacement must not run");
    });
    f.guards.push({ guard, final });
  });
  const result = await f.run();
  await f.commit();
  expect(result.originalIntentDigest).toBe(hash(original));
});
it("caught same-source reentry cannot leave a committable partial result", async () => {
  const f = setup();
  await expect(
    f.source.withPublication(f.input, plus(at, 2000), async () => {
      await expect(f.run()).rejects.toThrow();
    }),
  ).rejects.toThrow();
  await expect(f.commit()).rejects.toThrow();
});
it("cannot treat missing or foreign registry as a business HardError", async () => {
  owner.registry.mockReturnValue({ ...registry(), brandReference: id(9999) });
  const f = setup();
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toThrow();
});
