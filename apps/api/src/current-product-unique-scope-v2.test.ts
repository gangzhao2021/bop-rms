import { beforeEach, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { parsePublishingProductPublicationPolicy, productPolicyScopeLevels } from "@bop/publishing";
import type {
  TenantStoreReferenceSourceOptions,
  TenantStoreReferenceRequest,
  TenantStoreReferenceSnapshot,
} from "@bop/tenant";
import {
  buildCatalogProductRetirementCoverage,
  CatalogError,
  parseCatalogReference,
  parseProductPublicationVersion,
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
  parseProductPublicationCommandV2,
  type ProductPublicationStoreOptionsV2,
  type CatalogProductRetirementCoverage,
  createPostgresProductPublicationSourceStoreV2,
} from "@rms/catalog";
import { createCurrentProductUniqueScopeSourceV2 } from "./current-product-unique-scope-v2.js";
import type { CurrentProductPublicationPolicy } from "./current-product-publication-policy.js";
const owners = vi.hoisted(() => ({ history: vi.fn(), stores: vi.fn() }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductPublicationSourceStoreV2: owners.history,
}));
vi.mock("@bop/tenant", async (original) => ({
  ...(await original<typeof import("@bop/tenant")>()),
  createPostgresTenantStoreReferenceSource: owners.stores,
}));
type HistoryOptions = Parameters<typeof createPostgresProductPublicationSourceStoreV2>[0];
type Tx = Parameters<ProductPublicationStoreOptionsV2["sources"]["withHeldCurrentFacts"]>[0];
const id = (n: number) => "01902462-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-03T10:00:00.000Z",
  before = "2026-10-03T09:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
beforeEach(() => {
  owners.history.mockReset();
  owners.stores.mockReset();
});
function fixture(fixtureOptions: { none?: boolean; empty?: boolean } = {}) {
  let clock = at,
    mode = "normal",
    policyMilliseconds = 30000;
  const scopeSet = [20, 21].map((n) => ({
      level: "Store" as const,
      reference: id(n),
      channelCodes: [],
      orderTypeCodes: [],
    })),
    effectivePeriod = { timeZone: "UTC", effectiveFrom: boundary(before), effectiveUntil: null },
    previous = parseProductPublicationVersion({
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(6),
      versionReference: id(50),
      publicationVersion: 3,
      productAggregateVersion: 3,
      state: "Published",
      contentDigest: hash("old"),
      configurationDigest: hash("configuration"),
      scopeSet,
      scopeDigest: hash(scopeSet),
      effectivePeriod,
      periodDigest: hash(effectivePeriod),
      validationEvidenceReference: id(53),
      validationDecision: "Pass",
      policyReference: id(8),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      reviewReference: id(54),
      reviewVersion: 2,
      submittedByActorReference: id(3),
      approvalEvidenceReference: null,
      scheduleReference: null,
      scheduleVersion: 0,
      publishedAt: before,
      supersededAt: null,
      supersededByVersionReference: null,
      successorDraftVersionReference: id(7),
      operationReference: id(52),
      intentDigest: hash("old command"),
      actorReference: id(3),
      actorKind: "User",
      occurredAt: before,
      reasonCode: "SYNTHETIC",
    }),
    body = {
      profile: "CatalogProductExactStoreSelectorReplacementV1",
      mode: "PermanentSelectorRetirement",
      previousVersionReference: previous.versionReference,
      previousPublicationOperationReference: previous.operationReference,
      expectedPreviousPublicationVersion: previous.publicationVersion,
      previousIntentDigest: previous.intentDigest,
      previousScopeDigest: previous.scopeDigest,
      previousPeriodDigest: previous.periodDigest,
      previousSelectorIndex: 0,
      previousSelectorDigest: hash(scopeSet[0]),
    },
    replacementIntent = fixtureOptions.none
      ? parseCatalogProductPublicationReplacementIntent({
          profile: "CatalogProductNoReplacementIntentV1",
          mode: "None",
          digest: hash({ profile: "CatalogProductNoReplacementIntentV1", mode: "None" }),
        })
      : parseCatalogProductScopeReplacementIntent({ ...body, digest: hash(body) }),
    command = parseProductPublicationCommandV2({
      profile: "CatalogProductPublicationCommandV2",
      purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      actorKind: "User",
      operationReference: id(5),
      productReference: id(6),
      versionReference: id(7),
      expectedProductAggregateVersion: fixtureOptions.empty ? 1 : 4,
      expectedPublicationVersion: 0,
      action: "Validate",
      contentDigest: hash("current"),
      configurationDigest: hash("configuration"),
      scopeSet: [scopeSet[0]],
      effectivePeriod,
      scheduleReference: null,
      replacementVersionReference: null,
      successorDraftVersionReference: null,
      occurredAt: at,
      reasonCode: "SYNTHETIC",
      replacementIntent,
      replacementIntentDigest: replacementIntent.digest,
    }),
    input = { command, policyReference: id(8), policyVersion: 1 },
    tx: Tx = { query: vi.fn(async () => ({ rows: [] })) },
    coverage = (observedAt: string) =>
      buildCatalogProductRetirementCoverage({
        tenantReference: id(1),
        brandReference: id(2),
        productReference: id(6),
        aggregateVersion: fixtureOptions.empty ? 1 : 4,
        sourceRevision: fixtureOptions.empty ? "1" : "4",
        observedAt,
        headers: [],
        history: fixtureOptions.empty
          ? []
          : [
              {
                publicationAction: "Validate",
                publication: {
                  ...previous,
                  state: "Draft",
                  publicationVersion: 1,
                  productAggregateVersion: 1,
                  reviewReference: null,
                  reviewVersion: null,
                  submittedByActorReference: null,
                  publishedAt: null,
                  successorDraftVersionReference: null,
                  operationReference: id(55),
                },
              },
              {
                publicationAction: "SubmitReview",
                publication: {
                  ...previous,
                  state: "InReview",
                  publicationVersion: 2,
                  productAggregateVersion: 2,
                  publishedAt: null,
                  successorDraftVersionReference: null,
                  operationReference: id(56),
                },
              },
              { publicationAction: "Publish", publication: previous },
            ],
      }),
    validationAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => {
        if (mode === "validation-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
        if (
          mode === "late-validation" &&
          validationAuthority.holdUntilTransactionCompletes.mock.calls.length === 2
        )
          clock = new Date(Date.parse(at) + 5000).toISOString();
        if (
          mode === "delay-validation" &&
          validationAuthority.holdUntilTransactionCompletes.mock.calls.length === 1
        )
          clock = new Date(Date.parse(at) + 1000).toISOString();
      }),
    },
    historyAuthority = {
      holdUntilTransactionCompletes: vi.fn(async (): Promise<void> => {
        if (mode === "history-denial") throw new CatalogError("CATALOG_PERMISSION_DENIED");
      }),
    },
    tenantRead = vi.fn((request: TenantStoreReferenceRequest) => {
      expect(request.brandReference).toBe(id(2));
    }),
    tenantAuthority = {
      async withCurrentBrandReferenceRead<T>(
        request: TenantStoreReferenceRequest,
        work: () => Promise<T>,
      ): Promise<T> {
        tenantRead(request);
        return work();
      },
      isCurrent: vi.fn(async () => true),
    },
    policySource = {
      context: {
        tenantReference: parseCatalogReference(id(1)),
        brandReference: parseCatalogReference(id(2)),
        actorReference: parseCatalogReference(id(3)),
        actorKind: "User" as const,
      },
      async withCurrentPolicy<T>(
        actual: Tx,
        request: { policyReference: string; policyVersion: number; observedAt: string },
        work: (policy: CurrentProductPublicationPolicy) => Promise<T>,
      ): Promise<T> {
        expect(actual).toBe(tx);
        const policy = {
          content: parsePublishingProductPublicationPolicy({
            profile: "PublishingProductPublicationPolicyV1",
            tenantReference: id(1),
            brandReference: id(2),
            familyReference: id(9),
            policyReference: mode === "wrong-policy-reference" ? id(99) : request.policyReference,
            policyVersion:
              mode === "wrong-policy-version" ? request.policyVersion + 1 : request.policyVersion,
            scopeOrder: productPolicyScopeLevels,
            approvalPolicy: "NotRequired",
            warningOverrideAllowed: false,
            requiredLocales: ["en-CA"],
            mediaRequirement: "Optional",
            effectiveFrom: before,
            effectiveUntil: null,
          }),
          currentPublicationReference: id(10),
          observedAt: request.observedAt,
          validUntil: new Date(Date.parse(request.observedAt) + policyMilliseconds).toISOString(),
        };
        const result = await work(policy);
        if (mode === "double-policy") await work(policy);
        if (mode === "late-policy") clock = new Date(Date.parse(at) + 5000).toISOString();
        if (mode === "reverse-policy") clock = before;
        return mode === "policy-result" ? ({ substituted: true } as T) : result;
      },
    };
  // Synthetic owner adapters isolate API orchestration; the Catalog assessor,
  // publication/coverage parsers and full V2 hashes remain actual contracts.
  owners.history.mockImplementation((options: HistoryOptions) => ({
    async withCurrentCoverage<R>(
      request: unknown,
      work: (value: CatalogProductRetirementCoverage, actual: Tx) => Promise<R>,
    ) {
      expect(request).toEqual({
        productReference: id(6),
        expectedAggregateVersion: fixtureOptions.empty ? 1 : 4,
      });
      const observedAt = options.clock.now();
      const hold = () =>
        options.authority.holdUntilTransactionCompletes(tx, {
          tenantReference: id(1),
          brandReference: id(2),
          actorReference: id(3),
          actorKind: "User",
          productReference: id(6),
          purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE",
          permission: "catalog.manage",
          owningActions: ["catalog.product.history.read"],
          requiredFields: [] as unknown as Parameters<
            HistoryOptions["authority"]["holdUntilTransactionCompletes"]
          >[1]["requiredFields"],
          observedAt,
        });
      await hold();
      return options.transactions.run(async (actual) => {
        const result = await work(coverage(observedAt), actual);
        if (mode === "double-history") await work(coverage(observedAt), actual);
        await hold();
        return result;
      });
    },
  }));
  owners.stores.mockImplementation((options: TenantStoreReferenceSourceOptions) => ({
    async withCurrentSnapshot<R>(
      request: TenantStoreReferenceRequest,
      work: (snapshot: TenantStoreReferenceSnapshot) => Promise<R>,
    ) {
      return options.authority.withCurrentBrandReferenceRead(request, () =>
        options.transactions.run(async (actual) => {
          expect(actual).toBe(tx);
          expect(request.originalIntentDigest).toBe(hash(command));
          if (!(await options.authority.isCurrent(actual, request)))
            throw new Error("SYNTHETIC_ROSTER_DENIED");
          const snapshot: TenantStoreReferenceSnapshot = {
              profile: "TenantStoreReferenceV1",
              brandReference: id(2),
              brandLifecycle: "Active",
              brandVersion: "1",
              generation: "1",
              referenceCount: "2",
              originalIntentDigest:
                mode === "wrong-roster-intent" ? hash("downgraded") : request.originalIntentDigest,
              observedAt: request.observedAt,
              references: [20, 21].map((n) => ({
                storeReference: id(n),
                lifecycle: "Active",
                version: "1",
                createdAt: before,
                updatedAt: before,
              })),
            },
            result = await work(snapshot);
          if (mode === "double-stores") await work(snapshot);
          if (!(await options.authority.isCurrent(actual, request)))
            throw new Error("SYNTHETIC_ROSTER_DENIED");
          return result;
        }),
      );
    },
  }));
  const options = {
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
      validationAuthority,
      historyAuthority,
      tenantAuthority,
      policySource,
      clock: { now: () => clock },
    },
    source = createCurrentProductUniqueScopeSourceV2(options);
  return {
    source,
    options,
    tenantRead,
    input,
    tx,
    setMode: (value: string) => {
      mode = value;
    },
    setClock: (value: string) => {
      clock = value;
    },
    setPolicyMilliseconds: (value: number) => {
      policyMilliseconds = value;
    },
  };
}
it("binds actual pure V2 target assessment through one synthetic same-transaction owner chain", async () => {
  const f = fixture(),
    result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
  expect(result).toMatchObject({
    profile: "CatalogProductUniqueScopeAssessmentV2",
    originalIntentDigest: hash(f.input.command),
    replacementIntentDigest: f.input.command.replacementIntentDigest,
    check: { code: "UniqueScope", outcome: "Pass" },
    sourceRevision: "4",
    sourceAuthority: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
  });
  expect(f.options.validationAuthority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  expect(result.validUntil).toBe("2026-10-03T10:00:05.000Z");
});
it.each([
  "double-history",
  "double-stores",
  "double-policy",
  "policy-result",
  "wrong-roster-intent",
  "wrong-policy-reference",
  "wrong-policy-version",
  "late-policy",
  "reverse-policy",
  "late-validation",
])("rejects %s and poisons a failed transaction", async (mode) => {
  const f = fixture();
  f.setMode(mode);
  await expect(
    f.source.withCurrentAssessment(f.tx, f.input, async () => "result"),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  f.setMode("normal");
  await expect(f.source.withCurrentAssessment(f.tx, f.input, vi.fn())).rejects.toThrow();
});
it("keeps original composition deadline when coverage observes later and keeps a shorter policy lease", async () => {
  const f = fixture();
  f.setMode("delay-validation");
  const result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
  expect(result.observedAt).toBe("2026-10-03T10:00:01.000Z");
  expect(result.validUntil).toBe("2026-10-03T10:00:05.000Z");
  const boundedBody = Object.fromEntries(
    Object.entries(result).filter(([key]) => key !== "digest"),
  );
  expect(result.digest).toBe(hash(boundedBody));
  expect(result.digest).not.toBe(hash({ ...boundedBody, validUntil: "2026-10-03T10:00:06.000Z" }));
  const shorter = fixture();
  shorter.setPolicyMilliseconds(2000);
  expect(
    (await shorter.source.withCurrentAssessment(shorter.tx, shorter.input, async (value) => value))
      .validUntil,
  ).toBe("2026-10-03T10:00:02.000Z");
});
it.each(["validation-denial", "history-denial"])(
  "preserves %s before later owners or consumer",
  async (mode) => {
    const f = fixture(),
      work = vi.fn();
    f.setMode(mode);
    await expect(f.source.withCurrentAssessment(f.tx, f.input, work)).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.tenantRead).not.toHaveBeenCalled();
    expect(work).not.toHaveBeenCalled();
  },
);
it("captures configured ports and rejects tx mutation, consumer reentry and expired consumer completion", async () => {
  const f = fixture(),
    injected = vi.fn(async () => {
      throw new Error("MUTATED_PORT");
    });
  f.options.validationAuthority.holdUntilTransactionCompletes = injected;
  f.options.historyAuthority.holdUntilTransactionCompletes = injected;
  f.options.policySource.withCurrentPolicy = injected;
  f.options.clock.now = () => before;
  expect(await f.source.withCurrentAssessment(f.tx, f.input, async () => "captured")).toBe(
    "captured",
  );
  expect(injected).not.toHaveBeenCalled();
  for (const mode of ["query", "reentry", "expiry"]) {
    const g = fixture();
    await expect(
      g.source.withCurrentAssessment(g.tx, g.input, async () => {
        if (mode === "query") g.tx.query = vi.fn();
        if (mode === "expiry") g.setClock("2026-10-03T10:00:05.000Z");
        if (mode === "reentry")
          await g.source.withCurrentAssessment(g.tx, g.input, vi.fn()).catch(() => undefined);
        return "value";
      }),
    ).rejects.toThrow();
  }
});
it("rejects V1, extra fields, getters, foreign owner and unsupported action before acquisition", async () => {
  const base = fixture().input,
    legacy = Object.fromEntries(
      Object.entries(base.command).filter(
        ([key]) => !["profile", "replacementIntent", "replacementIntentDigest"].includes(key),
      ),
    ),
    invalid = [
      { ...base, extra: true },
      { ...base, command: legacy },
      ...["tenantReference", "brandReference", "actorReference"].map((key) => ({
        ...base,
        command: { ...base.command, [key]: id(99) },
      })),
      { ...base, command: { ...base.command, action: "SubmitReview" } },
      { ...base, policyVersion: 0 },
    ];
  for (const value of invalid) {
    const f = fixture();
    await expect(f.source.withCurrentAssessment(f.tx, value, vi.fn())).rejects.toThrow();
    expect(f.options.validationAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  }
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.input, "command", { enumerable: true, get: getter });
  await expect(f.source.withCurrentAssessment(f.tx, f.input, vi.fn())).rejects.toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it.each([false, true])(
  "None current-owner composition preserves full intent and denies any unretired overlap (empty=%s)",
  async (empty) => {
    const f = fixture({ none: true, empty }),
      result = await f.source.withCurrentAssessment(f.tx, f.input, async (value) => value);
    expect(result).toMatchObject({
      originalIntentDigest: hash(f.input.command),
      replacementIntentDigest: f.input.command.replacementIntentDigest,
      equalRankResolution: "NoReplacementRequested",
      check: { code: "UniqueScope", outcome: empty ? "Pass" : "HardError" },
      sourceRevision: empty ? "1" : "4",
    });
    expect(result.findings).toHaveLength(empty ? 0 : 1);
    if (!empty)
      expect(result.findings[0]).toMatchObject({
        reason: "EQUAL_RANK_REQUIRES_DISPOSITION",
        versionReference: id(50),
        selectorIndex: 0,
        counterpartIndex: 0,
      });
    expect(f.tenantRead).toHaveBeenCalled();
    expect(f.options.validationAuthority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(2);
  },
);
