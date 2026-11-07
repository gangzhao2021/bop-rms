import { createCurrentProductPublicationService } from "../application/current-product-publication.js";
import { buildProductPublicationSourceSnapshot } from "../contracts/product-publication-source.js";
import {
  buildCatalogProductPublicationEvent,
  catalogProductPublicationAuditAction,
} from "../contracts/product-publication-event.js";
import { parseProductAggregate, type ProductAggregate } from "../contracts/product.js";
import {
  createCatalogProductPublicationMaterialization,
  parseCatalogProductPublicationContent,
  deriveCatalogProductPublicationContentIdentity,
} from "../contracts/product-publication-content.js";
import { buildCatalogInventorySkuReferenceSnapshot } from "../contracts/inventory-sku-reference-source.js";
import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseProductPublicationCommand,
  parseProductPublicationVersion,
  parseProductPublicationValidation,
  planCatalogProductPublication,
  recoverCatalogProductPublication,
  resolveCatalogProductPublication,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  type ProductPublicationAction,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
  type ProductPublicationVersion,
  type ProductPublicationScope,
  type ProductPublicationPeriod,
} from "../contracts/product-publication.js";
const id = (n: number) => "01902420-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-29T12:00:00.000Z",
  later = "2026-09-29T13:00:00.000Z",
  expiry = "2026-09-30T00:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
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
const scope: readonly ProductPublicationScope[] = [
  { level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] },
];
function command(p: Partial<ProductPublicationCommand> = {}): ProductPublicationCommand {
  return {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(4),
    productReference: id(5),
    versionReference: id(6),
    expectedProductAggregateVersion: 4,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash("content"),
    configurationDigest: hash("configuration"),
    scopeSet: scope,
    effectivePeriod: period,
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "EDITOR_REQUEST",
    ...p,
  };
}
function facts(
  c: ProductPublicationCommand,
  p: Partial<ProductPublicationFacts> = {},
): ProductPublicationFacts {
  return {
    now: c.occurredAt,
    productAggregateVersion: c.expectedProductAggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      evidenceReference: id(10),
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(11),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: c.occurredAt,
      validUntil: expiry,
    },
    approval: null,
    reviewReference: null,
    replacement: null,
    ...p,
  };
}
function step(
  action: ProductPublicationCommand["action"],
  current: ProductPublicationVersion,
  p: Partial<ProductPublicationCommand> = {},
  f: Partial<ProductPublicationFacts> = {},
): ProductPublicationVersion {
  const c = command({ action, expectedPublicationVersion: current.publicationVersion, ...p });
  return planCatalogProductPublication(c, current, facts(c, f));
}
function draft(p: Partial<ProductPublicationCommand> = {}): ProductPublicationVersion {
  const c = command(p);
  return planCatalogProductPublication(c, null, facts(c));
}
function submitted(p: Partial<ProductPublicationCommand> = {}): ProductPublicationVersion {
  return step("SubmitReview", draft(p), p, { reviewReference: id(12) });
}
function published(p: Partial<ProductPublicationCommand> = {}): ProductPublicationVersion {
  return step("Publish", submitted(p), { successorDraftVersionReference: id(13), ...p });
}
function requiredFlow() {
  const c = command(),
    f = facts(c);
  const validation = { ...f.validation, approvalPolicy: "Required" as const };
  const d = planCatalogProductPublication(c, null, { ...f, validation });
  const s = step("SubmitReview", d, {}, { validation, reviewReference: id(12) });
  const approval = {
    evidenceReference: id(14),
    reviewReference: id(12),
    reviewVersion: s.reviewVersion ?? 0,
    requestedByActorReference: id(3),
    approvedByActorReference: id(15),
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: f.scopeDigest,
    periodDigest: f.periodDigest,
    policyReference: id(11),
    policyVersion: 1,
    approvedAt: at,
    validUntil: expiry,
  };
  return { c, validation, s, approval };
}
const context = {
  storeReference: id(20),
  storeGroupReferences: [id(21)],
  regionReferences: [id(22)],
  channelCode: "WEB",
  orderTypeCode: "PICKUP",
  at,
};
describe("Product-owned publication contracts and plans", () => {
  it("requires a complete closed command and never evaluates getters", () => {
    const c = command(),
      getter = vi.fn(() => c.action);
    Object.defineProperty(c, "action", { enumerable: true, get: getter });
    expect(() => parseProductPublicationCommand(c)).toThrow(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
    expect(getter).not.toHaveBeenCalled();
    expect(() => parseProductPublicationCommand({ ...command(), permission: true })).toThrow();
    expect(() =>
      parseProductPublicationCommand(Object.assign(Object.create({}), command())),
    ).toThrow();
  });
  it("rejects unknown checks, omitted checks, duplicate checks and sparse arrays", () => {
    const f = facts(command());
    expect(() =>
      parseProductPublicationValidation({ ...f.validation, checks: f.validation.checks.slice(1) }),
    ).toThrow();
    expect(() =>
      parseProductPublicationValidation({
        ...f.validation,
        checks: f.validation.checks.map(() => f.validation.checks[0]),
      }),
    ).toThrow();
    const checks = Array.from(f.validation.checks);
    delete checks[1];
    expect(() => parseProductPublicationValidation({ ...f.validation, checks })).toThrow();
  });
  it("canonicalizes selectors and rejects duplicate or contradictory selectors", () => {
    const selector = {
      level: "Store" as const,
      reference: id(20),
      channelCodes: ["WEB", "POS"],
      orderTypeCodes: [],
    };
    const c = parseProductPublicationCommand(
      command({
        scopeSet: [
          selector,
          { level: "Brand" as const, reference: null, channelCodes: [], orderTypeCodes: [] },
        ],
      }),
    );
    expect(c.scopeSet.find((s) => s.level === "Store")?.channelCodes).toEqual(["POS", "WEB"]);
    expect(() =>
      parseProductPublicationCommand(command({ scopeSet: [selector, selector] })),
    ).toThrow();
    expect(() =>
      parseProductPublicationCommand(
        command({
          scopeSet: [{ ...selector, level: "Channel", reference: "WEB", channelCodes: ["POS"] }],
        }),
      ),
    ).toThrow();
  });
  it("validates IANA boundary and half-open ordering", () => {
    expect(() =>
      parseProductPublicationCommand(
        command({ effectivePeriod: { ...period, timeZone: "Not/AZone" } }),
      ),
    ).toThrow();
    expect(() =>
      parseProductPublicationCommand(
        command({ effectivePeriod: { ...period, effectiveUntil: boundary(at) } }),
      ),
    ).toThrow();
    expect(() =>
      parseProductPublicationCommand(
        command({
          effectivePeriod: { ...period, effectiveFrom: { ...boundary(at), utcOffsetMinutes: 60 } },
        }),
      ),
    ).toThrow();
  });
  it("validates a Draft, submits then publishes without optional approval", () => {
    const s = submitted(),
      p = step("Publish", s, { successorDraftVersionReference: id(13) });
    expect(s.state).toBe("InReview");
    expect(p.state).toBe("Published");
    expect(p.successorDraftVersionReference).toBe(id(13));
    expect(p.publicationVersion).toBe(3);
    expect(Object.isFrozen(p.scopeSet[0]?.channelCodes)).toBe(true);
    expect(() => step("Validate", p)).toThrow(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
  });
  it("requires source-root and snapshot digests to match held facts", () => {
    const c = command(),
      f = facts(c);
    for (const changed of [
      { productAggregateVersion: 3 },
      { contentDigest: hash("changed") },
      { scopeDigest: hash("changed") },
      { periodDigest: hash("changed") },
    ])
      expect(() => planCatalogProductPublication(c, null, { ...f, ...changed })).toThrow(
        expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
      );
    const d = draft();
    expect(() =>
      step("SubmitReview", d, { expectedProductAggregateVersion: 3 }, { reviewReference: id(12) }),
    ).toThrow();
  });
  it("rejects validation checked in the future or expired at the instant", () => {
    const c = command(),
      f = facts(c);
    expect(() =>
      planCatalogProductPublication(c, null, {
        ...f,
        validation: { ...f.validation, checkedAt: later },
      }),
    ).toThrow();
    expect(() => planCatalogProductPublication(c, null, { ...f, now: expiry })).toThrow(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
  });
  it("records HardError but never overrides it with warning acknowledgement", () => {
    const c = command(),
      f = facts(c),
      checks = f.validation.checks.map((v) => ({
        ...v,
        outcome:
          v.code === "MediaReady" || v.code === "HardErrorsCleared"
            ? ("HardError" as const)
            : v.code === "TaxResolution"
              ? ("Warning" as const)
              : v.outcome,
      })),
      validation = {
        ...f.validation,
        checks,
        warningAcknowledgement: {
          actorReference: id(3),
          reasonCode: "ACK_WARNING",
          warningCodes: ["TaxResolution" as const],
        },
      };
    const d = planCatalogProductPublication(c, null, { ...f, validation });
    expect(d.validationDecision).toBe("HardError");
    expect(() => step("SubmitReview", d, {}, { validation, reviewReference: id(12) })).toThrow(
      expect.objectContaining({ code: "CATALOG_LIFECYCLE_CONFLICT" }),
    );
  });
  it("requires every warning acknowledged by the current action actor", () => {
    const c = command(),
      f = facts(c),
      checks = f.validation.checks.map((v) => ({
        ...v,
        outcome: v.code === "TaxResolution" ? ("Warning" as const) : v.outcome,
      })),
      validation = { ...f.validation, checks };
    const d = planCatalogProductPublication(c, null, { ...f, validation });
    expect(d.validationDecision).toBe("WarningAcknowledgementRequired");
    expect(() => step("SubmitReview", d, {}, { validation, reviewReference: id(12) })).toThrow();
    const ack = {
      ...validation,
      warningAcknowledgement: {
        actorReference: id(3),
        reasonCode: "ACK_WARNING",
        warningCodes: ["TaxResolution" as const],
      },
    };
    expect(step("SubmitReview", d, {}, { validation: ack, reviewReference: id(12) }).state).toBe(
      "InReview",
    );
    expect(() =>
      step(
        "SubmitReview",
        d,
        {},
        {
          validation: {
            ...ack,
            warningAcknowledgement: { ...ack.warningAcknowledgement, actorReference: id(15) },
          },
          reviewReference: id(12),
        },
      ),
    ).toThrow();
  });
  it("pins approval to review, policy, content, scope and time; requires a different actor", () => {
    const { validation, s, approval } = requiredFlow();
    expect(() => step("Approve", s, {}, { validation, approval })).toThrow();
    const p = { actorReference: id(15) };
    expect(step("Approve", s, p, { validation, approval }).state).toBe("Approved");
    for (const changed of [
      { reviewVersion: 99 },
      { periodDigest: hash("changed") },
      { policyVersion: 2 },
      { scopeDigest: hash("changed") },
    ])
      expect(() =>
        step("Approve", s, p, { validation, approval: { ...approval, ...changed } }),
      ).toThrow();
  });
  it("rejects a review to editable Draft and preserves the input record", () => {
    const s = submitted();
    const d = step("Reject", s, { actorReference: id(15) });
    expect(d.state).toBe("Draft");
    expect(d.reviewReference).toBeNull();
    expect(s.reviewReference).toBe(id(12));
    expect(step("Validate", d).state).toBe("Draft");
  });
  it("accepts an unexpired older approval for publication after source revalidation", () => {
    const { validation, s, approval } = requiredFlow();
    const approved = step("Approve", s, { actorReference: id(15) }, { validation, approval });
    const c = command({
        action: "Publish",
        expectedPublicationVersion: approved.publicationVersion,
        occurredAt: later,
        successorDraftVersionReference: id(13),
      }),
      f = facts(c);
    expect(
      planCatalogProductPublication(c, approved, {
        ...f,
        validation: { ...f.validation, approvalPolicy: "Required" },
        approval,
      }).state,
    ).toBe("Published");
  });
  it("schedules, reschedules, cancels then permits fresh validation", () => {
    const future = { ...period, effectiveFrom: boundary(later) },
      p = { effectivePeriod: future };
    const s = submitted(p);
    const scheduled = step("SchedulePublish", s, { ...p, scheduleReference: id(30) });
    expect(scheduled.scheduleVersion).toBe(1);
    const secondPeriod = { ...period, effectiveFrom: boundary("2026-09-29T14:00:00.000Z") };
    const rescheduled = step("ReschedulePublish", scheduled, {
      effectivePeriod: secondPeriod,
      scheduleReference: id(30),
    });
    expect(rescheduled.scheduleVersion).toBe(2);
    const cancelled = step("CancelScheduledPublish", rescheduled, {
      effectivePeriod: secondPeriod,
      scheduleReference: id(30),
    });
    expect(cancelled.state).toBe("Draft");
    expect(cancelled.scheduleVersion).toBe(3);
    expect(step("Validate", cancelled, { effectivePeriod: secondPeriod }).state).toBe("Draft");
    expect(scheduled.effectivePeriod.effectiveFrom.instant).toBe(later);
  });
  it("only activates a matching due schedule as the system with a real successor identity", () => {
    const p = { effectivePeriod: { ...period, effectiveFrom: boundary(later) } };
    const scheduled = step("SchedulePublish", submitted(p), { ...p, scheduleReference: id(30) });
    const a = {
      ...p,
      actorKind: "System" as const,
      scheduleReference: id(30),
      successorDraftVersionReference: id(13),
    };
    expect(() => step("ActivateScheduled", scheduled, a)).toThrow();
    expect(() =>
      step("ActivateScheduled", scheduled, { ...a, occurredAt: later, scheduleReference: id(31) }),
    ).toThrow();
    expect(step("ActivateScheduled", scheduled, { ...a, occurredAt: later }).state).toBe(
      "Published",
    );
    expect(() =>
      parseProductPublicationCommand(
        command({ action: "Publish", successorDraftVersionReference: id(6) }),
      ),
    ).toThrow();
  });
  it("requires a newly approved exact period when rescheduling an approved version", () => {
    const future = { ...period, effectiveFrom: boundary(later) },
      c = command({ effectivePeriod: future }),
      f = facts(c);
    const validation = { ...f.validation, approvalPolicy: "Required" as const };
    const d = planCatalogProductPublication(c, null, { ...f, validation });
    const s = step(
      "SubmitReview",
      d,
      { effectivePeriod: future },
      { validation, reviewReference: id(12) },
    );
    const approval = {
      evidenceReference: id(14),
      reviewReference: id(12),
      reviewVersion: s.reviewVersion ?? 0,
      requestedByActorReference: id(3),
      approvedByActorReference: id(15),
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: f.scopeDigest,
      periodDigest: f.periodDigest,
      policyReference: id(11),
      policyVersion: 1,
      approvedAt: at,
      validUntil: expiry,
    };
    const approved = step(
      "Approve",
      s,
      { effectivePeriod: future, actorReference: id(15) },
      { validation, approval },
    );
    const scheduled = step(
      "SchedulePublish",
      approved,
      { effectivePeriod: future, scheduleReference: id(30) },
      { validation, approval },
    );
    const changed = { ...period, effectiveFrom: boundary("2026-09-29T14:00:00.000Z") },
      change = command({ effectivePeriod: changed }),
      newFacts = facts(change),
      newValidation = { ...newFacts.validation, approvalPolicy: "Required" as const };
    const p = { effectivePeriod: changed, scheduleReference: id(30) };
    expect(() =>
      step("ReschedulePublish", scheduled, p, { validation: newValidation, approval }),
    ).toThrow();
    const timingApproval = {
      ...approval,
      evidenceReference: id(31),
      reviewReference: id(32),
      reviewVersion: scheduled.publicationVersion,
      periodDigest: newFacts.periodDigest,
    };
    const moved = step("ReschedulePublish", scheduled, p, {
      validation: newValidation,
      approval: timingApproval,
    });
    expect(moved.approvalEvidenceReference).toBe(id(31));
    expect(moved.reviewReference).toBe(id(32));
    expect(moved.scheduleVersion).toBe(2);
    const activation = {
      ...p,
      occurredAt: "2026-09-29T14:00:00.000Z",
      actorKind: "System" as const,
      successorDraftVersionReference: id(13),
    };
    const activationValidation = { ...newValidation, checkedAt: activation.occurredAt };
    expect(() =>
      step("ActivateScheduled", moved, activation, { validation: activationValidation, approval }),
    ).toThrow();
    expect(
      step("ActivateScheduled", moved, activation, {
        validation: activationValidation,
        approval: timingApproval,
      }).state,
    ).toBe("Published");
  });
  it("rejects contradictory hard-error summary and impossible persisted phase metadata", () => {
    const f = facts(command());
    const checks = f.validation.checks.map((c) => ({
      ...c,
      outcome: c.code === "MediaReady" ? ("HardError" as const) : c.outcome,
    }));
    expect(() => parseProductPublicationValidation({ ...f.validation, checks })).toThrow();
    const p = published();
    expect(() =>
      parseProductPublicationVersion({ ...p, validationDecision: "HardError" }),
    ).toThrow();
    expect(() =>
      parseProductPublicationVersion({ ...draft(), approvalEvidenceReference: id(14) }),
    ).toThrow();
  });
  it("supersedes only with the owning published same-scope replacement fact", () => {
    const p = published(),
      replacement = {
        productReference: p.productReference,
        versionReference: id(40),
        scopeDigest: p.scopeDigest,
        state: "Published" as const,
        publishedAt: later,
      };
    const c = {
      actorKind: "System" as const,
      replacementVersionReference: id(40),
      occurredAt: later,
    };
    expect(() => step("Supersede", p, c)).toThrow();
    expect(() =>
      step("Supersede", p, c, { replacement: { ...replacement, scopeDigest: hash("other") } }),
    ).toThrow();
    const old = step("Supersede", p, c, { replacement });
    expect(old.state).toBe("Superseded");
    expect(
      resolveCatalogProductPublication([old], context, productPublicationScopeLevels).outcome,
    ).toBe("Selected");
    expect(
      resolveCatalogProductPublication(
        [old],
        { ...context, at: later },
        productPublicationScopeLevels,
      ).outcome,
    ).toBe("Unavailable");
  });
  it("recovers the original committed result without present source facts", () => {
    const c = command(),
      d = planCatalogProductPublication(c, null, facts(c));
    expect(recoverCatalogProductPublication(c, d)).toEqual(d);
    expect(() => recoverCatalogProductPublication({ ...c, reasonCode: "OTHER_REASON" }, d)).toThrow(
      expect.objectContaining({ code: "CATALOG_IDEMPOTENCY_CONFLICT" }),
    );
    expect(() =>
      recoverCatalogProductPublication({ ...c, operationReference: id(99) }, d),
    ).toThrow();
  });
  it("selects exact scope using explicit policy and rejects ambiguous ties", () => {
    const brand = published(),
      store = published({
        versionReference: id(50),
        scopeSet: [
          { level: "Store", reference: id(20), channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] },
        ],
      });
    expect(
      resolveCatalogProductPublication([brand, store], context, productPublicationScopeLevels),
    ).toMatchObject({ outcome: "Selected", versionReference: id(50) });
    const reversed = [...productPublicationScopeLevels].reverse();
    expect(resolveCatalogProductPublication([brand, store], context, reversed)).toMatchObject({
      outcome: "Selected",
      versionReference: id(6),
    });
    const another = published({ versionReference: id(51), scopeSet: store.scopeSet });
    expect(
      resolveCatalogProductPublication([store, another], context, productPublicationScopeLevels),
    ).toMatchObject({ outcome: "Conflict", versionReferences: [id(50), id(51)] });
  });
  it("does not substitute timestamps for scope priority or ignore qualifiers", () => {
    const p = published({
      scopeSet: [
        { level: "StoreGroup", reference: id(21), channelCodes: ["POS"], orderTypeCodes: [] },
      ],
    });
    expect(
      resolveCatalogProductPublication([p], context, productPublicationScopeLevels).outcome,
    ).toBe("Unavailable");
    expect(
      resolveCatalogProductPublication(
        [p],
        { ...context, channelCode: "POS" },
        productPublicationScopeLevels,
      ).outcome,
    ).toBe("Selected");
    const finite = published({ effectivePeriod: { ...period, effectiveUntil: boundary(later) } });
    expect(
      resolveCatalogProductPublication(
        [finite],
        { ...context, at: later },
        productPublicationScopeLevels,
      ).outcome,
    ).toBe("Unavailable");
  });
  it("rejects duplicate version records, cross-brand candidates and incomplete scope order", () => {
    const p = published();
    expect(() =>
      resolveCatalogProductPublication([p, p], context, productPublicationScopeLevels),
    ).toThrow();
    expect(() =>
      resolveCatalogProductPublication(
        [p, { ...p, brandReference: id(90), versionReference: id(91) }],
        context,
        productPublicationScopeLevels,
      ),
    ).toThrow();
    expect(() => resolveCatalogProductPublication([p], context, ["Store"])).toThrow();
    expect(() =>
      parseProductPublicationVersion({ ...p, scopeDigest: hash("fabricated") }),
    ).toThrow();
  });
});

function productSource(): ProductAggregate {
  return parseProductAggregate({
    productReference: id(5),
    brandReference: id(2),
    internalCode: "SYNTHETIC_PRODUCT",
    productType: "PreparedFood",
    lifecycle: "Active",
    aggregateVersion: 4,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic supported draft" },
      taxClassificationReference: id(60),
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [id(61)], primaryCategoryReference: id(61) },
      skus: [0, 1].map((n) => ({
        skuReference: id(70 + n),
        productReference: id(5),
        brandReference: id(2),
        skuCode: "SYNTHETIC_" + n,
        lifecycle: "Active",
        localizedNames: { "en-CA": "Synthetic SKU " + n },
        variantSelections: [{ dimensionReference: id(80), valueReference: id(81 + n) }],
        unitOfSale: "EA",
        unitQuantity: "1",
        createdAt: at,
        createdByActorReference: id(3),
      })),
      optionBindings: [
        {
          bindingReference: id(90),
          optionSetReference: id(91),
          optionSetVersionReference: id(92),
          purpose: "SELECT",
          sortOrder: 0,
          enabledOptionReferences: [id(94), id(93)],
          defaultSelections: [{ optionReference: id(93), quantity: 1 }],
          minimumSelectionOverride: 0,
          maximumSelectionOverride: 2,
          includedSkuReferences: [id(70)],
          excludedSkuReferences: [id(71)],
          channelCodes: ["WEB", "POS"],
          storeOverrideAllowed: false,
        },
      ],
    },
  });
}
function publicationForSource(source: ProductAggregate) {
  const identity = deriveCatalogProductPublicationContentIdentity(source);
  return published({
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    expectedProductAggregateVersion: source.aggregateVersion,
  });
}
describe("Immutable owning publication content and successor Draft", () => {
  it("copies supported source content into a new Version and preserves stable SKU identity", () => {
    const source = productSource(),
      p = publicationForSource(source),
      result = createCatalogProductPublicationMaterialization(source, p);
    expect(result.content.profile).toBe("CatalogSupportedProductDraftContentV1");
    expect(result.content.sourceDraft).toEqual(source.draft);
    expect(result.successor.aggregateVersion).toBe(5);
    expect(result.successor.draft.versionReference).toBe(id(13));
    expect(result.successor.draft.baseVersionReference).toBe(id(6));
    expect(result.successor.draft.skus).toEqual(source.draft.skus);
    expect(result.successor.draft.optionBindings).toEqual(source.draft.optionBindings);
    expect(result.successor.draft.categoryClassification).toEqual(
      source.draft.categoryClassification,
    );
    expect(source.aggregateVersion).toBe(4);
    expect(source.draft.versionReference).toBe(id(6));
  });
  it("seals copied content independently of caller mutation and later Draft editing", () => {
    const raw = JSON.parse(JSON.stringify(productSource())) as ProductAggregate;
    const result = createCatalogProductPublicationMaterialization(raw, publicationForSource(raw));
    Object.assign(raw.draft.localizedNames, { "en-CA": "Changed after preparation" });
    expect(result.content.sourceDraft.localizedNames["en-CA"]).toBe("Synthetic supported draft");
    const edited = parseProductAggregate({
      ...result.successor,
      draft: { ...result.successor.draft, localizedNames: { "en-CA": "Next Draft" } },
    });
    expect(edited.draft.versionReference).toBe(id(13));
    expect(result.content.sourceDraft.versionReference).toBe(id(6));
    expect(Object.isFrozen(result.content.sourceDraft.skus[0]?.variantSelections)).toBe(true);
  });
  it("rejects changed source content, authority tuple, source revision or digest", () => {
    const source = productSource(),
      p = publicationForSource(source);
    for (const changed of [
      { ...source, draft: { ...source.draft, localizedNames: { "en-CA": "Changed" } } },
      { ...source, brandReference: id(99), draft: { ...source.draft, skus: [] } },
      { ...source, aggregateVersion: 5 },
    ])
      expect(() => createCatalogProductPublicationMaterialization(changed, p)).toThrow();
    expect(() =>
      createCatalogProductPublicationMaterialization(source, {
        ...p,
        contentDigest: hash("forged"),
      }),
    ).toThrow();
    expect(() =>
      createCatalogProductPublicationMaterialization(source, {
        ...p,
        configurationDigest: hash("forged"),
      }),
    ).toThrow();
  });
  it("does not materialize review/scheduled states or root-overflow", () => {
    const source = productSource(),
      identity = deriveCatalogProductPublicationContentIdentity(source),
      s = submitted({
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      });
    expect(() => createCatalogProductPublicationMaterialization(source, s)).toThrow();
    const overflow = parseProductAggregate({ ...source, aggregateVersion: 2147483647 });
    expect(() =>
      createCatalogProductPublicationMaterialization(overflow, publicationForSource(overflow)),
    ).toThrow();
  });
  it("rejects publication preceding source changes and timestamps a new Draft at publication", () => {
    const source = productSource(),
      p = publicationForSource(source);
    expect(() =>
      createCatalogProductPublicationMaterialization({ ...source, updatedAt: later }, p),
    ).toThrow();
    expect(() =>
      createCatalogProductPublicationMaterialization(
        { ...source, draft: { ...source.draft, updatedAt: later } },
        p,
      ),
    ).toThrow();
    const c = command({
      action: "Publish",
      expectedPublicationVersion: 2,
      occurredAt: later,
      contentDigest: p.contentDigest,
      configurationDigest: p.configurationDigest,
      successorDraftVersionReference: id(13),
    });
    const s = submitted({
      contentDigest: p.contentDigest,
      configurationDigest: p.configurationDigest,
    });
    const result = createCatalogProductPublicationMaterialization(
      source,
      planCatalogProductPublication(c, s, facts(c)),
    );
    expect(result.successor.draft.createdAt).toBe(later);
    expect(result.successor.draft.updatedAt).toBe(later);
    expect(result.successor.draft.skus[0]?.createdAt).toBe(at);
    expect(result.successor.createdAt).toBe(at);
  });
  it("matches the existing public current-SKU source canonical configuration digest", () => {
    const source = productSource(),
      identity = deriveCatalogProductPublicationContentIdentity(source);
    const current = buildCatalogInventorySkuReferenceSnapshot(
      {
        brandReference: id(2),
        productReference: id(5),
        skuReference: id(70),
        sourceRevision: "1",
        productAggregateVersion: 4,
        observedAt: at,
        precise: true,
        configuration: identity.referenceConfiguration,
      },
      {
        purposeCode: "INVENTORY_FINISHED_GOOD_SKU_SOURCE_READ",
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(3),
        operationReference: id(4),
        consumerIntentDigest: hash("intent"),
        productReference: id(5),
        productVersionReference: id(6),
        skuReference: id(70),
        expectedConfigurationDigest: null,
      },
      at,
    );
    expect(current.configurationDigest).toBe(identity.configurationDigest);
    expect(current.configuration).toEqual(identity.referenceConfiguration);
  });
  it("retains unavailable legacy category coverage and private value changes in content digest", () => {
    const source = productSource();
    const legacyDraft = { ...source.draft };
    delete legacyDraft.categoryClassification;
    const legacy = deriveCatalogProductPublicationContentIdentity({
      ...source,
      draft: legacyDraft,
    });
    expect(legacy.referenceConfiguration.categoryCoverage).toBe("Unavailable");
    expect(legacy.referenceConfiguration.categoryReferences).toBeNull();
    const original = deriveCatalogProductPublicationContentIdentity(source),
      changed = deriveCatalogProductPublicationContentIdentity({
        ...source,
        draft: {
          ...source.draft,
          optionBindings: source.draft.optionBindings.map((b) => ({
            ...b,
            defaultSelections: [{ optionReference: id(93), quantity: 2 }],
          })),
        },
      });
    expect(changed.configurationDigest).toBe(original.configurationDigest);
    expect(changed.contentDigest).not.toBe(original.contentDigest);
  });
  it("rejects source getters without invoking them", () => {
    const source = productSource(),
      getter = vi.fn(() => source.draft);
    const unsafe = { ...source };
    Object.defineProperty(unsafe, "draft", { enumerable: true, get: getter });
    expect(() => deriveCatalogProductPublicationContentIdentity(unsafe)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
});

it("recovers exact stored content and rejects changed digests or owner references", () => {
  const source = productSource(),
    content = createCatalogProductPublicationMaterialization(
      source,
      publicationForSource(source),
    ).content;
  const serialized = JSON.parse(JSON.stringify(content));
  expect(parseCatalogProductPublicationContent(serialized)).toEqual(content);
  for (const changed of [
    { ...serialized, contentDigest: hash("forged") },
    {
      ...serialized,
      referenceConfiguration: { ...serialized.referenceConfiguration, skuReferences: [] },
    },
    { ...serialized, brandReference: id(98) },
    { ...serialized, sourceAggregateVersion: 0 },
    { ...serialized, sealedAt: "2026-09-29T11:59:59.999Z" },
    { ...serialized, profile: "FullProductContent" },
  ])
    expect(() => parseCatalogProductPublicationContent(changed)).toThrow();
});
it("rejects a known previous Version as the successor Draft identity", () => {
  const source = parseProductAggregate({
    ...productSource(),
    draft: { ...productSource().draft, baseVersionReference: id(13) },
  });
  expect(() =>
    createCatalogProductPublicationMaterialization(source, publicationForSource(source)),
  ).toThrow();
});

function publicationAudit(
  p: ProductPublicationVersion,
  action: ProductPublicationCommand["action"],
) {
  return {
    auditId: id(250),
    brandId: p.brandReference,
    actor:
      p.actorKind === "System"
        ? { type: "System" as const }
        : { type: "User" as const, reference: p.actorReference },
    actionCode: catalogProductPublicationAuditAction(action),
    targetType: "Product",
    targetId: p.productReference,
    reasonCode: p.reasonCode,
    correlationId: p.operationReference,
    occurredAt: p.occurredAt,
    sourceChannel: p.actorKind === "System" ? "SYSTEM" : "API",
    dataClassification: "Internal" as const,
    retentionPolicyCode: "OPERATIONAL",
    retentionPolicyVersion: 1,
  };
}
it("produces a minimal event with published Version independent of the resulting Draft", () => {
  const source = productSource(),
    p = publicationForSource(source),
    root = createCatalogProductPublicationMaterialization(source, p).successor;
  const event = buildCatalogProductPublicationEvent(
    p,
    root,
    "Publish",
    publicationAudit(p, "Publish"),
    "12",
  );
  expect(event.envelope.eventType).toBe("ProductVersionPublished");
  expect(event.envelope.payload.productVersionReference).toBe(id(6));
  expect(event.envelope.payload.resultDraftVersionReference).toBe(id(13));
  expect(event.envelope.payload.sourceRevision).toBe("12");
  expect(event.envelope.actor).toEqual({ type: "Actor", actorId: id(3) });
  expect(JSON.stringify(event.envelope.payload)).not.toContain("localizedNames");
  expect(event.audit.afterSummary).toMatchObject({ state: "Published", publicationVersion: 3 });
});
it("rejects wrong Actor, Audit target, root version, arbitrary summaries and invalid generations", () => {
  const source = productSource(),
    p = publicationForSource(source),
    root = createCatalogProductPublicationMaterialization(source, p).successor,
    audit = publicationAudit(p, "Publish");
  for (const changed of [
    { ...audit, actor: { type: "User", reference: id(99) } },
    { ...audit, targetId: id(99) },
    { ...audit, afterSummary: { privateNote: "Do not emit" } },
    { ...audit, actionCode: "CATALOG_OTHER" },
  ])
    expect(() => buildCatalogProductPublicationEvent(p, root, "Publish", changed, "1")).toThrow();
  expect(() =>
    buildCatalogProductPublicationEvent(
      p,
      { ...root, aggregateVersion: 10 },
      "Publish",
      audit,
      "1",
    ),
  ).toThrow();
  for (const revision of ["0", "01", "9223372036854775808"])
    expect(() =>
      buildCatalogProductPublicationEvent(p, root, "Publish", audit, revision),
    ).toThrow();
});
it("emits scheduler activation as actual System Audit/Event Actor", () => {
  const source = productSource(),
    identity = deriveCatalogProductPublicationContentIdentity(source),
    periodFuture = { ...period, effectiveFrom: boundary(later) },
    args = {
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      effectivePeriod: periodFuture,
    };
  const scheduled = step("SchedulePublish", submitted(args), {
      ...args,
      scheduleReference: id(30),
    }),
    p = step("ActivateScheduled", scheduled, {
      ...args,
      scheduleReference: id(30),
      actorKind: "System",
      occurredAt: later,
      successorDraftVersionReference: id(13),
    }),
    root = createCatalogProductPublicationMaterialization(source, p).successor;
  const result = buildCatalogProductPublicationEvent(
    p,
    root,
    "ActivateScheduled",
    publicationAudit(p, "ActivateScheduled"),
    "1",
  );
  expect(result.envelope.actor).toEqual({ type: "System" });
  expect(result.audit.actor).toEqual({ type: "System" });
  expect(() =>
    buildCatalogProductPublicationEvent(p, root, "Publish", publicationAudit(p, "Publish"), "1"),
  ).toThrow();
});

function requiredFixture<T>(value: T | undefined): T {
  if (value === undefined) throw Error("synthetic fixture missing");
  return value;
}
function sourceHistory(future = false, cancel = false) {
  let root = productSource(),
    current: ProductPublicationVersion | null = null;
  const rows: {
    action: ProductPublicationAction;
    publication: ProductPublicationVersion;
    aggregate: ProductAggregate;
    content: unknown;
    coherent: boolean;
    snapshotDigest: string;
  }[] = [];
  const identity = deriveCatalogProductPublicationContentIdentity(root);
  const selectedPeriod = future ? { ...period, effectiveFrom: boundary(later) } : period;
  const actions: ProductPublicationAction[] = future
    ? ["Validate", "SubmitReview", "SchedulePublish"]
    : ["Validate", "SubmitReview", "Publish"];
  if (cancel) actions.push("CancelScheduledPublish");
  for (const action of actions) {
    const c = command({
      action,
      operationReference: id(500 + rows.length),
      expectedProductAggregateVersion: root.aggregateVersion,
      expectedPublicationVersion: current?.publicationVersion ?? 0,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      effectivePeriod: selectedPeriod,
      scheduleReference:
        action === "SchedulePublish" || action === "CancelScheduledPublish" ? id(5010) : null,
      successorDraftVersionReference: action === "Publish" ? id(13) : null,
    });
    current = planCatalogProductPublication(c, current, {
      ...facts(c),
      reviewReference: action === "SubmitReview" ? id(12) : null,
    });
    let content: unknown = null;
    if (action === "Publish") {
      const result = createCatalogProductPublicationMaterialization(root, current);
      root = result.successor;
      content = result.content;
    } else
      root = parseProductAggregate({
        ...root,
        aggregateVersion: root.aggregateVersion + 1,
        updatedAt: at,
      });
    rows.push({
      action,
      publication: current,
      aggregate: root,
      content,
      coherent: true,
      snapshotDigest: hash(root),
    });
  }
  return {
    raw: { aggregateVersion: root.aggregateVersion, observedAt: at, revisions: rows },
    request: { productReference: id(5), expectedAggregateVersion: root.aggregateVersion },
  };
}
describe("complete recorded Product publication source", () => {
  const bound = { tenantReference: id(1), brandReference: id(2) };
  it("checks actual frozen content independently of the successor Draft", () => {
    const x = sourceHistory();
    const result = buildProductPublicationSourceSnapshot(x.raw, bound, x.request, at);
    expect(result.latest[0]?.state).toBe("Published");
    expect(result.history[2]?.configuration.versionReference).toBe(id(6));
    expect(result.eligibility).toBe("NotEvaluated");
    expect(result.history[2]?.configuration).not.toHaveProperty("localizedNames");
    expect(Object.isFrozen(result.history)).toBe(true);
  });
  it("retains future and cancelled schedule history without activating the scheduled version", () => {
    const x = sourceHistory(true, true);
    const result = buildProductPublicationSourceSnapshot(x.raw, bound, x.request, at);
    expect(result.history[2]?.publication.state).toBe("Scheduled");
    expect(result.latest[0]?.state).toBe("Draft");
    expect(result.latest[0]?.scheduleVersion).toBe(2);
    expect(result.eligibility).toBe("NotEvaluated");
  });
  it("supports complete empty publication history without inventing a published graph", () => {
    const result = buildProductPublicationSourceSnapshot(
      { aggregateVersion: 4, observedAt: at, revisions: [] },
      bound,
      { productReference: id(5), expectedAggregateVersion: 4 },
      at,
    );
    expect(result.latest).toEqual([]);
  });
  it.each(["coherent", "snapshotDigest", "content"])("refuses altered %s evidence", (field) => {
    const x = sourceHistory();
    Object.assign(requiredFixture(x.raw.revisions[2]), {
      [field]: field === "coherent" ? false : field === "snapshotDigest" ? hash("altered") : null,
    });
    expect(() => buildProductPublicationSourceSnapshot(x.raw, bound, x.request, at)).toThrow();
  });
  it("rejects omitted revision history, foreign scope and stale aggregate", () => {
    const x = sourceHistory();
    x.raw.revisions.splice(1, 1);
    expect(() => buildProductPublicationSourceSnapshot(x.raw, bound, x.request, at)).toThrow();
    const y = sourceHistory();
    expect(() =>
      buildProductPublicationSourceSnapshot(
        y.raw,
        { ...bound, brandReference: id(99) },
        y.request,
        at,
      ),
    ).toThrow();
    expect(() =>
      buildProductPublicationSourceSnapshot(
        y.raw,
        bound,
        { ...y.request, expectedAggregateVersion: 6 },
        at,
      ),
    ).toThrow();
  });
  it("never invokes an accessor or accepts over-limit histories", () => {
    const x = sourceHistory();
    const get = vi.fn(() => x.raw.revisions);
    Object.defineProperty(x.raw, "revisions", { get, enumerable: true });
    expect(() => buildProductPublicationSourceSnapshot(x.raw, bound, x.request, at)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
});

function currentPublicationSetup(future = false, cancel = false) {
  const x = sourceHistory(future, cancel),
    snapshot = buildProductPublicationSourceSnapshot(
      x.raw,
      { tenantReference: id(1), brandReference: id(2) },
      x.request,
      at,
    );
  let now = at,
    held = 0;
  const f = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(20),
    observedAt: at,
    validUntil: expiry,
    coverage: "Complete",
    storeGroupReferences: [id(21)],
    regionReferences: [id(22)],
    policyReference: id(11),
    policyVersion: 1,
    scopeOrder: [...productPublicationScopeLevels],
    versions: snapshot.latest.map((p) => ({
      versionReference: p.versionReference,
      validation: {
        ...facts(
          command({
            contentDigest: p.contentDigest,
            configurationDigest: p.configurationDigest,
            effectivePeriod: p.effectivePeriod,
            scopeSet: p.scopeSet,
          }),
        ).validation,
        productAggregateVersion: snapshot.aggregateVersion,
      },
      approval: null,
    })),
  };
  const ports = {
    clock: { now: () => now },
    snapshots: {
      async withCurrentSnapshot<T>(_i: unknown, w: (s: typeof snapshot) => Promise<T>) {
        held++;
        try {
          return await w(snapshot);
        } finally {
          held--;
        }
      },
    },
    eligibility: {
      async withHeldCurrentFacts<T>(_i: unknown, w: (v: unknown) => Promise<T>) {
        held++;
        try {
          return await w(f);
        } finally {
          held--;
        }
      },
    },
  };
  const service = createCurrentProductPublicationService(ports, {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(20),
  });
  const request = { ...x.request, channelCode: "WEB", orderTypeCode: "PICKUP" };
  const read = () =>
    service.withCurrentPublication(request, async (view) => {
      expect(held).toBe(2);
      return view;
    });
  return {
    f,
    snapshot,
    ports,
    service,
    request,
    read,
    setTime: (v: string) => {
      now = v;
    },
  };
}
describe("current held Product effective and future resolution", () => {
  it("selects frozen published version only under current complete facts", async () => {
    const x = currentPublicationSetup();
    expect((await x.read()).current).toMatchObject({
      outcome: "Selected",
      versionReference: id(6),
    });
  });
  it("lists future schedule but does not activate it or list a cancelled plan", async () => {
    const x = currentPublicationSetup(true);
    expect(await x.read()).toMatchObject({
      current: { outcome: "Unavailable" },
      future: [{ scheduleVersion: 1, eligibility: "NotEvaluated", currentValidation: "Pass" }],
    });
    expect((await currentPublicationSetup(true, true).read()).future).toEqual([]);
  });
  it("does not use stored publication as current eligibility when validation is missing or has hard errors", async () => {
    const x = currentPublicationSetup();
    requiredFixture(x.f.versions[0]).validation = null as never;
    expect((await x.read()).current.outcome).toBe("Unavailable");
    const y = currentPublicationSetup();
    requiredFixture(y.f.versions[0]).validation.checks = requiredFixture(
      y.f.versions[0],
    ).validation.checks.map((c) => ({
      ...c,
      outcome:
        c.code === "DefaultLocaleName" || c.code === "HardErrorsCleared" ? "HardError" : "Pass",
    }));
    expect((await y.read()).current.outcome).toBe("Unavailable");
  });
  it("rejects expired, foreign, incomplete or duplicate current source evidence", async () => {
    for (const change of [
      { validUntil: at },
      { storeReference: id(99) },
      { coverage: "Partial" },
      { versions: [] },
    ]) {
      const x = currentPublicationSetup();
      Object.assign(x.f, change);
      await expect(x.read()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    }
  });
  it("refuses policy ambiguity and stale or altered frozen-content validation", async () => {
    const x = currentPublicationSetup();
    x.f.scopeOrder.splice(0, 1);
    await expect(x.read()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    const y = currentPublicationSetup();
    requiredFixture(y.f.versions[0]).validation.contentDigest = hash("altered");
    await expect(y.read()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  });
  it("preserves broader version outside a narrower scope and refuses same-priority ambiguity", async () => {
    const x = currentPublicationSetup(),
      original = requiredFixture(x.snapshot.latest[0]);
    const narrow = parseProductPublicationVersion({
      ...original,
      versionReference: id(99),
      scopeSet: [{ level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] }],
      scopeDigest: hash([
        { level: "Store", reference: id(20), channelCodes: [], orderTypeCodes: [] },
      ]),
    });
    const candidates = [original, narrow];
    expect(
      resolveCatalogProductPublication(candidates, context, productPublicationScopeLevels),
    ).toMatchObject({ outcome: "Selected", versionReference: id(99) });
    expect(
      resolveCatalogProductPublication(
        candidates,
        { ...context, storeReference: id(23) },
        productPublicationScopeLevels,
      ),
    ).toMatchObject({ outcome: "Selected", versionReference: id(6) });
    expect(
      resolveCatalogProductPublication(
        [original, { ...original, versionReference: id(99) }],
        context,
        productPublicationScopeLevels,
      ).outcome,
    ).toBe("Conflict");
  });
  it("rejects scope injection, accessor evidence, holder substitution and callback expiry", async () => {
    const x = currentPublicationSetup();
    await expect(
      x.service.withCurrentPublication({ ...x.request, storeReference: id(99) }, async (v) => v),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    const y = currentPublicationSetup();
    const get = vi.fn(() => y.f.coverage);
    Object.defineProperty(y.f, "coverage", { get, enumerable: true });
    await expect(y.read()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    expect(get).not.toHaveBeenCalled();
    const z = currentPublicationSetup();
    z.ports.eligibility.withHeldCurrentFacts = async (_i, w) => {
      await w(z.f);
      return {} as never;
    };
    await expect(z.read()).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
    const e = currentPublicationSetup();
    await expect(
      e.service.withCurrentPublication(e.request, async () => {
        e.setTime(expiry);
      }),
    ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  });
});
