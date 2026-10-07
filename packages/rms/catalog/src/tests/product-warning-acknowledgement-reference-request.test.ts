import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import { buildCatalogProductPublicationValidationReport } from "../contracts/product-publication-validation-report.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
import {
  buildCatalogProductWarningAcknowledgementReferenceRequest as build,
  parseCatalogProductWarningAcknowledgementReferenceRequest as parse,
  bindCatalogProductWarningAcknowledgementReferenceRequestToCurrent as bind,
} from "../contracts/product-warning-acknowledgement-reference-request.js";
const id = (n: number) => "01902500-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  humanAt = "2026-10-03T13:00:00.000Z",
  plus = (ms: number) => new Date(Date.parse(humanAt) + ms).toISOString(),
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
// Synthetic facts prove request binding, not publication permission/qualification.
function fixture(exact = false) {
  const original = parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "ACK_REFERENCES",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
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
  });
  const identity = deriveCatalogProductPublicationContentIdentity(original),
    selector = { level: "Store", reference: id(30), channelCodes: [], orderTypeCodes: [] };
  const body = exact
    ? {
        profile: "CatalogProductExactStoreSelectorReplacementV1",
        mode: "PermanentSelectorRetirement",
        previousVersionReference: id(40),
        previousPublicationOperationReference: id(41),
        expectedPreviousPublicationVersion: 2,
        previousIntentDigest: hash("old intent"),
        previousScopeDigest: hash([selector]),
        previousPeriodDigest: hash("old period"),
        previousSelectorIndex: 0,
        previousSelectorDigest: hash(selector),
      }
    : { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const publicationCommand = parseProductPublicationCommandV2({
    profile: "CatalogProductPublicationCommandV2",
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(8),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [selector],
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
    replacementIntent: { ...body, digest: hash(body) },
    replacementIntentDigest: hash(body),
  });
  const validation = {
    profile: "CatalogProductPublicationValidationV2" as const,
    replacementIntentDigest: publicationCommand.replacementIntentDigest,
    evidenceReference: id(20),
    productAggregateVersion: 1,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeDigest: hash(publicationCommand.scopeSet),
    periodDigest: hash(publicationCommand.effectivePeriod),
    policyReference: id(21),
    policyVersion: 1,
    approvalPolicy: "Required" as const,
    checks: productPublicationCheckCodes.map((code) => ({
      code,
      outcome:
        code === "ApprovalPolicy"
          ? ("Pending" as const)
          : code === "ChangeImpact"
            ? ("Warning" as const)
            : ("Pass" as const),
    })),
    warningAcknowledgement: null,
    checkedAt: at,
    validUntil: "2026-10-03T12:00:05.000Z",
  };
  const current = planCatalogProductPublicationV2(publicationCommand, null, {
    now: at,
    productAggregateVersion: 1,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeDigest: validation.scopeDigest,
    periodDigest: validation.periodDigest,
    validation,
    approval: null,
    reviewReference: null,
    replacement: null,
  });
  const report = buildCatalogProductPublicationValidationReport({
    command: publicationCommand,
    publication: current,
    validation,
    recordedAt: at,
    details: {
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_REFERENCE",
          outcome: "Warning",
          subjectReference: id(5),
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC",
          sourceDigest: hash("source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant"),
          observedAt: at,
          validUntil: validation.validUntil,
        },
      ],
    },
  });
  const aggregate = parseProductAggregate({ ...original, aggregateVersion: 2 });
  const command = parseCatalogProductPublicationWarningAcknowledgementCommand({
    profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
    action: "AcknowledgeProductPublicationWarnings",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(9),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 2,
    reportOperationReference: report.operationReference,
    reportDigest: report.digest,
    warningBindingDigest: report.warningBindingDigest,
    warningCodes: ["ChangeImpact"],
    reasonCode: "EXPLICIT_REVIEW",
    occurredAt: humanAt,
  });
  const input = {
    command,
    aggregate,
    current,
    report,
    observedAt: humanAt,
    validUntil: plus(1000),
  };
  return { ...input, input, request: build(input), publicationCommand, identity };
}

import { parseCatalogProductPublicationReferenceRequestV2 } from "../contracts/product-publication-reference-request-v2.js";
it.each([false, true])(
  "keeps actual Ack command and original report-bound None/Exact=%s semantics",
  (exact) => {
    const f = fixture(exact);
    const request = parse(f.request);
    expect(request.command).toEqual(f.command);
    expect(request.originalIntentDigest).toBe(hash(f.command));
    expect(request.aggregateSnapshotDigest).toBe(hash(f.aggregate));
    expect(request.currentPublicationDigest).toBe(hash(f.current));
    expect(request.replacementIntentDigest).toBe(f.current.replacementIntentDigest);
    expect(f.report.validation.validUntil < request.observedAt).toBe(true);
    expect(bind(request, f.aggregate, f.current)).toEqual(request);
    expect(Object.isFrozen(request.command)).toBe(true);
    expect(() => parseCatalogProductPublicationReferenceRequestV2(request)).toThrow();
    expect(() => parse({ ...request, command: f.publicationCommand })).toThrow();
  },
);
it.each([
  "originalIntentDigest",
  "aggregateSnapshotDigest",
  "currentPublicationDigest",
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "replacementIntentDigest",
  "policyReference",
  "policyVersion",
  "publicationVersion",
] as const)("actual current binder rejects transplanted %s", (field) => {
  const f = fixture();
  const altered = {
    ...f.request,
    [field]:
      field === "policyReference" ? id(90) : field.endsWith("Version") ? 2 : hash("transplant"),
  };
  expect(() => bind(altered, f.aggregate, f.current)).toThrow();
});
it.each([
  "reportDigest",
  "warningBindingDigest",
  "reportOperationReference",
  "expectedProductAggregateVersion",
  "actorKind",
  "purposeCode",
])("refuses malformed/transplanted Ack %s before request production", (field) => {
  const f = fixture(),
    value =
      field === "expectedProductAggregateVersion"
        ? 3
        : field === "actorKind"
          ? "System"
          : field === "purposeCode"
            ? "CATALOG_PRODUCT_VERSION_PUBLICATION"
            : field === "reportOperationReference"
              ? id(91)
              : hash("foreign");
  expect(() => build({ ...f.input, command: { ...f.command, [field]: value } })).toThrow();
});
it.each([0, -1, 5001])("rejects exclusive original lease offset %s", (offset) => {
  const f = fixture();
  expect(() => build({ ...f.input, validUntil: plus(offset) })).toThrow();
});
it("rejects missing heads, foreign owners and changed complete saved content", () => {
  const f = fixture();
  expect(() => bind(f.request, f.aggregate, null)).toThrow();
  expect(() => bind(f.request, { ...f.aggregate, brandReference: id(90) }, f.current)).toThrow();
  expect(() =>
    bind(
      f.request,
      { ...f.aggregate, draft: { ...f.aggregate.draft, localizedNames: { "en-CA": "Changed" } } },
      f.current,
    ),
  ).toThrow();
});
it("detaches fields and refuses hostile accessors/extra fields without execution", () => {
  const f = fixture(),
    raw = structuredClone(f.request),
    getter = vi.fn(() => f.command);
  expect(() =>
    parse(Object.defineProperty({ ...raw }, "command", { enumerable: true, get: getter })),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() => parse({ ...raw, assertedRegistered: true })).toThrow();
  expect(() => parse(Object.assign(Object.create({}), raw))).toThrow();
  const parsed = parse(raw);
  Object.assign(raw.command, { reasonCode: "OTHER_REASON" });
  expect(parsed.command.reasonCode).toBe("EXPLICIT_REVIEW");
});
