import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import {
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
} from "../contracts/product-publication-validation-report.js";
import {
  assertCatalogProductPublicationReferenceContinuity as assertContinuity,
  productPublicationReferenceBaselineActions,
} from "../contracts/product-publication-reference-continuity.js";

// Pure synthetic complete evidence tests reference continuity only. Passing this
// guard neither supplies current source authority nor approves a lifecycle action.
const id = (n: number) => "019a2421-0016-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  fresh = "2026-10-03T14:00:00.000Z",
  end = "2026-10-03T14:00:05.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value)),
  conflict = expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
  unavailable = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
function command() {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    start = "2026-10-04T12:00:00.000Z";
  return parseProductPublicationCommandV2({
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
    contentDigest: hash("content"),
    configurationDigest: hash("configuration"),
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: { instant: start, localDateTime: start.slice(0, -1), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    replacementIntent: { ...body, digest: hash(body) },
    replacementIntentDigest: hash(body),
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_CONTINUITY",
  });
}
function recorded(
  c = command(),
  previous: ProductPublicationVersionV2 | null = null,
  hard = false,
) {
  const until = new Date(Date.parse(c.occurredAt) + 5000).toISOString(),
    validation = parseProductPublicationValidationV2({
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: c.replacementIntentDigest,
      evidenceReference: id(100 + c.expectedProductAggregateVersion),
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          hard && (code === "InternalCode" || code === "HardErrorsCleared") ? "HardError" : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: c.occurredAt,
      validUntil: until,
    }),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: hard
        ? [
            {
              checkCode: "InternalCode",
              outcome: "HardError",
              ruleCode: "SYNTHETIC_INTERNAL_CODE",
              subjectReference: id(5),
              reasonCode: "SYNTHETIC_DUPLICATE",
              references: [],
            },
          ]
        : [],
      sources: ["MENU", "PRICING"].map((sourceCode) => ({
        sourceCode,
        sourceDigest: hash([sourceCode, "original request"]),
        generation: "1",
        relevantReferenceDigest: hash([sourceCode, "original relevant references"]),
        observedAt: c.occurredAt,
        validUntil: until,
      })),
    }),
    publication = planCatalogProductPublicationV2(c, previous, {
      now: c.occurredAt,
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: validation.scopeDigest,
      periodDigest: validation.periodDigest,
      validation,
      approval: null,
      reviewReference: c.action === "SubmitReview" ? id(9) : null,
      replacement: null,
    });
  if (details.coverage !== "Complete") throw Error("Missing synthetic complete details");
  return {
    command: c,
    publication,
    validation,
    details,
    report: buildCatalogProductPublicationValidationReport({
      command: c,
      publication,
      validation,
      details,
      recordedAt: c.occurredAt,
    }),
  };
}
function next(
  c: ProductPublicationCommandV2,
  current: ProductPublicationVersionV2,
  action: ProductPublicationCommandV2["action"],
) {
  return parseProductPublicationCommandV2({
    ...c,
    operationReference: id(20 + current.publicationVersion),
    action,
    actorReference: action === "Reject" ? id(99) : c.actorReference,
    actorKind: action === "ActivateScheduled" ? "System" : "User",
    expectedProductAggregateVersion: current.productAggregateVersion + 1,
    expectedPublicationVersion: current.publicationVersion,
    occurredAt: new Date(Date.parse(current.occurredAt) + 1).toISOString(),
    scheduleReference: [
      "SchedulePublish",
      "ReschedulePublish",
      "CancelScheduledPublish",
      "ActivateScheduled",
    ].includes(action)
      ? id(10)
      : null,
    successorDraftVersionReference:
      action === "Publish" || action === "ActivateScheduled" ? id(50) : null,
  });
}
function fixture(
  baseline = recorded(),
  action: (typeof productPublicationReferenceBaselineActions)[number] = "SubmitReview",
) {
  const c = parseProductPublicationCommandV2({
    ...next(baseline.command, baseline.publication, action),
    occurredAt: fresh,
    actorKind: action === "ActivateScheduled" ? "System" : "User",
    successorDraftVersionReference:
      action === "Publish" || action === "ActivateScheduled" ? id(50) : null,
  });
  return {
    command: c,
    current: baseline.publication,
    report: baseline.report,
    validation: {
      ...baseline.validation,
      productAggregateVersion: c.expectedProductAggregateVersion,
      evidenceReference: id(60),
      checkedAt: fresh,
      validUntil: end,
    },
    details: {
      ...baseline.details,
      sources: baseline.details.sources
        .map((source) => ({
          ...source,
          generation: "900",
          sourceDigest: hash([source.sourceCode, "new unrelated generation/request"]),
          observedAt: "2026-10-03T14:00:00.001Z",
          validUntil: end,
        }))
        .reverse(),
    },
    observedAt: fresh,
    now: "2026-10-03T14:00:00.002Z",
  };
}
it.each(productPublicationReferenceBaselineActions)(
  "compares only relevant reference identity for %s, retaining expired historical evidence",
  (action) => {
    const input = fixture(undefined, action);
    expect(input.report.validation.validUntil < input.observedAt).toBe(true);
    expect(assertContinuity(input)).toBe(end);
  },
);
it.each(["changed", "missing", "added"])(
  "requires Validate after a %s semantic source set",
  (change) => {
    const input = fixture(),
      sources = input.details.sources;
    const changed =
      change === "missing"
        ? sources.slice(1)
        : change === "added"
          ? [...sources, { ...sources[0], sourceCode: "INVENTORY" }]
          : sources.map((source, i) =>
              i === 0
                ? { ...source, relevantReferenceDigest: hash("changed owner reference") }
                : source,
            );
    expect(() =>
      assertContinuity({ ...input, details: { ...input.details, sources: changed } }),
    ).toThrow(conflict);
  },
);
it.each(["missing-report", "checks-only-report", "missing-details", "checks-only-details"])(
  "cannot use %s as a Complete baseline",
  (mode) => {
    const baseline = recorded(),
      input = fixture(baseline);
    const checksOnly = buildCatalogProductPublicationValidationReport({
      command: baseline.command,
      publication: baseline.publication,
      validation: baseline.validation,
      details: null,
      recordedAt: at,
    });
    expect(() =>
      assertContinuity({
        ...input,
        report:
          mode === "missing-report"
            ? null
            : mode === "checks-only-report"
              ? checksOnly
              : input.report,
        details:
          mode === "missing-details"
            ? null
            : mode === "checks-only-details"
              ? { coverage: "ChecksOnly", impact: "NotRecorded" }
              : input.details,
      }),
    ).toThrow(conflict);
  },
);
it("rejects a valid report belonging to another exact head", () => {
  const input = fixture(),
    different = recorded({ ...command(), operationReference: id(90) });
  expect(() => assertContinuity({ ...input, report: different.report })).toThrow();
});
it("requires the current head's source root to precede the incoming actual root", () => {
  const input = fixture(),
    root = input.current.productAggregateVersion;
  expect(() =>
    assertContinuity({
      ...input,
      command: { ...input.command, expectedProductAggregateVersion: root },
      validation: { ...input.validation, productAggregateVersion: root },
    }),
  ).toThrow(conflict);
});
it.each(["contentDigest", "configurationDigest", "replacementIntentDigest"])(
  "does not let unchanged references replace the current %s binding",
  (field) => {
    const input = fixture();
    expect(() =>
      assertContinuity({ ...input, command: { ...input.command, [field]: hash("different") } }),
    ).toThrow();
  },
);
it("does not clear a prior technical HardError merely because current checks turn Pass", () => {
  const input = fixture(recorded(command(), null, true)),
    clean = fixture();
  expect(() =>
    assertContinuity({ ...input, validation: clean.validation, details: clean.details }),
  ).toThrow(conflict);
});
it.each(["Reject", "CancelScheduledPublish"] as const)(
  "requires fresh Validate after %s rather than adopting withdrawal references",
  (action) => {
    const initial = recorded(),
      review = recorded(
        next(initial.command, initial.publication, "SubmitReview"),
        initial.publication,
      ),
      parent =
        action === "Reject"
          ? review
          : recorded(
              next(review.command, review.publication, "SchedulePublish"),
              review.publication,
            ),
      withdrawal = recorded(next(parent.command, parent.publication, action), parent.publication);
    expect(() => assertContinuity(fixture(withdrawal))).toThrow(conflict);
    const validated = recorded(
      next(withdrawal.command, withdrawal.publication, "Validate"),
      withdrawal.publication,
    );
    expect(assertContinuity(fixture(validated))).toBe(end);
  },
);
it.each(["future-source", "expired", "short-source", "clock-backwards", "outer-expired"])(
  "refuses current %s without applying historical source deadlines",
  (mode) => {
    const input = fixture();
    const now = mode === "clock-backwards" ? at : mode === "outer-expired" ? end : input.now;
    expect(() =>
      assertContinuity({
        ...input,
        now,
        details: {
          ...input.details,
          sources: input.details.sources.map((s) => ({
            ...s,
            observedAt: mode === "future-source" ? "2026-10-03T14:00:01.000Z" : s.observedAt,
            validUntil:
              mode === "expired"
                ? input.now
                : mode === "short-source"
                  ? "2026-10-03T14:00:04.000Z"
                  : s.validUntil,
          })),
        },
      }),
    ).toThrow(unavailable);
  },
);
it("returns the unchanged shorter current deadline", () => {
  const input = fixture(),
    shortened = "2026-10-03T14:00:04.000Z";
  expect(
    assertContinuity({
      ...input,
      validation: { ...input.validation, validUntil: shortened },
      details: {
        ...input.details,
        sources: input.details.sources.map((s) => ({ ...s, validUntil: shortened })),
      },
    }),
  ).toBe(shortened);
});
