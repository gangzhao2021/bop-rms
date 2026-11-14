import { expect, it } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
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
  parseProductPublicationValidationV2,
  parseProductPublicationVersionV2,
  planCatalogProductPublicationV2,
  recoverCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationApprovalV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";

// Synthetic pure lifecycle facts. Owning receipt creation and SQL authorization are covered separately.
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
    versionReference: current.versionReference,
    contentDigest: current.contentDigest,
    configurationDigest: current.configurationDigest,
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

function requiredFacts(c: ProductPublicationCommandV2, pending = true): ProductPublicationFactsV2 {
  const f = facts(c);
  return {
    ...f,
    validation: {
      ...f.validation,
      approvalPolicy: "Required",
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome: pending && check.code === "ApprovalPolicy" ? "Pending" : check.outcome,
      })),
    },
  };
}
function technical(f: ProductPublicationFactsV2, outcome: "HardError" | "Warning") {
  return {
    ...f,
    validation: {
      ...f.validation,
      checks: f.validation.checks.map((check) => ({
        ...check,
        outcome:
          check.code === "TaxResolution"
            ? outcome
            : check.code === "HardErrorsCleared" && outcome === "HardError"
              ? ("HardError" as const)
              : check.outcome,
      })),
    },
  };
}
const lifecycleConflict = expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" });
const invalid = expect.objectContaining({ code: "CATALOG_INPUT_INVALID" });

it("keeps required technical readiness Pending from Validate through SubmitReview without a receipt", () => {
  const { c, draft, version } = review(true);
  expect(draft).toMatchObject({
    state: "Draft",
    validationDecision: "ApprovalPending",
    approvalEvidenceReference: null,
  });
  expect(version).toMatchObject({
    state: "InReview",
    validationDecision: "ApprovalPending",
    approvalEvidenceReference: null,
  });
  expect(draft.intentDigest).toBe(hash(c));
  expect(version.replacementIntentDigest).toBe(c.replacementIntentDigest);
  const parsed = parseProductPublicationValidationV2(requiredFacts(c).validation);
  expect(parsed.checks.find((check) => check.code === "ApprovalPolicy")?.outcome).toBe("Pending");
  expect(parsed.checks.find((check) => check.code === "HardErrorsCleared")?.outcome).toBe("Pass");
  expect(Object.isFrozen(parsed.checks)).toBe(true);
});

it("accepts Pending only on the required ApprovalPolicy check and never as a warning override", () => {
  const v = requiredFacts(command()).validation;
  for (const code of productPublicationCheckCodes.filter((value) => value !== "ApprovalPolicy")) {
    expect(() =>
      parseProductPublicationValidationV2({
        ...v,
        checks: v.checks.map((check) =>
          check.code === code ? { ...check, outcome: "Pending" } : check,
        ),
      }),
    ).toThrow(invalid);
  }
  expect(() =>
    parseProductPublicationValidationV2({ ...v, approvalPolicy: "NotRequired" }),
  ).toThrow(invalid);
  expect(() =>
    parseProductPublicationValidationV2({
      ...v,
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "ACK",
        warningCodes: ["ApprovalPolicy"],
      },
    }),
  ).toThrow(invalid);
});

it("refuses newly supplied Required Pass facts or any receipt before independent approval", () => {
  const { c, draft, version } = review(true);
  const submit = following(draft, "SubmitReview");
  for (const [cmd, current] of [
    [c, null],
    [submit, draft],
  ] as const) {
    const f = { ...requiredFacts(cmd, false), reviewReference: id(12) };
    expect(() => planCatalogProductPublicationV2(cmd, current, f)).toThrow(lifecycleConflict);
    expect(() =>
      planCatalogProductPublicationV2(cmd, current, {
        ...requiredFacts(cmd),
        reviewReference: id(12),
        approval: approval(version),
      }),
    ).toThrow(lifecycleConflict);
  }
});

it.each(["HardError", "Warning"] as const)(
  "retains %s with Pending and refuses SubmitReview",
  (outcome) => {
    const c = command(),
      f = technical(requiredFacts(c), outcome);
    const draft = planCatalogProductPublicationV2(c, null, f);
    expect(draft.validationDecision).toBe(
      outcome === "HardError" ? "HardError" : "WarningAcknowledgementRequired",
    );
    const submit = following(draft, "SubmitReview");
    expect(() =>
      planCatalogProductPublicationV2(submit, draft, {
        ...technical(requiredFacts(submit), outcome),
        reviewReference: id(12),
      }),
    ).toThrow(lifecycleConflict);
  },
);

it("allows a separate technical warning acknowledgement while preserving ApprovalPending", () => {
  const c = command(),
    f = technical(requiredFacts(c), "Warning");
  const acknowledged = {
    ...f,
    validation: {
      ...f.validation,
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "ACK_TAX",
        warningCodes: ["TaxResolution" as const],
      },
    },
  };
  const draft = planCatalogProductPublicationV2(c, null, acknowledged);
  expect(draft.validationDecision).toBe("ApprovalPending");
  const submit = following(draft, "SubmitReview");
  const next = technical(requiredFacts(submit), "Warning");
  expect(
    planCatalogProductPublicationV2(submit, draft, {
      ...next,
      reviewReference: id(12),
      validation: {
        ...next.validation,
        warningAcknowledgement: acknowledged.validation.warningAcknowledgement,
      },
    }).validationDecision,
  ).toBe("ApprovalPending");
  expect(() =>
    planCatalogProductPublicationV2(submit, draft, {
      ...next,
      reviewReference: id(12),
      validation: {
        ...next.validation,
        warningAcknowledgement: {
          ...acknowledged.validation.warningAcknowledgement,
          actorReference: id(15),
        },
      },
    }),
  ).toThrow(lifecycleConflict);
});

it("requires actual approval plus Pass, independent actor and the complete original target", () => {
  const submitted = review(true).version;
  const c = following(submitted, "Approve", { actorReference: id(15) });
  const a = approval(submitted),
    f = { ...requiredFacts(c, false), approval: a };
  expect(planCatalogProductPublicationV2(c, submitted, f)).toMatchObject({
    state: "Approved",
    validationDecision: "Pass",
    approvalEvidenceReference: a.evidenceReference,
  });
  expect(() =>
    planCatalogProductPublicationV2(c, submitted, { ...requiredFacts(c), approval: a }),
  ).toThrow(lifecycleConflict);
  expect(() => planCatalogProductPublicationV2(c, submitted, { ...f, approval: null })).toThrow(
    lifecycleConflict,
  );
  expect(() =>
    planCatalogProductPublicationV2({ ...c, actorReference: id(3) }, submitted, f),
  ).toThrow(lifecycleConflict);
  for (const patch of [
    { periodDigest: hash("wrong period") },
    { replacementIntentDigest: intent(50).digest },
    { validUntil: at },
    { reviewVersion: 1 },
    { policyVersion: 2 },
  ]) {
    expect(() =>
      planCatalogProductPublicationV2(c, submitted, { ...f, approval: { ...a, ...patch } }),
    ).toThrow();
  }
  for (const validationDecision of ["HardError", "WarningAcknowledgementRequired"] as const)
    expect(() =>
      planCatalogProductPublicationV2(c, { ...submitted, validationDecision }, f),
    ).toThrow(lifecycleConflict);
});

it("does not accept an acknowledged ApprovalPolicy Warning as actual approval Pass", () => {
  const submitted = review(true).version;
  const c = following(submitted, "Approve", { actorReference: id(15) });
  const f = requiredFacts(c, false);
  expect(() =>
    planCatalogProductPublicationV2(c, submitted, {
      ...f,
      approval: approval(submitted),
      validation: {
        ...f.validation,
        checks: f.validation.checks.map((check) =>
          check.code === "ApprovalPolicy" ? { ...check, outcome: "Warning" } : check,
        ),
        warningAcknowledgement: {
          actorReference: id(15),
          reasonCode: "ACK",
          warningCodes: ["ApprovalPolicy"],
        },
      },
    }),
  ).toThrow(lifecycleConflict);
});

it.each(["Publish", "SchedulePublish", "ActivateScheduled"] as const)(
  "refuses Pending %s despite a syntactically valid receipt",
  (action) => {
    const submitted = review(true, action !== "Publish").version;
    const approve = following(submitted, "Approve", { actorReference: id(15) });
    const a = approval(submitted);
    const approved = planCatalogProductPublicationV2(approve, submitted, {
      ...requiredFacts(approve, false),
      approval: a,
    });
    const schedule = following(approved, "SchedulePublish", { scheduleReference: id(20) });
    const current =
      action === "ActivateScheduled"
        ? planCatalogProductPublicationV2(schedule, approved, {
            ...requiredFacts(schedule, false),
            approval: a,
          })
        : approved;
    const c = following(current, action, {
      actorKind: action === "ActivateScheduled" ? "System" : "User",
      actorReference: action === "ActivateScheduled" ? id(21) : id(3),
      scheduleReference: action === "Publish" ? null : id(20),
      successorDraftVersionReference: action === "SchedulePublish" ? null : id(22),
      occurredAt: action === "ActivateScheduled" ? later : at,
    });
    expect(() =>
      planCatalogProductPublicationV2(c, current, { ...requiredFacts(c), approval: a }),
    ).toThrow(lifecycleConflict);
    expect(() =>
      planCatalogProductPublicationV2(c, current, { ...requiredFacts(c, false), approval: a }),
    ).not.toThrow();
  },
);

it.each(["Reject", "CancelScheduledPublish"] as const)(
  "clears approval and returns %s to Pending without erasing technical negatives",
  (action) => {
    const submitted = review(true, action === "CancelScheduledPublish").version;
    const a = approval(submitted);
    const approve = following(submitted, "Approve", { actorReference: id(15) });
    const approved = planCatalogProductPublicationV2(approve, submitted, {
      ...requiredFacts(approve, false),
      approval: a,
    });
    const schedule = following(approved, "SchedulePublish", { scheduleReference: id(20) });
    const current =
      action === "Reject"
        ? submitted
        : planCatalogProductPublicationV2(schedule, approved, {
            ...requiredFacts(schedule, false),
            approval: a,
          });
    const c = following(current, action, {
      actorReference: id(15),
      scheduleReference: action === "Reject" ? null : id(20),
    });
    const f = requiredFacts(c, false);
    const draft = planCatalogProductPublicationV2(c, current, f);
    expect(draft).toMatchObject({
      state: "Draft",
      validationDecision: "ApprovalPending",
      reviewReference: null,
      reviewVersion: null,
      submittedByActorReference: null,
      approvalEvidenceReference: null,
    });
    expect(draft.replacementIntentDigest).toBe(current.replacementIntentDigest);
    for (const outcome of ["HardError", "Warning"] as const) {
      expect(
        planCatalogProductPublicationV2(c, current, technical(f, outcome)).validationDecision,
      ).toBe(outcome === "HardError" ? "HardError" : "WarningAcknowledgementRequired");
    }
  },
);

it("rejects Pending on NotRequired or released snapshots and preserves historical legal V2 Pass replay bytes", () => {
  const { c, draft, version } = review(true);
  expect(() =>
    parseProductPublicationVersionV2({ ...draft, approvalPolicy: "NotRequired" }),
  ).toThrow(invalid);
  const approve = following(version, "Approve", { actorReference: id(15) });
  const approved = planCatalogProductPublicationV2(approve, version, {
    ...requiredFacts(approve, false),
    approval: approval(version),
  });
  expect(() =>
    parseProductPublicationVersionV2({ ...approved, validationDecision: "ApprovalPending" }),
  ).toThrow(invalid);
  // An explicitly retained prior committed snapshot, not a new validation result.
  const oldDraft = { ...draft, validationDecision: "Pass" as const };
  const before = canonicalizeRfc8785(oldDraft);
  expect(canonicalizeRfc8785(parseProductPublicationVersionV2(oldDraft))).toBe(before);
  expect(canonicalizeRfc8785(recoverCatalogProductPublicationV2(c, oldDraft))).toBe(before);
  const oldReview = { ...version, validationDecision: "Pass" as const };
  expect(
    planCatalogProductPublicationV2(approve, oldReview, {
      ...requiredFacts(approve, false),
      approval: approval(oldReview),
    }).state,
  ).toBe("Approved");
  expect(canonicalizeRfc8785(recoverCatalogProductPublicationV2(c, draft))).toBe(
    canonicalizeRfc8785(draft),
  );
});

it("preserves original request identity and actual held time for Pending Validate and stale refusal", () => {
  const c = command(),
    f = requiredFacts(c),
    now = "2026-10-02T12:00:02.000Z";
  const before = canonicalizeRfc8785(f);
  const draft = planCatalogProductPublicationV2(c, null, { ...f, now });
  expect(draft).toMatchObject({
    occurredAt: now,
    intentDigest: hash(c),
    validationDecision: "ApprovalPending",
  });
  expect(canonicalizeRfc8785(f)).toBe(before);
  expect(() =>
    planCatalogProductPublicationV2(c, null, {
      ...f,
      now,
      validation: { ...f.validation, validUntil: now },
    }),
  ).toThrow(lifecycleConflict);
});

it("uses the same Required V2 approval phases for first None publication and editing its successor", () => {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  const replacementIntent = parseCatalogProductPublicationReplacementIntent({
    ...body,
    digest: hash(body),
  });
  const c = command({ replacementIntent, replacementIntentDigest: replacementIntent.digest });
  const draft = planCatalogProductPublicationV2(c, null, requiredFacts(c));
  const submit = following(draft, "SubmitReview");
  const review = planCatalogProductPublicationV2(submit, draft, {
    ...requiredFacts(submit),
    reviewReference: id(12),
  });
  const approve = following(review, "Approve", { actorReference: id(15) }),
    a = approval(review);
  const approved = planCatalogProductPublicationV2(approve, review, {
    ...requiredFacts(approve, false),
    approval: a,
  });
  const publish = following(approved, "Publish", { successorDraftVersionReference: id(16) });
  const published = planCatalogProductPublicationV2(publish, approved, {
    ...requiredFacts(publish, false),
    approval: a,
  });
  const original = canonicalizeRfc8785(published);
  expect(draft.validationDecision).toBe("ApprovalPending");
  expect(review.validationDecision).toBe("ApprovalPending");
  expect(published).toMatchObject({
    state: "Published",
    validationDecision: "Pass",
    replacementIntent,
  });
  const oldSelector = published.scopeSet[0];
  if (!oldSelector) throw new Error("Missing synthetic selector");
  const exactBody = {
    profile: "CatalogProductExactStoreSelectorReplacementV1",
    mode: "PermanentSelectorRetirement",
    previousVersionReference: published.versionReference,
    previousPublicationOperationReference: published.operationReference,
    expectedPreviousPublicationVersion: published.publicationVersion,
    previousIntentDigest: published.intentDigest,
    previousScopeDigest: published.scopeDigest,
    previousPeriodDigest: published.periodDigest,
    previousSelectorIndex: 0,
    previousSelectorDigest: hash(oldSelector),
  };
  const exact = parseCatalogProductScopeReplacementIntent({
    ...exactBody,
    digest: hash(exactBody),
  });
  const edit = command({
    versionReference: id(16),
    operationReference: id(210),
    expectedProductAggregateVersion: published.productAggregateVersion + 1,
    contentDigest: hash("edited content"),
    replacementIntent: exact,
    replacementIntentDigest: exact.digest,
  });
  const edited = planCatalogProductPublicationV2(edit, null, requiredFacts(edit));
  const resubmit = following(edited, "SubmitReview", { operationReference: id(211) });
  const reviewed = planCatalogProductPublicationV2(resubmit, edited, {
    ...requiredFacts(resubmit),
    reviewReference: id(212),
  });
  const reapprove = following(reviewed, "Approve", {
    operationReference: id(213),
    actorReference: id(15),
  });
  const nextApproval = { ...approval(reviewed), evidenceReference: id(214) };
  expect(() =>
    planCatalogProductPublicationV2(reapprove, reviewed, {
      ...requiredFacts(reapprove, false),
      approval: a,
    }),
  ).toThrow();
  const reapproved = planCatalogProductPublicationV2(reapprove, reviewed, {
    ...requiredFacts(reapprove, false),
    approval: nextApproval,
  });
  const republish = following(reapproved, "Publish", {
    operationReference: id(215),
    successorDraftVersionReference: id(216),
  });
  const second = planCatalogProductPublicationV2(republish, reapproved, {
    ...requiredFacts(republish, false),
    approval: nextApproval,
  });
  expect(second).toMatchObject({
    state: "Published",
    replacementIntent: exact,
    contentDigest: edit.contentDigest,
  });
  expect(canonicalizeRfc8785(recoverCatalogProductPublicationV2(publish, published))).toBe(
    original,
  );
  expect(recoverCatalogProductPublicationV2(republish, second)).toEqual(second);
});
