import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  planCatalogProductPublication,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  type ProductPublicationAction,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
  type ProductPublicationScope,
  type ProductPublicationVersion,
} from "../contracts/product-publication.js";
import {
  parseProductPublicationCommandV2,
  planCatalogProductPublicationV2,
  type ProductPublicationCommandV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import {
  buildCatalogProductRetirementCoverage,
  catalogProductRetirementSourceHeadDigest,
  type CatalogProductRetirementHistoryEntry,
  type CatalogProductRetirementPublication,
} from "../contracts/product-publication-source-v2.js";
import {
  buildCatalogProductScopeRetirementHeader,
  type CatalogProductScopeRetirementHeader,
} from "../contracts/product-scope-retirement.js";
import {
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
  type CatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import { assessCatalogProductUniqueScopeV2 } from "../contracts/product-unique-scope-v2.js";

const id = (n: number) => "01902433-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  before = "2026-10-02T10:00:00.000Z",
  retiredAt = "2026-10-02T11:00:00.000Z",
  expiredAt = "2026-10-02T11:30:00.000Z",
  at = "2026-10-02T12:00:00.000Z",
  hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const period = (from = before, until: string | null = null) => ({
  timeZone: "UTC",
  effectiveFrom: boundary(from),
  effectiveUntil: until === null ? null : boundary(until),
});
const selector = (n: number): ProductPublicationScope => ({
  level: "Store",
  reference: id(n),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
});
const noReplacement = () => {
  const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" };
  return parseCatalogProductPublicationReplacementIntent({ ...body, digest: hash(body) });
};
function required<T>(value: T | undefined | null): T {
  if (value === undefined || value === null) throw new Error("Missing synthetic fixture value");
  return value;
}
function fixture(
  options: {
    extraScopes?: ProductPublicationScope[];
    scheduled?: boolean;
    retired?: boolean;
    oldUntil?: string;
    oldScopes?: ProductPublicationScope[];
    oldV2?: boolean;
  } = {},
) {
  const history: CatalogProductRetirementHistoryEntry[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [],
    oldScopes = options.oldScopes ?? [selector(20), selector(21)];
  const command = (
    version: number,
    scopes: readonly ProductPublicationScope[],
    action: ProductPublicationAction,
    current: Pick<ProductPublicationVersion, "publicationVersion"> | null,
    occurredAt = before,
    effectivePeriod = period(),
  ): ProductPublicationCommand => ({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(1000 + history.length),
    productReference: id(5),
    versionReference: id(version),
    expectedProductAggregateVersion: history.length + 1,
    expectedPublicationVersion: current?.publicationVersion ?? 0,
    action,
    contentDigest: hash("content " + version),
    configurationDigest: hash("configuration"),
    scopeSet: scopes,
    effectivePeriod,
    scheduleReference: action === "SchedulePublish" ? id(90) : null,
    replacementVersionReference: null,
    successorDraftVersionReference: action === "Publish" ? id(version + 1) : null,
    occurredAt,
    reasonCode: "SYNTHETIC_SCOPE_V2",
  });
  const facts = (c: ProductPublicationCommand): ProductPublicationFacts => ({
    now: c.occurredAt,
    productAggregateVersion: c.expectedProductAggregateVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      evidenceReference: id(80),
      productAggregateVersion: c.expectedProductAggregateVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(81),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: c.occurredAt,
      validUntil: "2026-10-03T00:00:00.000Z",
    },
    approval: null,
    reviewReference: c.action === "SubmitReview" ? id(82) : null,
    replacement: null,
  });
  const addLegacy = (
    version: number,
    scopes: ProductPublicationScope[],
    scheduled = false,
    effectivePeriod = period(),
  ) => {
    let current: ProductPublicationVersion | null = null;
    for (const action of [
      "Validate",
      "SubmitReview",
      scheduled ? "SchedulePublish" : "Publish",
    ] as const) {
      const c = command(version, scopes, action, current, before, effectivePeriod);
      current = planCatalogProductPublication(c, current, facts(c));
      history.push({ publicationAction: action, publication: current });
    }
    return required(current);
  };
  const intentFor = (previous: CatalogProductRetirementPublication, index = 0) => {
    const body = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: previous.versionReference,
      previousPublicationOperationReference: previous.operationReference,
      expectedPreviousPublicationVersion: previous.publicationVersion,
      previousIntentDigest: previous.intentDigest,
      previousScopeDigest: previous.scopeDigest,
      previousPeriodDigest: previous.periodDigest,
      previousSelectorIndex: index,
      previousSelectorDigest: hash(previous.scopeSet[index]),
    };
    return parseCatalogProductScopeReplacementIntent({ ...body, digest: hash(body) });
  };
  const coverage = (observedAt = at) =>
    buildCatalogProductRetirementCoverage({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      aggregateVersion: history.length + 1,
      sourceRevision: String(history.length + 1),
      observedAt,
      history,
      headers,
    });
  const addV2 = (
    version: number,
    scopes: readonly ProductPublicationScope[],
    intent: CatalogProductPublicationReplacementIntent,
    publishedAt: string,
    effectivePeriod = period(),
    previous: CatalogProductRetirementPublication | null = null,
  ) => {
    let current: ProductPublicationVersionV2 | null = null;
    for (const action of ["Validate", "SubmitReview", "Publish"] as const) {
      const source = coverage(publishedAt),
        c: ProductPublicationCommandV2 = {
          ...command(version, scopes, action, current, publishedAt, effectivePeriod),
          profile: "CatalogProductPublicationCommandV2",
          replacementIntent: intent,
          replacementIntentDigest: intent.digest,
        },
        base = facts(c);
      current = planCatalogProductPublicationV2(c, current, {
        ...base,
        replacement: null,
        validation: {
          ...base.validation,
          profile: "CatalogProductPublicationValidationV2",
          replacementIntentDigest: intent.digest,
        },
      });
      headers.push(
        buildCatalogProductScopeRetirementHeader({
          publicationAction: action,
          publication: current,
          previousPublication: action === "Publish" ? previous : null,
          observedSourceRevision: source.sourceRevision,
          observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
            tenantReference: source.tenantReference,
            brandReference: source.brandReference,
            productReference: source.productReference,
            aggregateVersion: source.aggregateVersion,
            sourceRevision: source.sourceRevision,
            latest: source.latest,
          }),
        }),
      );
      history.push({ publicationAction: action, publication: current });
    }
    return required(current);
  };
  const old = options.oldV2
      ? addV2(40, oldScopes, noReplacement(), before, period(before, options.oldUntil ?? null))
      : addLegacy(40, oldScopes, false, period(before, options.oldUntil ?? null)),
    extra = options.extraScopes
      ? addLegacy(
          50,
          options.extraScopes,
          options.scheduled,
          options.scheduled ? period("2026-10-02T12:00:01.000Z") : period(),
        )
      : null;
  if (options.retired)
    addV2(
      60,
      [required(old.scopeSet[0])],
      intentFor(old),
      retiredAt,
      period(retiredAt, expiredAt),
      old,
    );
  const target = options.retired ? required(extra) : old,
    intent = intentFor(target),
    incoming = parseProductPublicationCommandV2({
      ...command(70, [required(target.scopeSet[0])], "Validate", null, at, period(at)),
      profile: "CatalogProductPublicationCommandV2",
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
    }),
    stores = {
      profile: "TenantStoreReferenceV1",
      brandReference: id(2),
      brandLifecycle: "Active",
      brandVersion: "1",
      generation: "3",
      referenceCount: "3",
      originalIntentDigest: hash(incoming),
      observedAt: at,
      references: [20, 21, 22].map((n) => ({
        storeReference: id(n),
        lifecycle: "Active",
        version: "1",
        createdAt: before,
        updatedAt: before,
      })),
    },
    policy = {
      content: {
        profile: "PublishingProductPublicationPolicyV1",
        tenantReference: id(1),
        brandReference: id(2),
        familyReference: id(83),
        policyReference: id(81),
        policyVersion: 1,
        scopeOrder: productPublicationScopeLevels,
        approvalPolicy: "NotRequired",
        warningOverrideAllowed: false,
        requiredLocales: [],
        mediaRequirement: "Optional",
        effectiveFrom: before,
        effectiveUntil: null,
      },
      currentPublicationReference: id(84),
      observedAt: at,
      validUntil: "2026-10-02T12:00:20.000Z",
    };
  return {
    command: incoming,
    coverage: coverage(),
    stores,
    policy,
    old,
    extra,
    history,
    headers,
    intentFor,
    facts,
    coverageAt: coverage,
  };
}

import { parseProductAggregate } from "../contracts/product.js";
import { deriveCatalogProductPublicationContentIdentity } from "../contracts/product-publication-content.js";
import {
  assessCatalogProductPublicationScope,
  type CatalogProductPublicationScopeInput,
} from "../contracts/product-publication-scope-assessment.js";
import {
  buildCatalogProductPublicationValidationReport,
  parseCatalogProductPublicationValidationDetails,
} from "../contracts/product-publication-validation-report.js";
import { parseCatalogProductPublicationWarningAcknowledgementCommand } from "../contracts/product-publication-warning-acknowledgement.js";
const plus = (value: string, ms: number) => new Date(Date.parse(value) + ms).toISOString();
// Synthetic complete owning histories and current-source values; their actual
// acquisition/permission/SQL provenance belongs to the API/native source tests.
function prepared(options: Parameters<typeof fixture>[0] = {}, empty = false) {
  const f = fixture(options),
    coverage = empty
      ? buildCatalogProductRetirementCoverage({
          tenantReference: id(1),
          brandReference: id(2),
          productReference: id(5),
          aggregateVersion: 1,
          sourceRevision: "1",
          observedAt: at,
          history: [],
          headers: [],
        })
      : f.coverage;
  const aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "SYNTHETIC_SCOPE_MEMBER",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: coverage.aggregateVersion,
      createdAt: before,
      createdByActorReference: id(3),
      updatedAt: at,
      draft: {
        versionReference: id(70),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic scope" },
        taxClassificationReference: null,
        createdAt: before,
        updatedAt: at,
        skus: [
          {
            skuReference: id(10),
            productReference: id(5),
            brandReference: id(2),
            skuCode: "ACTIVE_MEMBER",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Synthetic member" },
            variantSelections: [],
            unitOfSale: "EA",
            unitQuantity: "1",
            createdAt: before,
            createdByActorReference: id(3),
          },
        ],
        optionBindings: [],
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
    intent = empty ? noReplacement() : f.command.replacementIntent,
    command = parseProductPublicationCommandV2({
      ...f.command,
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
    });
  const input: CatalogProductPublicationScopeInput = {
    command,
    aggregate,
    current: null,
    report: null,
    observedAt: at,
    validUntil: plus(at, 3000),
  };
  return {
    ...f,
    coverage,
    input,
    stores: { ...f.stores, originalIntentDigest: hash(command) },
    policy: { ...f.policy, validUntil: plus(at, 4000) },
    history: empty ? ([] as CatalogProductRetirementHistoryEntry[]) : f.history,
    headers: empty ? ([] as CatalogProductScopeRetirementHeader[]) : f.headers,
  };
}
type Fixture = ReturnType<typeof prepared>;
const run = (f: Fixture, now = f.input.observedAt) =>
  assessCatalogProductPublicationScope(f.input, f.coverage, f.stores, f.policy, now);
function rebind(f: Fixture, patch: Partial<ProductPublicationCommandV2> = {}) {
  if (f.input.command.profile !== "CatalogProductPublicationCommandV2")
    throw Error("Expected original publication command");
  const command = parseProductPublicationCommandV2({ ...f.input.command, ...patch });
  f.input = { ...f.input, command };
  f.stores = { ...f.stores, originalIntentDigest: hash(command) };
}
function sourceClock(f: Fixture, observedAt: string, coverageAt = observedAt) {
  f.input = { ...f.input, observedAt, validUntil: plus(observedAt, 3000) };
  f.coverage = buildCatalogProductRetirementCoverage({
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    aggregateVersion: f.input.aggregate.aggregateVersion,
    sourceRevision: String(f.history.length + 1),
    observedAt: coverageAt,
    history: f.history,
    headers: f.headers,
  });
  f.stores = { ...f.stores, observedAt: coverageAt, originalIntentDigest: hash(f.input.command) };
  f.policy = { ...f.policy, observedAt, validUntil: plus(observedAt, 4000) };
}
function advance(f: Fixture, next: ProductPublicationAction, warning = false) {
  const c = f.input.command;
  if (c.profile !== "CatalogProductPublicationCommandV2")
    throw Error("Expected publication fixture");
  const base = f.facts(c),
    validation = {
      ...base.validation,
      profile: "CatalogProductPublicationValidationV2" as const,
      replacementIntentDigest: c.replacementIntentDigest,
      validUntil: plus(at, 3000),
      checks: base.validation.checks.map((check) =>
        warning && check.code === "ChangeImpact"
          ? { ...check, outcome: "Warning" as const }
          : check,
      ),
    },
    publication = planCatalogProductPublicationV2(c, f.input.current, {
      ...base,
      replacement: null,
      validation,
    }),
    head = f.coverage;
  f.headers.push(
    buildCatalogProductScopeRetirementHeader({
      publicationAction: c.action,
      publication,
      previousPublication: null,
      observedSourceRevision: head.sourceRevision,
      observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
        tenantReference: head.tenantReference,
        brandReference: head.brandReference,
        productReference: head.productReference,
        aggregateVersion: head.aggregateVersion,
        sourceRevision: head.sourceRevision,
        latest: head.latest,
      }),
    }),
  );
  f.history.push({ publicationAction: c.action, publication });
  const aggregate = parseProductAggregate({
      ...f.input.aggregate,
      aggregateVersion: f.input.aggregate.aggregateVersion + 1,
    }),
    command = parseProductPublicationCommandV2({
      ...c,
      action: next,
      operationReference: id(9000 + f.history.length),
      expectedProductAggregateVersion: aggregate.aggregateVersion,
      expectedPublicationVersion: publication.publicationVersion,
      actorKind: next === "ActivateScheduled" ? "System" : "User",
      actorReference: next === "ActivateScheduled" ? id(99) : id(3),
      occurredAt: next === "ActivateScheduled" ? c.effectivePeriod.effectiveFrom.instant : at,
      scheduleReference: [
        "SchedulePublish",
        "ActivateScheduled",
        "CancelScheduledPublish",
        "ReschedulePublish",
      ].includes(next)
        ? id(92)
        : null,
      successorDraftVersionReference: ["Publish", "ActivateScheduled"].includes(next)
        ? id(93)
        : null,
    });
  f.input = { ...f.input, aggregate, current: publication, command };
  sourceClock(f, next === "ActivateScheduled" ? plus(command.occurredAt, 1000) : at);
  return { publication, command: c, validation };
}

it("qualifies actual Active members in a recorded empty None scope without manufacturing InternalCode", () => {
  const f = prepared({}, true),
    result = run(f);
  expect(result.check).toEqual({ code: "UniqueScope", outcome: "Pass" });
  expect(result.publishableSkuCheck).toEqual({ code: "PublishableSku", outcome: "Pass" });
  expect(result.activeSkuReferences).toEqual([id(10)]);
  expect(result.skuQualification).toBe("ActiveMemberInRegisteredUnambiguousProductScope");
  expect(result.originalIntentDigest).toBe(hash(f.input.command));
  expect(result).toMatchObject({
    sourceAuthority: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(result).not.toHaveProperty("internalCodeCheck");
  expect(result).not.toHaveProperty("checks");
  const { digest, ...body } = result;
  expect(digest).toBe(hash(body));
  expect(Object.isFrozen(result.activeSkuReferences)).toBe(true);
});
it.each([false, true])(
  "retains the exact old V1/V2 selector only exemption (oldV2=%s)",
  (oldV2) => {
    const f = prepared({ oldV2 }),
      original = canonicalizeRfc8785(f.coverage);
    expect(run(f).check.outcome).toBe("Pass");
    expect(run(f).equalRankResolution).toBe("ExactStoreSelectorRetirementBound");
    expect(canonicalizeRfc8785(f.coverage)).toBe(original);
    const legacy = assessCatalogProductUniqueScopeV2(
      f.input.command,
      f.coverage,
      f.stores,
      f.policy,
      at,
    );
    expect(run(f).findings).toEqual(legacy.findings);
  },
);
it.each([false, true])(
  "None cannot waive a live equal-rank version or Scheduled reservation (%s)",
  (scheduled) => {
    const f = prepared({ extraScopes: [selector(22)], scheduled }),
      none = noReplacement();
    rebind(f, {
      scopeSet: [selector(22)],
      replacementIntent: none,
      replacementIntentDigest: none.digest,
    });
    const result = run(f);
    expect(result.check.outcome).toBe("HardError");
    expect(result.publishableSkuCheck.outcome).toBe("HardError");
    expect(result.findings).toContainEqual({
      reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
      versionReference: required(f.extra).versionReference,
      selectorIndex: 0,
      counterpartIndex: 0,
    });
  },
);
it("None honors a verified permanent retirement after the replacement expires and keeps other old selectors conflicting", () => {
  const f = prepared({ retired: true, extraScopes: [selector(22)] }),
    none = noReplacement();
  rebind(f, {
    scopeSet: [selector(20)],
    replacementIntent: none,
    replacementIntentDigest: none.digest,
  });
  expect(run(f).check.outcome).toBe("Pass");
  rebind(f, { scopeSet: [selector(21)] });
  expect(run(f).findings).toContainEqual({
    reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
    versionReference: f.old.versionReference,
    selectorIndex: 0,
    counterpartIndex: 1,
  });
});
it.each(["no-member", "inactive", "empty-roster", "inactive-store", "inactive-brand", "region"])(
  "does not qualify SKU membership from %s",
  (mode) => {
    const f = prepared({}, true);
    if (mode === "no-member" || mode === "inactive") {
      const raw = structuredClone(f.input.aggregate);
      if (mode === "no-member") Object.assign(raw.draft, { skus: [] });
      else Object.assign(raw.draft.skus[0] ?? {}, { lifecycle: "Suspended" });
      const aggregate = parseProductAggregate(raw),
        identity = deriveCatalogProductPublicationContentIdentity(aggregate);
      f.input = { ...f.input, aggregate };
      rebind(f, {
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      });
    }
    if (mode === "empty-roster") f.stores = { ...f.stores, referenceCount: "0", references: [] };
    if (mode === "inactive-store")
      f.stores = {
        ...f.stores,
        references: f.stores.references.map((s) => ({ ...s, lifecycle: "Suspended" })),
      };
    if (mode === "inactive-brand") f.stores = { ...f.stores, brandLifecycle: "Suspended" };
    if (mode === "region")
      rebind(f, {
        scopeSet: [{ level: "Region", reference: id(33), channelCodes: [], orderTypeCodes: [] }],
      });
    const result = run(f);
    expect(result.publishableSkuCheck.outcome).toBe("HardError");
    if (mode === "no-member" || mode === "inactive") {
      expect(result.check.outcome).toBe("Pass");
      expect(result.skuQualification).toBe("NoActiveMember");
    }
    if (mode === "region")
      expect(result.findings).toContainEqual({
        reason: "CURRENT_TOPOLOGY_REQUIRED",
        versionReference: null,
        selectorIndex: 0,
        counterpartIndex: null,
      });
  },
);
it("binds the complete current head for SubmitReview/Publish and keeps the old entry Validate-only", () => {
  const f = prepared({}, true);
  advance(f, "SubmitReview");
  expect(run(f).check.outcome).toBe("Pass");
  expect(() =>
    assessCatalogProductUniqueScopeV2(f.input.command, f.coverage, f.stores, f.policy, at),
  ).toThrow();
  advance(f, "Publish");
  expect(run(f).check.outcome).toBe("Pass");
  expect(run(f).originalIntentDigest).toBe(hash(f.input.command));
});
it("preserves delayed System activation and its true Scheduled head instead of a User Validate command", () => {
  const f = prepared({}, true);
  rebind(f, { effectivePeriod: period(plus(at, 10000)) });
  advance(f, "SubmitReview");
  advance(f, "SchedulePublish");
  advance(f, "ActivateScheduled");
  const result = run(f);
  expect(result.check.outcome).toBe("Pass");
  expect(f.input.current?.state).toBe("Scheduled");
  expect(f.input.command.actorKind).toBe("System");
  expect(result.originalIntentDigest).toBe(hash(f.input.command));
  expect(f.input.command.occurredAt < f.input.observedAt).toBe(true);
});
it("binds independent Ack to the real original report and current head after human reading", () => {
  const f = prepared({}, true),
    recorded = advance(f, "Validate", true),
    details = parseCatalogProductPublicationValidationDetails({
      coverage: "Complete",
      impact: "Recorded",
      findings: [
        {
          checkCode: "ChangeImpact",
          ruleCode: "SYNTHETIC_REFERENCE_GAP",
          outcome: "Warning",
          subjectReference: id(10),
          reasonCode: "SYNTHETIC",
          references: [],
        },
      ],
      sources: [
        {
          sourceCode: "SYNTHETIC_SOURCE",
          sourceDigest: hash("synthetic"),
          generation: null,
          relevantReferenceDigest: hash("synthetic relevant"),
          observedAt: at,
          validUntil: plus(at, 3000),
        },
      ],
    }),
    report = buildCatalogProductPublicationValidationReport({
      ...recorded,
      details,
      recordedAt: at,
    }),
    observedAt = plus(at, 3600000),
    command = parseCatalogProductPublicationWarningAcknowledgementCommand({
      profile: "CatalogProductPublicationWarningAcknowledgementCommandV1",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_WARNING_ACKNOWLEDGEMENT",
      action: "AcknowledgeProductPublicationWarnings",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(9500),
      productReference: id(5),
      versionReference: id(70),
      expectedProductAggregateVersion: f.input.aggregate.aggregateVersion,
      reportOperationReference: report.operationReference,
      reportDigest: report.digest,
      warningBindingDigest: report.warningBindingDigest,
      warningCodes: ["ChangeImpact"],
      reasonCode: "EXPLICIT_REVIEW",
      occurredAt: observedAt,
    });
  f.input = { ...f.input, command, report };
  sourceClock(f, observedAt);
  const result = run(f);
  expect(result.originalIntentDigest).toBe(hash(command));
  expect(result.check.outcome).toBe("Pass");
  expect(report.validation.validUntil < observedAt).toBe(true);
  f.input = {
    ...f.input,
    command: parseCatalogProductPublicationWarningAcknowledgementCommand({
      ...command,
      reportDigest: hash("other report"),
    }),
  };
  f.stores = { ...f.stores, originalIntentDigest: hash(f.input.command) };
  expect(() => run(f)).toThrow();
});
it("keeps the first original lease with staggered later coverage/Store observations", () => {
  const f = prepared();
  sourceClock(f, at, plus(at, 2));
  const result = run(f, plus(at, 3));
  expect(result.observedAt).toBe(at);
  expect(result.validUntil).toBe(plus(at, 3000));
  expect(result.sourceDigest).toBe(f.coverage.digest);
  f.policy = { ...f.policy, validUntil: plus(at, 500) };
  expect(run(f, plus(at, 3)).validUntil).toBe(plus(at, 500));
  expect(() => run(f, plus(at, 500))).toThrow();
});
it("caps Exact target qualification at its actual old period expiry", () => {
  const f = prepared({ oldUntil: plus(at, 1000) });
  expect(run(f).validUntil).toBe(plus(at, 1000));
  expect(() => run(f, plus(at, 1000))).toThrow();
});
it.each(["Reject", "CancelScheduledPublish"] as const)(
  "preserves %s with an expired incoming period as a negative assessment",
  (action) => {
    const f = prepared({}, true);
    rebind(f, {
      effectivePeriod: period(action === "Reject" ? at : plus(at, 1000), plus(at, 2000)),
    });
    advance(f, "SubmitReview");
    if (action === "CancelScheduledPublish") advance(f, "SchedulePublish");
    advance(f, action);
    const observedAt = plus(at, 3000);
    rebind(f, { occurredAt: observedAt });
    sourceClock(f, observedAt);
    const result = run(f);
    expect(result.check.outcome).toBe("HardError");
    expect(result.findings).toContainEqual({
      reason: "PUBLICATION_PERIOD_EXPIRED",
      versionReference: null,
      selectorIndex: 0,
      counterpartIndex: null,
    });
    expect(result.publishableSkuCheck.outcome).toBe("HardError");
    expect(result.equalRankResolution).toBe("NotEvaluatedForExpiredPeriod");
    expect(result.validUntil).toBe(plus(observedAt, 3000));
    expect(result.originalIntentDigest).toBe(hash(f.input.command));
  },
);
it.each(["Reject", "CancelScheduledPublish"] as const)(
  "preserves %s after its Exact target expires without granting an exemption",
  (action) => {
    const f = prepared({ oldUntil: plus(at, 1000) });
    if (action === "CancelScheduledPublish") rebind(f, { effectivePeriod: period(plus(at, 500)) });
    advance(f, "SubmitReview");
    if (action === "CancelScheduledPublish") advance(f, "SchedulePublish");
    advance(f, action);
    const observedAt = plus(at, 2000);
    rebind(f, { occurredAt: observedAt });
    sourceClock(f, observedAt);
    const result = run(f);
    expect(result.check.outcome).toBe("HardError");
    expect(result.findings).toContainEqual({
      reason: "REPLACEMENT_TARGET_NOT_CURRENT",
      versionReference: f.old.versionReference,
      selectorIndex: 0,
      counterpartIndex: 0,
    });
    expect(result.equalRankResolution).toBe("ReplacementTargetNotCurrent");
    expect(result.validUntil).toBe(plus(observedAt, 3000));
  },
);
it.each([
  "missing-coverage",
  "source-root",
  "source-clock",
  "store-hash",
  "store-clock",
  "policy-owner",
  "policy-clock",
  "policy-expired",
  "original-expired",
  "extra-input",
  "full-head",
  "missing-content",
])("refuses %s without inventing a result", (mode) => {
  const f = prepared({}, true);
  if (mode === "missing-coverage") Object.assign(f, { coverage: null });
  if (mode === "source-root")
    Object.assign(f, {
      coverage: buildCatalogProductRetirementCoverage({
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(5),
        aggregateVersion: 2,
        sourceRevision: "1",
        observedAt: at,
        history: [],
        headers: [],
      }),
    });
  if (mode === "source-clock")
    f.coverage = buildCatalogProductRetirementCoverage({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      aggregateVersion: 1,
      sourceRevision: "1",
      observedAt: before,
      history: [],
      headers: [],
    });
  if (mode === "store-hash")
    f.stores = { ...f.stores, originalIntentDigest: hash("different intent") };
  if (mode === "store-clock") f.stores = { ...f.stores, observedAt: plus(at, 1) };
  if (mode === "policy-owner")
    f.policy = { ...f.policy, content: { ...f.policy.content, brandReference: id(99) } };
  if (mode === "policy-clock") f.policy = { ...f.policy, observedAt: plus(at, 1) };
  if (mode === "policy-expired") f.policy = { ...f.policy, validUntil: at };
  if (mode === "original-expired") f.input = { ...f.input, validUntil: at };
  if (mode === "extra-input") Object.assign(f.input, { isHeld: true });
  if (mode === "full-head") {
    advance(f, "Validate");
    f.input = {
      ...f.input,
      current: { ...required(f.input.current), intentDigest: hash("different head") },
    };
  }
  if (mode === "missing-content") {
    const raw: Record<string, unknown> = { ...f.input.aggregate.draft };
    delete raw.editorContent;
    const aggregate = parseProductAggregate({ ...f.input.aggregate, draft: raw }),
      identity = deriveCatalogProductPublicationContentIdentity(aggregate);
    f.input = { ...f.input, aggregate };
    rebind(f, {
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    });
  }
  expect(() => run(f)).toThrow();
});
it("rejects expired/retired/retargeted Exact tuples even when the replacement intent digest is resealed", () => {
  const f = prepared(),
    c = f.input.command;
  if (
    c.profile !== "CatalogProductPublicationCommandV2" ||
    c.replacementIntent.mode !== "PermanentSelectorRetirement"
  )
    throw Error("Expected Exact fixture");
  const { digest, ...target } = c.replacementIntent,
    changed = { ...target, expectedPreviousPublicationVersion: 99 },
    intent = parseCatalogProductScopeReplacementIntent({ ...changed, digest: hash(changed) });
  expect(digest).toBe(hash(target));
  rebind(f, { replacementIntent: intent, replacementIntentDigest: intent.digest });
  expect(() => run(f)).toThrow();
  const retired = prepared({ retired: true, extraScopes: [selector(22)] }),
    original = retired.intentFor(retired.old);
  rebind(retired, {
    scopeSet: [selector(20)],
    replacementIntent: original,
    replacementIntentDigest: original.digest,
  });
  expect(() => run(retired)).toThrow();
});
it("rejects accessor inputs before evaluating them and detaches the successful assessment", () => {
  const f = prepared(),
    getter = vi.fn(),
    bad = { ...f.input };
  Object.defineProperty(bad, "report", { enumerable: true, get: getter });
  expect(() =>
    assessCatalogProductPublicationScope(bad, f.coverage, f.stores, f.policy, at),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const result = run(f),
    original = canonicalizeRfc8785(result);
  if (f.stores.references[0]) Object.assign(f.stores.references[0], { lifecycle: "Suspended" });
  expect(canonicalizeRfc8785(result)).toBe(original);
});
it("keeps relevant evidence stable across original command, read-clock and Draft/review root revisions", () => {
  const f = prepared({}, true),
    first = run(f);
  rebind(f, { operationReference: id(9800) });
  sourceClock(f, plus(at, 2));
  const reread = run(f);
  expect(reread.originalIntentDigest).not.toBe(first.originalIntentDigest);
  expect(reread.sourceDigest).not.toBe(first.sourceDigest);
  expect(reread.registeredStoreDigest).not.toBe(first.registeredStoreDigest);
  expect(reread.relevantReferenceDigest).toBe(first.relevantReferenceDigest);
  sourceClock(f, at);
  advance(f, "SubmitReview");
  const draft = run(f);
  advance(f, "Publish");
  const review = run(f);
  expect(draft.aggregateVersion).not.toBe(first.aggregateVersion);
  expect(review.aggregateVersion).not.toBe(draft.aggregateVersion);
  expect(review.sourceHeadDigest).not.toBe(draft.sourceHeadDigest);
  expect(draft.relevantReferenceDigest).toBe(first.relevantReferenceDigest);
  expect(review.relevantReferenceDigest).toBe(first.relevantReferenceDigest);
});
it("excludes unrelated Store changes and coarse roster generations but retains consumed Store lifecycle", () => {
  const f = prepared({}, true),
    first = run(f);
  f.stores = {
    ...f.stores,
    generation: "4",
    brandVersion: "2",
    references: f.stores.references.map((store) =>
      store.storeReference === id(22)
        ? { ...store, lifecycle: "Suspended", version: "2", updatedAt: at }
        : store,
    ),
  };
  const unrelated = run(f);
  expect(unrelated.registeredStoreDigest).not.toBe(first.registeredStoreDigest);
  expect(unrelated.storeRelevantDigest).toBe(first.storeRelevantDigest);
  expect(unrelated.relevantReferenceDigest).toBe(first.relevantReferenceDigest);
  f.stores = {
    ...f.stores,
    generation: "5",
    references: f.stores.references.map((store) =>
      store.storeReference === id(20)
        ? { ...store, lifecycle: "Suspended", version: "2", updatedAt: at }
        : store,
    ),
  };
  const affected = run(f);
  expect(affected.storeRelevantDigest).not.toBe(first.storeRelevantDigest);
  expect(affected.relevantReferenceDigest).not.toBe(first.relevantReferenceDigest);
  expect(affected.publishableSkuCheck.outcome).toBe("HardError");
});
it("retains actual published or reserved scope/period and verified retirement effects in relevant evidence", () => {
  const live = prepared({ extraScopes: [selector(22)] }),
    retired = prepared({ retired: true, extraScopes: [selector(22)] }),
    reserved = prepared({ extraScopes: [selector(22)], scheduled: true }),
    none = noReplacement();
  for (const f of [live, retired, reserved])
    rebind(f, {
      scopeSet: [selector(20)],
      replacementIntent: none,
      replacementIntentDigest: none.digest,
    });
  const current = run(live),
    disposed = run(retired),
    scheduled = run(reserved);
  expect(current.check.outcome).toBe("HardError");
  expect(disposed.check.outcome).toBe("Pass");
  expect(disposed.scopeRelevantDigest).not.toBe(current.scopeRelevantDigest);
  expect(scheduled.scopeRelevantDigest).not.toBe(current.scopeRelevantDigest);
  expect(disposed.relevantReferenceDigest).not.toBe(current.relevantReferenceDigest);
});
