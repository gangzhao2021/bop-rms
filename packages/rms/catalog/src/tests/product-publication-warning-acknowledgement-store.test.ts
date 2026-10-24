import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  canonicalizeRfc8785,
  sha256Hex,
  appendAuditRecordInTransaction,
  auditChainContent,
  AUDIT_CHAIN_VERSION,
  type AppendAuditRecordInput,
} from "@bop/audit";
import { appendEventInTransaction } from "@bop/eventing";
import { CatalogError, parseCatalogReference } from "../contracts/product.js";
import {
  buildCatalogProductEditorSnapshot,
  productEditorSnapshotFields,
} from "../contracts/product-editor-snapshot.js";
import {
  buildCatalogProductRetirementCoverage,
  catalogProductRetirementSourceHeadDigest,
} from "../contracts/product-publication-source-v2.js";
import { buildCatalogProductScopeRetirementHeader } from "../contracts/product-scope-retirement.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import {
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
} from "../contracts/product-publication-validation-report.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand as parseCommand,
  buildCatalogProductPublicationWarningAcknowledgementObservation as observe,
  buildCatalogProductPublicationWarningAcknowledgementReceipt as acknowledge,
} from "../contracts/product-publication-warning-acknowledgement.js";
import { createPostgresProductEditorSourceStore } from "../infrastructure/persistence/product-editor-source-store.js";
import {
  createPostgresProductPublicationSourceStoreV2,
  productPublicationSourceFieldsV2,
} from "../infrastructure/persistence/product-publication-source-store.js";
import { recoverProductPublicationValidationReport } from "../infrastructure/persistence/product-publication-validation-report-store.js";
import {
  recoverProductPublicationWarningAcknowledgement,
  appendProductPublicationWarningAcknowledgement,
} from "../infrastructure/persistence/product-publication-warning-acknowledgement-record.js";
import {
  createPostgresProductPublicationWarningAcknowledgementStore as create,
  productPublicationWarningAcknowledgementFields,
  type ProductPublicationWarningAcknowledgementStoreOptions as Options,
} from "../infrastructure/persistence/product-publication-warning-acknowledgement-store.js";
import type { ProductLifecycleTransaction as Tx } from "../infrastructure/persistence/product-lifecycle-store.js";
vi.mock("@bop/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: vi.fn(),
}));
vi.mock("@bop/eventing", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@bop/eventing")>()),
  appendEventInTransaction: vi.fn(),
}));
vi.mock("../infrastructure/persistence/product-editor-source-store.js", () => ({
  createPostgresProductEditorSourceStore: vi.fn(),
}));
vi.mock(
  "../infrastructure/persistence/product-publication-source-store.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("../infrastructure/persistence/product-publication-source-store.js")
    >()),
    createPostgresProductPublicationSourceStoreV2: vi.fn(),
  }),
);
vi.mock("../infrastructure/persistence/product-publication-validation-report-store.js", () => ({
  recoverProductPublicationValidationReport: vi.fn(),
}));
vi.mock(
  "../infrastructure/persistence/product-publication-warning-acknowledgement-record.js",
  () => ({
    recoverProductPublicationWarningAcknowledgement: vi.fn(),
    appendProductPublicationWarningAcknowledgement: vi.fn(),
  }),
);
const id = (n: number) => "01902491-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  humanUntil = "2026-10-03T14:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  time = (ms: number) => new Date(Date.parse(humanAt) + ms).toISOString();
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(humanAt) + 1000);
});
afterEach(() => vi.restoreAllMocks());
// Controlled held sources and append ports only. Actual SQL, RLS and durable
// Audit/Outbox rollback are exercised by the selected native owning-writer case.
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

function harness(replay = false) {
  const f = fixture(),
    statements: string[] = [],
    scope = { tenant_reference: "", brand_reference: "", store_reference: "" },
    guards: { asyncGuard: () => Promise<void>; finalAssert: () => void }[] = [];
  let ms = replay ? 10000 : 0,
    depth = 0,
    receiptWrites = 0,
    auditWrites = 0,
    eventWrites = 0,
    committed = 0,
    afterWork: (() => void) | undefined,
    afterAsync: (() => void) | undefined,
    finalFailure: unknown;
  const tx: Tx = {
    async query<Row>(sql: string, values: readonly unknown[]) {
      statements.push(sql);
      if (sql.includes("set_config('bop.tenant_id'")) {
        scope.tenant_reference = String(values[0]);
        scope.brand_reference = String(values[1]);
        scope.store_reference = sql.includes("set_config('bop.store_id',$3")
          ? String(values[2])
          : "";
      }
      return {
        rows: (sql.includes("transaction_isolation")
          ? [{ isolation: "read committed" }]
          : []) as unknown as readonly Row[],
        rowCount: 1,
      };
    },
  };
  const authority = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(
      async () => undefined,
    ),
    content = vi.fn<Options["contentAuthority"]["holdUntilTransactionCompletes"]>(
      async () => undefined,
    ),
    history = vi.fn<Options["historyAuthority"]["holdUntilTransactionCompletes"]>(
      async () => undefined,
    ),
    report = vi.fn<Options["reportAuthority"]["holdUntilTransactionCompletes"]>(
      async () => undefined,
    );
  const sources: Options["sources"] = {
    async withHeldCurrentObservation<T>(
      actual: Tx,
      input: Parameters<Options["sources"]["withHeldCurrentObservation"]>[1],
      work: (value: unknown) => Promise<T>,
    ) {
      expect(actual).toBe(tx);
      expect(input.command).toEqual(f.command);
      expect(input.aggregate).toEqual(f.editor.aggregate);
      expect(input.current).toEqual(f.publication);
      expect(input.report).toEqual(f.report);
      expect(input.validUntil).toBe(humanUntil);
      ms = 3;
      return work(f.receipt.observation);
    },
  };
  vi.spyOn(sources, "withHeldCurrentObservation");
  const options: Options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: {
      now() {
        return time(ms);
      },
    },
    authority: { holdUntilTransactionCompletes: authority },
    contentAuthority: { holdUntilTransactionCompletes: content },
    historyAuthority: { holdUntilTransactionCompletes: history },
    reportAuthority: { holdUntilTransactionCompletes: report },
    sources,
    audit: {
      create(receipt) {
        return {
          auditId: id(80),
          brandId: id(2),
          actor: { type: "User", reference: id(3) },
          actionCode: "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
          targetType: "Product",
          targetId: id(5),
          reasonCode: receipt.command.reasonCode,
          correlationId: id(81),
          occurredAt: receipt.recordedAt,
          sourceChannel: "WEB",
          dataClassification: "Internal",
          retentionPolicyCode: "SYNTHETIC",
          retentionPolicyVersion: 1,
        } satisfies AppendAuditRecordInput;
      },
    },
    async registerBeforeCommit(actual, asyncGuard, finalAssert) {
      expect(actual).toBe(tx);
      guards.push({ asyncGuard, finalAssert });
    },
    transactions: {
      async run<T>(work: (actual: Tx) => Promise<T>) {
        if (depth > 0) return work(tx);
        depth++;
        try {
          const result = await work(tx);
          afterWork?.();
          for (const g of guards) await g.asyncGuard();
          afterAsync?.();
          for (const g of guards) {
            try {
              expect(g.finalAssert()).toBeUndefined();
            } catch (e) {
              finalFailure = e;
              throw e;
            }
          }
          committed++;
          return result;
        } catch (e) {
          receiptWrites = 0;
          auditWrites = 0;
          eventWrites = 0;
          throw e;
        } finally {
          depth--;
        }
      },
    },
  };
  vi.mocked(createPostgresProductEditorSourceStore).mockImplementation((o) => ({
    context: {
      tenantReference: parseCatalogReference(id(1)),
      brandReference: parseCatalogReference(id(2)),
      actorReference: parseCatalogReference(id(3)),
      actorKind: "User",
    },
    async withCurrentSnapshot<T>(
      _request: unknown,
      work: (snapshot: typeof f.editor, actual: Tx) => Promise<T>,
    ) {
      return o.transactions.run(async (actual) => {
        await o.authority.holdUntilTransactionCompletes(actual, {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(3),
          actorKind: "User",
          productReference: id(5),
          purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
          permission: "catalog.manage",
          owningAction: "catalog.product.manage",
          requiredFields: productEditorSnapshotFields,
          observedAt: humanAt,
        });
        return work(f.editor, actual);
      });
    },
  }));
  vi.mocked(createPostgresProductPublicationSourceStoreV2).mockImplementation(
    (o) =>
      ({
        async withCurrentCoverage<T>(
          _request: unknown,
          work: (coverage: typeof f.coverage, actual: Tx) => Promise<T>,
        ) {
          return o.transactions.run(async (actual) => {
            await o.authority.holdUntilTransactionCompletes(actual, {
              tenantReference: id(1),
              brandReference: id(2),
              actorReference: id(3),
              actorKind: "User",
              productReference: id(5),
              purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
              permission: "catalog.manage",
              owningActions: ["catalog.product.history.read"],
              requiredFields: productPublicationSourceFieldsV2,
              observedAt: humanAt,
            });
            return work(f.coverage, actual);
          });
        },
      }) as ReturnType<typeof createPostgresProductPublicationSourceStoreV2>,
  );
  vi.mocked(recoverProductPublicationWarningAcknowledgement).mockResolvedValue(
    replay ? f.receipt : null,
  );
  vi.mocked(recoverProductPublicationValidationReport).mockResolvedValue({
    status: "Recorded",
    report: f.report,
  });
  vi.mocked(appendProductPublicationWarningAcknowledgement).mockImplementation(async () => {
    receiptWrites++;
  });
  vi.mocked(appendAuditRecordInTransaction).mockImplementation(async (_tx, input) => {
    auditWrites++;
    return {
      version: AUDIT_CHAIN_VERSION,
      sequence: 1,
      previousHash: null,
      recordHash: "a".repeat(64),
      recordedAt: time(ms),
      content: auditChainContent(input),
    };
  });
  vi.mocked(appendEventInTransaction).mockImplementation(async () => {
    eventWrites++;
    return undefined;
  });
  const store = create(options);
  return {
    f,
    store,
    options,
    tx,
    sources,
    authority,
    content,
    history,
    report,
    guards,
    statements,
    currentScope() {
      return { ...scope };
    },
    setTime(value: number) {
      ms = value;
    },
    afterWork(work: () => void) {
      afterWork = work;
    },
    afterAsync(work: () => void) {
      afterAsync = work;
    },
    counts() {
      return { receiptWrites, auditWrites, eventWrites, committed };
    },
    finalFailure() {
      return finalFailure;
    },
  };
}
const unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("restores validated Catalog Brand scope after an authority holds Store scope before append", async () => {
  const h = harness(),
    append = vi.mocked(appendProductPublicationWarningAcknowledgement).getMockImplementation();
  if (!append) throw Error("Missing controlled append");
  const changedScopes: ReturnType<typeof h.currentScope>[] = [];
  h.authority.mockImplementation(async (actual) => {
    await actual.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [id(1), id(2), id(90)],
    );
    changedScopes.push(h.currentScope());
  });
  vi.mocked(appendProductPublicationWarningAcknowledgement).mockImplementation(
    async (actual, input) => {
      expect(actual).toBe(h.tx);
      expect(h.currentScope()).toEqual({
        tenant_reference: id(1),
        brand_reference: id(2),
        store_reference: "",
      });
      const savepoint = h.statements.indexOf("SAVEPOINT catalog_product_warning_acknowledgement");
      expect(h.statements[savepoint - 1]).toBe(
        "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
      );
      await append(actual, input);
    },
  );
  expect((await h.store.execute(h.f.command)).status).toBe("Applied");
  expect(changedScopes.length).toBeGreaterThan(1);
  expect(changedScopes.every((scope) => scope.store_reference === id(90))).toBe(true);
  expect(h.counts()).toEqual({ receiptWrites: 1, auditWrites: 1, eventWrites: 1, committed: 1 });
});
it("does not restore scope into a write after the final prewrite authority denies", async () => {
  const h = harness(),
    denied = new CatalogError("CATALOG_PERMISSION_DENIED");
  let calls = 0;
  h.authority.mockImplementation(async (actual) => {
    await actual.query(
      "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
      [id(1), id(2), id(90)],
    );
    if (++calls === 2) throw denied;
  });
  await expect(h.store.execute(h.f.command)).rejects.toBe(denied);
  expect(h.sources.withHeldCurrentObservation).toHaveBeenCalledOnce();
  expect(h.statements).not.toContain(
    "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id','',true)",
  );
  expect(h.statements).not.toContain("SAVEPOINT catalog_product_warning_acknowledgement");
  expect(appendProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
  expect(h.counts()).toEqual({ receiptWrites: 0, auditWrites: 0, eventWrites: 0, committed: 0 });
});
it("atomically records the exact Actor acknowledgement and independent artifacts without changing Product root", async () => {
  const h = harness(),
    result = await h.store.execute(h.f.command);
  expect(result).toEqual({ status: "Applied", receipt: h.f.receipt });
  expect(h.counts()).toEqual({ receiptWrites: 1, auditWrites: 1, eventWrites: 1, committed: 1 });
  expect(h.statements.some((sql) => sql.includes("UPDATE rms_catalog.product"))).toBe(false);
  expect(h.statements.some((sql) => sql.includes("product_operation_record"))).toBe(false);
  expect(h.authority).toHaveBeenCalledWith(
    h.tx,
    expect.objectContaining({
      command: h.f.command,
      mode: "Acknowledge",
      requiredScope: "FullBrandScope",
      requiredFields: productPublicationWarningAcknowledgementFields,
      requiredPermissions: [
        "catalog.manage",
        "catalog.product.manage",
        "catalog.product.acknowledge-warnings",
        "catalog.product.read",
        "catalog.product.history.read",
      ],
      observedAt: humanAt,
    }),
  );
  expect(appendEventInTransaction).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      aggregateType: "ProductPublicationWarningAcknowledgement",
      aggregateId: h.f.command.operationReference,
      aggregateVersion: 1n,
    }),
  );
  expect(h.f.report.validation.warningAcknowledgement).toBeNull();
});
it("recovers the exact original before all mutable sources and performs zero new appends", async () => {
  const h = harness(true);
  expect(await h.store.execute(h.f.command)).toEqual({ status: "Replayed", receipt: h.f.receipt });
  expect(createPostgresProductEditorSourceStore).not.toHaveBeenCalled();
  expect(createPostgresProductPublicationSourceStoreV2).not.toHaveBeenCalled();
  expect(recoverProductPublicationValidationReport).not.toHaveBeenCalled();
  expect(h.sources.withHeldCurrentObservation).not.toHaveBeenCalled();
  expect(h.counts()).toEqual({ receiptWrites: 0, auditWrites: 0, eventWrites: 0, committed: 1 });
  expect(h.authority).toHaveBeenCalledWith(h.tx, expect.objectContaining({ mode: "Replay" }));
});
it("preserves replay idempotency conflict without reading current facts", async () => {
  const h = harness(true),
    conflict = new CatalogError("CATALOG_IDEMPOTENCY_CONFLICT");
  vi.mocked(recoverProductPublicationWarningAcknowledgement).mockRejectedValue(conflict);
  await expect(h.store.execute(h.f.command)).rejects.toBe(conflict);
  expect(h.sources.withHeldCurrentObservation).not.toHaveBeenCalled();
});
it("still rejects revoked current authority on original recovery", async () => {
  const h = harness(true),
    denied = new CatalogError("CATALOG_PERMISSION_DENIED");
  h.authority.mockRejectedValue(denied);
  await expect(h.store.execute(h.f.command)).rejects.toBe(denied);
  expect(recoverProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
});
it.each(["unknownReport", "differentRoot", "differentActor", "legacyAbsent"] as const)(
  "refuses %s before writes",
  async (kind) => {
    const h = harness();
    let command: unknown = h.f.command;
    if (kind === "unknownReport") command = { ...h.f.command, reportOperationReference: id(99) };
    if (kind === "differentRoot") command = { ...h.f.command, expectedProductAggregateVersion: 8 };
    if (kind === "differentActor") command = { ...h.f.command, actorReference: id(99) };
    if (kind === "legacyAbsent")
      vi.mocked(recoverProductPublicationValidationReport).mockResolvedValue({
        status: "NotRecorded",
        report: null,
      });
    await expect(h.store.execute(command)).rejects.toEqual(
      expect.objectContaining({
        code:
          kind === "differentActor"
            ? "CATALOG_PERMISSION_DENIED"
            : "CATALOG_DEPENDENCY_UNAVAILABLE",
      }),
    );
    expect(appendProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
    expect(h.counts().committed).toBe(0);
  },
);
it.each(["missing", "double", "wrongResult", "changedBinding"] as const)(
  "poisons %s producer callback instead of recording consent",
  async (kind) => {
    const h = harness();
    vi.mocked(h.sources.withHeldCurrentObservation).mockImplementation(
      async <T>(
        _tx: Tx,
        _input: Parameters<Options["sources"]["withHeldCurrentObservation"]>[1],
        work: (value: unknown) => Promise<T>,
      ) => {
        h.setTime(3);
        if (kind === "missing") return undefined as T;
        if (kind === "changedBinding")
          return work({ ...h.f.receipt.observation, digest: hash("tampered") });
        const result = await work(h.f.receipt.observation);
        if (kind === "double") await work(h.f.receipt.observation);
        return kind === "wrongResult" ? (undefined as T) : result;
      },
    );
    // Factory captures ports, so construct after installing this controlled source.
    const store = create(h.options);
    await expect(store.execute(h.f.command)).rejects.toEqual(unavailable);
    expect(h.counts()).toEqual({ receiptWrites: 0, auditWrites: 0, eventWrites: 0, committed: 0 });
  },
);
it("rolls back tentative receipt/audit when Outbox append fails", async () => {
  const h = harness();
  let tentative = false;
  vi.mocked(appendEventInTransaction).mockImplementation(async () => {
    tentative = h.counts().receiptWrites === 1 && h.counts().auditWrites === 1;
    throw Error("synthetic outbox fault");
  });
  await expect(h.store.execute(h.f.command)).rejects.toEqual(unavailable);
  expect(tentative).toBe(true);
  expect(h.statements).toContain("ROLLBACK TO SAVEPOINT catalog_product_warning_acknowledgement");
  expect(h.counts().committed).toBe(0);
});
it("rolls back the written receipt on late authority denial", async () => {
  const h = harness(),
    denied = new CatalogError("CATALOG_PERMISSION_DENIED");
  let tentative = false;
  h.afterWork(() => {
    tentative = h.counts().receiptWrites === 1;
    h.authority.mockRejectedValue(denied);
  });
  await expect(h.store.execute(h.f.command)).rejects.toBe(denied);
  expect(tentative).toBe(true);
  expect(h.counts()).toEqual({ receiptWrites: 0, auditWrites: 0, eventWrites: 0, committed: 0 });
});
it("preserves original final error and rolls back after later async guard consumes the five-second lease", async () => {
  const h = harness();
  let tentative = false,
    received: unknown;
  h.afterAsync(() => {
    tentative = h.counts().receiptWrites === 1;
    h.setTime(5000);
  });
  try {
    await h.store.execute(h.f.command);
  } catch (e) {
    received = e;
  }
  expect(tentative).toBe(true);
  expect(received).toEqual(unavailable);
  expect(received).toBe(h.finalFailure());
  expect(h.counts().committed).toBe(0);
});
it("rejects a partial backwards clock after the source observed a larger instant", async () => {
  const h = harness();
  vi.mocked(appendProductPublicationWarningAcknowledgement).mockImplementation(async () => {
    h.setTime(2);
  });
  await expect(h.store.execute(h.f.command)).rejects.toEqual(unavailable);
  expect(h.counts().committed).toBe(0);
});
it("poisons an outer transaction after caught reentry from the held producer", async () => {
  const h = harness();
  let innerCalls = 0;
  vi.mocked(h.sources.withHeldCurrentObservation).mockImplementation(
    async <T>(
      _tx: Tx,
      _input: Parameters<Options["sources"]["withHeldCurrentObservation"]>[1],
      work: (value: unknown) => Promise<T>,
    ) => {
      innerCalls++;
      await expect(h.store.execute(h.f.command)).rejects.toEqual(unavailable);
      h.setTime(3);
      return work(h.f.receipt.observation);
    },
  );
  await expect(h.store.execute(h.f.command)).rejects.toEqual(unavailable);
  expect(innerCalls).toBe(1);
  expect(h.counts().committed).toBe(0);
});
it("registers transaction poison before malformed input or initial authority refusal", async () => {
  for (const denied of [false, true]) {
    const h = harness();
    if (denied) h.authority.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await expect(
      h.options.transactions.run(async () => {
        try {
          await h.store.execute(denied ? h.f.command : { ...h.f.command, extra: true });
        } catch {
          return "caught";
        }
      }),
    ).rejects.toEqual(unavailable);
    expect(h.guards).toHaveLength(1);
    expect(h.counts().committed).toBe(0);
  }
});
it("captures source, clock and authority receivers before caller changes configuration", async () => {
  const h = harness(),
    poison = vi.fn(async () => {
      throw Error("replacement");
    });
  h.options.sources.withHeldCurrentObservation = poison;
  h.options.authority.holdUntilTransactionCompletes = poison;
  h.options.clock.now = () => {
    throw Error("replacement");
  };
  expect((await h.store.execute(h.f.command)).status).toBe("Applied");
  expect(poison).not.toHaveBeenCalled();
});
it("rejects a replaced query port after actual tentative append", async () => {
  const h = harness();
  vi.mocked(appendProductPublicationWarningAcknowledgement).mockImplementation(async () => {
    h.tx.query = async <Row>() => ({ rows: [] as readonly Row[], rowCount: 0 });
  });
  await expect(h.store.execute(h.f.command)).rejects.toEqual(unavailable);
  expect(h.counts().committed).toBe(0);
});
it("binds the fresh policy to the actual latest workflow head as well as the displayed report", async () => {
  const h = harness();
  const factory = vi.mocked(createPostgresProductPublicationSourceStoreV2),
    original = factory.getMockImplementation();
  if (!original) throw Error("Expected controlled history factory");
  factory.mockImplementation((o) => {
    const source = original(o);
    return {
      ...source,
      withCurrentCoverage: async <T>(
        request: unknown,
        work: (coverage: typeof h.f.coverage, actual: Tx) => Promise<T>,
      ) =>
        source.withCurrentCoverage(request, (coverage, actual) =>
          work({ ...coverage, latest: [{ ...h.f.publication, policyReference: id(99) }] }, actual),
        ),
    };
  });
  await expect(h.store.execute(h.f.command)).rejects.toEqual(unavailable);
  expect(appendProductPublicationWarningAcknowledgement).not.toHaveBeenCalled();
});
