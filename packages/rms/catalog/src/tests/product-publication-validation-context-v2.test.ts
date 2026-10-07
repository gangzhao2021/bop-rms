import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import {
  createCatalogProductPublicationMaterializationV2,
  deriveCatalogProductPublicationContentIdentity,
} from "../contracts/product-publication-content.js";
import { productPublicationCheckCodes } from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  type ProductPublicationApprovalV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import { parseCatalogProductPublicationReplacementIntent } from "../contracts/product-scope-replacement-intent.js";
import { bindCatalogProductPublicationValidationContextV2 as bind } from "../contracts/product-publication-validation-context-v2.js";

// Pure binding/lifecycle fixtures. These do not provide current source authority,
// an owning approval receipt or complete production validation.
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
const without = (value: object, key: string) =>
  Object.fromEntries(Object.entries(value).filter(([name]) => name !== key));
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
function assertBound(input: Input) {
  const result = bind(input);
  expect(result.command).toEqual(input.command);
  expect(result.originalIntentDigest).toBe(hash(input.command));
  if (input.command.action !== "Validate")
    expect(result.originalIntentDigest).not.toBe(hash({ ...input.command, action: "Validate" }));
  expect(result.replacementIntentDigest).toBe(input.command.replacementIntentDigest);
  expect(result.currentPublicationDigest).toBe(input.current ? hash(input.current) : null);
  expect(result.sourceDraft).toEqual(input.aggregate.draft);
  expect(result.observedAt).toBe(input.observedAt);
  expect(result).toMatchObject({
    sourceAuthority: "NotEvaluated",
    eligibility: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  for (const key of ["validUntil", "validation", "checks", "approval", "authority"])
    expect(Object.hasOwn(result, key)).toBe(false);
  return result;
}

it.each([false, true])(
  "binds actual Required Validate→Review→Approve→Publish commands without projecting action (Exact=%s)",
  (exact) => {
    const sequence = review(exact),
      publish = following(sequence.approve, "Publish", sequence.approval);
    for (const input of [sequence.validate, sequence.submit, sequence.approve, publish])
      assertBound(input);
    const result = applied(publish, sequence.approval);
    expect(result.publication.state).toBe("Published");
    expect(result.aggregate.draft.versionReference).not.toBe(publish.command.versionReference);
    expect(bind(publish).sourceDraft.versionReference).toBe(publish.command.versionReference);
  },
);

it.each([false, true])(
  "binds actual Schedule/Cancel and delayed System activation with original planned time (Exact=%s)",
  (exact) => {
    const sequence = review(exact, true),
      schedule = following(sequence.approve, "SchedulePublish", sequence.approval),
      cancel = following(schedule, "CancelScheduledPublish", sequence.approval),
      activate = following(schedule, "ActivateScheduled", sequence.approval, { occurredAt: due });
    assertBound(schedule);
    assertBound(cancel);
    expect(applied(cancel).publication.state).toBe("Draft");
    // A later owning root observation must not rewrite the stable schedule command.
    activate.observedAt = later;
    activate.aggregate = parseProductAggregate({
      ...activate.aggregate,
      updatedAt: "2026-10-03T13:00:05.000Z",
    });
    const context = assertBound(activate),
      published = applied(activate, sequence.approval).publication;
    expect(context.command.occurredAt).toBe(due);
    expect(context.command.scheduleReference).toBe(activate.current?.scheduleReference);
    expect(published.occurredAt).toBe(later);
    expect(published.intentDigest).toBe(context.originalIntentDigest);
  },
);

it("binds Reject without manufacturing a new approval or a pass result", () => {
  const sequence = review(),
    reject = {
      ...sequence.approve,
      command: parseProductPublicationCommandV2({ ...sequence.approve.command, action: "Reject" }),
    };
  assertBound(reject);
  expect(applied(reject).publication.validationDecision).toBe("ApprovalPending");
});

it.each([false, true])(
  "allows Draft Validate to change None/Exact targets while freezing subsequent commands (old Exact=%s)",
  (exact) => {
    const prior = initial(exact),
      next = following(prior, "Validate"),
      target = replacement(!exact);
    const retarget = {
      ...next,
      command: parseProductPublicationCommandV2({
        ...next.command,
        replacementIntent: target,
        replacementIntentDigest: target.digest,
      }),
    };
    assertBound(retarget);
    const submit = following(retarget, "SubmitReview"),
      originalTarget = replacement(exact);
    expect(() =>
      bind({
        ...submit,
        command: {
          ...submit.command,
          replacementIntent: originalTarget,
          replacementIntentDigest: originalTarget.digest,
        },
      }),
    ).toThrow();
  },
);

it("revalidates an edited Draft across intervening root changes while retaining the old publication head", () => {
  const prior = following(initial(), "Validate"),
    editedAt = "2026-10-03T12:00:01.000Z",
    validatedAt = "2026-10-03T12:00:02.000Z",
    aggregate = parseProductAggregate({
      ...prior.aggregate,
      aggregateVersion: prior.aggregate.aggregateVersion + 1,
      updatedAt: editedAt,
      draft: {
        ...prior.aggregate.draft,
        localizedNames: { "en-CA": "Synthetic edited context" },
        updatedAt: editedAt,
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    input = {
      ...prior,
      aggregate,
      command: parseProductPublicationCommandV2({
        ...prior.command,
        expectedProductAggregateVersion: aggregate.aggregateVersion,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
        occurredAt: validatedAt,
      }),
      observedAt: validatedAt,
    };
  if (prior.current === null) throw Error("Missing previous synthetic Validate head");
  expect(aggregate.aggregateVersion - prior.current.productAggregateVersion).toBeGreaterThan(1);
  expect(identity.contentDigest).not.toBe(prior.current.contentDigest);
  expect(input.current).toBe(prior.current);
  const context = assertBound(input),
    result = applied(input);
  expect(context.sourceDraft.localizedNames["en-CA"]).toBe("Synthetic edited context");
  expect(context.currentPublicationDigest).toBe(hash(prior.current));
  expect(result.publication).toMatchObject({
    state: "Draft",
    validationDecision: "ApprovalPending",
    publicationVersion: prior.current.publicationVersion + 1,
    productAggregateVersion: aggregate.aggregateVersion,
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
  });
  expect(result.aggregate.aggregateVersion).toBe(aggregate.aggregateVersion + 1);
});

it("keeps Reschedule's changed period bound without claiming its Required receipt chain is available", () => {
  const sequence = review(false, true),
    schedule = following(sequence.approve, "SchedulePublish", sequence.approval),
    reschedule = following(schedule, "ReschedulePublish", sequence.approval, {
      effectivePeriod: { timeZone: "UTC", effectiveFrom: boundary(later), effectiveUntil: null },
    });
  const context = assertBound(reschedule);
  expect(context.periodDigest).not.toBe(context.current?.periodDigest);
  expect(() => applied(reschedule, sequence.approval)).toThrow();
});

it("returns isolated readonly values, including full intent and current publication", () => {
  const input = structuredClone(review(true).approve),
    before = hash(input),
    result = bind(input);
  expect(hash(input)).toBe(before);
  expect(result.command).not.toBe(input.command);
  expect(result.aggregate).not.toBe(input.aggregate);
  expect(result.current).not.toBe(input.current);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.command.replacementIntent)).toBe(true);
  expect(Object.isFrozen(result.sourceDraft.editorContent?.media)).toBe(true);
  expect(Object.isFrozen(result.current)).toBe(true);
  Object.assign(input.aggregate.draft.localizedNames, { "en-CA": "Changed after binding" });
  Object.assign(input.command.replacementIntent, { digest: hash("changed after binding") });
  expect(result.sourceDraft.localizedNames["en-CA"]).toBe("Synthetic context");
  expect(result.command.replacementIntent.digest).not.toBe(input.command.replacementIntent.digest);
});

it("marks a real minimal Draft unavailable without inventing full content", () => {
  const input = initial(),
    aggregate = parseProductAggregate({
      ...input.aggregate,
      draft: without(input.aggregate.draft, "editorContent"),
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const result = bind({
    ...input,
    aggregate,
    command: {
      ...input.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    },
  });
  expect(result.completeContent).toBe("Unavailable");
  expect(result.sourceDraft.editorContent).toBeUndefined();
  expect(result.publishValidation).toBe("Incomplete");
});

it.each([
  [
    "command root",
    (input: Input) => ({
      ...input,
      command: { ...input.command, expectedProductAggregateVersion: 8 },
    }),
  ],
  [
    "Brand",
    (input: Input) => ({ ...input, command: { ...input.command, brandReference: id(90) } }),
  ],
  [
    "Product",
    (input: Input) => ({ ...input, command: { ...input.command, productReference: id(90) } }),
  ],
  [
    "Draft",
    (input: Input) => ({ ...input, command: { ...input.command, versionReference: id(90) } }),
  ],
  [
    "content digest",
    (input: Input) => ({ ...input, command: { ...input.command, contentDigest: hash("wrong") } }),
  ],
  [
    "configuration digest",
    (input: Input) => ({
      ...input,
      command: { ...input.command, configurationDigest: hash("wrong") },
    }),
  ],
  [
    "missing initial head",
    (input: Input) => ({ ...input, command: { ...input.command, expectedPublicationVersion: 1 } }),
  ],
  [
    "future command",
    (input: Input) => ({ ...input, command: { ...input.command, occurredAt: later } }),
  ],
  [
    "observation before the command",
    (input: Input) => ({ ...input, observedAt: "2026-10-03T11:59:59.999Z" }),
  ],
  ["extra lease", (input: Input) => ({ ...input, validUntil: expiry })],
  ["noncanonical clock", (input: Input) => ({ ...input, observedAt: "2026-10-03T12:00:00Z" })],
  ["content substitution", (input: Input) => ({ ...input, content: {} })],
  [
    "wrong actor/action",
    (input: Input) => ({ ...input, command: { ...input.command, actorKind: "System" } }),
  ],
  [
    "unknown action",
    (input: Input) => ({ ...input, command: { ...input.command, action: "ValidateAndPublish" } }),
  ],
] as const)("refuses wrong writer context: %s", (_name, mutate) => {
  expect(() => bind(mutate(initial()))).toThrow();
});

it.each([
  ["Tenant", { tenantReference: id(90) }],
  ["Brand", { brandReference: id(90) }],
  ["Product", { productReference: id(90) }],
  ["version", { versionReference: id(90) }],
  ["publication revision", { publicationVersion: 3 }],
  ["uncommitted root", { productAggregateVersion: 9 }],
  ["future recorded time", { occurredAt: later }],
  ["content", { contentDigest: hash("wrong") }],
  ["configuration", { configurationDigest: hash("wrong") }],
] as const)("refuses mismatched current publication %s", (_name, patch) => {
  const input = review().approve;
  expect(() => bind({ ...input, current: { ...input.current, ...patch } })).toThrow();
});

it("refuses changed frozen scope/period and a missing head for later actions", () => {
  const input = review().approve;
  expect(() => bind({ ...input, current: null })).toThrow();
  expect(() =>
    bind({
      ...input,
      command: { ...input.command, scopeSet: [{ ...selector, reference: id(31) }] },
    }),
  ).toThrow();
  expect(() =>
    bind({
      ...input,
      command: {
        ...input.command,
        effectivePeriod: { ...input.command.effectivePeriod, effectiveFrom: boundary(due) },
      },
    }),
  ).toThrow();
});

it("refuses a User command older than the actual root and observations older than the Draft", () => {
  const input = initial();
  expect(() =>
    bind({ ...input, observedAt: later, aggregate: { ...input.aggregate, updatedAt: due } }),
  ).toThrow();
  const aggregate = parseProductAggregate({
    ...input.aggregate,
    draft: { ...input.aggregate.draft, updatedAt: later },
  });
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  expect(() =>
    bind({
      ...input,
      aggregate,
      command: {
        ...input.command,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      },
    }),
  ).toThrow();
});

it("keeps Supersede closed even with real frozen content and a different successor Draft", () => {
  const sequence = review(),
    publish = following(sequence.approve, "Publish", sequence.approval),
    publication = applied(publish, sequence.approval).publication,
    materialized = createCatalogProductPublicationMaterializationV2(publish.aggregate, publication);
  const supersede = {
    ...publish.command,
    action: "Supersede",
    actorKind: "System",
    operationReference: id(90),
    expectedProductAggregateVersion: materialized.successor.aggregateVersion,
    expectedPublicationVersion: publication.publicationVersion,
    successorDraftVersionReference: null,
    replacementVersionReference: id(91),
  };
  expect(materialized.content.sourceDraft.versionReference).not.toBe(
    materialized.successor.draft.versionReference,
  );
  expect(() =>
    bind({
      command: supersede,
      aggregate: materialized.successor,
      current: publication,
      content: materialized.content,
      observedAt: at,
    }),
  ).toThrow();
  expect(() =>
    bind({ ...publish, aggregate: materialized.successor, content: materialized.content }),
  ).toThrow();
});

it("rejects hostile context descriptors without evaluating getters", () => {
  const input = initial(),
    read = vi.fn(() => input.command),
    hostile = { ...input };
  Object.defineProperty(hostile, "command", { enumerable: true, get: read });
  expect(() => bind(hostile)).toThrow();
  expect(read).not.toHaveBeenCalled();
  expect(() => bind(Object.assign(Object.create({ authority: true }), input))).toThrow();
});
