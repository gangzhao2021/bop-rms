import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  planCatalogProductPublicationV2,
} from "../contracts/product-publication-v2.js";
import {
  buildCatalogProductPublicationValidationReport as build,
  parseCatalogProductPublicationValidationReport as parse,
  bindCatalogProductPublicationValidationReportToPublication as bind,
  parseCatalogProductPublicationValidationDetails as parseDetails,
  calculateCatalogProductPublicationWarningBindingDigest as fingerprint,
} from "../contracts/product-publication-validation-report.js";

// Synthetic pure facts: these tests establish report integrity, not actual source
// completeness, current authority, reference severity policy or sale eligibility.
const id = (n: number) => "01902490-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture(hard = false) {
  const intent = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
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
      replacementIntentDigest: command.replacementIntentDigest,
      evidenceReference: id(7),
      productAggregateVersion: 1,
      contentDigest: command.contentDigest,
      configurationDigest: command.configurationDigest,
      scopeDigest: hash(command.scopeSet),
      periodDigest: hash(command.effectivePeriod),
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "Required",
      checks: productPublicationCheckCodes.map((code) => ({
        code,
        outcome:
          code === "ApprovalPolicy"
            ? "Pending"
            : code === "ChangeImpact"
              ? hard
                ? "HardError"
                : "Warning"
              : hard && code === "HardErrorsCleared"
                ? "HardError"
                : "Pass",
      })),
      warningAcknowledgement: null,
      checkedAt: at,
      validUntil: until,
    }),
    publication = planCatalogProductPublicationV2(command, null, {
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
    }),
    details = parseDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SKU-008",
          outcome: hard ? "HardError" : "Warning",
          subjectReference: id(20),
          reasonCode: "SYNTHETIC_REFERENCE_GAP",
          references: [
            {
              sourceCode: "PRICING",
              resourceReference: id(21),
              versionReference: id(22),
              referenceDigest: hash("reference"),
            },
          ],
        },
      ],
      sources: [
        {
          sourceCode: "PRICING",
          sourceDigest: hash("held request and source"),
          generation: "4",
          relevantReferenceDigest: hash("relevant references"),
          observedAt: at,
          validUntil: until,
        },
      ],
    });
  if (details.coverage !== "Complete") throw new Error("Missing complete synthetic details");
  return { command, publication, validation, details, recordedAt: at };
}
function required<T>(v: T | undefined): T {
  if (v === undefined) throw new Error("Missing synthetic value");
  return v;
}

it("records all actual final checks and explicitly incomplete impact without inventing findings", () => {
  const f = fixture(true),
    report = build({ ...f, details: null });
  expect(report.validation).toEqual(f.validation);
  expect(report.validation.checks).toHaveLength(12);
  expect(report.details).toEqual({ coverage: "ChecksOnly", impact: "NotRecorded" });
  expect(report.warningBindingDigest).toBeNull();
  expect(report.publicationSnapshotDigest).toBe(hash(f.publication));
  expect(report.originalIntentDigest).toBe(hash(f.command));
  expect(bind(report, f.publication)).toEqual(report);
});

it("records supplied complete findings, with stable semantic binding and read-only copies", () => {
  const f = fixture(),
    rawChecks = f.validation.checks.map((c) => ({ ...c })),
    report = build({ ...f, validation: { ...f.validation, checks: rawChecks } });
  rawChecks[0] = { code: "ApprovalPolicy", outcome: "Pass" };
  expect(report.validation).toEqual(f.validation);
  expect(Object.isFrozen(report)).toBe(true);
  expect(Object.isFrozen(report.validation.checks)).toBe(true);
  expect(report.warningBindingDigest).toBe(fingerprint(report.binding, f.validation, f.details));
  expect(parse(report)).toEqual(report);
});

it("accepts actual completion after the command, initial validation and staggered source reads", () => {
  const f = fixture();
  if (f.details.coverage !== "Complete") throw new Error("Missing complete synthetic details");
  const validation = { ...f.validation, checkedAt: "2026-10-03T12:00:00.100Z" },
    details = {
      ...f.details,
      sources: f.details.sources.map((s) => ({ ...s, observedAt: "2026-10-03T12:00:00.200Z" })),
    },
    report = build({ ...f, validation, details, recordedAt: "2026-10-03T12:00:00.300Z" });
  expect(report.recordedAt).toBe("2026-10-03T12:00:00.300Z");
  expect(report.validation.checkedAt).toBe(validation.checkedAt);
  expect(f.publication.occurredAt).toBe(at);
  // Historical replay binds original immutable bytes, without today's clock.
  expect(bind(JSON.parse(JSON.stringify(report)), f.publication)).toEqual(report);
  expect(() =>
    build({ ...f, validation, details, recordedAt: "2026-10-03T12:00:00.150Z" }),
  ).toThrow();
  expect(() => build({ ...f, recordedAt: until })).toThrow();
});

it("does not refresh an original shorter source lease", () => {
  const f = fixture();
  if (f.details.coverage !== "Complete") throw new Error("Missing synthetic details");
  expect(() =>
    build({
      ...f,
      details: {
        ...f.details,
        sources: f.details.sources.map((s) => ({ ...s, validUntil: "2026-10-03T12:00:04.000Z" })),
      },
    }),
  ).toThrow();
  expect(() =>
    parseDetails({
      ...f.details,
      sources: f.details.sources.map((s) => ({ ...s, validUntil: "2026-10-03T12:00:05.001Z" })),
    }),
  ).toThrow();
});

it("keeps workflow root, evidence, approval promotion and coarse source generation out of consent identity", () => {
  const f = fixture(),
    report = build(f);
  if (f.details.coverage !== "Complete") throw new Error("Missing synthetic details");
  const validation = {
      ...f.validation,
      productAggregateVersion: 10,
      evidenceReference: id(80),
      checks: f.validation.checks.map((c) =>
        c.code === "ApprovalPolicy" ? { ...c, outcome: "Pass" } : c,
      ),
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "ACTUAL_CONFIRMATION",
        warningCodes: ["ChangeImpact"],
      },
      checkedAt: "2026-10-03T14:00:00.000Z",
      validUntil: "2026-10-03T14:00:05.000Z",
    },
    details = {
      ...f.details,
      sources: f.details.sources.map((s) => ({
        ...s,
        generation: "99",
        sourceDigest: hash("new full bound observation"),
        observedAt: validation.checkedAt,
        validUntil: validation.validUntil,
      })),
    };
  expect(fingerprint(report.binding, validation, details)).toBe(report.warningBindingDigest);
  const changedReport = build({
    ...f,
    details: {
      ...f.details,
      sources: f.details.sources.map((s) => ({
        ...s,
        generation: "5",
        sourceDigest: hash("new source"),
      })),
    },
  });
  expect(changedReport.warningBindingDigest).toBe(report.warningBindingDigest);
  expect(changedReport.digest).not.toBe(report.digest);
});

it.each([
  "contentDigest",
  "configurationDigest",
  "scopeDigest",
  "periodDigest",
  "replacementIntentDigest",
] as const)("invalidates consent when semantic %s changes", (field) => {
  const f = fixture(),
    report = build(f),
    changed = hash(field);
  expect(
    fingerprint(
      { ...report.binding, [field]: changed },
      { ...f.validation, [field]: changed },
      f.details,
    ),
  ).not.toBe(report.warningBindingDigest);
});

it("invalidates consent for policy, finding or relevant reference changes", () => {
  const f = fixture(),
    report = build(f);
  if (f.details.coverage !== "Complete") throw new Error("Missing synthetic details");
  expect(
    fingerprint(
      { ...report.binding, policyVersion: 2 },
      { ...f.validation, policyVersion: 2 },
      f.details,
    ),
  ).not.toBe(report.warningBindingDigest);
  expect(
    fingerprint(report.binding, f.validation, {
      ...f.details,
      findings: f.details.findings.map((v) => ({ ...v, reasonCode: "DIFFERENT_FINDING" })),
    }),
  ).not.toBe(report.warningBindingDigest);
  expect(
    fingerprint(report.binding, f.validation, {
      ...f.details,
      sources: f.details.sources.map((v) => ({
        ...v,
        relevantReferenceDigest: hash("changed relevant source"),
      })),
    }),
  ).not.toBe(report.warningBindingDigest);
});

it("rejects incomplete, contradictory or unbound detailed findings instead of deriving them", () => {
  const f = fixture();
  if (f.details.coverage !== "Complete") throw new Error("Missing synthetic details");
  expect(() => build({ ...f, details: { ...f.details, findings: [] } })).toThrow();
  expect(() =>
    build({
      ...f,
      details: {
        ...f.details,
        findings: f.details.findings.map((v) => ({ ...v, outcome: "HardError" })),
      },
    }),
  ).toThrow();
  expect(() => parseDetails({ ...f.details, sources: [] })).toThrow();
  expect(() =>
    parseDetails({
      ...f.details,
      sources: [required(f.details.sources[0]), required(f.details.sources[0])],
    }),
  ).toThrow();
  expect(() =>
    parseDetails({
      ...f.details,
      sources: f.details.sources.map((v) => ({ ...v, sourceCode: "UNRELATED" })),
    }),
  ).toThrow();
});

it("rejects altered reports and different immutable revisions, even if their owner tuple matches", () => {
  const f = fixture(),
    report = build(f);
  expect(() => parse({ ...report, sourceAggregateVersion: 2 })).toThrow();
  expect(() => parse({ ...report, extra: true })).toThrow();
  expect(() => bind(report, { ...f.publication, reasonCode: "OTHER_COMMAND" })).toThrow();
  expect(() => build({ ...f, command: { ...f.command, operationReference: id(30) } })).toThrow();
  expect(() =>
    build({ ...f, publication: { ...f.publication, validationDecision: "Pass" } }),
  ).toThrow();
  expect(() =>
    build({ ...f, validation: { ...f.validation, evidenceReference: id(31) } }),
  ).toThrow();
});

it("rejects accessor details without executing user code and enforces bounded lists", () => {
  const getter = vi.fn(),
    f = fixture();
  expect(() =>
    parseDetails(Object.defineProperty({}, "coverage", { enumerable: true, get: getter })),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  if (f.details.coverage !== "Complete") throw new Error("Missing synthetic details");
  expect(() =>
    parseDetails({
      ...f.details,
      findings: Array.from({ length: 1001 }, () =>
        required(f.details.coverage === "Complete" ? f.details.findings[0] : undefined),
      ),
    }),
  ).toThrow();
});

it("rejects a near-limit complete report that fits compact wire JSON but exceeds PostgreSQL jsonb text", () => {
  const f = fixture(),
    report = build(f);
  if (f.details.coverage !== "Complete") throw new Error("Missing synthetic details");
  const findings = Array.from({ length: 1000 }, (_, i) => ({
    checkCode: "ChangeImpact",
    ruleCode: "R".repeat(64),
    outcome: "Warning",
    subjectReference: id(10000 + i),
    reasonCode: "W".repeat(64),
    references: Array.from({ length: 4 }, (_, j) => ({
      sourceCode: "PRICING",
      resourceReference: id(20000 + i * 4 + j),
      versionReference: id(30000 + i * 4 + j),
      referenceDigest: hash([i, j]),
    })),
  }));
  const candidate = (count: number) => {
    const details = parseDetails({ ...f.details, findings: findings.slice(0, count) }),
      body = {
        ...report,
        details,
        warningBindingDigest: fingerprint(report.binding, f.validation, details),
      };
    const { digest: ignoredDigest, ...rest } = body;
    void ignoredDigest;
    return { ...rest, digest: hash(rest) };
  };
  let lower = 1,
    upper = 1000;
  while (lower < upper) {
    const middle = Math.ceil((lower + upper) / 2);
    if (new TextEncoder().encode(JSON.stringify(candidate(middle))).length <= 1048576)
      lower = middle;
    else upper = middle - 1;
  }
  const nearLimit = candidate(lower);
  expect(new TextEncoder().encode(JSON.stringify(nearLimit)).length).toBeLessThanOrEqual(1048576);
  expect(new TextEncoder().encode(JSON.stringify(nearLimit)).length).toBeGreaterThan(1040000);
  expect(() => parse(nearLimit)).toThrow();
  expect(parse(candidate(Math.floor(lower * 0.8))).details.coverage).toBe("Complete");
});
