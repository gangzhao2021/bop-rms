import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseProductAggregate,
  deriveCatalogProductPublicationContentIdentity,
  createCatalogProductPublicationMaterializationV2,
  productPublicationCheckCodes,
  parseProductPublicationCommandV2,
  parseProductPublicationVersionV2,
  planCatalogProductPublicationV2,
  parseCatalogProductPublicationReplacementIntent,
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
  parseCatalogProductPublicationWarningAcknowledgementCommand,
  type ProductPublicationApprovalV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationVersionV2,
} from "@rms/catalog";
import {
  bindPublicationQualificationInput as publicationContext,
  bindWarningAcknowledgementQualificationInput as acknowledgementContext,
  type WarningAcknowledgementQualificationInput,
} from "./product-publication-qualification-context.js";
// Pure fixtures exercise actual owning parsers/planner, not database provenance,
// permission, processing qualification or an actual current policy holder.
const id = (n: number) => "01902440-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  due = "2026-10-03T13:00:00.000Z",
  later = "2026-10-03T13:00:10.000Z",
  expiry = "2026-10-04T12:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, -1),
  utcOffsetMinutes: 0,
});
const selector = {
  level: "Store",
  reference: id(30),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
};
function originalAggregate() {
  return {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_CONTEXT",
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
      localizedNames: { "en-CA": "Synthetic context" },
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
}
function replacement(exact = false) {
  const body = exact
    ? {
        profile: "CatalogProductExactStoreSelectorReplacementV1",
        mode: "PermanentSelectorRetirement",
        previousVersionReference: id(40),
        previousPublicationOperationReference: id(41),
        expectedPreviousPublicationVersion: 3,
        previousIntentDigest: hash("old intent"),
        previousScopeDigest: hash([selector]),
        previousPeriodDigest: hash("old period"),
        previousSelectorIndex: 0,
        previousSelectorDigest: hash(selector),
      }
    : { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseCatalogProductPublicationReplacementIntent({ ...body, digest: hash(body) });
}
function initial(exact = false, future = false) {
  const aggregate = parseProductAggregate(originalAggregate()),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    replacementIntent = replacement(exact),
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
      scopeSet: [selector],
      effectivePeriod: {
        timeZone: "UTC",
        effectiveFrom: boundary(future ? due : at),
        effectiveUntil: null,
      },
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC_CONTEXT",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    });
  return {
    command,
    aggregate,
    current: null as ProductPublicationVersionV2 | null,
    content: null,
    observedAt: at,
  };
}
type Input = ReturnType<typeof initial>;
function facts(
  input: Input,
  approval: ProductPublicationApprovalV2 | null,
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
      evidenceReference: id(100 + c.expectedPublicationVersion),
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
function applied(input: Input, approval: ProductPublicationApprovalV2 | null = null) {
  const publication = planCatalogProductPublicationV2(
    input.command,
    input.current,
    facts(input, approval),
  );
  const aggregate =
    publication.state === "Published"
      ? createCatalogProductPublicationMaterializationV2(input.aggregate, publication).successor
      : parseProductAggregate({
          ...input.aggregate,
          aggregateVersion: input.aggregate.aggregateVersion + 1,
          updatedAt: input.observedAt,
        });
  return { publication, aggregate };
}
function following(
  input: Input,
  action: ProductPublicationCommandV2["action"],
  approval: ProductPublicationApprovalV2 | null = null,
  patch: Partial<ProductPublicationCommandV2> = {},
): Input {
  const result = applied(input, approval);
  return {
    command: parseProductPublicationCommandV2({
      ...input.command,
      action,
      expectedProductAggregateVersion: result.aggregate.aggregateVersion,
      expectedPublicationVersion: result.publication.publicationVersion,
      operationReference: id(200 + result.publication.publicationVersion),
      actorReference: action === "Approve" || action === "Reject" ? id(9) : id(3),
      actorKind: action === "ActivateScheduled" ? "System" : "User",
      scheduleReference: [
        "SchedulePublish",
        "ReschedulePublish",
        "CancelScheduledPublish",
        "ActivateScheduled",
      ].includes(action)
        ? id(22)
        : null,
      successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(action)
        ? id(23)
        : null,
      ...patch,
    }),
    aggregate: result.aggregate,
    current: result.publication,
    content: null,
    observedAt: input.observedAt,
  };
}
function review(exact = false, future = false) {
  const validate = initial(exact, future),
    submit = following(validate, "SubmitReview"),
    approve = following(submit, "Approve");
  const current = approve.current;
  if (
    !current ||
    !current.reviewReference ||
    current.reviewVersion === null ||
    !current.submittedByActorReference
  )
    throw Error("Missing synthetic review");
  const approval: ProductPublicationApprovalV2 = {
    profile: "CatalogProductPublicationApprovalV2",
    replacementIntentDigest: current.replacementIntentDigest,
    evidenceReference: approve.command.operationReference,
    reviewReference: current.reviewReference,
    reviewVersion: current.reviewVersion,
    requestedByActorReference: current.submittedByActorReference,
    approvedByActorReference: approve.command.actorReference,
    contentDigest: current.contentDigest,
    configurationDigest: current.configurationDigest,
    scopeDigest: current.scopeDigest,
    periodDigest: current.periodDigest,
    policyReference: current.policyReference,
    policyVersion: current.policyVersion,
    approvedAt: at,
    validUntil: expiry,
  };
  return { validate, submit, approve, approval };
}

const deadline = (observedAt: string, milliseconds = 3000) =>
  new Date(Date.parse(observedAt) + milliseconds).toISOString();
function assertContext(input: Input) {
  const end = deadline(input.observedAt),
    context = publicationContext(input, end);
  expect(context.command).toEqual(input.command);
  expect(context.originalIntentDigest).toBe(hash(input.command));
  expect(context.aggregateSnapshotDigest).toBe(hash(input.aggregate));
  expect(context.currentPublicationDigest).toBe(
    input.current === null ? null : hash(input.current),
  );
  expect(context.validUntil).toBe(end);
  expect(context.actorKind).toBe(input.command.actorKind);
  for (const key of [
    "profile",
    "isHeld",
    "sourceAuthority",
    "eligibility",
    "validation",
    "checks",
    "policy",
  ])
    expect(context).not.toHaveProperty(key);
  return context;
}
it.each([false, true])(
  "keeps full None/Exact=%s publication actions without fake Validate or policy selection",
  (exact) => {
    const sequence = review(exact),
      publish = following(sequence.approve, "Publish", sequence.approval);
    for (const input of [sequence.validate, sequence.submit, sequence.approve, publish])
      assertContext(input);
    expect(assertContext(sequence.validate).recordedPolicy).toBeNull();
    expect(assertContext(publish).recordedPolicy).toEqual({
      policyReference: publish.current?.policyReference,
      policyVersion: publish.current?.policyVersion,
    });
    const reject = {
      ...sequence.approve,
      command: parseProductPublicationCommandV2({ ...sequence.approve.command, action: "Reject" }),
    };
    expect(assertContext(reject).command.action).toBe("Reject");
  },
);
it("retains the real System actor and original scheduled request time during delayed activation", () => {
  const sequence = review(false, true),
    schedule = following(sequence.approve, "SchedulePublish", sequence.approval),
    cancel = following(schedule, "CancelScheduledPublish", sequence.approval),
    activate = following(schedule, "ActivateScheduled", sequence.approval, {
      actorReference: id(90),
      occurredAt: due,
    });
  assertContext(schedule);
  assertContext(cancel);
  activate.observedAt = later;
  activate.aggregate = parseProductAggregate({
    ...activate.aggregate,
    updatedAt: "2026-10-03T13:00:05.000Z",
  });
  const context = assertContext(activate);
  expect(context).toMatchObject({ actorKind: "System", actorReference: id(90), observedAt: later });
  expect(context.command.occurredAt).toBe(due);
  expect(context.originalIntentDigest).not.toBe(
    hash({
      ...activate.command,
      actorKind: "User",
      actorReference: activate.current?.submittedByActorReference,
    }),
  );
  const reschedule = {
    ...cancel,
    command: parseProductPublicationCommandV2({
      ...cancel.command,
      action: "ReschedulePublish",
      effectivePeriod: { ...cancel.command.effectivePeriod, effectiveFrom: boundary(later) },
    }),
  };
  expect(assertContext(reschedule).periodDigest).toBe(hash(reschedule.command.effectivePeriod));
});
it("allows genuine edited Draft revalidation and retargeting with intervening roots", () => {
  const input = initial(),
    prior = applied(input),
    raw = structuredClone(prior.aggregate);
  Object.assign(raw.draft, { localizedNames: { "en-CA": "Changed saved content" } });
  Object.assign(raw, { aggregateVersion: raw.aggregateVersion + 3 });
  const aggregate = parseProductAggregate(raw),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    target = replacement(true),
    next = {
      command: parseProductPublicationCommandV2({
        ...input.command,
        operationReference: id(50),
        expectedProductAggregateVersion: aggregate.aggregateVersion,
        expectedPublicationVersion: prior.publication.publicationVersion,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        replacementIntent: target,
        replacementIntentDigest: target.digest,
      }),
      aggregate,
      current: prior.publication,
      content: null,
      observedAt: at,
    };
  expect(assertContext(next).aggregateVersion).toBe(11);
  expect(assertContext(next).replacementIntent.mode).toBe("PermanentSelectorRetirement");
});
it.each([0, -1, 5001])("refuses non-original exclusive deadline offset %s", (offset) => {
  const input = initial();
  expect(() => publicationContext(input, deadline(at, offset))).toThrow();
});
it("requires explicit original deadline and never consults wall time to extend it", () => {
  const input = initial(),
    clock = vi.spyOn(Date, "now").mockImplementation(() => {
      throw Error("No clock in pure binding");
    });
  try {
    expect(publicationContext(input, deadline(at, 1)).validUntil).toBe(deadline(at, 1));
    expect(() => publicationContext(input, undefined as never)).toThrow();
  } finally {
    clock.mockRestore();
  }
});
it("detaches source content and rejects hostile outer/nested descriptors before evaluating getters", () => {
  const input = structuredClone(initial(true)),
    original = structuredClone(input),
    bound = assertContext(input);
  Object.assign(input.aggregate.draft.localizedNames, { "en-CA": "mutated" });
  expect(bound.aggregate).toEqual(original.aggregate);
  expect(Object.isFrozen(bound.aggregate.draft.localizedNames)).toBe(true);
  const getter = vi.fn(),
    outer = { ...initial() },
    nested = structuredClone(initial());
  Object.defineProperty(outer, "aggregate", { enumerable: true, get: getter });
  Object.defineProperty(nested.command, "action", { enumerable: true, get: getter });
  expect(() => publicationContext(outer, deadline(at))).toThrow();
  expect(() => publicationContext(nested, deadline(at))).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

const humanAt = "2026-10-03T14:00:00.000Z";
function acknowledgementFixture(exact = false): WarningAcknowledgementQualificationInput {
  const input = initial(exact),
    base = facts(input, null),
    f = {
      ...base,
      validation: {
        ...base.validation,
        validUntil: deadline(at),
        checks: base.validation.checks.map((check) =>
          check.code === "ChangeImpact" ? { ...check, outcome: "Warning" as const } : check,
        ),
      },
    };
  const current = planCatalogProductPublicationV2(input.command, null, f),
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
          sourceDigest: hash("source"),
          generation: "1",
          relevantReferenceDigest: hash("relevant"),
          observedAt: at,
          validUntil: deadline(at),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      command: input.command,
      publication: current,
      validation: f.validation,
      details,
      recordedAt: at,
    }),
    aggregate = parseProductAggregate({ ...input.aggregate, aggregateVersion: 11 }),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(60),
      productReference: id(5),
      versionReference: id(6),
      expectedProductAggregateVersion: 11,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: humanAt,
    });
  return {
    command,
    aggregate,
    current,
    report,
    observedAt: deadline(humanAt, 10),
    validUntil: deadline(humanAt, 2000),
  };
}
it.each([false, true])(
  "binds old complete report with newer actual root for independent Ack Exact=%s",
  (exact) => {
    const input = acknowledgementFixture(exact),
      context = acknowledgementContext(input);
    expect(context.kind).toBe("WarningAcknowledgement");
    expect(context.command).toEqual(input.command);
    expect(context.originalIntentDigest).toBe(hash(input.command));
    expect(context.command.purposeCode).toBe("CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT");
    expect(context.aggregateVersion).toBe(11);
    expect(context.report.resultAggregateVersion).toBe(8);
    expect(context.validUntil).toBe(input.validUntil);
    expect(context.report.validation.validUntil < context.observedAt).toBe(true);
    expect(context.replacementIntent).toEqual(input.current.replacementIntent);
    expect(context.recordedPolicy).toEqual({
      policyReference: input.current.policyReference,
      policyVersion: input.current.policyVersion,
    });
    for (const key of ["isHeld", "sourceAuthority", "policy", "checks"])
      expect(context).not.toHaveProperty(key);
  },
);
it("preserves a full historical report across an independently newer compatible head", () => {
  const input = acknowledgementFixture(),
    current = parseProductPublicationVersionV2({
      ...input.current,
      operationReference: id(61),
      publicationVersion: 2,
      productAggregateVersion: 9,
      intentDigest: hash("later real-shaped immutable revision"),
    });
  const context = acknowledgementContext({ ...input, current });
  expect(context.report).toEqual(input.report);
  expect(context.currentPublicationDigest).toBe(hash(current));
  expect(context.report.publicationVersion).toBe(1);
});
it.each([
  "root",
  "version",
  "tenant",
  "content",
  "scope",
  "target",
  "policy",
  "reportDigest",
  "reportOperation",
  "warningBinding",
  "warnings",
  "system",
  "future",
  "extra",
])("refuses Ack %s rebinding", (mode) => {
  const input = structuredClone(acknowledgementFixture());
  if (mode === "root") Object.assign(input.command, { expectedProductAggregateVersion: 12 });
  if (mode === "version") Object.assign(input.current, { versionReference: id(99) });
  if (mode === "tenant") Object.assign(input.current, { tenantReference: id(99) });
  if (mode === "content")
    Object.assign(input.aggregate.draft.localizedNames, { "en-CA": "Other content" });
  if (mode === "scope") {
    const scopeSet = [{ ...selector, channelCodes: [] }];
    Object.assign(input.current, { scopeSet, scopeDigest: hash(scopeSet) });
  }
  if (mode === "target") {
    const target = replacement(true);
    Object.assign(input.current, {
      replacementIntent: target,
      replacementIntentDigest: target.digest,
    });
  }
  if (mode === "policy") Object.assign(input.current, { policyVersion: 2 });
  if (mode === "reportDigest") Object.assign(input.command, { reportDigest: hash("other") });
  if (mode === "reportOperation")
    Object.assign(input.command, { reportOperationReference: id(99) });
  if (mode === "warningBinding")
    Object.assign(input.command, { warningBindingDigest: hash("other") });
  if (mode === "warnings") Object.assign(input.command, { warningCodes: ["MediaReady"] });
  if (mode === "system") Object.assign(input.command, { actorKind: "System" });
  if (mode === "future") Object.assign(input.command, { occurredAt: expiry });
  if (mode === "extra") Object.assign(input, { isHeld: true });
  expect(() => acknowledgementContext(input)).toThrow();
});
it("revalidates complete report integrity and nested descriptors without reading accessors", () => {
  const input = acknowledgementFixture(),
    raw = structuredClone(input),
    getter = vi.fn();
  Object.assign(raw.report, { digest: hash("forged report") });
  expect(() => acknowledgementContext(raw)).toThrow();
  Object.defineProperty(raw.report, "details", { enumerable: true, get: getter });
  expect(() => acknowledgementContext(raw)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const captured = acknowledgementContext(input);
  expect(Object.isFrozen(captured.report.details)).toBe(true);
  expect(captured.report).not.toBe(input.report);
});
it.each([0, 5001])("refuses Ack source deadline extension/zero window %s", (offset) => {
  const input = acknowledgementFixture();
  expect(() =>
    acknowledgementContext({ ...input, validUntil: deadline(input.observedAt, offset) }),
  ).toThrow();
});
