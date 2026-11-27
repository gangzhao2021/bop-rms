import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import { bindCatalogProductPublicationValidationContextV2 } from "../contracts/product-publication-validation-context-v2.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
} from "../contracts/product-publication-v2.js";
import {
  productPublicationCheckCodes,
  parseProductPublicationCommand,
} from "../contracts/product-publication.js";
import { parseProductLifecycleReviewRequest } from "../contracts/product-lifecycle-review.js";
import {
  buildCatalogProductPublicationReferenceRequestV2 as build,
  parseCatalogProductPublicationReferenceRequestV2 as parse,
  bindCatalogProductPublicationReferenceRequestV2 as bind,
} from "../contracts/product-publication-reference-request-v2.js";

const id = (n: number) => "01902445-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T12:00:00.000Z",
  until = "2026-10-03T12:00:01.000Z",
  hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
function fixture(exact = false) {
  const aggregate = parseProductAggregate({
      productReference: id(4),
      brandReference: id(2),
      internalCode: "SYNTHETIC_REFERENCE",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(5),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic reference" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
      },
    }),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    selector = { level: "Store", reference: id(6), channelCodes: [], orderTypeCodes: [] },
    body = exact
      ? {
          profile: "CatalogProductExactStoreSelectorReplacementV1",
          mode: "PermanentSelectorRetirement",
          previousVersionReference: id(20),
          previousPublicationOperationReference: id(21),
          expectedPreviousPublicationVersion: 3,
          previousIntentDigest: hash("intent"),
          previousScopeDigest: hash([selector]),
          previousPeriodDigest: hash("period"),
          previousSelectorIndex: 0,
          previousSelectorDigest: hash(selector),
        }
      : { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(7),
      productReference: id(4),
      versionReference: id(5),
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
  return { command, aggregate, current: null, content: null, observedAt: at };
}
// Controlled pure validation data proves binding only. It deliberately contains
// technical HardErrors and grants no owning-source/approval/publishing result.
function withCurrent(exact = false) {
  const initial = fixture(exact),
    c = initial.command,
    current = planCatalogProductPublicationV2(c, null, {
      now: at,
      productAggregateVersion: 1,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      validation: {
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: c.replacementIntentDigest,
        evidenceReference: id(30),
        productAggregateVersion: 1,
        contentDigest: c.contentDigest,
        configurationDigest: c.configurationDigest,
        scopeDigest: hash(c.scopeSet),
        periodDigest: hash(c.effectivePeriod),
        policyReference: id(31),
        policyVersion: 1,
        approvalPolicy: "NotRequired",
        checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "HardError" })),
        warningAcknowledgement: null,
        checkedAt: at,
        validUntil: until,
      },
      approval: null,
      reviewReference: null,
      replacement: null,
    });
  return {
    ...initial,
    aggregate: parseProductAggregate({ ...initial.aggregate, aggregateVersion: 2 }),
    current,
    command: parseProductPublicationCommandV2({
      ...c,
      operationReference: id(8),
      expectedProductAggregateVersion: 2,
      expectedPublicationVersion: 1,
    }),
  };
}
it.each([false, true])(
  "binds the original full None/Exact command and actual context without granting authority: %s",
  (exact) => {
    const context = bindCatalogProductPublicationValidationContextV2(fixture(exact)),
      result = build(context, until);
    expect(result).toEqual({
      profile: "CatalogProductPublicationReferenceRequestV2",
      command: context.command,
      originalIntentDigest: hash(context.command),
      replacementIntentDigest: context.replacementIntentDigest,
      aggregateSnapshotDigest: hash(context.aggregate),
      currentPublicationDigest: null,
      observedAt: at,
      validUntil: until,
    });
    expect(bind(result, context)).toEqual(result);
    expect(Object.isFrozen(result.command.replacementIntent)).toBe(true);
    expect(Object.hasOwn(result, "eligibility")).toBe(false);
    expect(() => parseProductPublicationCommand(result.command)).toThrow();
    expect(() => parseProductLifecycleReviewRequest(result)).toThrow();
  },
);
it.each([
  "Validate",
  "SubmitReview",
  "Approve",
  "Reject",
  "Publish",
  "SchedulePublish",
  "ReschedulePublish",
  "CancelScheduledPublish",
  "ActivateScheduled",
] as const)(
  "retains actual action %s instead of manufacturing a Lifecycle or Validate request",
  (action) => {
    const base = withCurrent(),
      command = parseProductPublicationCommandV2({
        ...base.command,
        action,
        actorKind: action === "ActivateScheduled" ? "System" : "User",
        scheduleReference: [
          "SchedulePublish",
          "ReschedulePublish",
          "CancelScheduledPublish",
          "ActivateScheduled",
        ].includes(action)
          ? id(40)
          : null,
        successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(action)
          ? id(41)
          : null,
      }),
      context = bindCatalogProductPublicationValidationContextV2({ ...base, command }),
      result = build(context, until);
    expect(result.command.action).toBe(action);
    expect(result.originalIntentDigest).toBe(hash(command));
    expect(result.currentPublicationDigest).toBe(hash(base.current));
    expect(base.current.validationDecision).toBe("HardError");
  },
);
it.each([
  "hash",
  "replacement",
  "aggregate",
  "current",
  "observed",
  "extra",
  "profile",
  "renewal",
  "zeroLease",
  "bareHash",
])("rejects unbound or malformed request data: %s", (fault) => {
  const context = bindCatalogProductPublicationValidationContextV2(withCurrent()),
    value = { ...build(context, until) };
  if (fault === "hash") value.originalIntentDigest = hash("changed");
  if (fault === "replacement") value.replacementIntentDigest = hash("changed");
  if (fault === "aggregate") value.aggregateSnapshotDigest = hash("changed");
  if (fault === "current") value.currentPublicationDigest = hash("changed");
  if (fault === "observed") value.observedAt = "2026-10-03T12:00:00.001Z";
  if (fault === "extra") Object.assign(value, { assertedComplete: true });
  if (fault === "profile") Object.assign(value, { profile: "CatalogLifecycleReview" });
  if (fault === "renewal") value.validUntil = "2026-10-03T12:00:05.001Z";
  if (fault === "zeroLease") value.validUntil = at;
  if (fault === "bareHash") value.aggregateSnapshotDigest = "a".repeat(64);
  expect(() => bind(value, context)).toThrow();
});
it("permits null current only for first Validate, preserves a shortened lease, and refuses derived context pollution", () => {
  const context = bindCatalogProductPublicationValidationContextV2(fixture()),
    first = build(context, until),
    prior = build(bindCatalogProductPublicationValidationContextV2(withCurrent()), until);
  expect(parse(first).validUntil).toBe(until);
  expect(() => parse({ ...prior, currentPublicationDigest: null })).toThrow();
  expect(() => parse({ ...first, currentPublicationDigest: hash("asserted") })).toThrow();
  const submit: ProductPublicationCommandV2 = { ...first.command, action: "SubmitReview" };
  expect(() => parse({ ...first, command: submit, originalIntentDigest: hash(submit) })).toThrow();
  expect(() => build({ ...context, originalIntentDigest: hash("asserted") }, until)).toThrow();
  expect(() => build({ ...context, sourceAuthority: "CurrentTransactionHeld" }, until)).toThrow();
  expect(() => build({ ...context, extra: true }, until)).toThrow();
});
it("rejects getters, prototypes, altered full action and unsupported Supersede without invoking code", () => {
  const context = bindCatalogProductPublicationValidationContextV2(fixture()),
    value = { ...build(context, until) },
    getter = vi.fn(() => value.command);
  Object.defineProperty(value, "command", { enumerable: true, get: getter });
  expect(() => parse(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    parse(Object.assign(Object.create({ inherited: true }), build(context, until))),
  ).toThrow();
  const altered = {
    ...build(context, until),
    command: { ...context.command, action: "Supersede" },
  };
  expect(() => parse(altered)).toThrow();
});
