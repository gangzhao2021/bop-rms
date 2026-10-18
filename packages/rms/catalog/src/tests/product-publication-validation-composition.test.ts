import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy } from "@bop/publishing";
import { parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  type ProductPublicationFactsV2,
} from "../contracts/product-publication-v2.js";
import {
  bindCatalogProductPublicationQualificationContext,
  bindCatalogProductWarningAcknowledgementQualificationContext,
} from "../contracts/product-publication-qualification-context.js";
import {
  buildCatalogProductPublicationValidationReport,
  calculateCatalogProductPublicationWarningBindingDigest,
  parseCatalogProductPublicationValidationDetails,
  type CatalogProductPublicationValidationFinding,
} from "../contracts/product-publication-validation-report.js";
import {
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  buildCatalogProductPublicationWarningAcknowledgementObservation,
} from "../contracts/product-publication-warning-acknowledgement.js";
import {
  composeCatalogProductPublicationValidation as compose,
  productPublicationCompositionCheckCodes,
  type CatalogProductPublicationValidationCompositionInput as Input,
} from "../application/product-publication-validation-composition.js";

// Synthetic supplied source assessments exercise only pure composition. Actual
// authority, locks, sources and the unique-code constraint belong to native tests.
const id = (n: number) => "019024b0-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v)),
  boundary = (instant: string) => ({
    instant,
    localDateTime: instant.slice(0, -1),
    utcOffsetMinutes: 0,
  });
function fixture(required = true): Input {
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_COMPOSITION",
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
        localizedNames: { "en-CA": "Synthetic composition" },
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
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    none = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
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
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
      effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(at), effectiveUntil: null },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_COMPOSITION",
      replacementIntent: { ...none, digest: hash(none) },
      replacementIntentDigest: hash(none),
    }),
    context = bindCatalogProductPublicationQualificationContext(
      { command, aggregate, current: null, content: null, observedAt: at },
      until,
    ),
    content = parsePublishingProductPublicationPolicy({
      profile: "PublishingProductPublicationPolicyV1",
      tenantReference: id(1),
      brandReference: id(2),
      familyReference: id(18),
      policyReference: id(19),
      policyVersion: 1,
      scopeOrder: ["Store", "StoreGroup", "Region", "Channel", "OrderType", "Brand"],
      approvalPolicy: required ? "Required" : "NotRequired",
      warningOverrideAllowed: true,
      requiredLocales: ["en-CA"],
      mediaRequirement: "Optional",
      effectiveFrom: "2026-10-01T00:00:00.000Z",
      effectiveUntil: null,
    }),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [],
      sources: [
        {
          sourceCode: "SYNTHETIC_HELD",
          sourceDigest: hash("actual source packet"),
          generation: "1",
          relevantReferenceDigest: hash("stable reference facts"),
          observedAt: at,
          validUntil: until,
        },
      ],
    });
  if (details.coverage !== "Complete") throw Error("synthetic details missing");
  return {
    context,
    policy: { content, currentPublicationReference: id(20), observedAt: at, validUntil: until },
    evidenceReference: id(21),
    checks: productPublicationCompositionCheckCodes.map((code) => ({ code, outcome: "Pass" })),
    details,
    assessedAt: at,
  };
}
function negative(
  input: Input,
  code: Input["checks"][number]["code"],
  outcome: "Warning" | "HardError",
): Input {
  const finding: CatalogProductPublicationValidationFinding = {
    checkCode: code,
    ruleCode: code === "ChangeImpact" ? "SKU-008" : "SYNTHETIC_SOURCE_RULE",
    outcome,
    subjectReference: input.context.productReference,
    reasonCode: "SYNTHETIC_NEGATIVE",
    references: [
      {
        sourceCode: "SYNTHETIC_HELD",
        resourceReference: id(22),
        versionReference: id(23),
        referenceDigest: hash("reference"),
      },
    ],
  };
  return {
    ...input,
    checks: input.checks.map((c) => (c.code === code ? { ...c, outcome } : c)),
    details: { ...input.details, findings: [...input.details.findings, finding] },
  };
}
function publication(input: Input, output = compose(input)) {
  if (input.context.kind !== "Publication") throw Error("synthetic publication expected");
  const c = input.context,
    facts: ProductPublicationFactsV2 = {
      now: c.observedAt,
      productAggregateVersion: c.aggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: c.scopeDigest,
      periodDigest: c.periodDigest,
      validation: output.validation,
      approval: null,
      reviewReference: c.command.action === "SubmitReview" ? id(50) : null,
      replacement: null,
    };
  return planCatalogProductPublicationV2(c.command, c.current, facts);
}
const outcome = (output: ReturnType<typeof compose>, code: string) =>
  output.validation.checks.find((c) => c.code === code)?.outcome;
const rejects = (value: unknown) =>
  expect(() => compose(value as Input)).toThrow(
    expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" }),
  );

it("composes exactly twelve actual checks, leaves Required approval Pending and never creates consent", () => {
  const f = fixture(),
    output = compose(f);
  expect(output.validation.checks).toHaveLength(12);
  expect(outcome(output, "ApprovalPolicy")).toBe("Pending");
  expect(outcome(output, "InternalCode")).toBe("Pass");
  expect(outcome(output, "HardErrorsCleared")).toBe("Pass");
  expect(output.validation.warningAcknowledgement).toBeNull();
  expect(Object.keys(output).sort()).toEqual(["binding", "details", "validation"]);
  expect(publication(f).validationDecision).toBe("ApprovalPending");
  expect(output.binding.replacementIntentDigest).toBe(f.context.replacementIntentDigest);
  expect(output.details.coverage).toBe("Complete");
  expect(Object.isFrozen(output.validation.checks)).toBe(true);
});
it("keeps NotRequired approval separate from Required pending", () => {
  const f = fixture(false);
  expect(outcome(compose(f), "ApprovalPolicy")).toBe("Pass");
  expect(publication(f).validationDecision).toBe("Pass");
});
it.each(productPublicationCompositionCheckCodes)(
  "retains an actual %s hard error and its finding",
  (code) => {
    const f = negative(fixture(), code, "HardError"),
      output = compose(f);
    expect(outcome(output, code)).toBe("HardError");
    expect(outcome(output, "HardErrorsCleared")).toBe("HardError");
    expect(output.details.findings).toEqual(f.details.findings);
    expect(publication(f).validationDecision).toBe("HardError");
  },
);
it("preserves a policy-classified warning without treating it as a hard error or acknowledgement", () => {
  const f = negative(fixture(), "ChangeImpact", "Warning"),
    output = compose(f);
  expect(outcome(output, "ChangeImpact")).toBe("Warning");
  expect(outcome(output, "HardErrorsCleared")).toBe("Pass");
  expect(outcome(output, "ApprovalPolicy")).toBe("Pending");
  expect(publication(f).validationDecision).toBe("WarningAcknowledgementRequired");
});
it("requires every explicit source result and matching findings, with no generic Pass fallback", () => {
  const f = fixture(),
    bad = negative(f, "MediaReady", "HardError");
  for (const value of [
    { ...f, checks: f.checks.slice(1) },
    { ...f, checks: [...f.checks.slice(1), f.checks[1]] },
    { ...bad, checks: f.checks },
    { ...bad, details: f.details },
    { ...f, details: { coverage: "ChecksOnly", impact: "NotRecorded" } },
    {
      ...f,
      checks: f.checks.map((c) =>
        c.code === "EffectivePeriod" ? { ...c, outcome: "Warning" } : c,
      ),
    },
    {
      ...f,
      checks: f.checks.map((c) => (c.code === "ChangeImpact" ? { ...c, outcome: "Pending" } : c)),
    },
  ])
    rejects(value);
});
it("does not permit external InternalCode, approval or hard-summary claims", () => {
  const f = fixture();
  for (const code of ["InternalCode", "ApprovalPolicy", "HardErrorsCleared"]) {
    rejects({ ...f, checks: [{ code, outcome: "Pass" }, ...f.checks.slice(1)] });
    rejects({
      ...f,
      details: {
        ...f.details,
        findings: [
          {
            checkCode: code,
            ruleCode: "SYNTHETIC",
            outcome: "HardError",
            subjectReference: null,
            reasonCode: "SYNTHETIC",
            references: [],
          },
        ],
      },
    });
  }
});
it("records ended half-open periods as a hard error without inventing a backdate allowance or using the business end as a source lease", () => {
  const f = fixture();
  if (f.context.kind !== "Publication") throw Error("fixture");
  const end = "2026-10-03T12:00:00.001Z",
    assessedAt = "2026-10-03T12:00:01.000Z",
    command = parseProductPublicationCommandV2({
      ...f.context.command,
      effectivePeriod: { ...f.context.effectivePeriod, effectiveUntil: boundary(end) },
    }),
    context = bindCatalogProductPublicationQualificationContext(
      { command, aggregate: f.context.aggregate, current: null, content: null, observedAt: at },
      until,
    ),
    output = compose({ ...f, context, assessedAt });
  expect(outcome(output, "EffectivePeriod")).toBe("HardError");
  expect(output.validation.validUntil).toBe(until);
  expect(output.details.findings).toMatchObject([
    {
      checkCode: "EffectivePeriod",
      reasonCode: "PRODUCT_EFFECTIVE_PERIOD_ENDED",
      outcome: "HardError",
    },
  ]);
});
it("retains an explicitly assessed backdate rejection and does not convert it to a warning", () => {
  const f = negative(fixture(), "EffectivePeriod", "HardError");
  expect(compose(f).details.findings).toEqual(f.details.findings);
  rejects({ ...f, checks: f.checks.filter((c) => c.code !== "EffectivePeriod") });
});
it("keeps original validation time but allows staggered actual reads and takes the earliest original lease", () => {
  const f = fixture(),
    observedAt = "2026-10-03T12:00:00.500Z",
    assessedAt = "2026-10-03T12:00:01.000Z",
    short = "2026-10-03T12:00:02.000Z",
    output = compose({
      ...f,
      assessedAt,
      details: {
        ...f.details,
        sources: f.details.sources.map((s) => ({ ...s, observedAt, validUntil: short })),
      },
    });
  expect(output.validation.checkedAt).toBe(at);
  expect(output.validation.validUntil).toBe(short);
  expect(output.details.sources.find((s) => s.sourceCode === "SYNTHETIC_HELD")?.observedAt).toBe(
    observedAt,
  );
  for (const assessedAt of [short, "2026-10-03T11:59:59.999Z"])
    rejects({
      ...f,
      assessedAt,
      details: {
        ...f.details,
        sources: f.details.sources.map((s) => ({ ...s, validUntil: short })),
      },
    });
  rejects({
    ...f,
    details: { ...f.details, sources: f.details.sources.map((s) => ({ ...s, observedAt })) },
  });
});
it("rejects detached or transplanted context, policy, incomplete details and caller-provided local evidence", () => {
  const f = fixture();
  for (const context of [
    { ...f.context, originalIntentDigest: hash("other") },
    { ...f.context, scopeDigest: hash("other") },
    { ...f.context, replacementIntentDigest: hash("other") },
    { ...f.context, aggregateSnapshotDigest: hash("other") },
    { ...f.context, actorReference: id(99) },
  ])
    rejects({ ...f, context });
  for (const content of [
    { ...f.policy.content, tenantReference: id(99) },
    { ...f.policy.content, brandReference: id(99) },
    { ...f.policy.content, effectiveUntil: at },
  ])
    rejects({ ...f, policy: { ...f.policy, content } });
  rejects({
    ...f,
    details: {
      ...f.details,
      sources: f.details.sources.map((s) => ({
        ...s,
        sourceCode: "CATALOG_PRODUCT_PUBLICATION_INPUT",
      })),
    },
  });
});
it("does not invoke getters or retain caller mutable check/source objects", () => {
  const f = fixture(),
    getter = vi.fn(() => f.checks),
    value = { ...f };
  Object.defineProperty(value, "checks", { enumerable: true, get: getter });
  rejects(value);
  expect(getter).not.toHaveBeenCalled();
  const checks = f.checks.map((c) => ({ ...c })),
    sources = f.details.sources.map((s) => ({ ...s })),
    output = compose({ ...f, checks, details: { ...f.details, sources } });
  const check = checks[0],
    source = sources[0];
  if (!check || !source) throw Error("fixture");
  check.outcome = "HardError";
  source.relevantReferenceDigest = hash("changed");
  expect(outcome(output, check.code)).toBe("Pass");
  expect(
    output.details.sources.find((s) => s.sourceCode === source.sourceCode)?.relevantReferenceDigest,
  ).not.toBe(source.relevantReferenceDigest);
});
it("reuses stable semantic warning binding across root/workflow/time and independent Ack, without reusing historical leases", () => {
  const f = negative(fixture(), "ChangeImpact", "Warning"),
    output = compose(f);
  if (f.context.kind !== "Publication") throw Error("fixture");
  const current = publication(f, output),
    report = buildCatalogProductPublicationValidationReport({
      command: f.context.command,
      publication: current,
      validation: output.validation,
      details: output.details,
      recordedAt: at,
    }),
    later = "2026-10-03T13:00:00.000Z",
    laterUntil = "2026-10-03T13:00:05.000Z",
    aggregate = parseProductAggregate({
      ...f.context.aggregate,
      aggregateVersion: 8,
      updatedAt: at,
    });
  const command = parseCatalogProductPublicationWarningAcknowledgementCommand({
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
      expectedProductAggregateVersion: 8,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_SYNTHETIC_CONFIRMATION",
      occurredAt: later,
    }),
    context = bindCatalogProductWarningAcknowledgementQualificationContext({
      command,
      aggregate,
      current,
      report,
      observedAt: later,
      validUntil: laterUntil,
    });
  const originalSources = f.details.sources.map((s) => ({
      ...s,
      generation: "99",
      sourceDigest: hash("new observed source packet"),
      observedAt: later,
      validUntil: laterUntil,
    })),
    freshInput: Input = {
      ...f,
      context,
      evidenceReference: id(31),
      policy: { ...f.policy, observedAt: later, validUntil: laterUntil },
      details: { ...f.details, sources: originalSources },
      assessedAt: later,
    },
    fresh = compose(freshInput);
  expect(fresh.binding).toEqual(output.binding);
  expect(
    calculateCatalogProductPublicationWarningBindingDigest(
      fresh.binding,
      fresh.validation,
      fresh.details,
    ),
  ).toBe(report.warningBindingDigest);
  expect(fresh.validation.warningAcknowledgement).toBeNull();
  expect(
    buildCatalogProductPublicationWarningAcknowledgementObservation({
      command,
      binding: fresh.binding,
      validation: fresh.validation,
      details: fresh.details,
      policy: f.policy.content,
      observedAt: later,
      validUntil: laterUntil,
    }).acknowledgementIntentDigest,
  ).toBe(context.originalIntentDigest);
  rejects({
    ...freshInput,
    policy: { ...freshInput.policy, content: { ...f.policy.content, policyVersion: 2 } },
  });
  rejects({ ...freshInput, details: f.details });
});
it("supports new policy selection on explicit Validate while retaining the recorded policy for follow-on actions", () => {
  const f = fixture(),
    output = compose(f);
  if (f.context.kind !== "Publication") throw Error("fixture");
  const current = publication(f, output),
    aggregate = parseProductAggregate({ ...f.context.aggregate, aggregateVersion: 8 }),
    command = parseProductPublicationCommandV2({
      ...f.context.command,
      operationReference: id(32),
      expectedProductAggregateVersion: 8,
      expectedPublicationVersion: 1,
      action: "SubmitReview",
    }),
    context = bindCatalogProductPublicationQualificationContext(
      { command, aggregate, current, content: null, observedAt: at },
      until,
    ),
    follow = { ...f, context };
  expect(publication(follow).state).toBe("InReview");
  rejects({
    ...follow,
    policy: {
      ...f.policy,
      content: parsePublishingProductPublicationPolicy({ ...f.policy.content, policyVersion: 2 }),
    },
  });
  const validate = parseProductPublicationCommandV2({ ...command, action: "Validate" }),
    again = bindCatalogProductPublicationQualificationContext(
      { command: validate, aggregate, current, content: null, observedAt: at },
      until,
    );
  expect(
    compose({
      ...f,
      context: again,
      policy: {
        ...f.policy,
        content: parsePublishingProductPublicationPolicy({ ...f.policy.content, policyVersion: 2 }),
      },
    }).validation.policyVersion,
  ).toBe(2);
});
