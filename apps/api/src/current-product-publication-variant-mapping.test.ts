import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  buildCatalogProductPublicationReferenceProvenance,
  buildCatalogProductPublicationReferenceRequestV2,
  bindCatalogProductPublicationValidationContextV2,
  buildCatalogProductPublicationValidationReport,
  deriveCatalogProductPublicationContentIdentity,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  parseProductAggregate,
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  productPublicationCheckCodes,
  productPublicationQualificationHistoryFields,
  productWarningAcknowledgementQualificationHistoryFields,
  type createPostgresProductPublicationQualificationHistorySource,
  type createPostgresProductWarningAcknowledgementQualificationHistorySource,
  type ProductPublicationApprovalV2,
  type ProductPublicationFactsV2,
  type CatalogProductPublicationReferenceProvenance,
} from "@rms/catalog";
import {
  createCurrentProductPublicationVariantMappingSource,
  type CurrentProductPublicationVariantMapping,
} from "./current-product-publication-variant-mapping.js";
import type {
  PublicationQualificationInput,
  WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";

type OwnerOptions = Parameters<
  typeof createPostgresProductPublicationQualificationHistorySource
>[0];
type AckOptions = Parameters<
  typeof createPostgresProductWarningAcknowledgementQualificationHistorySource
>[0];
type Request =
  | Parameters<
      ReturnType<
        typeof createPostgresProductPublicationQualificationHistorySource
      >["withCurrentQualificationHistory"]
    >[0]
  | Parameters<
      ReturnType<
        typeof createPostgresProductWarningAcknowledgementQualificationHistorySource
      >["withCurrentQualificationHistory"]
    >[0];
type Options = Parameters<typeof createCurrentProductPublicationVariantMappingSource>[0];
type Tx = Options["transaction"];
const owner = vi.hoisted(() => ({ mode: "normal", read: vi.fn(), create: vi.fn() }));
vi.mock("@rms/catalog", async (original) => {
  function create(options: OwnerOptions | AckOptions) {
    owner.create(options);
    return {
      async withCurrentQualificationHistory<T>(
        request: Request,
        work: (value: CatalogProductPublicationReferenceProvenance, tx: Tx) => Promise<T>,
      ): Promise<T> {
        if (owner.mode === "skip") return undefined as T;
        const run = () =>
          options.transactions.run(async (tx) => {
            const input = {
              tenantReference: options.tenantReference,
              brandReference: options.brandReference,
              actorReference: options.actorReference,
              actorKind: request.command.actorKind,
              purposeCode:
                request.profile === "CatalogProductPublicationReferenceRequestV2"
                  ? "CATALOG_PRODUCT_PUBLICATION_QUALIFICATION_HISTORY_READ"
                  : "CATALOG_PRODUCT_WARNING_ACKNOWLEDGEMENT_QUALIFICATION_HISTORY_READ",
              permission: "catalog.manage",
              owningAction: "catalog.product.history.read",
              requiredScope: "FullBrandScope",
              request,
              requiredFields:
                request.profile === "CatalogProductPublicationReferenceRequestV2"
                  ? productPublicationQualificationHistoryFields
                  : productWarningAcknowledgementQualificationHistoryFields,
              observedAt: options.clock.now(),
            };
            if (owner.mode === "authority-fields") Object.assign(input, { requiredFields: [] });
            if (owner.mode === "authority-request")
              Object.assign(input, {
                request: { ...request, originalIntentDigest: hash("other intent") },
              });
            const actual = owner.mode === "different-tx" ? { query: vi.fn() } : tx;
            await options.authority.holdUntilTransactionCompletes(actual, input as never);
            const snapshot = (await owner.read(
              request,
              tx,
              options.clock.now(),
            )) as CatalogProductPublicationReferenceProvenance;
            let result: T;
            try {
              result = await work(snapshot, tx);
            } catch (error) {
              if (owner.mode !== "swallow") throw error;
              return undefined as T;
            }
            if (owner.mode === "repeat") {
              try {
                await work(snapshot, tx);
              } catch {
                /* retained poison */
              }
            }
            await options.authority.holdUntilTransactionCompletes(tx, {
              ...input,
              observedAt: options.clock.now(),
            } as never);
            return owner.mode === "substitute" ? ({ substituted: true } as T) : result;
          });
        const result = await run();
        if (owner.mode === "repeat-transaction") {
          try {
            await run();
          } catch {
            /* retained poison */
          }
        }
        return result;
      },
    };
  }
  return {
    ...(await original<typeof import("@rms/catalog")>()),
    createPostgresProductPublicationQualificationHistorySource: create,
    createPostgresProductWarningAcknowledgementQualificationHistorySource: create,
  };
});
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
          lifecycle: "Draft",
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
function history(
  request: Request,
  observedAt: string,
  historical = aggregate(),
  current = historical,
) {
  return buildCatalogProductPublicationReferenceProvenance(
    {
      aggregateVersion: request.command.expectedProductAggregateVersion,
      observedAt,
      history: Array.from({ length: request.command.expectedProductAggregateVersion }, (_, i) => {
        const value = parseProductAggregate({
          ...(i + 1 === request.command.expectedProductAggregateVersion ? current : historical),
          aggregateVersion: i + 1,
        });
        return {
          aggregate: value,
          operationReference: id(300 + i),
          snapshotDigest: hash(value),
          coherent: true,
        };
      }),
    },
    request,
    observedAt,
  );
}
function fixture(input = publication(), historical = aggregate()) {
  let time = input.observedAt,
    denied = false;
  const query = vi.fn(async () => ({ rows: [] })),
    tx: Tx = { query: query as unknown as Tx["query"] },
    guards: (() => Promise<void>)[] = [],
    finals: (() => void)[] = [],
    hold = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(async () => {
      if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    }),
    register = vi.fn<Options["registerBeforeCommit"]>(async (actual, guard, finalAssert) => {
      expect(actual).toBe(tx);
      guards.push(guard);
      finals.push(finalAssert);
    }),
    options: Options = {
      transaction: tx,
      clock: { now: () => time },
      authority: { holdUntilTransactionCompletes: hold },
      registerBeforeCommit: register,
    },
    source = createCurrentProductPublicationVariantMappingSource(options),
    work = vi.fn(async (value: CurrentProductPublicationVariantMapping) => value),
    validUntil = plus(input.observedAt, 3000),
    storedAggregate = parseProductAggregate(input.aggregate);
  owner.read.mockImplementation(async (request: Request, actual: Tx, readAt: string) => {
    expect(actual).toBe(tx);
    return history(request, readAt, historical, storedAggregate);
  });
  return {
    input,
    source,
    options,
    tx,
    query,
    guards,
    finals,
    hold,
    register,
    work,
    validUntil,
    run: () => source.withPublication(input, validUntil, work),
    setTime(value: string) {
      time = value;
    },
    deny() {
      denied = true;
    },
    async commit() {
      for (const guard of guards) await guard();
      for (const final of finals) final();
    },
  };
}
beforeEach(() => {
  owner.mode = "normal";
  owner.read.mockReset();
  owner.create.mockReset();
});

it("passes complete compatible explicit mapping under the original command and domain read purpose", async () => {
  const f = fixture(),
    result = await f.run();
  expect(result).toMatchObject({
    check: { code: "VariantMapping", outcome: "Pass" },
    findings: [],
    originalIntentDigest: hash(f.input.command),
    validUntil: f.validUntil,
  });
  const actualProvenance = history(
      buildCatalogProductPublicationReferenceRequestV2(
        bindCatalogProductPublicationValidationContextV2(f.input),
        f.validUntil,
      ),
      at,
    ),
    actualHistory = actualProvenance.variantHistory;
  expect(result.referenceProvenance).toEqual(actualProvenance);
  expect(result.historyDigest).toBe(actualHistory.digest);
  expect(result.sources[0]?.sourceDigest).toBe(actualHistory.digest);
  expect(result.sources[0]?.relevantReferenceDigest).toBe(
    hash({ brandReference: id(2), productReference: id(1), used: actualHistory.used }),
  );
  expect(Object.isFrozen(result.sources[0])).toBe(true);
  expect(result).not.toHaveProperty("checks");
  await f.commit();
  expect(owner.read).toHaveBeenCalledTimes(1);
  for (const [tx, input] of f.hold.mock.calls) {
    expect(tx).toBe(f.tx);
    expect(input).toMatchObject({
      command: f.input.command,
      actorKind: "User",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_QUALIFICATION_HISTORY_READ",
      commandPurposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      originalIntentDigest: hash(f.input.command),
      replacementIntentDigest: f.input.command.replacementIntentDigest,
      requestObservedAt: at,
      requestValidUntil: f.validUntil,
      requiredFields: productPublicationQualificationHistoryFields,
    });
  }
});
it("preserves real lifecycle actions and delayed System activation without a User Validate projection", async () => {
  for (const input of lifecycle()) {
    const f = fixture(input);
    await f.run();
    await f.commit();
    expect(
      f.hold.mock.calls.every(
        ([, call]) =>
          call.command.action === input.command.action &&
          call.actorKind === input.command.actorKind,
      ),
    ).toBe(true);
    expect(f.hold.mock.calls[0]?.[1].command).toEqual(input.command);
    if (input.command.action === "ActivateScheduled") {
      expect(input.command.occurredAt).toBe(due);
      expect(input.observedAt).toBe(plus(due, 10000));
      expect(f.hold.mock.calls[0]?.[1].actorReference).toBe(id(90));
    }
  }
});
it("keeps independent Ack and its fresh original lease while the original human report is old", async () => {
  const input = acknowledgement(),
    f = fixture();
  owner.read.mockImplementation(async (request: Request, _actual: Tx, readAt: string) =>
    history(request, readAt, aggregate(), input.aggregate),
  );
  f.setTime(input.observedAt);
  const result = await f.source.withAcknowledgement(input, f.work);
  await f.commit();
  expect(input.report.validation.validUntil < input.observedAt).toBe(true);
  expect(result.originalIntentDigest).toBe(hash(input.command));
  expect(result.validUntil).toBe(input.validUntil);
  expect(f.hold.mock.calls[0]?.[1]).toMatchObject({
    command: input.command,
    commandPurposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    requestValidUntil: input.validUntil,
  });
  expect(f.hold.mock.calls[0]?.[1].command).not.toHaveProperty("scopeSet");
});
it("excludes operation, root and clock from unchanged identity history relevance", async () => {
  const a = await fixture().run(),
    original = publication(),
    value = parseProductAggregate({ ...original.aggregate, aggregateVersion: 3 }),
    observedAt = plus(at, 1000),
    input = {
      ...original,
      aggregate: value,
      observedAt,
      command: parseProductPublicationCommandV2({
        ...original.command,
        expectedProductAggregateVersion: 3,
        operationReference: id(90),
        occurredAt: observedAt,
      }),
    },
    b = await fixture(input).run();
  expect(a.sources[0]?.relevantReferenceDigest).toBe(b.sources[0]?.relevantReferenceDigest);
  expect(a.sources[0]?.sourceDigest).not.toBe(b.sources[0]?.sourceDigest);
});
it.each(["removed", "not-generated", "both"])(
  "reports proved %s contradictions as HardError with stable actual evidence",
  async (mode) => {
    const raw = structuredClone(aggregate()),
      content = raw.draft.editorContent;
    if (!content) throw Error("Missing synthetic content");
    if (mode === "both") Object.assign(content.variantDimensions[0] ?? {}, { code: "REUSED" });
    if (mode === "removed") {
      Object.assign(raw.draft, { skus: [] });
      Object.assign(content, { variantDimensions: [], variantCombinations: [] });
    }
    if (mode === "not-generated" || mode === "both") {
      Object.assign(raw.draft, { skus: [] });
      Object.assign(content.variantCombinations[0] ?? {}, {
        disposition: "NotGenerated",
        skuReference: null,
      });
    }
    Object.assign(raw, { aggregateVersion: 2 });
    const f = fixture(publication(parseProductAggregate(raw))),
      result = await f.run();
    expect(result.check).toEqual({ code: "VariantMapping", outcome: "HardError" });
    const codes = result.findings.map((item) => item.ruleCode);
    expect(codes).toEqual(
      mode === "not-generated"
        ? ["VARIANT_COMBINATION_NOT_GENERATED"]
        : mode === "both"
          ? ["VARIANT_IDENTITY_HISTORY_CONFLICT", "VARIANT_COMBINATION_NOT_GENERATED"]
          : ["VARIANT_IDENTITY_HISTORY_CONFLICT"],
    );
    const identityFinding = result.findings.find(
      (item) => item.ruleCode === "VARIANT_IDENTITY_HISTORY_CONFLICT",
    );
    if (identityFinding)
      expect(identityFinding.references).toEqual([
        {
          sourceCode: "VARIANT_IDENTITY_HISTORY",
          resourceReference: id(1),
          versionReference: null,
          referenceDigest: result.sources[0]?.relevantReferenceDigest,
        },
      ]);
  },
);
it("refuses a committed history that changes a permanently used identity code", async () => {
  const raw = structuredClone(aggregate());
  Object.assign(raw, { aggregateVersion: 2 });
  Object.assign(raw.draft.editorContent?.variantDimensions[0] ?? {}, { code: "REUSED" });
  const f = fixture(publication(parseProductAggregate(raw)));
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.work).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("accepts truly unused empty definitions and explicit Invalid exclusions", async () => {
  for (const empty of [true, false]) {
    const raw = structuredClone(aggregate()),
      content = raw.draft.editorContent;
    if (!content) throw Error("Missing synthetic content");
    Object.assign(raw.draft, { skus: [] });
    if (empty) Object.assign(content, { variantDimensions: [], variantCombinations: [] });
    else
      Object.assign(content.variantCombinations[0] ?? {}, {
        disposition: "Invalid",
        skuReference: null,
      });
    const value = parseProductAggregate(raw),
      f = fixture(publication(value), value);
    expect((await f.run()).check.outcome).toBe("Pass");
    expect(owner.read).toHaveBeenCalled();
  }
});
it.each(["wrong-root", "wrong-intent", "wrong-product", "future", "digest", "malformed"])(
  "refuses %s history without emitting a business HardError",
  async (mode) => {
    const f = fixture();
    owner.read.mockImplementation(async (request: Request) => {
      const original = history(request, at),
        { digest, ...body } = original;
      const change = structuredClone(body);
      if (mode === "wrong-root") Object.assign(change.variantHistory, { aggregateVersion: 2 });
      if (mode === "wrong-intent")
        Object.assign(change.request, { originalIntentDigest: hash("other") });
      if (mode === "wrong-product")
        Object.assign(change.variantHistory, { productReference: id(99) });
      if (mode === "future") Object.assign(change, { observedAt: plus(at, 1) });
      if (mode === "malformed")
        Object.assign(change, { operationProvenance: [{ malformed: true }] });
      return { ...change, digest: mode === "digest" ? hash(digest) : hash(change) };
    });
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.work).not.toHaveBeenCalled();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it.each([
  "skip",
  "repeat",
  "substitute",
  "swallow",
  "repeat-transaction",
  "different-tx",
  "authority-fields",
  "authority-request",
])("poisons caught %s owner protocol failure", async (mode) => {
  const f = fixture();
  owner.mode = mode;
  if (mode === "swallow") f.work.mockRejectedValue(new Error("Controlled consumer failure"));
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("reauthorizes through commit without rereading unchanged locked history", async () => {
  const f = fixture();
  await f.run();
  f.deny();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(owner.read).toHaveBeenCalledTimes(1);
  const final = f.finals[0];
  if (!final) throw Error("Missing final guard");
  expect(final).toThrow(CatalogError);
});
it("refuses exact original deadline after the asynchronous guard completed", async () => {
  const f = fixture();
  await f.run();
  const guard = f.guards[0],
    final = f.finals[0];
  if (!guard || !final) throw Error("Missing outer guard");
  await guard();
  f.setTime(f.validUntil);
  expect(final).toThrow(CatalogError);
  f.setTime(at);
  expect(final).toThrow(CatalogError);
  expect(owner.read).toHaveBeenCalledTimes(1);
});
it.each(["late-work", "query", "reentry"])(
  "retains poison after a caught %s consumer failure",
  async (mode) => {
    const f = fixture(),
      query = f.tx.query,
      inner = vi.fn(async (v: CurrentProductPublicationVariantMapping) => v);
    f.work.mockImplementation(async (value) => {
      if (mode === "late-work") f.setTime(f.validUntil);
      if (mode === "query") Object.assign(f.tx, { query: vi.fn() });
      if (mode === "reentry") {
        try {
          await f.source.withPublication(f.input, f.validUntil, inner);
        } catch {
          /* Outer must still fail. */
        }
      }
      return value;
    });
    await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    Object.assign(f.tx, { query });
    f.setTime(at);
    expect(inner).not.toHaveBeenCalled();
    await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  },
);
it("captures full context and configured ports before the first host hook", async () => {
  const input = structuredClone(publication()),
    original = structuredClone(input),
    f = fixture(input);
  Object.assign(f.options.clock, {
    now: () => {
      throw Error("Replaced clock");
    },
  });
  Object.assign(f.options.authority, {
    holdUntilTransactionCompletes: () => {
      throw Error("Replaced authority");
    },
  });
  Object.assign(f.options, {
    registerBeforeCommit: () => {
      throw Error("Replaced register");
    },
  });
  f.register.mockImplementation(async (_tx, guard, finalAssert) => {
    f.guards.push(guard);
    f.finals.push(finalAssert);
    Object.assign(input.command, { operationReference: id(99) });
    Object.assign(input.aggregate.draft.localizedNames, { "en-CA": "Caller mutation" });
  });
  expect((await f.run()).originalIntentDigest).toBe(hash(original.command));
  expect(f.hold.mock.calls[0]?.[1].command).toEqual(original.command);
  await f.commit();
});
it("registers a refusing outer guard for malformed initial context before exposing the error", async () => {
  const input = structuredClone(publication());
  Object.assign(input.command, { expectedProductAggregateVersion: 99 });
  const f = fixture(input);
  await expect(f.run()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.register).toHaveBeenCalledTimes(1);
  expect(owner.read).not.toHaveBeenCalled();
  await expect(f.commit()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
