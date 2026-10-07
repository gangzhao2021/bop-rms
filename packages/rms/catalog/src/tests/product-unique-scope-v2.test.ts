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
import {
  assessCatalogProductUniqueScopeV2,
  parseCatalogProductUniqueScopeAssessmentV2,
} from "../contracts/product-unique-scope-v2.js";
import { assessProductUniqueScopeRules } from "../domain/product-unique-scope.js";

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
const run = (f: ReturnType<typeof fixture>, now = at) =>
  assessCatalogProductUniqueScopeV2(f.command, f.coverage, f.stores, f.policy, now);
function rehash(value: Record<string, unknown>) {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: hash(body) };
}
function assessNone(
  f: ReturnType<typeof fixture>,
  scopeSet: readonly ProductPublicationScope[] = f.command.scopeSet,
  coverage = f.coverage,
) {
  const intent = noReplacement(),
    command = parseProductPublicationCommandV2({
      ...f.command,
      expectedProductAggregateVersion: coverage.aggregateVersion,
      scopeSet,
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
    });
  return assessCatalogProductUniqueScopeV2(
    command,
    coverage,
    { ...f.stores, originalIntentDigest: hash(command) },
    f.policy,
    at,
  );
}

it("permits a None first publication with complete empty coverage and no invented target", () => {
  const f = fixture(),
    empty = buildCatalogProductRetirementCoverage({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      aggregateVersion: 1,
      sourceRevision: "1",
      observedAt: at,
      history: [],
      headers: [],
    }),
    result = assessNone(f, [selector(20), selector(21)], empty);
  expect(result).toMatchObject({
    check: { outcome: "Pass" },
    findings: [],
    equalRankResolution: "NoReplacementRequested",
    sourceDigest: empty.digest,
  });
  expect(parseCatalogProductUniqueScopeAssessmentV2(structuredClone(result))).toEqual(result);
});
it.each([false, true])(
  "None retains live equal-rank conflicts and Scheduled reservations (scheduled=%s)",
  (scheduled) => {
    const f = fixture({ extraScopes: [selector(22)], scheduled }),
      result = assessNone(f, [selector(21), selector(22)]);
    expect(result.equalRankResolution).toBe("NoReplacementRequested");
    expect(result.check.outcome).toBe("HardError");
    expect(result.findings).toContainEqual({
      reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
      versionReference: id(40),
      selectorIndex: 0,
      counterpartIndex: 1,
    });
    expect(result.findings).toContainEqual({
      reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
      versionReference: id(50),
      selectorIndex: 1,
      counterpartIndex: 0,
    });
    expect(parseCatalogProductUniqueScopeAssessmentV2(result)).toEqual(result);
  },
);
it("None respects only actual recorded retirements, including after the replacement expires", () => {
  const retired = fixture({ extraScopes: [selector(22)], retired: true }),
    bytes = canonicalizeRfc8785(retired.coverage),
    result = assessNone(retired, [selector(20)]);
  expect(result.check.outcome).toBe("Pass");
  expect(result.equalRankResolution).toBe("NoReplacementRequested");
  expect(canonicalizeRfc8785(retired.coverage)).toBe(bytes);
  const stillLive = fixture({ extraScopes: [selector(20)], retired: true });
  expect(assessNone(stillLive).findings).toEqual([
    {
      reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
      versionReference: id(50),
      selectorIndex: 0,
      counterpartIndex: 0,
    },
  ]);
});
it.each([false, true])(
  "binds a legal single-Store Published target (V2=%s) without changing its bytes",
  (oldV2) => {
    const f = fixture({ oldV2, oldScopes: [selector(20)] }),
      bytes = canonicalizeRfc8785(f.old),
      result = run(f);
    expect(result.check.outcome).toBe("Pass");
    expect(result.equalRankResolution).toBe("ExactStoreSelectorRetirementBound");
    expect(canonicalizeRfc8785(f.old)).toBe(bytes);
    expect(result.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
  },
);

it("binds the exact selector, full command and coverage while retaining immutable V1 bytes and rules", () => {
  const f = fixture(),
    beforeBytes = canonicalizeRfc8785(f.coverage),
    oldDigest = hash(f.old),
    result = run(f),
    unchanged = assessProductUniqueScopeRules({
      command: f.command,
      latest: f.coverage.latest,
      scopeOrder: productPublicationScopeLevels,
      activeStores: new Set([id(20), id(21), id(22)]),
      brandActive: true,
      registeredStoreCount: 3,
      observedAt: at,
    });
  expect(unchanged.findings).toEqual([
    {
      reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
      versionReference: id(40),
      selectorIndex: 0,
      counterpartIndex: 0,
    },
  ]);
  expect(result.check.outcome).toBe("Pass");
  expect(result.originalIntentDigest).toBe(hash(f.command));
  expect(result.replacementIntentDigest).toBe(f.command.replacementIntentDigest);
  expect(result.sourceDigest).toBe(f.coverage.digest);
  expect(result.sourceRevision).toBe(f.coverage.sourceRevision);
  expect(result.sourceHeadDigest).toBe(
    catalogProductRetirementSourceHeadDigest({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      aggregateVersion: f.coverage.aggregateVersion,
      sourceRevision: f.coverage.sourceRevision,
      latest: f.coverage.latest,
    }),
  );
  expect(result.validUntil).toBe("2026-10-02T12:00:05.000Z");
  expect(result).toMatchObject({
    publishValidation: "Incomplete",
    sourceAuthority: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  expect(canonicalizeRfc8785(f.coverage)).toBe(beforeBytes);
  expect(hash(f.old)).toBe(oldDigest);
  expect(f.old.scopeSet).toHaveLength(2);
});
it.each([false, true])(
  "retains other equal-rank publications and Scheduled reservations (scheduled=%s)",
  (scheduled) => {
    const result = run(fixture({ extraScopes: [selector(20)], scheduled }));
    expect(result.check.outcome).toBe("HardError");
    expect(result.findings).toEqual([
      {
        reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
        versionReference: id(50),
        selectorIndex: 0,
        counterpartIndex: 0,
      },
    ]);
  },
);
it("accepts the actual current V2 Draft revision and permits a newly bound Draft target without accepting a stale revision", () => {
  const f = fixture({ extraScopes: [selector(20), selector(22)] }),
    base = f.facts(f.command),
    draft = planCatalogProductPublicationV2(f.command, null, {
      ...base,
      replacement: null,
      validation: {
        ...base.validation,
        profile: "CatalogProductPublicationValidationV2",
        replacementIntentDigest: f.command.replacementIntentDigest,
        approvalPolicy: "Required",
        checks: base.validation.checks.map((check) => ({
          ...check,
          outcome: check.code === "ApprovalPolicy" ? "Pending" : check.outcome,
        })),
      },
    });
  expect(draft).toMatchObject({
    state: "Draft",
    validationDecision: "ApprovalPending",
    approvalEvidenceReference: null,
    publishedAt: null,
  });
  f.headers.push(
    buildCatalogProductScopeRetirementHeader({
      publicationAction: "Validate",
      publication: draft,
      previousPublication: null,
      observedSourceRevision: f.coverage.sourceRevision,
      observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
        tenantReference: f.coverage.tenantReference,
        brandReference: f.coverage.brandReference,
        productReference: f.coverage.productReference,
        aggregateVersion: f.coverage.aggregateVersion,
        sourceRevision: f.coverage.sourceRevision,
        latest: f.coverage.latest,
      }),
    }),
  );
  f.history.push({ publicationAction: "Validate", publication: draft });
  const coverage = f.coverageAt(),
    policy = { ...f.policy, content: { ...f.policy.content, approvalPolicy: "Required" } },
    intent = f.intentFor(required(f.extra)),
    command = {
      ...f.command,
      operationReference: id(5000),
      expectedProductAggregateVersion: coverage.aggregateVersion,
      expectedPublicationVersion: draft.publicationVersion,
      replacementIntent: intent,
      replacementIntentDigest: intent.digest,
    },
    result = assessCatalogProductUniqueScopeV2(
      command,
      coverage,
      { ...f.stores, originalIntentDigest: hash(command) },
      policy,
      at,
    );
  expect(result.findings).toEqual([
    {
      reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
      versionReference: id(40),
      selectorIndex: 0,
      counterpartIndex: 0,
    },
  ]);
  const stale = { ...command, expectedPublicationVersion: 0 };
  expect(() =>
    assessCatalogProductUniqueScopeV2(
      stale,
      coverage,
      { ...f.stores, originalIntentDigest: hash(stale) },
      policy,
      at,
    ),
  ).toThrow();
});
it.each(["Region", "StoreGroup"] as const)("retains unsupported %s topology", (level) => {
  const f = fixture({ extraScopes: [{ ...selector(20), level }] });
  expect(run(f).findings).toContainEqual({
    reason: "CURRENT_TOPOLOGY_REQUIRED",
    versionReference: id(50),
    selectorIndex: 0,
    counterpartIndex: null,
  });
});
it("keeps registration findings including an inactive retained old B", () => {
  const f = fixture();
  required(f.stores.references[1]).lifecycle = "Archived";
  expect(run(f).findings).toContainEqual({
    reason: "STORE_NOT_CURRENT_ACTIVE",
    versionReference: id(40),
    selectorIndex: 1,
    counterpartIndex: null,
  });
  required(f.stores.references[0]).lifecycle = "Archived";
  expect(run(f).findings).toContainEqual({
    reason: "STORE_NOT_CURRENT_ACTIVE",
    versionReference: null,
    selectorIndex: 0,
    counterpartIndex: null,
  });
});
it("suppresses a recorded retirement permanently after its replacement expires, and never a still-live other A", () => {
  expect(run(fixture({ extraScopes: [selector(20), selector(22)] })).check.outcome).toBe(
    "HardError",
  );
  const f = fixture({ extraScopes: [selector(20), selector(22)], retired: true });
  expect(run(f).check.outcome).toBe("Pass");
  const intent = f.intentFor(f.old),
    c = { ...f.command, replacementIntent: intent, replacementIntentDigest: intent.digest };
  expect(() =>
    assessCatalogProductUniqueScopeV2(
      c,
      f.coverage,
      { ...f.stores, originalIntentDigest: hash(c) },
      f.policy,
      at,
    ),
  ).toThrow();
  required(f.stores.references[0]).lifecycle = "Archived";
  expect(run(f).findings).toContainEqual({
    reason: "STORE_NOT_CURRENT_ACTIVE",
    versionReference: id(40),
    selectorIndex: 0,
    counterpartIndex: null,
  });
});
it("does not accept a target whose effective period already ended", () => {
  expect(() => run(fixture({ oldUntil: at }))).toThrow();
});
it.each(["operation", "revision", "intent", "scope", "period", "ordinal", "selector"])(
  "refuses altered original target %s",
  (part) => {
    const f = fixture(),
      intent = { ...parseCatalogProductScopeReplacementIntent(f.command.replacementIntent) };
    if (part === "operation") intent.previousPublicationOperationReference = id(999);
    if (part === "revision") intent.expectedPreviousPublicationVersion++;
    if (part === "intent") intent.previousIntentDigest = hash("wrong");
    if (part === "scope") intent.previousScopeDigest = hash("wrong");
    if (part === "period") intent.previousPeriodDigest = hash("wrong");
    if (part === "ordinal") intent.previousSelectorIndex = 1;
    if (part === "selector") intent.previousSelectorDigest = hash(selector(22));
    const replacementIntent = rehash(intent),
      command = {
        ...f.command,
        replacementIntent,
        replacementIntentDigest: replacementIntent.digest,
      };
    expect(() =>
      assessCatalogProductUniqueScopeV2(
        command,
        f.coverage,
        { ...f.stores, originalIntentDigest: hash(command) },
        f.policy,
        at,
      ),
    ).toThrow();
  },
);
it("refuses canonical-history reordering, missing retirement coverage and V1 or unknown fields", () => {
  const f = fixture(),
    raw = JSON.parse(JSON.stringify(f.coverage));
  raw.history[2].publication.scopeSet.reverse();
  expect(() =>
    assessCatalogProductUniqueScopeV2(f.command, rehash(raw), f.stores, f.policy, at),
  ).toThrow();
  const retired = fixture({ extraScopes: [selector(20), selector(22)], retired: true });
  expect(() =>
    assessCatalogProductUniqueScopeV2(
      retired.command,
      rehash({ ...retired.coverage, headers: [] }),
      retired.stores,
      retired.policy,
      at,
    ),
  ).toThrow();
  const v1 = Object.fromEntries(
    Object.entries(f.command).filter(
      ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
    ),
  );
  expect(() => assessCatalogProductUniqueScopeV2(v1, f.coverage, f.stores, f.policy, at)).toThrow();
  expect(() =>
    assessCatalogProductUniqueScopeV2(
      { ...f.command, skipSelectors: [0] },
      f.coverage,
      f.stores,
      f.policy,
      at,
    ),
  ).toThrow();
});
it.each([
  "root",
  "ownRevision",
  "storeIntent",
  "observation",
  "policy",
  "sourceDigest",
  "clockPast",
  "clockExpired",
])("rejects substituted or expired binding %s", (part) => {
  const f = fixture();
  let c: unknown = f.command,
    coverage: unknown = f.coverage,
    now = at;
  if (part === "root")
    c = {
      ...f.command,
      expectedProductAggregateVersion: f.command.expectedProductAggregateVersion + 1,
    };
  if (part === "ownRevision") c = { ...f.command, expectedPublicationVersion: 1 };
  if (part === "storeIntent") f.stores.originalIntentDigest = hash("wrong");
  if (part === "observation") f.stores.observedAt = "2026-10-02T12:00:01.000Z";
  if (part === "policy") f.policy.content.brandReference = id(999);
  if (part === "sourceDigest") coverage = { ...f.coverage, digest: hash("wrong") };
  if (part === "clockPast") now = "2026-10-02T11:59:59.999Z";
  if (part === "clockExpired") now = "2026-10-02T12:00:05.000Z";
  expect(() => assessCatalogProductUniqueScopeV2(c, coverage, f.stores, f.policy, now)).toThrow();
});
it("captures complete assessments, rejects getters and digest/check/ordinal drift, and keeps original policy deadlines", () => {
  const f = fixture({ extraScopes: [selector(20)] });
  f.policy.validUntil = "2026-10-02T12:00:02.000Z";
  const result = run(f),
    raw = JSON.parse(JSON.stringify(result)),
    parsed = parseCatalogProductUniqueScopeAssessmentV2(raw);
  expect(result.validUntil).toBe(f.policy.validUntil);
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(Object.isFrozen(parsed.findings)).toBe(true);
  expect(Object.isFrozen(parsed.findings[0])).toBe(true);
  expect(Object.isFrozen(parsed.check)).toBe(true);
  raw.findings[0].counterpartIndex = 4;
  expect(parsed.findings[0]?.counterpartIndex).toBe(0);
  const get = vi.fn();
  expect(() =>
    parseCatalogProductUniqueScopeAssessmentV2(
      Object.defineProperty({ ...result }, "check", { enumerable: true, get }),
    ),
  ).toThrow();
  expect(() =>
    assessCatalogProductUniqueScopeV2(
      Object.defineProperty({ ...f.command }, "replacementIntent", { enumerable: true, get }),
      f.coverage,
      f.stores,
      f.policy,
      at,
    ),
  ).toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(() =>
    parseCatalogProductUniqueScopeAssessmentV2({ ...result, sourceHeadDigest: hash("wrong") }),
  ).toThrow();
  for (const patch of [
    { profile: "CatalogProductUniqueScopeAssessmentV1" },
    { extra: true },
    { check: { code: "UniqueScope", outcome: "Pass" } },
    { findings: [{ ...required(result.findings[0]), counterpartIndex: 1000 }] },
    { validUntil: "2026-10-02T12:00:05.001Z" },
  ])
    expect(() =>
      parseCatalogProductUniqueScopeAssessmentV2(rehash({ ...result, ...patch })),
    ).toThrow();
});
