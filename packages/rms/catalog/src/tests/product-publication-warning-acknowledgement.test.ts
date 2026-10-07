import { expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildCatalogProductPublicationWarningAcknowledgementEvent as buildEvent,
  catalogProductPublicationWarningAcknowledgementEventId as eventId,
} from "../contracts/product-publication-warning-acknowledgement-event.js";
import { calculateCatalogProductPublicationWarningBindingDigest } from "../contracts/product-publication-validation-report.js";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  parseProductPublicationVersionV2,
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
  parseCatalogProductPublicationWarningAcknowledgementReceipt as parseReceipt,
  bindCatalogProductPublicationWarningAcknowledgement as bind,
  assessCatalogProductPublicationWarningAcknowledgement as assess,
} from "../contracts/product-publication-warning-acknowledgement.js";

// Explicit synthetic complete producer/policy facts. This tests pure consent
// binding, not production acquisition, human UI, persistence or authority.
const id = (n: number) => "01902491-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:05.000Z",
  humanAt = "2026-10-03T14:00:00.000Z",
  humanUntil = "2026-10-03T14:00:05.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
beforeEach(() => {
  vi.spyOn(Date, "now").mockReturnValue(Date.parse(humanAt) + 1000);
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
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
  return {
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
function reseal(value: object) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: hash(body) };
}

it("returns an explicit Applicable result while retaining original strict equal-ack behavior", () => {
  const f = fixture(),
    strict = bind(f.bindingInput),
    result = assess(f.bindingInput);
  expect(result).toEqual({ status: "Applicable", validation: strict });
  expect(Object.isFrozen(result)).toBe(true);
  expect(bind({ ...f.bindingInput, validation: strict })).toEqual(strict);
});

it.each(["content", "policy", "references", "findings", "warnings"] as const)(
  "classifies only coherent changed %s as StaleSemantic and leaves Warning/Pending untouched",
  (kind) => {
    const f = fixture();
    const input = structuredClone(f.bindingInput);
    if (kind === "content") {
      input.command = parseProductPublicationCommandV2({
        ...input.command,
        contentDigest: hash("new content"),
      });
      input.validation = { ...input.validation, contentDigest: input.command.contentDigest };
    }
    if (kind === "policy") {
      input.validation = { ...input.validation, policyVersion: 2 };
      input.policy = { ...input.policy, policyVersion: 2 };
    }
    if (kind === "references")
      input.details = {
        ...input.details,
        sources: input.details.sources.map((s) => ({
          ...s,
          relevantReferenceDigest: hash("changed references"),
        })),
      };
    if (kind === "findings")
      input.details = {
        ...input.details,
        findings: input.details.findings.map((finding) => ({
          ...finding,
          reasonCode: "CHANGED_REFERENCE_WARNING",
        })),
      };
    if (kind === "warnings") {
      input.validation = {
        ...input.validation,
        checks: input.validation.checks.map((c) =>
          c.code === "OptionSelection" ? { ...c, outcome: "Warning" as const } : c,
        ),
      };
      input.details = {
        ...input.details,
        findings: [
          ...input.details.findings,
          {
            checkCode: "OptionSelection" as const,
            ruleCode: "SYNTHETIC_OPTION",
            outcome: "Warning" as const,
            subjectReference: id(91),
            reasonCode: "CHANGED_OPTION_WARNING",
            references: [],
          },
        ],
      };
    }
    const result = assess(input);
    expect(result.status).toBe("StaleSemantic");
    expect(result.validation.warningAcknowledgement).toBeNull();
    expect(result.validation.checks).toEqual(
      parseProductPublicationValidationV2(input.validation).checks,
    );
    expect(result.validation.validUntil).toBe(input.validation.validUntil);
    expect(() => bind(input)).toThrow();
  },
);

it.each([
  "receipt",
  "foreignActor",
  "foreignCurrent",
  "expired",
  "futureSource",
  "incomplete",
  "incoherent",
  "forgedAck",
] as const)("never hides %s failure behind a stale classification", (kind) => {
  const f = fixture(),
    input: Record<string, unknown> = { ...f.bindingInput };
  if (kind === "receipt") input.receipt = { ...f.receipt, digest: hash("corrupt") };
  if (kind === "foreignActor")
    input.command = { ...f.bindingInput.command, actorReference: id(99) };
  if (kind === "foreignCurrent") input.current = { ...f.publication, productReference: id(99) };
  if (kind === "expired") input.now = humanUntil;
  if (kind === "futureSource")
    input.details = {
      ...f.bindingInput.details,
      sources: f.bindingInput.details.sources.map((s) => ({
        ...s,
        observedAt: "2026-10-03T14:00:00.005Z",
      })),
    };
  if (kind === "incomplete") input.details = { coverage: "ChecksOnly", impact: "NotRecorded" };
  if (kind === "incoherent")
    input.validation = {
      ...f.bindingInput.validation,
      contentDigest: hash("unbound current fact"),
    };
  if (kind === "forgedAck")
    input.validation = {
      ...f.bindingInput.validation,
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "NOT_THE_RECEIPT",
        warningCodes: ["ChangeImpact"],
      },
    };
  expect(() => assess(input)).toThrow();
});

it("accepts explicit confirmation hours after display using fresh same-semantic sources at a later root", () => {
  const f = fixture();
  expect(f.receipt.command.reportDigest).toBe(f.report.digest);
  expect(f.receipt.observation.productAggregateVersion).toBe(7);
  expect(f.report.resultAggregateVersion).toBe(2);
  expect(f.receipt.observation.warningBindingDigest).toBe(f.report.warningBindingDigest);
  expect(f.receipt.originalIntentDigest).toBe(hash(f.command));
  expect(parseReceipt(JSON.parse(JSON.stringify(f.receipt)))).toEqual(f.receipt);
  expect(f.report.validation.warningAcknowledgement).toBeNull();
});

it("binds consent without promoting Pending, rewriting checks or renewing original leases", () => {
  const f = fixture(),
    result = bind(f.bindingInput);
  expect(result.checks).toEqual(f.bindingInput.validation.checks);
  expect(result.checks.find((c) => c.code === "ApprovalPolicy")?.outcome).toBe("Pending");
  expect(result.checkedAt).toBe(humanAt);
  expect(result.validUntil).toBe(humanUntil);
  expect(result.warningAcknowledgement).toEqual({
    actorReference: id(3),
    reasonCode: f.command.reasonCode,
    warningCodes: ["ChangeImpact"],
  });
  const promoted = {
    ...f.bindingInput.validation,
    checks: f.bindingInput.validation.checks.map((c) =>
      c.code === "ApprovalPolicy" ? { ...c, outcome: "Pass" } : c,
    ),
  };
  expect(
    bind({ ...f.bindingInput, validation: promoted }).checks.find(
      (c) => c.code === "ApprovalPolicy",
    )?.outcome,
  ).toBe("Pass");
});

it("refuses original five-second expiry and observations from after write completion", () => {
  const f = fixture();
  expect(() => acknowledge({ ...f.receiptInput, recordedAt: humanUntil })).toThrow();
  expect(() => acknowledge({ ...f.receiptInput, recordedAt: humanAt })).toThrow();
  expect(() => observe({ ...f.observationInput, observedAt: humanAt })).toThrow();
  expect(() => bind({ ...f.bindingInput, now: humanUntil })).toThrow();
});

it("never transfers an observation to another acknowledgement operation, actor or reason", () => {
  const f = fixture();
  for (const patch of [
    { operationReference: id(90) },
    { actorReference: id(90) },
    { reasonCode: "OTHER_REASON" },
  ]) {
    const command = parseCommand({ ...f.command, ...patch });
    expect(() => acknowledge({ ...f.receiptInput, command })).toThrow();
  }
  expect(() =>
    parseReceipt(reseal({ ...f.receipt, originalIntentDigest: hash("other intent") })),
  ).toThrow();
  expect(() => parseCommand({ ...f.command, actorKind: "System" })).toThrow();
  expect(() => parseCommand({ ...f.command, warningCodes: [] })).toThrow();
});

it("requires complete displayed and current reports instead of manufacturing missing findings", () => {
  const f = fixture(),
    incomplete = buildCatalogProductPublicationValidationReport({
      command: f.publicationCommand,
      publication: f.publication,
      validation: f.validation,
      details: null,
      recordedAt: at,
    });
  expect(() => acknowledge({ ...f.receiptInput, report: incomplete })).toThrow();
  expect(() =>
    observe({ ...f.observationInput, details: { coverage: "ChecksOnly", impact: "NotRecorded" } }),
  ).toThrow();
  expect(() =>
    bind({ ...f.bindingInput, details: { coverage: "ChecksOnly", impact: "NotRecorded" } }),
  ).toThrow();
});

it("does not acknowledge HardError or mistake ApprovalPolicy Pending for a warning", () => {
  const f = fixture(),
    hard = {
      ...f.bindingInput.validation,
      checks: f.bindingInput.validation.checks.map((c) =>
        c.code === "InternalCode" || c.code === "HardErrorsCleared"
          ? { ...c, outcome: "HardError" }
          : c,
      ),
    };
  expect(() => bind({ ...f.bindingInput, validation: hard })).toThrow();
  expect(() => observe({ ...f.observationInput, validation: hard })).toThrow();
  expect(() =>
    observe({
      ...f.observationInput,
      command: { ...f.command, warningCodes: ["ApprovalPolicy", "ChangeImpact"] },
    }),
  ).toThrow();
  const clean = {
    ...f.observationInput.validation,
    checks: f.observationInput.validation.checks.map((c) =>
      c.code === "ChangeImpact" ? { ...c, outcome: "Pass" } : c,
    ),
  };
  expect(() =>
    observe({
      ...f.observationInput,
      validation: clean,
      details: { ...f.observationInput.details, findings: [] },
    }),
  ).toThrow();
});

it("invalidates consent on content, policy or related reference changes after display", () => {
  const f = fixture(),
    changed = hash("changed content");
  expect(() =>
    observe({
      ...f.observationInput,
      binding: { ...f.report.binding, contentDigest: changed },
      validation: { ...f.observationInput.validation, contentDigest: changed },
    }),
  ).toThrow();
  expect(() =>
    observe({
      ...f.observationInput,
      binding: { ...f.report.binding, policyVersion: 2 },
      validation: { ...f.observationInput.validation, policyVersion: 2 },
      policy: { ...f.observationInput.policy, policyVersion: 2 },
    }),
  ).toThrow();
  expect(() =>
    observe({
      ...f.observationInput,
      details: {
        ...f.observationInput.details,
        sources: f.observationInput.details.sources.map((s) => ({
          ...s,
          relevantReferenceDigest: hash("different relevant reference"),
        })),
      },
    }),
  ).toThrow();
  expect(() =>
    bind({
      ...f.bindingInput,
      command: { ...f.bindingInput.command, contentDigest: changed },
      validation: { ...f.bindingInput.validation, contentDigest: changed },
    }),
  ).toThrow();
});

it("requires the actual held policy to permit warning acknowledgement at confirmation and reuse", () => {
  const f = fixture();
  expect(() =>
    observe({
      ...f.observationInput,
      policy: { ...f.observationInput.policy, warningOverrideAllowed: false },
    }),
  ).toThrow();
  expect(() =>
    bind({
      ...f.bindingInput,
      policy: { ...f.bindingInput.policy, warningOverrideAllowed: false },
    }),
  ).toThrow();
  expect(() =>
    observe({
      ...f.observationInput,
      policy: { ...f.observationInput.policy, brandReference: id(90) },
    }),
  ).toThrow();
  expect(() =>
    bind({ ...f.bindingInput, policy: { ...f.bindingInput.policy, effectiveUntil: humanAt } }),
  ).toThrow();
});

it("uses the actual submitter's receipt for System activation and refuses a different User", () => {
  const f = fixture(),
    current = parseProductPublicationVersionV2({
      ...f.publication,
      state: "Scheduled",
      validationDecision: "Pass",
      reviewReference: id(60),
      reviewVersion: 1,
      submittedByActorReference: id(3),
      approvalEvidenceReference: id(61),
      scheduleReference: id(62),
      scheduleVersion: 1,
    }),
    command = parseProductPublicationCommandV2({
      ...f.bindingInput.command,
      action: "ActivateScheduled",
      actorKind: "System",
      actorReference: id(63),
      scheduleReference: id(62),
      successorDraftVersionReference: id(64),
    });
  expect(bind({ ...f.bindingInput, command, current }).warningAcknowledgement?.actorReference).toBe(
    id(3),
  );
  expect(() =>
    bind({
      ...f.bindingInput,
      command,
      current: { ...current, submittedByActorReference: id(70) },
    }),
  ).toThrow();
  expect(() => bind({ ...f.bindingInput, command, current: null })).toThrow();
  expect(() =>
    bind({ ...f.bindingInput, command: { ...f.bindingInput.command, actorReference: id(70) } }),
  ).toThrow();
});

it("keeps original publication commands closed and rejects altered receipt bytes", () => {
  const f = fixture(),
    original = canonicalizeRfc8785(f.publicationCommand);
  bind(f.bindingInput);
  expect(canonicalizeRfc8785(f.publicationCommand)).toBe(original);
  expect(() =>
    parseProductPublicationCommandV2({ ...f.publicationCommand, warningCodes: ["ChangeImpact"] }),
  ).toThrow();
  expect(() => parseReceipt({ ...f.receipt, extra: true })).toThrow();
  expect(() => parseReceipt({ ...f.receipt, recordedAt: "2026-10-03T14:00:00.004Z" })).toThrow();
  expect(() =>
    bind({
      ...f.bindingInput,
      validation: {
        ...f.bindingInput.validation,
        warningAcknowledgement: {
          actorReference: id(3),
          reasonCode: "SILENT_OTHER_REASON",
          warningCodes: ["ChangeImpact"],
        },
      },
    }),
  ).toThrow();
});

function auditInput(receipt = fixture().receipt) {
  return {
    auditId: id(800),
    brandId: receipt.command.brandReference,
    actor: { type: "User", reference: receipt.command.actorReference },
    actionCode: "CATALOG_PRODUCT_PUBLICATION_WARNINGS_ACKNOWLEDGED",
    targetType: "Product",
    targetId: receipt.command.productReference,
    occurredAt: receipt.recordedAt,
    reasonCode: receipt.command.reasonCode,
    correlationId: id(801),
    sourceChannel: "MERCHANT_WEB",
    dataClassification: "Confidential",
    retentionPolicyCode: "CATALOG_CONFIGURATION",
    retentionPolicyVersion: 1,
  };
}
it("emits an independent version1 acknowledgement with exact original audit identity", () => {
  const { receipt } = fixture();
  const result = buildEvent(receipt, auditInput(receipt));
  expect(result.envelope).toMatchObject({
    eventType: "ProductPublicationWarningsAcknowledged",
    aggregateType: "ProductPublicationWarningAcknowledgement",
    aggregateId: receipt.command.operationReference,
    aggregateVersion: 1n,
    occurredAt: receipt.recordedAt,
    tenantId: receipt.command.brandReference,
    actor: { type: "Actor", actorId: receipt.command.actorReference },
  });
  expect(result.envelope.eventId).toBe(eventId(receipt.command));
  expect(eventId({ ...receipt.command, operationReference: id(802) })).not.toBe(
    result.envelope.eventId,
  );
  expect(result.envelope.payload.productAggregateVersion).toBe(7);
  expect(result.envelope.payload.receiptDigest).toBe(receipt.digest);
  expect(result.audit.afterSummary).toMatchObject({
    receiptDigest: receipt.digest,
    warningCodes: ["ChangeImpact"],
  });
  expect(result.envelope.payload).not.toHaveProperty("observation");
  expect(result.envelope.payload).not.toHaveProperty("findings");
});
it.each([
  { brandId: id(90) },
  { storeId: id(91) },
  { actor: { type: "System" } },
  { actor: { type: "User", reference: id(92) } },
  { targetType: "ProductPublicationWarningAcknowledgement" },
  { targetId: id(93) },
  { occurredAt: at },
  { reasonCode: "WRONG" },
  { actionCode: "CATALOG_PRODUCT_VERSION_VALIDATE" },
  { beforeSummary: {} },
  { afterSummary: {} },
  { correctsAuditId: id(94) },
])("refuses mismatched acknowledgement audit %j", (patch) => {
  const { receipt } = fixture();
  expect(() => buildEvent(receipt, { ...auditInput(receipt), ...patch })).toThrow();
});
it("bounds independently valid receipts by PostgreSQL text bytes including spaces", () => {
  const f = fixture();
  const make = (count: number) => {
    const details = parseCatalogProductPublicationValidationDetails({
      ...f.observationInput.details,
      findings: Array.from({ length: count }, (_, i) => ({
        checkCode: "ChangeImpact",
        ruleCode: "R".repeat(64),
        outcome: "Warning",
        subjectReference: id(1000 + i),
        reasonCode: "W".repeat(64),
        references: Array.from({ length: 8 }, (_, j) => ({
          sourceCode: "SYNTHETIC_REFERENCE",
          resourceReference: id(10000 + i * 8 + j),
          versionReference: id(20000 + i * 8 + j),
          referenceDigest: hash([i, j]),
        })),
      })),
    });
    const warningBindingDigest = calculateCatalogProductPublicationWarningBindingDigest(
      f.report.binding,
      f.observationInput.validation,
      details,
    );
    const command = parseCommand({ ...f.command, warningBindingDigest });
    const observation = observe({ ...f.observationInput, command, details });
    return reseal({ ...f.receipt, command, originalIntentDigest: hash(command), observation });
  };
  const small = make(10),
    large = make(1000);
  expect(parseReceipt(small)).toEqual(small);
  // This candidate passes complete observation and hash validation; only its
  // independently bounded persisted receipt envelope is too large.
  expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeGreaterThan(2_097_152);
  expect(() => parseReceipt(large)).toThrow();
});
