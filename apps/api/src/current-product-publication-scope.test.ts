import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  buildCatalogProductRetirementCoverage,
  buildCatalogProductScopeRetirementHeader,
  catalogProductRetirementSourceHeadDigest,
  buildCatalogProductPublicationValidationReport,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  productPublicationSourceFieldsV2,
  type createPostgresProductPublicationSourceStoreV2,
  type CatalogProductRetirementHistoryEntry,
  type CatalogProductScopeRetirementHeader,
  type ProductPublicationApprovalV2,
  type ProductPublicationFactsV2,
} from "@rms/catalog";
import type { TenantStoreReferenceSourceOptions, TenantStoreReferenceRequest } from "@bop/tenant";
import {
  createCurrentProductPublicationScopeSource,
  type CurrentProductPublicationScope,
} from "./current-product-publication-scope.js";
import type {
  PublicationQualificationInput,
  WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";
type Options = Parameters<typeof createCurrentProductPublicationScopeSource>[0];
type Tx = Options["transaction"];
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
const owners = vi.hoisted(() => ({ mode: "normal", coverage: vi.fn(), stores: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  // Controlled acquisition ports; owning coverage, command, report and scope
  // contracts remain real. SQL/locks are independently covered by the native case.
  createPostgresProductPublicationSourceStoreV2(options: HistoryOptions) {
    return {
      async withCurrentCoverage<T>(
        request: unknown,
        work: (value: unknown, tx: Tx) => Promise<T>,
      ): Promise<T> {
        if (owners.mode === "skip-history") return undefined as T;
        return options.transactions.run(async (tx) => {
          const packet = {
            tenantReference: options.tenantReference,
            brandReference: options.brandReference,
            actorReference: options.actorReference,
            actorKind: options.actorKind,
            productReference: id(1),
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE" as const,
            permission: "catalog.manage" as const,
            owningActions: ["catalog.product.history.read" as const],
            requiredFields: productPublicationSourceFieldsV2,
            observedAt: options.clock.now(),
          };
          if (owners.mode === "history-fields") Object.assign(packet, { requiredFields: [] });
          await options.authority.holdUntilTransactionCompletes(tx, packet);
          const coverage = await owners.coverage(request, tx, options.clock.now());
          const actual = owners.mode === "foreign-tx" ? ({ query: vi.fn() } as Tx) : tx;
          const answer = await work(coverage, actual);
          if (owners.mode === "repeat-history") {
            try {
              await work(coverage, tx);
            } catch {
              /* poison persists */
            }
          }
          await options.authority.holdUntilTransactionCompletes(tx, {
            ...packet,
            observedAt: options.clock.now(),
          });
          return owners.mode === "substitute-history" ? ({} as T) : answer;
        });
      },
    };
  },
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresTenantStoreReferenceSource(options: TenantStoreReferenceSourceOptions) {
    return {
      async withCurrentSnapshot<T>(
        request: TenantStoreReferenceRequest,
        work: (value: unknown) => Promise<T>,
      ): Promise<T> {
        try {
          if (owners.mode === "skip-stores") return undefined as T;
          return await options.authority.withCurrentBrandReferenceRead(request, () =>
            options.transactions.run(async (tx) => {
              await options.authority.isCurrent(tx, request);
              const value = await owners.stores(request, tx);
              const answer = await work(value);
              if (owners.mode === "repeat-stores") {
                try {
                  await work(value);
                } catch {
                  /* poison persists */
                }
              }
              await options.authority.isCurrent(tx, request);
              return owners.mode === "substitute-stores" ? ({} as T) : answer;
            }),
          );
        } catch {
          throw Error("TENANT_STORE_REFERENCE_UNAVAILABLE");
        }
      },
    };
  },
}));
const id = (n: number) => "01902446-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  due = "2026-10-03T13:00:00.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  expiry = "2026-10-04T12:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString(),
  boundary = (instant: string) => ({
    instant,
    localDateTime: instant.slice(0, -1),
    utcOffsetMinutes: 0,
  });
function aggregate() {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "SYNTHETIC_VARIANT",
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
      localizedNames: { "en-CA": "Synthetic" },
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
          localizedNames: { "en-CA": "Synthetic" },
          variantSelections: [{ dimensionReference: id(6), valueReference: id(7) }],
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
        variantDimensions: [
          {
            dimensionReference: id(6),
            code: "SIZE",
            localizedNames: { "en-CA": "Size" },
            sortOrder: 0,
            selectionRequirement: "Required",
            values: [
              {
                valueReference: id(7),
                code: "SMALL",
                localizedNames: { "en-CA": "Small" },
                sortOrder: 0,
                attributeReference: null,
                mediaReference: null,
              },
            ],
          },
        ],
        variantCombinations: [
          {
            selections: [{ dimensionReference: id(6), valueReference: id(7) }],
            disposition: "Valid",
            skuReference: id(5),
          },
        ],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
}
function publication(value = aggregate()): PublicationQualificationInput {
  const identity = deriveCatalogProductPublicationContentIdentity(value),
    none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
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
      expectedProductAggregateVersion: value.aggregateVersion,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Store", reference: id(12), channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(due), effectiveUntil: null },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_VALIDATE",
      replacementIntent: { ...none, digest: hash(none) },
      replacementIntentDigest: hash(none),
    });
  return { command, aggregate: value, current: null, content: null, observedAt: at };
}
function facts(
  input: PublicationQualificationInput,
  approval: ProductPublicationApprovalV2 | null = null,
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
      evidenceReference: id(50 + c.expectedPublicationVersion),
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
function lifecycle() {
  const inputs = [publication()];
  let approval: ProductPublicationApprovalV2 | null = null;
  for (const action of [
    "SubmitReview",
    "Approve",
    "SchedulePublish",
    "ActivateScheduled",
  ] as const) {
    const prior = inputs.at(-1);
    if (!prior) throw Error("Missing synthetic lifecycle input");
    const current = planCatalogProductPublicationV2(
        prior.command,
        prior.current,
        facts(prior, approval),
      ),
      value = parseProductAggregate({
        ...prior.aggregate,
        aggregateVersion: prior.aggregate.aggregateVersion + 1,
      }),
      command = parseProductPublicationCommandV2({
        ...prior.command,
        action,
        operationReference: id(100 + current.publicationVersion),
        expectedProductAggregateVersion: value.aggregateVersion,
        expectedPublicationVersion: current.publicationVersion,
        actorReference:
          action === "Approve" ? id(9) : action === "ActivateScheduled" ? id(90) : id(3),
        actorKind: action === "ActivateScheduled" ? "System" : "User",
        occurredAt: action === "ActivateScheduled" ? due : at,
        scheduleReference:
          action === "SchedulePublish" || action === "ActivateScheduled" ? id(22) : null,
        successorDraftVersionReference: action === "ActivateScheduled" ? id(23) : null,
      });
    const input = {
      command,
      aggregate: value,
      current,
      content: null,
      observedAt: action === "ActivateScheduled" ? plus(due, 10000) : at,
    };
    inputs.push(input);
    if (action === "Approve") {
      if (
        !current.reviewReference ||
        current.reviewVersion === null ||
        !current.submittedByActorReference
      )
        throw Error("Missing real parsed review tuple");
      approval = {
        profile: "CatalogProductPublicationApprovalV2",
        replacementIntentDigest: current.replacementIntentDigest,
        evidenceReference: command.operationReference,
        reviewReference: current.reviewReference,
        reviewVersion: current.reviewVersion,
        requestedByActorReference: current.submittedByActorReference,
        approvedByActorReference: command.actorReference,
        contentDigest: current.contentDigest,
        configurationDigest: current.configurationDigest,
        scopeDigest: current.scopeDigest,
        periodDigest: current.periodDigest,
        policyReference: current.policyReference,
        policyVersion: current.policyVersion,
        approvedAt: at,
        validUntil: expiry,
      };
    }
  }
  return inputs;
}
function acknowledgement(): WarningAcknowledgementQualificationInput {
  const input = publication(),
    f = facts(input),
    validation = {
      ...f.validation,
      validUntil: plus(at, 3000),
      checks: f.validation.checks.map((c) =>
        c.code === "ChangeImpact" ? { ...c, outcome: "Warning" as const } : c,
      ),
    },
    current = planCatalogProductPublicationV2(input.command, null, { ...f, validation }),
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
          relevantReferenceDigest: hash("controlled references"),
          observedAt: at,
          validUntil: plus(at, 3000),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: input.command,
      publication: current,
      validation,
      details,
      recordedAt: at,
    }),
    value = parseProductAggregate({ ...input.aggregate, aggregateVersion: 4 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(10),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(60),
      productReference: id(1),
      versionReference: id(4),
      expectedProductAggregateVersion: 4,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: humanAt,
    });
  return {
    command,
    aggregate: value,
    current,
    report,
    observedAt: plus(humanAt, 10),
    validUntil: plus(humanAt, 2000),
  };
}
function coverage(
  input: PublicationQualificationInput | WarningAcknowledgementQualificationInput,
  observedAt: string,
) {
  const history: CatalogProductRetirementHistoryEntry[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [];
  const heads =
    input.current === null
      ? []
      : input.current.publicationVersion === 1
        ? [input.current]
        : lifecycle()
            .map((value) => value.current)
            .filter((value) => value !== null)
            .filter(
              (value) =>
                value !== null &&
                value.publicationVersion <= (input.current?.publicationVersion ?? 0),
            );
  for (const head of heads) {
    const publicationAction = (["Validate", "SubmitReview", "Approve", "SchedulePublish"] as const)[
      head.publicationVersion - 1
    ];
    if (!publicationAction) throw Error("Missing synthetic history action");
    const latest = history.length === 0 ? [] : [history[history.length - 1]?.publication];
    headers.push(
      buildCatalogProductScopeRetirementHeader({
        publicationAction,
        publication: head,
        previousPublication: null,
        observedSourceRevision: String(history.length + 1),
        observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
          tenantReference: id(10),
          brandReference: id(2),
          productReference: id(1),
          aggregateVersion: head.productAggregateVersion,
          sourceRevision: String(history.length + 1),
          latest,
        }),
      }),
    );
    history.push({ publicationAction, publication: head });
  }
  return buildCatalogProductRetirementCoverage({
    tenantReference: id(10),
    brandReference: id(2),
    productReference: id(1),
    aggregateVersion: input.aggregate.aggregateVersion,
    sourceRevision: String(history.length + 1),
    observedAt,
    history,
    headers,
  });
}
function stores(request: TenantStoreReferenceRequest) {
  return {
    profile: "TenantStoreReferenceV1",
    brandReference: id(2),
    brandLifecycle: "Active",
    brandVersion: "1",
    generation: "1",
    referenceCount: "1",
    originalIntentDigest: request.originalIntentDigest,
    observedAt: request.observedAt,
    references: [
      { storeReference: id(12), lifecycle: "Active", version: "1", createdAt: at, updatedAt: at },
    ],
  };
}
function policy(observedAt = at) {
  return {
    content: {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(10),
      brandReference: id(2),
      familyReference: id(40),
      policyReference: id(20),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: [],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    },
    currentPublicationReference: id(41),
    observedAt,
    validUntil: plus(observedAt, 20000),
  };
}
function fixture(
  input: PublicationQualificationInput | WarningAcknowledgementQualificationInput = publication(),
) {
  let time = input.observedAt,
    denied: "history" | "stores" | null = null;
  const tx: Tx = { query: vi.fn(async () => ({ rows: [] })) },
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    historyHold = vi.fn<Options["historyAuthority"]["holdUntilTransactionCompletes"]>(async () => {
      if (denied === "history") throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    tenantHold = vi.fn<Options["tenantAuthority"]["withCurrentBrandReferenceRead"]>(
      async (_tx, _packet, work) => {
        if (denied === "stores") throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return work();
      },
    ),
    isCurrent = vi.fn<Options["tenantAuthority"]["isCurrent"]>(async () => true),
    register = vi.fn<Options["registerBeforeCommit"]>(async (actual, guard, final) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(final);
    }),
    options: Options = {
      transaction: tx,
      clock: { now: () => time },
      historyAuthority: { holdUntilTransactionCompletes: historyHold },
      tenantAuthority: {
        withCurrentBrandReferenceRead:
          tenantHold as Options["tenantAuthority"]["withCurrentBrandReferenceRead"],
        isCurrent,
      },
      registerBeforeCommit: register,
    },
    source = createCurrentProductPublicationScopeSource(options),
    p = policy(input.observedAt),
    work = vi.fn(async (value: CurrentProductPublicationScope) => value),
    validUntil = plus(input.observedAt, 3000);
  owners.coverage.mockImplementation(async (_request, actual, readAt: string) => {
    expect(actual).toBe(tx);
    return coverage(input, readAt);
  });
  owners.stores.mockImplementation(async (request: TenantStoreReferenceRequest, actual) => {
    expect(actual).toBe(tx);
    return stores(request);
  });
  return {
    input,
    tx,
    options,
    p,
    work,
    source,
    guards,
    finals,
    historyHold,
    tenantHold,
    isCurrent,
    register,
    validUntil,
    run: () =>
      "report" in input
        ? source.withAcknowledgement(input, p, work)
        : source.withPublication(input, validUntil, p, work),
    setTime(value: string) {
      time = value;
    },
    deny(value: "history" | "stores") {
      denied = value;
    },
    async commit() {
      for (const g of guards) await g();
      for (const f of finals) f();
    },
  };
}
beforeEach(() => {
  owners.mode = "normal";
  owners.coverage.mockReset();
  owners.stores.mockReset();
});
it("uses one actual history and roster with the outer policy, returning only scope and active-member checks", async () => {
  const f = fixture(),
    result = await f.run();
  await f.commit();
  expect(result).toMatchObject({
    check: { code: "UniqueScope", outcome: "Pass" },
    publishableSkuCheck: { code: "PublishableSku", outcome: "Pass" },
    findings: [],
    validUntil: f.validUntil,
  });
  expect(result.assessment.activeSkuReferences).toEqual([id(5)]);
  expect(result).not.toHaveProperty("checks");
  expect(owners.coverage).toHaveBeenCalledTimes(1);
  expect(owners.stores).toHaveBeenCalledTimes(1);
  for (const [tx, packet] of f.historyHold.mock.calls) {
    expect(tx).toBe(f.tx);
    expect(packet).toMatchObject({
      command: f.input.command,
      actorKind: "User",
      originalIntentDigest: hash(f.input.command),
      commandPurposeCode: f.input.command.purposeCode,
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
      requestObservedAt: at,
      requestValidUntil: f.validUntil,
    });
  }
  for (const [tx, packet] of f.tenantHold.mock.calls) {
    expect(tx).toBe(f.tx);
    expect(packet.command).toEqual(f.input.command);
    expect(packet.request).toMatchObject({
      purposeCode: f.input.command.purposeCode,
      originalIntentDigest: hash(f.input.command),
    });
  }
});
it("preserves Validate/review/approval/scheduling and delayed System activation identities", async () => {
  for (const input of lifecycle()) {
    const f = fixture(input);
    await f.run();
    await f.commit();
    expect(f.historyHold.mock.calls[0]?.[1]).toMatchObject({
      command: input.command,
      actorKind: input.command.actorKind,
    });
    expect(f.tenantHold.mock.calls[0]?.[1].command).toEqual(input.command);
  }
});
it("binds independent Ack to its old report with a fresh original lease", async () => {
  const input = acknowledgement(),
    f = fixture(input),
    result = await f.run();
  await f.commit();
  expect(input.report.validation.validUntil < input.observedAt).toBe(true);
  expect(result.validUntil).toBe(input.validUntil);
  expect(f.historyHold.mock.calls[0]?.[1]).toMatchObject({
    command: input.command,
    commandPurposeCode: input.command.purposeCode,
    originalIntentDigest: hash(input.command),
  });
});
it("allows sequential source acquisition without changing original policy or command times", async () => {
  const f = fixture();
  f.setTime(plus(at, 500));
  const result = await f.run();
  await f.commit();
  expect(result.coverage.observedAt).toBe(plus(at, 500));
  expect(result.stores.observedAt).toBe(plus(at, 500));
  expect(result.policy.observedAt).toBe(at);
  expect(result.validUntil).toBe(f.validUntil);
});
it("uses owning scope and active-member failures without inventing missing source facts", async () => {
  const f = fixture();
  owners.stores.mockImplementation(async (r: TenantStoreReferenceRequest) => ({
    ...stores(r),
    references: [{ ...stores(r).references[0], lifecycle: "Suspended" }],
  }));
  const result = await f.run();
  await f.commit();
  expect(result.check.outcome).toBe("HardError");
  expect(result.publishableSkuCheck.outcome).toBe("HardError");
  expect(result.findings.map((x) => x.ruleCode)).toEqual([
    "STORE_NOT_CURRENT_ACTIVE",
    "SKU_SCOPE_NOT_QUALIFIED",
  ]);
});
it.each(["history", "stores"] as const)(
  "rechecks late %s permission through the actual outer commit",
  async (owner) => {
    const f = fixture();
    await f.run();
    f.deny(owner);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(owners.coverage).toHaveBeenCalledTimes(1);
    expect(owners.stores).toHaveBeenCalledTimes(1);
  },
);
it("preserves a Tenant adapter permission error hidden by the old owner", async () => {
  const f = fixture();
  f.deny("stores");
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.work).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
});
it("preserves an exact consumer dependency error across Tenant normalization and poisons COMMIT", async () => {
  const f = fixture(),
    failure = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  f.work.mockRejectedValue(failure);
  await expect(f.run()).rejects.toBe(failure);
  expect(f.work).toHaveBeenCalledTimes(1);
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("retains permission-denial precedence over a captured consumer dependency error", async () => {
  const f = fixture(),
    dependency = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"),
    denial = new CatalogError("CATALOG_PERMISSION_DENIED");
  f.work.mockRejectedValue(dependency);
  f.tenantHold.mockImplementation(async (_tx, _packet, work) => {
    try {
      return await work();
    } catch {
      throw denial;
    }
  });
  await expect(f.run()).rejects.toBe(denial);
  expect(f.work).toHaveBeenCalledTimes(1);
  await expect(f.commit()).rejects.toBe(denial);
});
it.each([
  new Error("Controlled Tenant failure"),
  new CatalogError("CATALOG_INPUT_INVALID"),
  new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE"),
])("does not preserve an unrestricted Tenant source error: %s", async (failure) => {
  const f = fixture();
  owners.stores.mockRejectedValue(failure);
  let observed: unknown;
  await expect(
    f.run().catch((error: unknown) => {
      observed = error;
      throw error;
    }),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(observed).not.toBe(failure);
  expect(f.work).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each([
  "skip-history",
  "history-fields",
  "foreign-tx",
  "repeat-history",
  "substitute-history",
  "skip-stores",
  "repeat-stores",
  "substitute-stores",
])("poisons caught %s protocol failure", async (mode) => {
  const f = fixture();
  owners.mode = mode;
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it.each(["root", "intent", "policy", "timestamp"])(
  "refuses %s mismatch before findings",
  async (mode) => {
    const f = fixture();
    if (mode === "root")
      owners.coverage.mockImplementation(async () =>
        coverage(
          {
            ...publication(),
            aggregate: parseProductAggregate({ ...aggregate(), aggregateVersion: 2 }),
          },
          at,
        ),
      );
    if (mode === "intent")
      owners.stores.mockImplementation(async (r: TenantStoreReferenceRequest) =>
        stores({ ...r, originalIntentDigest: hash("other") }),
      );
    if (mode === "policy") Object.assign(f.p.content, { brandReference: id(99) });
    if (mode === "timestamp")
      owners.stores.mockImplementation(async (r: TenantStoreReferenceRequest) =>
        stores({ ...r, observedAt: plus(at, 1) }),
      );
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.work).not.toHaveBeenCalled();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("enforces shorter policy validity after every global async guard", async () => {
  const f = fixture();
  f.p.validUntil = plus(at, 1500);
  await f.run();
  for (const guard of f.guards) await guard();
  f.setTime(f.p.validUntil);
  expect(() => f.finals[0]?.()).toThrow(CatalogError);
  f.setTime(at);
  expect(() => f.finals[0]?.()).toThrow(CatalogError);
});
it.each(["query", "reentry", "expired", "rewind"])(
  "keeps caught %s mutation poisoned",
  async (mode) => {
    const f = fixture(),
      original = f.tx.query;
    f.work.mockImplementation(async (value) => {
      if (mode === "query") Object.assign(f.tx, { query: vi.fn() });
      if (mode === "expired") f.setTime(f.validUntil);
      if (mode === "rewind") f.setTime(plus(at, -1));
      if (mode === "reentry") {
        try {
          await f.run();
        } catch {
          /* fail outside too */
        }
      }
      return value;
    });
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    Object.assign(f.tx, { query: original });
    f.setTime(at);
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("captures context/policy/ports before the first awaited host hook", async () => {
  const input = structuredClone(publication()),
    f = fixture(input),
    original = structuredClone(input);
  Object.assign(f.options.clock, {
    now: () => {
      throw Error("replacement clock");
    },
  });
  Object.assign(f.options.historyAuthority, {
    holdUntilTransactionCompletes: () => {
      throw Error("replacement authority");
    },
  });
  f.register.mockImplementation(async (_tx, guard, final) => {
    f.guards.push(guard);
    f.finals.push(final);
    Object.assign(input.command, { operationReference: id(99) });
    f.p.content.scopeOrder.reverse();
  });
  const result = await f.run();
  await f.commit();
  expect(result.assessment.originalIntentDigest).toBe(hash(original.command));
  expect(result.policy.content.scopeOrder[0]).toBe("Store");
});
it("registers a rejecting guard before exposing malformed context", async () => {
  const input = structuredClone(publication());
  Object.assign(input.command, { expectedProductAggregateVersion: 9 });
  const f = fixture(input);
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(owners.coverage).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
