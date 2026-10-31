import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseProductPublicationCommand,
  parseProductPublicationValidation,
  parseProductPublicationApproval,
  parseProductPublicationVersion,
  planCatalogProductPublication,
  recoverCatalogProductPublication,
  productPublicationCheckCodes,
  type ProductPublicationAction,
  type ProductPublicationPeriod,
  type ProductPublicationScope,
} from "../contracts/product-publication.js";
import {
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import {
  parseProductPublicationCommandV2,
  parseProductPublicationValidationV2,
  parseProductPublicationApprovalV2,
  parseProductPublicationVersionV2,
  planCatalogProductPublicationV2,
  recoverCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationApprovalV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";

const id = (n: number) => "01902430-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-02T12:00:00.000Z",
  later = "2026-10-02T13:00:00.000Z",
  expiry = "2026-10-03T00:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const selector: ProductPublicationScope = {
  level: "Store",
  reference: id(30),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
};
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const period: ProductPublicationPeriod = {
  timeZone: "UTC",
  effectiveFrom: boundary(at),
  effectiveUntil: null,
};
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Synthetic fixture missing");
  return value;
}
function intent(previous = 40) {
  const body = {
    profile: "CatalogProductExactStoreSelectorReplacementV1",
    mode: "PermanentSelectorRetirement",
    previousVersionReference: id(previous),
    previousPublicationOperationReference: id(previous + 1),
    expectedPreviousPublicationVersion: 4,
    previousIntentDigest: hash("original publication"),
    previousScopeDigest: hash([selector, { ...selector, reference: id(31) }]),
    previousPeriodDigest: hash(period),
    previousSelectorIndex: 0,
    previousSelectorDigest: hash(selector),
  };
  return parseCatalogProductScopeReplacementIntent({ ...body, digest: hash(body) });
}
function command(patch: Partial<ProductPublicationCommandV2> = {}): ProductPublicationCommandV2 {
  const replacementIntent = intent();
  return {
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
    scopeSet: [selector],
    effectivePeriod: period,
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_REPLACEMENT",
    profile: "CatalogProductPublicationCommandV2",
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
    ...patch,
  };
}
function facts(
  c: ProductPublicationCommandV2,
  patch: Partial<ProductPublicationFactsV2> = {},
): ProductPublicationFactsV2 {
  return {
    now: c.occurredAt,
    productAggregateVersion: c.expectedProductAggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      profile: "CatalogProductPublicationValidationV2",
      replacementIntentDigest: c.replacementIntentDigest,
      evidenceReference: id(10),
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(11),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" as const })),
      warningAcknowledgement: null,
      checkedAt: c.occurredAt,
      validUntil: expiry,
    },
    approval: null,
    reviewReference: null,
    replacement: null,
    ...patch,
  };
}
function following(
  current: ProductPublicationVersionV2,
  action: ProductPublicationAction,
  patch: Partial<ProductPublicationCommandV2> = {},
) {
  return command({
    action,
    operationReference: id(100 + current.publicationVersion),
    expectedProductAggregateVersion: current.productAggregateVersion + 1,
    expectedPublicationVersion: current.publicationVersion,
    scopeSet: current.scopeSet,
    effectivePeriod: current.effectivePeriod,
    replacementIntent: current.replacementIntent,
    replacementIntentDigest: current.replacementIntentDigest,
    ...patch,
  });
}
function review(requiredApproval = false, future = false) {
  const c = command({
      effectivePeriod: future ? { ...period, effectiveFrom: boundary(later) } : period,
    }),
    f = facts(c),
    draft = planCatalogProductPublicationV2(c, null, {
      ...f,
      validation: {
        ...f.validation,
        approvalPolicy: requiredApproval ? "Required" : "NotRequired",
        checks: f.validation.checks.map((check) => ({
          ...check,
          outcome:
            requiredApproval && check.code === "ApprovalPolicy"
              ? ("Pending" as const)
              : check.outcome,
        })),
      },
    }),
    submitted = following(draft, "SubmitReview"),
    sf = facts(submitted);
  const version = planCatalogProductPublicationV2(submitted, draft, {
    ...sf,
    reviewReference: id(12),
    validation: {
      ...sf.validation,
      approvalPolicy: draft.approvalPolicy,
      checks: sf.validation.checks.map((check) => ({
        ...check,
        outcome:
          requiredApproval && check.code === "ApprovalPolicy"
            ? ("Pending" as const)
            : check.outcome,
      })),
    },
  });
  return { c, draft, version };
}
function approval(current: ProductPublicationVersionV2): ProductPublicationApprovalV2 {
  return {
    profile: "CatalogProductPublicationApprovalV2",
    replacementIntentDigest: current.replacementIntentDigest,
    evidenceReference: id(14),
    reviewReference: required(current.reviewReference),
    reviewVersion: required(current.reviewVersion),
    requestedByActorReference: id(3),
    approvedByActorReference: id(15),
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
function without(value: object, keys: readonly string[]) {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}
const intentKeys = ["profile", "replacementIntent", "replacementIntentDigest"],
  evidenceKeys = ["profile", "replacementIntentDigest"];

it("binds the same explicit intent through independent approval and immediate publication", () => {
  const { version: submitted } = review(true),
    a = approval(submitted),
    approve = following(submitted, "Approve", { actorReference: id(15) }),
    af = facts(approve),
    approved = planCatalogProductPublicationV2(approve, submitted, {
      ...af,
      validation: { ...af.validation, approvalPolicy: "Required" },
      approval: a,
    }),
    publish = following(approved, "Publish", { successorDraftVersionReference: id(16) }),
    pf = facts(publish),
    published = planCatalogProductPublicationV2(publish, approved, {
      ...pf,
      validation: { ...pf.validation, approvalPolicy: "Required" },
      approval: a,
    });
  expect(published).toMatchObject({
    profile: "CatalogProductPublicationVersionV2",
    state: "Published",
    replacementIntent: intent(),
    replacementIntentDigest: intent().digest,
    approvalEvidenceReference: a.evidenceReference,
    intentDigest: hash(parseProductPublicationCommandV2(publish)),
  });
  expect(published.intentDigest).not.toBe(
    hash(parseProductPublicationCommand(without(publish, intentKeys))),
  );
  expect(recoverCatalogProductPublicationV2(publish, published)).toEqual(published);
});

it("retains the scheduled target through rescheduling and System activation", () => {
  const { version: submitted } = review(false, true),
    schedule = following(submitted, "SchedulePublish", { scheduleReference: id(20) }),
    scheduled = planCatalogProductPublicationV2(schedule, submitted, facts(schedule)),
    moved = "2026-10-02T14:00:00.000Z",
    reschedule = following(scheduled, "ReschedulePublish", {
      scheduleReference: id(20),
      effectivePeriod: { ...period, effectiveFrom: boundary(moved) },
    }),
    rescheduled = planCatalogProductPublicationV2(reschedule, scheduled, facts(reschedule)),
    activate = following(rescheduled, "ActivateScheduled", {
      actorKind: "System",
      actorReference: id(21),
      scheduleReference: id(20),
      successorDraftVersionReference: id(22),
      occurredAt: moved,
    }),
    published = planCatalogProductPublicationV2(activate, rescheduled, facts(activate));
  expect(published.state).toBe("Published");
  expect(published.scheduleVersion).toBe(3);
  expect(published.replacementIntentDigest).toBe(submitted.replacementIntentDigest);
  expect(published.publishedAt).toBe(moved);
  expect(recoverCatalogProductPublicationV2(activate, published)).toEqual(published);
});

it("preserves the target on Reject/Cancel and permits retargeting only by a subsequent Draft Validate", () => {
  const { version: submitted } = review(),
    reject = following(submitted, "Reject", { actorReference: id(15) }),
    rejected = planCatalogProductPublicationV2(reject, submitted, facts(reject)),
    nextIntent = intent(50),
    validate = following(rejected, "Validate", {
      replacementIntent: nextIntent,
      replacementIntentDigest: nextIntent.digest,
    }),
    retargeted = planCatalogProductPublicationV2(validate, rejected, facts(validate));
  expect(retargeted).toMatchObject({
    state: "Draft",
    replacementIntent: nextIntent,
    reviewReference: null,
    reviewVersion: null,
    submittedByActorReference: null,
    approvalEvidenceReference: null,
  });
  const future = review(false, true).version,
    schedule = following(future, "SchedulePublish", { scheduleReference: id(20) }),
    scheduled = planCatalogProductPublicationV2(schedule, future, facts(schedule)),
    cancel = following(scheduled, "CancelScheduledPublish", { scheduleReference: id(20) }),
    cancelled = planCatalogProductPublicationV2(cancel, scheduled, facts(cancel));
  expect(cancelled.state).toBe("Draft");
  expect(cancelled.replacementIntent).toEqual(scheduled.replacementIntent);
  const cancelledValidate = following(cancelled, "Validate", {
    replacementIntent: nextIntent,
    replacementIntentDigest: nextIntent.digest,
  });
  expect(
    planCatalogProductPublicationV2(cancelledValidate, cancelled, facts(cancelledValidate))
      .replacementIntentDigest,
  ).toBe(nextIntent.digest);
});

it("refuses retargeting on review, approval, Publish, Reject, schedule, reschedule, Cancel and activation", () => {
  const { draft, version: submitted } = review(false, true),
    schedule = following(submitted, "SchedulePublish", { scheduleReference: id(20) }),
    scheduled = planCatalogProductPublicationV2(schedule, submitted, facts(schedule)),
    nextIntent = intent(50);
  const requiredReview = review(true, true).version,
    approve = following(requiredReview, "Approve", { actorReference: id(15) }),
    af = facts(approve),
    a = approval(requiredReview),
    approvalFacts = {
      ...af,
      validation: { ...af.validation, approvalPolicy: "Required" as const },
      approval: a,
    },
    approved = planCatalogProductPublicationV2(approve, requiredReview, approvalFacts),
    publish = following(approved, "Publish", {
      successorDraftVersionReference: id(16),
      occurredAt: later,
    }),
    pf = facts(publish),
    publishFacts = {
      ...pf,
      validation: { ...pf.validation, approvalPolicy: "Required" as const },
      approval: a,
    };
  const attempt = (
    current: ProductPublicationVersionV2,
    c: ProductPublicationCommandV2,
    f = facts(c),
  ) => ({ current, c, f });
  const submit = following(draft, "SubmitReview");
  const attempts = [
    attempt(draft, submit, facts(submit, { reviewReference: id(12) })),
    attempt(submitted, following(submitted, "Reject", { actorReference: id(15) })),
    attempt(requiredReview, approve, approvalFacts),
    attempt(approved, publish, publishFacts),
    attempt(submitted, schedule),
    attempt(scheduled, following(scheduled, "ReschedulePublish", { scheduleReference: id(20) })),
    attempt(
      scheduled,
      following(scheduled, "CancelScheduledPublish", { scheduleReference: id(20) }),
    ),
    attempt(
      scheduled,
      following(scheduled, "ActivateScheduled", {
        actorKind: "System",
        actorReference: id(21),
        scheduleReference: id(20),
        successorDraftVersionReference: id(22),
        occurredAt: later,
      }),
    ),
  ];
  for (const { current, c, f } of attempts) {
    expect(() => planCatalogProductPublicationV2(c, current, f)).not.toThrow();
    const changed = {
      ...c,
      replacementIntent: nextIntent,
      replacementIntentDigest: nextIntent.digest,
    };
    const changedFacts = {
      ...f,
      validation: { ...f.validation, replacementIntentDigest: nextIntent.digest },
      approval:
        f.approval === null ? null : { ...f.approval, replacementIntentDigest: nextIntent.digest },
    };
    expect(() => planCatalogProductPublicationV2(changed, current, changedFacts)).toThrow(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
  }
});

it("requires a matching fresh approval for a Required reschedule while retaining its replacement target", () => {
  const submitted = review(true, true).version,
    approve = following(submitted, "Approve", { actorReference: id(15) }),
    a = approval(submitted),
    af = facts(approve),
    approved = planCatalogProductPublicationV2(approve, submitted, {
      ...af,
      validation: { ...af.validation, approvalPolicy: "Required" },
      approval: a,
    }),
    schedule = following(approved, "SchedulePublish", { scheduleReference: id(20) }),
    sf = facts(schedule),
    scheduled = planCatalogProductPublicationV2(schedule, approved, {
      ...sf,
      validation: { ...sf.validation, approvalPolicy: "Required" },
      approval: a,
    }),
    now = "2026-10-02T12:00:01.000Z",
    reschedule = following(scheduled, "ReschedulePublish", {
      scheduleReference: id(20),
      occurredAt: now,
      effectivePeriod: { ...period, effectiveFrom: boundary("2026-10-02T14:00:00.000Z") },
    }),
    rf = facts(reschedule),
    freshApproval = {
      ...a,
      evidenceReference: id(60),
      reviewReference: id(61),
      reviewVersion: scheduled.publicationVersion,
      periodDigest: hash(reschedule.effectivePeriod),
      approvedAt: now,
    },
    freshFacts = {
      ...rf,
      validation: { ...rf.validation, approvalPolicy: "Required" as const },
      approval: freshApproval,
    };
  expect(() =>
    planCatalogProductPublicationV2(reschedule, scheduled, { ...freshFacts, approval: a }),
  ).toThrow();
  expect(() =>
    planCatalogProductPublicationV2(reschedule, scheduled, {
      ...freshFacts,
      approval: { ...freshApproval, replacementIntentDigest: intent(50).digest },
    }),
  ).toThrow();
  const rescheduled = planCatalogProductPublicationV2(reschedule, scheduled, freshFacts);
  expect(rescheduled).toMatchObject({
    state: "Scheduled",
    scheduleVersion: 2,
    approvalEvidenceReference: id(60),
    replacementIntentDigest: scheduled.replacementIntentDigest,
    periodDigest: hash(reschedule.effectivePeriod),
  });
});

it("refuses mismatched validation and even an unused NotRequired approval binding", () => {
  const c = command(),
    f = facts(c);
  expect(() =>
    planCatalogProductPublicationV2(c, null, {
      ...f,
      validation: { ...f.validation, replacementIntentDigest: intent(50).digest },
    }),
  ).toThrow();
  const submitted = review().version,
    publish = following(submitted, "Publish", { successorDraftVersionReference: id(16) });
  expect(() =>
    planCatalogProductPublicationV2(
      publish,
      submitted,
      facts(publish, {
        approval: { ...approval(submitted), replacementIntentDigest: intent(50).digest },
      }),
    ),
  ).toThrow();
  expect(() => planCatalogProductPublicationV2(c, null, { ...f, replacement: {} })).toThrow();
  expect(() =>
    planCatalogProductPublicationV2(c, null, { ...f, currentAuthority: true }),
  ).toThrow();
});

it("keeps existing independent approver, content, period, expiry and Approved state restrictions", () => {
  const submitted = review(true).version,
    c = following(submitted, "Approve", { actorReference: id(15) }),
    f = facts(c),
    a = approval(submitted),
    complete = {
      ...f,
      validation: { ...f.validation, approvalPolicy: "Required" as const },
      approval: a,
    },
    approved = planCatalogProductPublicationV2(c, submitted, complete);
  expect(() =>
    planCatalogProductPublicationV2({ ...c, actorReference: id(3) }, submitted, complete),
  ).toThrow();
  for (const patch of [
    { contentDigest: hash("changed") },
    { periodDigest: hash("changed") },
    { validUntil: at },
  ])
    expect(() =>
      planCatalogProductPublicationV2(c, submitted, { ...complete, approval: { ...a, ...patch } }),
    ).toThrow();
  const retarget = intent(50),
    validate = following(approved, "Validate", {
      replacementIntent: retarget,
      replacementIntentDigest: retarget.digest,
    });
  expect(() => planCatalogProductPublicationV2(validate, approved, facts(validate))).toThrow();
});

it("requires one exact Store selector, a distinct previous version, and no V2 Supersede", () => {
  const c = command();
  for (const scopeSet of [
    [],
    [selector, { ...selector, reference: id(31) }],
    [{ ...selector, level: "Brand", reference: null }],
    [{ ...selector, channelCodes: [] }],
    [{ ...selector, reference: id(31) }],
  ])
    expect(() => parseProductPublicationCommandV2({ ...c, scopeSet })).toThrow();
  expect(() =>
    parseProductPublicationCommandV2({
      ...c,
      versionReference: parseCatalogProductScopeReplacementIntent(c.replacementIntent)
        .previousVersionReference,
    }),
  ).toThrow();
  expect(() =>
    parseProductPublicationCommandV2({
      ...c,
      operationReference: parseCatalogProductScopeReplacementIntent(c.replacementIntent)
        .previousPublicationOperationReference,
    }),
  ).toThrow();
  const submitted = review().version,
    publish = following(submitted, "Publish", {
      successorDraftVersionReference: parseCatalogProductScopeReplacementIntent(c.replacementIntent)
        .previousVersionReference,
    });
  expect(() => parseProductPublicationCommandV2(publish)).toThrow();
  const validPublish = { ...publish, successorDraftVersionReference: id(16) },
    published = planCatalogProductPublicationV2(validPublish, submitted, facts(validPublish));
  expect(() =>
    parseProductPublicationVersionV2({
      ...published,
      successorDraftVersionReference: parseCatalogProductScopeReplacementIntent(c.replacementIntent)
        .previousVersionReference,
    }),
  ).toThrow();
  expect(() =>
    parseProductPublicationVersionV2({
      ...published,
      state: "Superseded",
      actorKind: "System",
      actorReference: id(21),
      supersededAt: at,
      supersededByVersionReference: id(99),
    }),
  ).toThrow();
  expect(() =>
    parseProductPublicationCommandV2({
      ...c,
      action: "Supersede",
      actorKind: "System",
      replacementVersionReference: id(99),
    }),
  ).toThrow();
  expect(() =>
    parseProductPublicationCommandV2({ ...c, replacementIntentDigest: hash("wrong") }),
  ).toThrow();
});

it("strictly separates every V2 parser from absent, undefined, wrong or mixed profiles", () => {
  const { c, draft, version: submitted } = review(),
    f = facts(c);
  const cases: readonly [(value: unknown) => unknown, object][] = [
    [parseProductPublicationCommandV2, c],
    [parseProductPublicationValidationV2, f.validation],
    [parseProductPublicationApprovalV2, approval(submitted)],
    [parseProductPublicationVersionV2, draft],
  ];
  for (const [parse, value] of cases) {
    for (const bad of [undefined, null, "CatalogProductPublicationCommandV1"])
      expect(() => parse({ ...value, profile: bad })).toThrow();
    expect(() => parse(without(value, ["profile"]))).toThrow();
    expect(() => parse({ ...value, permission: true })).toThrow();
    expect(() => parse(without(value, ["replacementIntentDigest"]))).toThrow();
    const getter = vi.fn(() => "CatalogProductPublicationCommandV2"),
      input = { ...value };
    Object.defineProperty(input, "profile", { enumerable: true, get: getter });
    expect(() => parse(input)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  }
  expect(() => parseProductPublicationCommandV2({ ...c, replacementIntent: null })).toThrow();
  expect(() =>
    parseProductPublicationVersionV2({ ...draft, replacementIntent: undefined }),
  ).toThrow();
  expect(() =>
    parseProductPublicationVersionV2({
      ...draft,
      operationReference: parseCatalogProductScopeReplacementIntent(draft.replacementIntent)
        .previousPublicationOperationReference,
    }),
  ).toThrow();
});

it("detaches and freezes parsed nested scopes and intent without evaluating nested getters", () => {
  const raw = {
      ...command(),
      replacementIntent: { ...intent() },
      scopeSet: [{ ...selector, channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] }],
    },
    parsed = parseProductPublicationCommandV2(raw);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.replacementIntent)).toBe(true);
  expect(Object.isFrozen(parsed.scopeSet)).toBe(true);
  expect(Object.isFrozen(parsed.scopeSet[0]?.channelCodes)).toBe(true);
  raw.replacementIntent.previousSelectorIndex = 1;
  required(raw.scopeSet[0]).channelCodes.push("POS");
  expect(
    parseCatalogProductScopeReplacementIntent(parsed.replacementIntent).previousSelectorIndex,
  ).toBe(0);
  expect(parsed.scopeSet[0]?.channelCodes).toEqual(["WEB"]);
  const getter = vi.fn(() => id(40)),
    nested = { ...intent() };
  Object.defineProperty(nested, "previousVersionReference", { enumerable: true, get: getter });
  expect(() =>
    parseProductPublicationCommandV2({ ...command(), replacementIntent: nested }),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("recovers the full original V2 hash and refuses changed intent, operation or forged result binding", () => {
  const c = command(),
    committed = planCatalogProductPublicationV2(c, null, facts(c)),
    original = canonicalizeRfc8785(committed),
    changedIntent = intent(50);
  expect(canonicalizeRfc8785(recoverCatalogProductPublicationV2(c, committed))).toBe(original);
  expect(() =>
    recoverCatalogProductPublicationV2(
      { ...c, replacementIntent: changedIntent, replacementIntentDigest: changedIntent.digest },
      committed,
    ),
  ).toThrow();
  expect(() =>
    recoverCatalogProductPublicationV2({ ...c, operationReference: id(99) }, committed),
  ).toThrow();
  expect(() =>
    recoverCatalogProductPublicationV2(c, {
      ...committed,
      intentDigest: hash(without(c, intentKeys)),
    }),
  ).toThrow();
  expect(() =>
    recoverCatalogProductPublicationV2(c, {
      ...committed,
      replacementIntent: changedIntent,
      replacementIntentDigest: changedIntent.digest,
    }),
  ).toThrow();
});

it("records the held execution instant while retaining the original delayed activation request hash", () => {
  const { version: submitted } = review(false, true);
  const schedule = following(submitted, "SchedulePublish", { scheduleReference: id(20) });
  const scheduled = planCatalogProductPublicationV2(schedule, submitted, facts(schedule));
  const activate = following(scheduled, "ActivateScheduled", {
    actorKind: "System",
    actorReference: id(21),
    scheduleReference: id(20),
    successorDraftVersionReference: id(22),
    occurredAt: later,
  });
  const executedAt = "2026-10-02T13:00:05.000Z";
  const before = canonicalizeRfc8785(activate);
  const published = planCatalogProductPublicationV2(activate, scheduled, {
    ...facts(activate),
    now: executedAt,
  });
  expect(published.occurredAt).toBe(executedAt);
  expect(published.publishedAt).toBe(executedAt);
  expect(published.intentDigest).toBe(hash(parseProductPublicationCommandV2(activate)));
  expect(published.intentDigest).not.toBe(hash({ ...activate, occurredAt: executedAt }));
  expect(canonicalizeRfc8785(activate)).toBe(before);
  expect(recoverCatalogProductPublicationV2(activate, published)).toEqual(published);
  expect(() =>
    recoverCatalogProductPublicationV2({ ...activate, occurredAt: executedAt }, published),
  ).toThrow();
  expect(() =>
    planCatalogProductPublicationV2({ ...activate, occurredAt: expiry }, scheduled, {
      ...facts(activate),
      now: executedAt,
    }),
  ).toThrow();
});

it("uses current execution time for Draft results without extending an expired validation", () => {
  const c = command();
  const f = facts(c);
  const now = "2026-10-02T12:00:01.000Z";
  const planned = planCatalogProductPublicationV2(c, null, { ...f, now });
  expect(planned.occurredAt).toBe(now);
  expect(planned.intentDigest).toBe(hash(parseProductPublicationCommandV2(c)));
  expect(() =>
    planCatalogProductPublicationV2(c, null, {
      ...f,
      now,
      validation: { ...f.validation, validUntil: now },
    }),
  ).toThrow();
  const next = following(planned, "Validate", { occurredAt: at });
  expect(() => planCatalogProductPublicationV2(next, planned, { ...facts(next), now })).toThrow();
});

it("leaves original V1 canonical bodies and hashes intact while V1 entry points reject V2", () => {
  const c = command(),
    f = facts(c),
    baseCommand = parseProductPublicationCommand(without(c, intentKeys)),
    baseValidation = parseProductPublicationValidation(without(f.validation, evidenceKeys)),
    baseFacts = { ...f, validation: baseValidation },
    originalCommand = canonicalizeRfc8785(baseCommand),
    originalValidation = canonicalizeRfc8785(baseValidation),
    v1 = planCatalogProductPublication(baseCommand, null, baseFacts),
    originalVersion = canonicalizeRfc8785(v1),
    v2 = planCatalogProductPublicationV2(c, null, f);
  expect(v1.intentDigest).toBe(hash(baseCommand));
  expect(v2.intentDigest).toBe(hash(parseProductPublicationCommandV2(c)));
  expect(canonicalizeRfc8785(parseProductPublicationCommand(baseCommand))).toBe(originalCommand);
  expect(canonicalizeRfc8785(parseProductPublicationValidation(baseValidation))).toBe(
    originalValidation,
  );
  expect(canonicalizeRfc8785(recoverCatalogProductPublication(baseCommand, v1))).toBe(
    originalVersion,
  );
  expect(canonicalizeRfc8785(baseCommand)).toBe(originalCommand);
  expect(canonicalizeRfc8785(baseValidation)).toBe(originalValidation);
  expect(() => parseProductPublicationCommand(c)).toThrow();
  expect(() => parseProductPublicationValidation(f.validation)).toThrow();
  expect(() => parseProductPublicationVersion(v2)).toThrow();
  expect(() => parseProductPublicationApproval(approval(review(true).version))).toThrow();
  expect(() =>
    planCatalogProductPublicationV2(
      following(v2, "Validate"),
      v1,
      facts(following(v2, "Validate")),
    ),
  ).toThrow();
  expect(() =>
    planCatalogProductPublicationV2(c, null, { ...f, validation: baseValidation }),
  ).toThrow();
});

it("parses explicit None with ordinary scopes without inventing an old publication", () => {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const replacementIntent = parseCatalogProductPublicationReplacementIntent({
    ...body,
    digest: hash(body),
  });
  for (const scopeSet of [
    [selector],
    [selector, { ...selector, reference: id(31) }],
    [{ level: "Brand" as const, reference: null, channelCodes: [], orderTypeCodes: [] }],
  ]) {
    const c = command({
      scopeSet,
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    });
    const parsed = parseProductPublicationCommandV2(c),
      draft = planCatalogProductPublicationV2(c, null, facts(c));
    expect(parsed.replacementIntent).toEqual(replacementIntent);
    expect(draft.intentDigest).toBe(hash(parsed));
    expect(draft.replacementIntent.mode).toBe("None");
    expect(recoverCatalogProductPublicationV2(c, draft)).toEqual(draft);
    expect(() => parseProductPublicationCommand(c)).toThrow();
  }
});

it("changes None to Exact only in Draft Validate and keeps the new full intent through review", () => {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const replacementIntent = parseCatalogProductPublicationReplacementIntent({
    ...body,
    digest: hash(body),
  });
  const c = command({ replacementIntent, replacementIntentDigest: replacementIntent.digest });
  const draft = planCatalogProductPublicationV2(c, null, facts(c));
  const exact = intent(),
    direct = following(draft, "SubmitReview", {
      replacementIntent: exact,
      replacementIntentDigest: exact.digest,
    });
  expect(() =>
    planCatalogProductPublicationV2(direct, draft, facts(direct, { reviewReference: id(12) })),
  ).toThrow();
  const validate = following(draft, "Validate", {
    replacementIntent: exact,
    replacementIntentDigest: exact.digest,
  });
  const changed = planCatalogProductPublicationV2(validate, draft, facts(validate));
  const submit = following(changed, "SubmitReview");
  const submitted = planCatalogProductPublicationV2(
    submit,
    changed,
    facts(submit, { reviewReference: id(12) }),
  );
  const back = following(submitted, "Publish", {
    successorDraftVersionReference: id(16),
    replacementIntent,
    replacementIntentDigest: replacementIntent.digest,
  });
  expect(() => planCatalogProductPublicationV2(back, submitted, facts(back))).toThrow();
  expect(recoverCatalogProductPublicationV2(c, draft)).toEqual(draft);
});
