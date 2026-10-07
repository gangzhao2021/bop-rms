import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex, type AppendAuditRecordInput } from "@bop/audit";
import { CatalogError, parseProductAggregate } from "../contracts/product.js";
import { buildCatalogProductEditorSnapshot } from "../contracts/product-editor-snapshot.js";
import {
  buildCatalogProductRetirementCoverage,
  catalogProductRetirementSourceHeadDigest,
} from "../contracts/product-publication-source-v2.js";
import { buildCatalogProductScopeRetirementHeader } from "../contracts/product-scope-retirement.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import { productEditorContentReferenceChecks } from "../application/product-editor-content-authority.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
  type ProductPublicationFactsV2,
} from "../contracts/product-publication-v2.js";
import {
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationValidationReport,
} from "../contracts/product-publication-validation-report.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand as parseCommand,
  buildCatalogProductPublicationWarningAcknowledgementObservation as observe,
  buildCatalogProductPublicationWarningAcknowledgementReceipt as acknowledge,
} from "../contracts/product-publication-warning-acknowledgement.js";
import {
  createPostgresProductPublicationStoreV2,
  type ProductPublicationStoreOptionsV2,
  type ProductPublicationWriteResultV2,
} from "../infrastructure/persistence/product-publication-store.js";
import {
  productSnapshotSelectSql,
  type ProductLifecycleTransaction as Tx,
} from "../infrastructure/persistence/product-lifecycle-store.js";
import {
  loadProductRetirementCoverage,
  appendProductScopeRetirementHeader,
  recoverProductScopeRetirementHeader,
} from "../infrastructure/persistence/product-scope-retirement-store.js";
import {
  appendProductPublicationValidationReport,
  recoverProductPublicationValidationReport,
} from "../infrastructure/persistence/product-publication-validation-report-store.js";
import { appendProductPublicationCommitArtifactsV2 } from "../infrastructure/persistence/product-source-producer.js";
import { readLatestProductPublicationWarningAcknowledgement } from "../infrastructure/persistence/product-publication-warning-acknowledgement-record.js";
vi.mock(
  "../infrastructure/persistence/product-scope-retirement-store.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../infrastructure/persistence/product-scope-retirement-store.js")
    >()),
    loadProductRetirementCoverage: vi.fn(),
    appendProductScopeRetirementHeader: vi.fn(),
    recoverProductScopeRetirementHeader: vi.fn(),
  }),
);
vi.mock(
  "../infrastructure/persistence/product-publication-validation-report-store.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../infrastructure/persistence/product-publication-validation-report-store.js")
    >()),
    appendProductPublicationValidationReport: vi.fn(),
    recoverProductPublicationValidationReport: vi.fn(),
  }),
);
vi.mock("../infrastructure/persistence/product-source-producer.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../infrastructure/persistence/product-source-producer.js")
  >()),
  appendProductPublicationCommitArtifactsV2: vi.fn(),
}));
vi.mock(
  "../infrastructure/persistence/product-publication-warning-acknowledgement-record.js",
  () => ({ readLatestProductPublicationWarningAcknowledgement: vi.fn() }),
);
const id = (n: number) => "01902491-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  humanUntil = "2026-10-03T14:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  time = (ms: number) => new Date(Date.parse(humanAt) + ms).toISOString();
beforeEach(() => vi.resetAllMocks());
// Synthetic current-source/SQL ports isolate the actual public V2 writer path.
// Real owning receipt inserts, policy reads and atomic SQL are native coverage.
function fixture() {
  const aggregate = {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_ACK",
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
      localizedNames: { "en-CA": "Synthetic acknowledgement" },
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
  const editor = buildCatalogProductEditorSnapshot(
    aggregate,
    { tenantReference: id(1), brandReference: id(2) },
    { productReference: id(5), expectedAggregateVersion: 7 },
    humanAt,
  );
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    publicationCommand = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
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
      contentDigest: editor.contentDigest,
      configurationDigest: editor.configurationDigest,
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
      replacementIntent: { ...intent, digest: hash(intent) },
      replacementIntentDigest: hash(intent),
    }),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: publicationCommand.replacementIntentDigest,
      evidenceReference: id(7),
      productAggregateVersion: 1,
      contentDigest: publicationCommand.contentDigest,
      configurationDigest: publicationCommand.configurationDigest,
      scopeDigest: hash(publicationCommand.scopeSet),
      periodDigest: hash(publicationCommand.effectivePeriod),
      policyReference: id(8),
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
    }),
    publication = planCatalogProductPublicationV2(publicationCommand, null, {
      now: at,
      productAggregateVersion: 1,
      contentDigest: publicationCommand.contentDigest,
      configurationDigest: publicationCommand.configurationDigest,
      scopeDigest: validation.scopeDigest,
      periodDigest: validation.periodDigest,
      validation,
      approval: null,
      reviewReference: null,
      replacement: null,
    }),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SKU-008",
          outcome: "Warning",
          subjectReference: id(20),
          reasonCode: "SYNTHETIC_REFERENCE_GAP",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_REFERENCE",
          sourceDigest: hash("held source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant refs"),
          observedAt: at,
          validUntil: until,
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: publicationCommand,
      publication,
      validation,
      details,
      recordedAt: at,
    });
  if (details.coverage !== "Complete") throw new Error("Missing synthetic details");
  const command = parseCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(30),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 7,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "CONFIRMED_REFERENCE_WARNING",
      occurredAt: humanAt,
    }),
    freshValidation = parseProductPublicationValidationV2({
      ...validation,
      productAggregateVersion: 7,
      evidenceReference: id(31),
      checkedAt: humanAt,
      validUntil: humanUntil,
    }),
    freshDetails = {
      ...details,
      sources: details.sources.map((s) => ({
        ...s,
        generation: "99",
        sourceDigest: hash("fresh source at new root"),
        observedAt: "2026-10-03T14:00:00.001Z",
        validUntil: humanUntil,
      })),
    },
    policy = {
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(40),
      policyReference: id(8),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
      approvalPolicy: "Required",
      warningOverrideAllowed: true,
      requiredLocales: [],
      mediaRequirement: "Optional",
      effectiveFrom: at,
      effectiveUntil: null,
    },
    observationInput = {
      command,
      binding: report.binding,
      validation: freshValidation,
      details: freshDetails,
      policy,
      observedAt: "2026-10-03T14:00:00.002Z",
      validUntil: humanUntil,
    },
    observation = observe(observationInput),
    receiptInput = { command, report, observation, recordedAt: "2026-10-03T14:00:00.003Z" },
    receipt = acknowledge(receiptInput),
    next = parseProductPublicationCommandV2({
      ...publicationCommand,
      operationReference: id(50),
      expectedProductAggregateVersion: 8,
      expectedPublicationVersion: publication.publicationVersion,
      occurredAt: "2026-10-03T14:00:00.004Z",
    }),
    bindingInput = {
      receipt,
      command: next,
      current: publication,
      validation: { ...freshValidation, productAggregateVersion: 8 },
      details: freshDetails,
      policy,
      now: "2026-10-03T14:00:00.004Z",
    };
  const header = buildCatalogProductScopeRetirementHeader({
    publicationAction: "Validate",
    publication,
    previousPublication: null,
    observedSourceRevision: "1",
    observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      aggregateVersion: 1,
      sourceRevision: "1",
      latest: [],
    }),
  });
  const coverage = buildCatalogProductRetirementCoverage({
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    aggregateVersion: 7,
    sourceRevision: "2",
    observedAt: humanAt,
    history: [{ publicationAction: "Validate", publication }],
    headers: [header],
  });
  return {
    editor,
    coverage,
    command,
    publicationCommand,
    publication,
    report,
    validation,
    details,
    observationInput,
    receiptInput,
    receipt,
    bindingInput,
  };
}

type Mode =
  | "normal"
  | "stale"
  | "absent"
  | "noWarnings"
  | "hardError"
  | "checksOnly"
  | "overrideFalse"
  | "preAck";
function harness(mode: Mode = "normal", action: "Validate" | "SubmitReview" = "Validate") {
  const f = fixture(),
    command = parseProductPublicationCommandV2({
      ...f.bindingInput.command,
      action,
      expectedProductAggregateVersion: 7,
    });
  let ms = 4,
    root = f.editor.aggregate,
    writes = 0,
    commits = 0,
    replay: ProductPublicationWriteResultV2 | undefined,
    mutateDetails = false,
    holdingFacts = false,
    denyReferences = false;
  const statements: string[] = [],
    editorModes: string[] = [],
    guards: { guard: () => Promise<void>; finalAssert?: () => void }[] = [];
  const validation = parseProductPublicationValidationV2({
    ...f.bindingInput.validation,
    productAggregateVersion: 7,
    warningAcknowledgement:
      mode === "preAck"
        ? {
            actorReference: id(3),
            reasonCode: f.command.reasonCode,
            warningCodes: ["ChangeImpact"],
          }
        : null,
    checks: f.bindingInput.validation.checks.map((c) =>
      mode === "noWarnings" && c.code === "ChangeImpact"
        ? { ...c, outcome: "Pass" }
        : mode === "hardError" && (c.code === "InternalCode" || c.code === "HardErrorsCleared")
          ? { ...c, outcome: "HardError" }
          : c,
    ),
  });
  const details = structuredClone({
    ...f.bindingInput.details,
    findings:
      mode === "noWarnings"
        ? []
        : mode === "hardError"
          ? [
              ...f.bindingInput.details.findings,
              {
                checkCode: "InternalCode",
                ruleCode: "SYNTHETIC_CODE",
                outcome: "HardError",
                subjectReference: id(5),
                reasonCode: "SYNTHETIC_CONFLICT",
                references: [],
              },
            ]
          : f.bindingInput.details.findings,
    sources: f.bindingInput.details.sources.map((s) => ({
      ...s,
      relevantReferenceDigest: mode === "stale" ? hash("new refs") : s.relevantReferenceDigest,
    })),
  });
  const facts: ProductPublicationFactsV2 = {
    now: time(4),
    productAggregateVersion: 7,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: validation.scopeDigest,
    periodDigest: validation.periodDigest,
    validation,
    approval: null,
    reviewReference: action === "SubmitReview" ? id(60) : null,
    replacement: null,
  };
  const tx: Tx = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      statements.push(sql);
      let rows: unknown[] = [];
      if (sql.includes("transaction_isolation")) rows = [{ isolation: "read committed" }];
      else if (sql.startsWith("SELECT o.action_code"))
        rows = replay
          ? [
              {
                action_code: "ProductPublication",
                publication: replay.publication,
                aggregate: replay.aggregate,
                content: replay.content,
                journal: null,
              },
            ]
          : [];
      else if (sql.startsWith("SELECT product_id FROM rms_catalog.product"))
        rows = [{ product_id: id(5) }];
      else if (sql === productSnapshotSelectSql) rows = [{ snapshot: root, precise: true }];
      else if (sql.startsWith("SELECT snapshot_json FROM rms_catalog.product_publication_revision"))
        rows = [{ snapshot_json: f.publication }];
      else if (sql.startsWith("UPDATE rms_catalog.product SET")) writes++;
      else if (sql.startsWith("INSERT INTO rms_catalog.product_operation_snapshot"))
        root = parseProductAggregate(values[5]);
      return { rows: rows as readonly Row[], rowCount: 1 };
    },
  };
  const source: ProductPublicationStoreOptionsV2["sources"] = {
    async withHeldCurrentFacts<T>(
      actual: Tx,
      input: Parameters<ProductPublicationStoreOptionsV2["sources"]["withHeldCurrentFacts"]>[1],
      work: (value: ProductPublicationFactsV2, detail?: unknown) => Promise<T>,
    ): Promise<T> {
      expect(actual).toBe(tx);
      expect(input.command).toEqual(command);
      holdingFacts = true;
      try {
        return await work(facts, mode === "checksOnly" ? undefined : details);
      } finally {
        holdingFacts = false;
      }
    },
    async withCurrentPolicy<T>(
      actual: Tx,
      input: Parameters<ProductPublicationStoreOptionsV2["sources"]["withCurrentPolicy"]>[1],
      work: (value: unknown) => Promise<T>,
    ): Promise<T> {
      expect(actual).toBe(tx);
      if (mutateDetails) {
        const first = details.sources[0];
        if (!first) throw Error("Missing source");
        first.relevantReferenceDigest = hash("mutated after capture");
      }
      return work({
        content: { ...f.observationInput.policy, warningOverrideAllowed: mode !== "overrideFalse" },
        currentPublicationReference: id(70),
        observedAt: input.observedAt,
        validUntil: humanUntil,
      });
    },
  };
  vi.spyOn(source, "withHeldCurrentFacts");
  vi.spyOn(source, "withCurrentPolicy");
  const options: ProductPublicationStoreOptionsV2 = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    maximumApprovalValiditySeconds: 300,
    clock: { now: () => time(ms) },
    transactions: {
      async run<T>(work: (actual: Tx) => Promise<T>) {
        const before = root;
        try {
          const result = await work(tx);
          for (const g of guards) await g.guard();
          for (const g of guards) g.finalAssert?.();
          commits++;
          return result;
        } catch (e) {
          root = before;
          writes = 0;
          throw e;
        }
      },
    },
    async registerBeforeCommit(actual, guard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push({ guard, finalAssert });
    },
    authority: {
      async holdUntilTransactionCompletes() {
        return undefined;
      },
    },
    editorContentAuthority: {
      async holdUntilTransactionCompletes(actual, input) {
        expect(actual).toBe(tx);
        editorModes.push(input.mode);
        if (input.mode === "Publish") {
          expect(holdingFacts).toBe(true);
          expect(input.aggregate).toEqual(f.editor.aggregate);
          expect(input.requiredReferenceChecks).toEqual(productEditorContentReferenceChecks);
          if (denyReferences) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        } else expect(input.requiredReferenceChecks).toEqual([]);
      },
    },
    sources: source,
    audit: {
      create(p) {
        return {
          auditId: id(80),
          brandId: id(2),
          actor: { type: "User", reference: id(3) },
          actionCode: "CATALOG_PRODUCT_VERSION_" + action.toUpperCase(),
          targetType: "Product",
          targetId: id(5),
          reasonCode: p.reasonCode,
          correlationId: id(81),
          occurredAt: p.occurredAt,
          sourceChannel: "WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC",
          retentionPolicyVersion: 1,
        } satisfies AppendAuditRecordInput;
      },
    },
  };
  vi.mocked(loadProductRetirementCoverage).mockResolvedValue(f.coverage);
  vi.mocked(appendProductScopeRetirementHeader).mockResolvedValue(undefined);
  vi.mocked(appendProductPublicationValidationReport).mockImplementation(async (_tx, value) =>
    parseCatalogProductPublicationValidationReport(value),
  );
  // This is the immutable exact-head report from the synthetic Validate above,
  // independently of the fresh current sources and their newer observation.
  vi.mocked(recoverProductPublicationValidationReport).mockResolvedValue({
    status: "Recorded",
    report: f.report,
  });
  vi.mocked(appendProductPublicationCommitArtifactsV2).mockResolvedValue(undefined);
  vi.mocked(readLatestProductPublicationWarningAcknowledgement).mockResolvedValue(
    mode === "absent" ? null : f.receipt,
  );
  const store = createPostgresProductPublicationStoreV2(options);
  return {
    f,
    command,
    store,
    source,
    statements,
    editorModes,
    details,
    refuseReferences() {
      denyReferences = true;
    },
    setTime(value: number) {
      ms = value;
    },
    mutateAtPolicy() {
      mutateDetails = true;
    },
    counts() {
      return { writes, commits };
    },
    enableReplay(value: ProductPublicationWriteResultV2) {
      replay = value;
      guards.splice(0);
      vi.mocked(recoverProductScopeRetirementHeader).mockResolvedValue(value.scopeRetirementHeader);
      vi.mocked(recoverProductPublicationValidationReport).mockResolvedValue(
        value.validationReport,
      );
    },
  };
}
it.each(["Validate", "SubmitReview"] as const)(
  "uses only the latest persisted Actor receipt for actual %s plan and immutable report",
  async (action) => {
    const h = harness("normal", action),
      result = await h.store.execute(h.command);
    expect(result.status).toBe("Applied");
    expect(result.publication.validationDecision).toBe("ApprovalPending");
    expect(result.publication.state).toBe(action === "Validate" ? "Draft" : "InReview");
    if (result.validationReport.status !== "Recorded") throw Error("Missing new report");
    expect(result.validationReport.report.validation.warningAcknowledgement).toEqual({
      actorReference: id(3),
      reasonCode: h.f.command.reasonCode,
      warningCodes: ["ChangeImpact"],
    });
    expect(
      result.validationReport.report.validation.checks.find((c) => c.code === "ChangeImpact")
        ?.outcome,
    ).toBe("Warning");
    expect(
      result.validationReport.report.validation.checks.find((c) => c.code === "ApprovalPolicy")
        ?.outcome,
    ).toBe("Pending");
    expect(readLatestProductPublicationWarningAcknowledgement).toHaveBeenCalledTimes(1);
    expect(readLatestProductPublicationWarningAcknowledgement).toHaveBeenCalledWith(
      expect.anything(),
      {
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(5),
        versionReference: id(6),
        actorReference: id(3),
      },
    );
  },
);
it.each(["stale", "absent"] as const)(
  "keeps %s confirmation unacknowledged and never retries an older receipt",
  async (mode) => {
    const h = harness(mode),
      result = await h.store.execute(h.command);
    expect(result.publication.validationDecision).toBe("WarningAcknowledgementRequired");
    if (result.validationReport.status !== "Recorded") throw Error("Missing report");
    expect(result.validationReport.report.validation.warningAcknowledgement).toBeNull();
    expect(readLatestProductPublicationWarningAcknowledgement).toHaveBeenCalledTimes(1);
  },
);
it.each(["noWarnings", "hardError", "checksOnly", "overrideFalse"] as const)(
  "does not acquire or manufacture consent for %s",
  async (mode) => {
    const h = harness(mode),
      result = await h.store.execute(h.command);
    expect(readLatestProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
    if (result.validationReport.status !== "Recorded") throw Error("Missing report");
    expect(result.validationReport.report.validation.warningAcknowledgement).toBeNull();
    expect(result.publication.validationDecision).toBe(
      mode === "hardError"
        ? "HardError"
        : mode === "noWarnings"
          ? "ApprovalPending"
          : "WarningAcknowledgementRequired",
    );
  },
);
it("rejects even an apparently matching caller-supplied acknowledgement before the owning read", async () => {
  const h = harness("preAck");
  await expect(h.store.execute(h.command)).rejects.toEqual(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(readLatestProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
  expect(h.counts()).toEqual({ writes: 0, commits: 0 });
});
it("fails on a corrupt latest receipt instead of swallowing the error or falling back", async () => {
  const h = harness(),
    error = new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  vi.mocked(readLatestProductPublicationWarningAcknowledgement).mockRejectedValue(error);
  await expect(h.store.execute(h.command)).rejects.toEqual(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(readLatestProductPublicationWarningAcknowledgement).toHaveBeenCalledTimes(1);
  expect(h.counts()).toEqual({ writes: 0, commits: 0 });
});
it("retains the original minimum source lease across the actual receipt read await", async () => {
  const h = harness();
  vi.mocked(readLatestProductPublicationWarningAcknowledgement).mockImplementation(async () => {
    h.setTime(5000);
    return h.f.receipt;
  });
  await expect(h.store.execute(h.command)).rejects.toEqual(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );
  expect(h.counts()).toEqual({ writes: 0, commits: 0 });
});
it("uses detached detailed evidence captured before policy awaits", async () => {
  const h = harness();
  h.mutateAtPolicy();
  const result = await h.store.execute(h.command);
  expect(result.publication.validationDecision).toBe("ApprovalPending");
  if (
    result.validationReport.status !== "Recorded" ||
    result.validationReport.report.details.coverage !== "Complete"
  )
    throw Error("Missing complete report");
  expect(result.validationReport.report.details.sources[0]?.relevantReferenceDigest).toBe(
    h.f.bindingInput.details.sources[0]?.relevantReferenceDigest,
  );
});
it("exact original operation replay never reads a newer receipt or any fresh facts", async () => {
  const h = harness(),
    first = await h.store.execute(h.command);
  h.enableReplay(first);
  h.setTime(60000);
  vi.mocked(readLatestProductPublicationWarningAcknowledgement).mockClear();
  vi.mocked(h.source.withHeldCurrentFacts).mockClear();
  vi.mocked(h.source.withCurrentPolicy).mockClear();
  const result = await h.store.execute(h.command);
  expect(result).toEqual({ ...first, status: "Replayed" });
  expect(readLatestProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
  expect(h.source.withHeldCurrentFacts).not.toHaveBeenCalled();
  expect(h.source.withCurrentPolicy).not.toHaveBeenCalled();
  expect(h.editorModes).toEqual(["Read", "Publish", "Read", "Read"]);
});
it("completes V2 editor references inside the actual facts hold before writing", async () => {
  const h = harness("hardError");
  const result = await h.store.execute(h.command);
  expect(result.publication.validationDecision).toBe("HardError");
  expect(h.editorModes).toEqual(["Read", "Publish", "Read"]);
  expect(h.counts()).toEqual({ writes: 1, commits: 1 });
});
it("refuses missing complete editor reference proofs before any V2 revision write", async () => {
  const h = harness();
  h.refuseReferences();
  await expect(h.store.execute(h.command)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(h.editorModes).toEqual(["Read", "Publish"]);
  expect(h.source.withHeldCurrentFacts).toHaveBeenCalledTimes(1);
  expect(h.source.withCurrentPolicy).not.toHaveBeenCalled();
  expect(
    h.statements.some((sql) =>
      sql.startsWith("INSERT INTO rms_catalog.product_publication_revision"),
    ),
  ).toBe(false);
  expect(h.counts()).toEqual({ writes: 0, commits: 0 });
});
it.each(["stale", "checksOnly", "missing-baseline"] as const)(
  "requires Validate before SubmitReview with %s reference evidence, before policy or Ack reads",
  async (mode) => {
    const h = harness(mode === "missing-baseline" ? "normal" : mode, "SubmitReview");
    if (mode === "missing-baseline")
      vi.mocked(recoverProductPublicationValidationReport).mockResolvedValue({
        status: "NotRecorded",
        report: null,
      });
    await expect(h.store.execute(h.command)).rejects.toHaveProperty(
      "code",
      "CATALOG_LIFECYCLE_CONFLICT",
    );
    expect(recoverProductPublicationValidationReport).toHaveBeenCalledWith(
      expect.anything(),
      h.f.publication,
    );
    expect(h.source.withCurrentPolicy).not.toHaveBeenCalled();
    expect(readLatestProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
    expect(appendProductPublicationValidationReport).not.toHaveBeenCalled();
    expect(h.counts()).toEqual({ writes: 0, commits: 0 });
  },
);
it("does not renew current sources while recovering an expired historical baseline", async () => {
  const h = harness("normal", "SubmitReview");
  vi.mocked(recoverProductPublicationValidationReport).mockImplementation(async () => {
    h.setTime(5000);
    return { status: "Recorded", report: h.f.report };
  });
  await expect(h.store.execute(h.command)).rejects.toHaveProperty(
    "code",
    "CATALOG_DEPENDENCY_UNAVAILABLE",
  );
  expect(h.source.withCurrentPolicy).not.toHaveBeenCalled();
  expect(readLatestProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
  expect(h.counts()).toEqual({ writes: 0, commits: 0 });
});
it("replays an already committed SubmitReview without new continuity qualification", async () => {
  const h = harness("normal", "SubmitReview"),
    first = await h.store.execute(h.command);
  h.enableReplay(first);
  h.setTime(60000);
  vi.mocked(h.source.withHeldCurrentFacts).mockClear();
  vi.mocked(h.source.withCurrentPolicy).mockClear();
  vi.mocked(readLatestProductPublicationWarningAcknowledgement).mockClear();
  vi.mocked(recoverProductPublicationValidationReport).mockClear();
  expect(await h.store.execute(h.command)).toEqual({ ...first, status: "Replayed" });
  // Only the original committed result's report is recovered, never a baseline
  // for a new operation or any current source/approval/acknowledgement evidence.
  expect(recoverProductPublicationValidationReport).toHaveBeenCalledTimes(1);
  expect(recoverProductPublicationValidationReport).toHaveBeenCalledWith(
    expect.anything(),
    first.publication,
  );
  expect(h.source.withHeldCurrentFacts).not.toHaveBeenCalled();
  expect(h.source.withCurrentPolicy).not.toHaveBeenCalled();
  expect(readLatestProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
});
