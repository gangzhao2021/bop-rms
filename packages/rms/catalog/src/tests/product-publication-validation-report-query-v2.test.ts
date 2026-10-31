import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { describe, expect, it, vi } from "vitest";
import { buildCatalogProductEditorSnapshot } from "../contracts/product-editor-snapshot.js";
import {
  buildCatalogProductRetirementCoverage,
  catalogProductRetirementSourceHeadDigest,
} from "../contracts/product-publication-source-v2.js";
import { buildCatalogProductScopeRetirementHeader } from "../contracts/product-scope-retirement.js";
import {
  productPublicationCheckCodes,
  parseProductPublicationVersion,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import { buildCatalogProductPublicationValidationReport } from "../contracts/product-publication-validation-report.js";
import {
  buildCatalogProductPublicationValidationReportView as build,
  parseCatalogProductPublicationValidationReportView as parse,
  parseCatalogProductPublicationValidationReportReadRequest as request,
} from "../contracts/product-publication-validation-report-query-v2.js";

// Pure synthetic snapshots prove protocol binding, never current source authority.
const id = (n: number) => `01902421-0133-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-03T12:00:00.000Z",
  time = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture(mode: "recorded" | "empty" | "legacy" | "historical" | "changed" = "recorded") {
  const aggregate = {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_REPORT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: mode === "empty" ? 1 : 2,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic report" },
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
  const context = { tenantReference: id(1), brandReference: id(2), storeReference: id(20) };
  const editorRequest = {
    productReference: id(5),
    expectedAggregateVersion: aggregate.aggregateVersion,
  };
  const initialEditor = buildCatalogProductEditorSnapshot(
    aggregate,
    context,
    editorRequest,
    time(10000),
  );
  const none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const command = parseProductPublicationCommandV2({
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
    contentDigest: initialEditor.contentDigest,
    configurationDigest: initialEditor.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_REPORT",
    replacementIntent: { ...none, digest: hash(none) },
    replacementIntentDigest: hash(none),
  });
  const validation = parseProductPublicationValidationV2({
    profile: "CatalogProductPublicationValidationV2",
    evidenceReference: id(7),
    replacementIntentDigest: command.replacementIntentDigest,
    productAggregateVersion: 1,
    contentDigest: command.contentDigest,
    configurationDigest: command.configurationDigest,
    scopeDigest: hash(command.scopeSet),
    periodDigest: hash(command.effectivePeriod),
    policyReference: id(8),
    policyVersion: 1,
    approvalPolicy: "NotRequired",
    checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: time(5000),
  });
  const publication = planCatalogProductPublicationV2(command, null, {
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
  });
  const report = buildCatalogProductPublicationValidationReport({
    command,
    publication,
    validation,
    details: null,
    recordedAt: time(1),
  });
  const header = buildCatalogProductScopeRetirementHeader({
    publicationAction: "Validate",
    publication,
    previousPublication: null,
    observedSourceRevision: "1",
    observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
      ...contextWithoutStore(context),
      productReference: id(5),
      aggregateVersion: 1,
      sourceRevision: "1",
      latest: [],
    }),
  });
  const legacyRaw: Record<string, unknown> = { ...publication };
  delete legacyRaw.profile;
  delete legacyRaw.replacementIntent;
  delete legacyRaw.replacementIntentDigest;
  const selected = mode === "legacy" ? parseProductPublicationVersion(legacyRaw) : publication;
  if (mode === "historical") aggregate.draft.versionReference = id(99);
  if (mode === "changed") aggregate.draft.localizedNames["en-CA"] = "Changed saved content";
  const editor = buildCatalogProductEditorSnapshot(aggregate, context, editorRequest, time(10000));
  const coverage = buildCatalogProductRetirementCoverage({
    ...contextWithoutStore(context),
    productReference: id(5),
    aggregateVersion: aggregate.aggregateVersion,
    sourceRevision: "2",
    observedAt: time(10000),
    history: mode === "empty" ? [] : [{ publicationAction: "Validate", publication: selected }],
    headers: mode === "empty" || mode === "legacy" ? [] : [header],
  });
  return {
    request: {
      ...editorRequest,
      versionReference:
        mode === "empty" ? editor.aggregate.draft.versionReference : selected.versionReference,
      expectedPublicationVersion: mode === "empty" ? 0 : 1,
    },
    editor,
    coverage,
    reportCoverage:
      mode === "empty"
        ? null
        : mode === "legacy"
          ? { status: "NotRecorded", report: null }
          : { status: "Recorded", report },
    context,
    observedAt: time(10000),
    validUntil: time(15000),
  };
}
function contextWithoutStore(context: { tenantReference: string; brandReference: string }) {
  return { tenantReference: context.tenantReference, brandReference: context.brandReference };
}
function rehash(value: Record<string, unknown>) {
  const body = { ...value };
  delete body.digest;
  return { ...body, digest: hash(body) };
}

describe("closed ordinary publication report view", () => {
  it.each(["recorded", "empty", "legacy", "historical", "changed"] as const)(
    "binds actual %s state without requalifying historical checks",
    (mode) => {
      const f = fixture(mode),
        view = build(f);
      expect(parse(view)).toEqual(view);
      expect(view.status).toBe(
        mode === "empty" ? "NotValidated" : mode === "legacy" ? "NotRecorded" : "Recorded",
      );
      expect(view.applicability).toBe(
        mode === "empty"
          ? "NotValidated"
          : mode === "historical"
            ? "HistoricalVersion"
            : mode === "changed"
              ? "ChangedDraftContent"
              : "CurrentDraftContent",
      );
      expect(view.eligibility).toBe("NotEvaluated");
      if (view.report) {
        expect(view.report.validation.validUntil).toBe(time(5000));
        expect(view.report.recordedAt).toBe(time(1));
        expect(view.selectedPublicationDigest).toBe(view.report.publicationSnapshotDigest);
      }
      expect(Object.isFrozen(view)).toBe(true);
      expect(Object.isFrozen(view.currentDraft)).toBe(true);
    },
  );
  it.each(["owner", "root", "head", "unknown", "missing", "lease", "futureObservation"] as const)(
    "refuses %s mismatch",
    (kind) => {
      const f = fixture();
      if (kind === "owner") f.context.tenantReference = id(90);
      if (kind === "root") f.request.expectedAggregateVersion++;
      if (kind === "head") f.request.expectedPublicationVersion++;
      if (kind === "unknown") f.request.versionReference = id(90);
      if (kind === "missing") f.reportCoverage = null;
      if (kind === "lease") f.validUntil = time(15001);
      if (kind === "futureObservation") f.observedAt = time(9999);
      expect(() => build(f)).toThrow();
    },
  );
  it("only permits NotValidated for the actual unvalidated Draft", () => {
    const f = fixture("empty");
    f.request.versionReference = id(90);
    expect(() => build(f)).toThrow();
    const g = fixture("empty");
    g.request.expectedPublicationVersion = 1;
    expect(() => build(g)).toThrow();
  });
  it("requires actual known Draft content before claiming equal or changed", () => {
    const f = fixture(),
      aggregate = structuredClone(f.editor.aggregate) as unknown as {
        draft: Record<string, unknown>;
      };
    delete aggregate.draft.editorContent;
    const editor = buildCatalogProductEditorSnapshot(
      aggregate,
      f.context,
      {
        productReference: f.request.productReference,
        expectedAggregateVersion: f.request.expectedAggregateVersion,
      },
      f.observedAt,
    );
    expect(() => build({ ...f, editor })).toThrow();
  });
  it.each(["operation", "digest", "version", "root", "applicability"] as const)(
    "rejects rehashed envelope %s transplant",
    (kind) => {
      const view = build(fixture());
      const raw: Record<string, unknown> = { ...view };
      if (kind === "operation") raw.selectedPublicationOperationReference = id(90);
      if (kind === "digest") raw.selectedPublicationDigest = hash("other");
      if (kind === "version") raw.publicationVersion = 2;
      if (kind === "root") raw.aggregateVersion = 1;
      if (kind === "applicability") raw.applicability = "ChangedDraftContent";
      expect(() => parse(rehash(raw))).toThrow();
    },
  );
  it("does not invoke accessors, toJSON or hostile applicability coercion", () => {
    const view = build(fixture()),
      getter = vi.fn(),
      toString = vi.fn(() => "CurrentDraftContent");
    expect(() => parse({ ...view, applicability: { toString } })).toThrow();
    expect(toString).not.toHaveBeenCalled();
    const raw = { ...view };
    Object.defineProperty(raw, "report", { enumerable: true, get: getter });
    expect(() => parse(raw)).toThrow();
    expect(getter).not.toHaveBeenCalled();
    expect(() => parse({ ...view, toJSON: getter })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("captures a closed four-field request and rejects coercions/extra fields", () => {
    const f = fixture(),
      parsed = request(f.request);
    f.request.versionReference = id(90);
    expect(parsed.versionReference).toBe(id(6));
    expect(Object.isFrozen(parsed)).toBe(true);
    for (const value of [
      { ...parsed, extra: true },
      { ...parsed, expectedPublicationVersion: "1" },
      { ...parsed, expectedAggregateVersion: 0 },
      Object.create(parsed),
    ])
      expect(() => request(value)).toThrow();
  });
});
