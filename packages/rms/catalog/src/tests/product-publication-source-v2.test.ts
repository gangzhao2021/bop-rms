import { CatalogError } from "../contracts/product.js";
import { createPostgresProductPublicationSourceStoreV2 } from "../infrastructure/persistence/product-publication-source-store.js";
import type { ProductLifecycleTransaction } from "../infrastructure/persistence/product-lifecycle-store.js";
import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  planCatalogProductPublication,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  type ProductPublicationAction,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
  type ProductPublicationVersion,
  parseProductPublicationVersion,
} from "../contracts/product-publication.js";
import {
  planCatalogProductPublicationV2,
  parseProductPublicationVersionV2,
  type ProductPublicationCommandV2,
  type ProductPublicationFactsV2,
  type ProductPublicationVersionV2,
} from "../contracts/product-publication-v2.js";
import {
  parseCatalogProductScopeReplacementIntent,
  parseCatalogProductPublicationReplacementIntent,
} from "../contracts/product-scope-replacement-intent.js";
import {
  buildCatalogProductScopeRetirementHeader,
  type CatalogProductScopeRetirementHeader,
} from "../contracts/product-scope-retirement.js";
import {
  catalogProductRetirementSourceHeadDigest,
  buildCatalogProductRetirementCoverage,
  parseCatalogProductRetirementCoverage,
  resolveCatalogProductPublicationWithRetirements,
  type CatalogProductRetirementHistoryEntry,
  type CatalogProductRetirementPublication,
} from "../contracts/product-publication-source-v2.js";

const id = (n: number) => "01902432-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  before = "2026-10-02T10:00:00.000Z",
  reviewAt = "2026-10-02T11:00:00.000Z",
  start = "2026-10-02T12:00:00.000Z",
  actual = "2026-10-02T12:15:00.000Z",
  expiry = "2026-10-02T13:00:00.000Z",
  observedAt = "2026-10-02T14:00:00.000Z";
const hash = (value: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(value));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const selector = (n: number) => ({
  level: "Store" as const,
  reference: id(n),
  channelCodes: ["WEB"],
  orderTypeCodes: ["PICKUP"],
});
function required<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) throw new Error("Missing synthetic fixture");
  return value;
}
function fixture(
  options: {
    scheduled?: boolean;
    requiredApproval?: boolean;
    secondRetirement?: boolean;
    initialV2?: boolean;
    chain?: boolean;
  } = {},
) {
  const history: CatalogProductRetirementHistoryEntry[] = [],
    headers: CatalogProductScopeRetirementHeader[] = [];
  const scopes = options.initialV2 ? [selector(30)] : [selector(30), selector(31)],
    oldPeriod = { timeZone: "UTC", effectiveFrom: boundary(before), effectiveUntil: null };
  const command = (
    action: ProductPublicationAction,
    current: Pick<ProductPublicationVersion, "publicationVersion"> | null,
    at: string,
  ): ProductPublicationCommand => ({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(3),
    versionReference: id(4),
    actorReference: id(5),
    actorKind: "User",
    operationReference: id(100 + history.length),
    expectedProductAggregateVersion: 1 + history.length * 2,
    expectedPublicationVersion: current?.publicationVersion ?? 0,
    action,
    contentDigest: hash("old content"),
    configurationDigest: hash("configuration"),
    scopeSet: scopes,
    effectivePeriod: oldPeriod,
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: action === "Publish" ? id(20) : null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_PUBLICATION",
  });
  const facts = (c: ProductPublicationCommand): ProductPublicationFacts => ({
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
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" as const })),
      warningAcknowledgement: null,
      checkedAt: c.occurredAt,
      validUntil: "2026-10-03T00:00:00.000Z",
    },
    approval: null,
    reviewReference: c.action === "SubmitReview" ? id(12) : null,
    replacement: null,
  });
  let old: CatalogProductRetirementPublication | null = null;
  for (const a of ["Validate", "SubmitReview", "Publish"] as const) {
    const c = command(a, old, before);
    if (options.initialV2) {
      const body = { profile: "CatalogProductNoReplacementIntentV1", mode: "None" },
        intent = parseCatalogProductPublicationReplacementIntent({ ...body, digest: hash(body) }),
        base = facts(c);
      old = planCatalogProductPublicationV2(
        {
          ...c,
          profile: "CatalogProductPublicationCommandV2",
          replacementIntent: intent,
          replacementIntentDigest: intent.digest,
        },
        old === null ? null : parseProductPublicationVersionV2(old),
        {
          ...base,
          replacement: null,
          validation: {
            ...base.validation,
            profile: "CatalogProductPublicationValidationV2",
            replacementIntentDigest: intent.digest,
          },
        },
      );
      headers.push(
        buildCatalogProductScopeRetirementHeader({
          publicationAction: a,
          publication: old,
          previousPublication: null,
          observedSourceRevision: String(history.length + 1),
          observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
            tenantReference: id(1),
            brandReference: id(2),
            productReference: id(3),
            aggregateVersion: old.productAggregateVersion,
            sourceRevision: String(history.length + 1),
            latest: history.length === 0 ? [] : [required(history.at(-1)).publication],
          }),
        }),
      );
    } else
      old = planCatalogProductPublication(
        c,
        old === null ? null : parseProductPublicationVersion(old),
        facts(c),
      );
    history.push({ publicationAction: a, publication: old });
  }
  const previous = required(old);
  const addReplacement = (
    reference: number,
    target: CatalogProductRetirementPublication = previous,
    activationAt = actual,
    from = start,
    until = expiry,
  ) => {
    const intentBody = {
        profile: "CatalogProductExactStoreSelectorReplacementV1",
        mode: "PermanentSelectorRetirement",
        previousVersionReference: target.versionReference,
        previousPublicationOperationReference: target.operationReference,
        expectedPreviousPublicationVersion: target.publicationVersion,
        previousIntentDigest: target.intentDigest,
        previousScopeDigest: target.scopeDigest,
        previousPeriodDigest: target.periodDigest,
        previousSelectorIndex: 0,
        previousSelectorDigest: hash(target.scopeSet[0]),
      },
      intent = parseCatalogProductScopeReplacementIntent({
        ...intentBody,
        digest: hash(intentBody),
      }),
      period = {
        timeZone: "UTC",
        effectiveFrom: boundary(from),
        effectiveUntil: boundary(until),
      };
    let current: ProductPublicationVersionV2 | null = null;
    const actions: ProductPublicationAction[] = [
      "Validate",
      "SubmitReview",
      ...(options.requiredApproval ? ["Approve" as const] : []),
      ...(options.scheduled
        ? ["SchedulePublish" as const, "ActivateScheduled" as const]
        : ["Publish" as const]),
    ];
    for (const a of actions) {
      const isPublishing = a === "Publish" || a === "ActivateScheduled",
        at = isPublishing ? activationAt : reference === 20 ? reviewAt : actual,
        c: ProductPublicationCommandV2 = {
          ...command(a, current, at),
          profile: "CatalogProductPublicationCommandV2",
          replacementIntent: intent,
          replacementIntentDigest: intent.digest,
          versionReference: id(reference),
          actorReference: a === "Approve" ? id(6) : id(5),
          actorKind: a === "ActivateScheduled" ? "System" : "User",
          contentDigest: hash("incoming content " + reference),
          scopeSet: [required(target.scopeSet[0])],
          effectivePeriod: period,
          scheduleReference: a === "SchedulePublish" || a === "ActivateScheduled" ? id(15) : null,
          successorDraftVersionReference: isPublishing ? id(reference + 1) : null,
        },
        base = facts(c),
        f: ProductPublicationFactsV2 = {
          ...base,
          replacement: null,
          validation: {
            ...base.validation,
            profile: "CatalogProductPublicationValidationV2",
            replacementIntentDigest: intent.digest,
            approvalPolicy: options.requiredApproval ? "Required" : "NotRequired",
            checks: base.validation.checks.map((check) => ({
              ...check,
              outcome:
                options.requiredApproval &&
                ["Validate", "SubmitReview"].includes(a) &&
                check.code === "ApprovalPolicy"
                  ? "Pending"
                  : check.outcome,
            })),
          },
          // Controlled, fully bound approval evidence for pure history contracts;
          // the native writer separately proves actual owning receipt acquisition.
          approval:
            options.requiredApproval &&
            current &&
            ["Approve", "Publish", "SchedulePublish", "ActivateScheduled"].includes(a)
              ? {
                  profile: "CatalogProductPublicationApprovalV2",
                  replacementIntentDigest: intent.digest,
                  evidenceReference: id(16),
                  reviewReference: required(current.reviewReference),
                  reviewVersion: required(current.reviewVersion),
                  requestedByActorReference: id(5),
                  approvedByActorReference: id(6),
                  contentDigest: c.contentDigest,
                  configurationDigest: c.configurationDigest,
                  scopeDigest: hash(c.scopeSet),
                  periodDigest: hash(c.effectivePeriod),
                  policyReference: id(11),
                  policyVersion: 1,
                  approvedAt: reviewAt,
                  validUntil: "2026-10-03T00:00:00.000Z",
                }
              : null,
        };
      current = planCatalogProductPublicationV2(c, current, f);
      headers.push(
        buildCatalogProductScopeRetirementHeader({
          publicationAction: a,
          publication: current,
          previousPublication: isPublishing ? target : null,
          observedSourceRevision: String(history.length + 1),
          observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
            tenantReference: id(1),
            brandReference: id(2),
            productReference: id(3),
            aggregateVersion: current.productAggregateVersion,
            sourceRevision: String(history.length + 1),
            latest: [
              ...new Map(
                history.map((entry) => [entry.publication.versionReference, entry.publication]),
              ).values(),
            ],
          }),
        }),
      );
      history.push({ publicationAction: a, publication: current });
    }
    return required(current);
  };
  const incoming = addReplacement(20);
  if (options.secondRetirement) addReplacement(40);
  const final = options.chain
    ? addReplacement(
        40,
        incoming,
        "2026-10-02T12:16:00.000Z",
        "2026-10-02T12:16:00.000Z",
        "2026-10-02T12:30:00.000Z",
      )
    : incoming;
  const input = {
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(3),
    aggregateVersion: 1 + history.length * 2,
    sourceRevision: String(history.length + 1),
    observedAt,
    history,
    headers,
  };
  return { input, previous, incoming, final };
}
const context = (store: number, at: string) => ({
  storeReference: id(store),
  storeGroupReferences: [],
  regionReferences: [],
  channelCode: "WEB",
  orderTypeCode: "PICKUP",
  at,
});
function resolve(value: unknown, store: number, at: string) {
  return resolveCatalogProductPublicationWithRetirements(
    value,
    context(store, at),
    productPublicationScopeLevels,
  );
}
function rehash<T extends { digest: string }>(value: T): T {
  const body = Object.fromEntries(Object.entries(value).filter(([key]) => key !== "digest"));
  return { ...body, digest: hash(body) } as T;
}

it("records None publication with an empty header and replaces the resulting single-Store V2 head repeatedly", () => {
  const f = fixture({ initialV2: true, chain: true }),
    original = canonicalizeRfc8785(f.previous),
    coverage = buildCatalogProductRetirementCoverage(f.input);
  expect(f.previous).toMatchObject({ replacementIntent: { mode: "None" }, state: "Published" });
  expect(f.previous.scopeSet).toHaveLength(1);
  expect(coverage.headers.slice(0, 3).every((header) => header.retirements.length === 0)).toBe(
    true,
  );
  expect(coverage.headers.filter((header) => header.retirements.length === 1)).toHaveLength(2);
  expect(resolve(coverage, 30, before)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  expect(resolve(coverage, 30, actual)).toMatchObject({
    outcome: "Selected",
    versionReference: f.incoming.versionReference,
  });
  expect(resolve(coverage, 30, "2026-10-02T12:16:00.000Z")).toMatchObject({
    outcome: "Selected",
    versionReference: f.final.versionReference,
  });
  expect(resolve(coverage, 30, "2026-10-02T12:30:00.000Z")).toMatchObject({
    outcome: "Unavailable",
  });
  expect(resolve(coverage, 30, expiry)).toMatchObject({ outcome: "Unavailable" });
  expect(
    canonicalizeRfc8785(
      coverage.latest.find((p) => p.versionReference === f.previous.versionReference),
    ),
  ).toBe(original);
  expect(parseCatalogProductRetirementCoverage(structuredClone(coverage))).toEqual(coverage);
});
it("requires every None header and the exact original V2 revision throughout a retirement chain", () => {
  const f = fixture({ initialV2: true, chain: true });
  for (const removed of [0, 1, 2])
    expect(() =>
      buildCatalogProductRetirementCoverage({
        ...f.input,
        headers: f.input.headers.filter((_, index) => index !== removed),
      }),
    ).toThrow();
  expect(() =>
    buildCatalogProductRetirementCoverage({
      ...f.input,
      history: f.input.history.filter(
        (entry) => entry.publication.operationReference !== f.previous.operationReference,
      ),
    }),
  ).toThrow();
  const changed = structuredClone(f.input),
    publishedNone = required(changed.headers[2]),
    actualRow = required(changed.headers.at(-1)?.retirements[0]);
  changed.headers[2] = rehash({ ...publishedNone, retirements: [actualRow] });
  expect(() => buildCatalogProductRetirementCoverage(changed)).toThrow();
  expect(() =>
    buildCatalogProductRetirementCoverage(
      fixture({ initialV2: true, secondRetirement: true }).input,
    ),
  ).toThrow();
});

it("permanently retires old A at actual execution, preserves B and pre-retirement history, and never revives A at expiry", () => {
  const f = fixture({ requiredApproval: true }),
    bytes = canonicalizeRfc8785(f.previous),
    coverage = buildCatalogProductRetirementCoverage(f.input);
  expect(coverage).toMatchObject({
    coverage: "CompleteRecordedPublicationRetirements",
    sourceAuthority: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  expect(resolve(coverage, 30, start)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  expect(resolve(coverage, 30, actual)).toMatchObject({
    outcome: "Selected",
    versionReference: f.incoming.versionReference,
  });
  expect(resolve(coverage, 31, actual)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  expect(resolve(coverage, 30, expiry)).toMatchObject({ outcome: "Unavailable" });
  expect(resolve(coverage, 31, expiry)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  expect(
    canonicalizeRfc8785(
      coverage.latest.find((p) => p.versionReference === f.previous.versionReference),
    ),
  ).toBe(bytes);
  expect(coverage.latest.find((p) => p.versionReference === f.incoming.versionReference)).toEqual(
    f.incoming,
  );
  expect(f.incoming.approvalEvidenceReference).toBe(id(16));
  expect(Object.isFrozen(coverage.history)).toBe(true);
  expect(Object.isFrozen(coverage.latest[0]?.scopeSet)).toBe(true);
  const copied = structuredClone({ ...coverage, headers: [...coverage.headers] }),
    parsed = parseCatalogProductRetirementCoverage(copied);
  copied.headers.splice(0);
  expect(parsed.headers).toHaveLength(4);
});
it("scheduled activation retires at actual activation, retaining the old version between planned start and execution", () => {
  const f = fixture({ scheduled: true, requiredApproval: true }),
    coverage = buildCatalogProductRetirementCoverage(f.input);
  expect(coverage.headers.at(-1)).toMatchObject({
    publicationAction: "ActivateScheduled",
    recordedAt: actual,
  });
  expect(resolve(coverage, 30, start)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  expect(resolve(coverage, 30, actual)).toMatchObject({
    outcome: "Selected",
    versionReference: f.incoming.versionReference,
  });
});
it("retains mixed V1 history and pending V2 review without retiring or selecting the unapproved replacement", () => {
  const f = fixture({ requiredApproval: true }),
    history = f.input.history.slice(0, 5),
    coverage = buildCatalogProductRetirementCoverage({
      ...f.input,
      history,
      headers: f.input.headers.slice(0, 2),
    }),
    pending = required(
      coverage.latest.find(
        (publication) => publication.versionReference === f.incoming.versionReference,
      ),
    );
  expect(pending).toMatchObject({
    state: "InReview",
    validationDecision: "ApprovalPending",
    approvalEvidenceReference: null,
    publishedAt: null,
  });
  expect(coverage.headers.every((header) => header.retirements.length === 0)).toBe(true);
  expect(coverage.history.slice(0, 3)).toEqual(f.input.history.slice(0, 3));
  expect(resolve(coverage, 30, actual)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  expect(parseCatalogProductRetirementCoverage(structuredClone(coverage))).toEqual(coverage);
});
it("distinguishes recorded zero retirements from missing coverage, including every non-publishing revision", () => {
  const f = fixture(),
    partial = {
      ...f.input,
      history: f.input.history.slice(0, 5),
      headers: f.input.headers.slice(0, 2),
    },
    coverage = buildCatalogProductRetirementCoverage(partial);
  expect(coverage.headers.every((header) => header.retirements.length === 0)).toBe(true);
  expect(resolve(coverage, 30, actual)).toMatchObject({
    outcome: "Selected",
    versionReference: f.previous.versionReference,
  });
  for (let omitted = 0; omitted < f.input.headers.length; omitted++)
    expect(() =>
      buildCatalogProductRetirementCoverage({
        ...f.input,
        headers: f.input.headers.filter((_, index) => index !== omitted),
      }),
    ).toThrow();
  expect(() => buildCatalogProductRetirementCoverage({ ...f.input, headers: undefined })).toThrow();
  expect(() =>
    buildCatalogProductRetirementCoverage({
      ...f.input,
      headers: [...f.input.headers, f.input.headers[0]],
    }),
  ).toThrow();
});
it("rejects duplicate permanent retirement even with another complete valid incoming version", () => {
  expect(() =>
    buildCatalogProductRetirementCoverage(fixture({ secondRetirement: true }).input),
  ).toThrow();
});
it("rejects missing, reordered, duplicate and cross-owner revisions and prevents source normalization", () => {
  const f = fixture(),
    first = required(f.input.history[0]),
    original = required(f.input.history[2]);
  const mutations = [
    { ...f.input, history: f.input.history.slice(1) },
    { ...f.input, history: [f.input.history[1], first, ...f.input.history.slice(2)] },
    { ...f.input, history: [first, first, ...f.input.history.slice(1)] },
    { ...f.input, aggregateVersion: f.previous.productAggregateVersion },
    { ...f.input, brandReference: id(99) },
    { ...f.input, sourceRevision: f.input.headers.at(-1)?.observedSourceRevision },
    {
      ...f.input,
      history: f.input.history.map((entry) =>
        entry === original
          ? {
              ...entry,
              publication: {
                ...entry.publication,
                scopeSet: [...entry.publication.scopeSet].reverse(),
              },
            }
          : entry,
      ),
    },
    { ...f.input, headers: [...f.input.headers].reverse() },
  ];
  for (const input of mutations)
    expect(() => buildCatalogProductRetirementCoverage(input)).toThrow();
});
it("keeps unrelated same-rank overlap a conflict instead of using retirement as a tie breaker", () => {
  const f = fixture(),
    extra = f.input.history.slice(0, 3).map((entry, index) => ({
      ...entry,
      publication: {
        ...entry.publication,
        versionReference: id(50),
        operationReference: id(500 + index),
        productAggregateVersion: 2 + index * 2,
        successorDraftVersionReference: entry.publication.state === "Published" ? id(51) : null,
        intentDigest: hash("independent overlap " + index),
      },
    }));
  const input = {
    ...f.input,
    history: [...f.input.history, ...extra].sort(
      (a, b) => a.publication.productAggregateVersion - b.publication.productAggregateVersion,
    ),
  };
  input.headers = input.headers.map((header) =>
    rehash({
      ...header,
      observedSourceHeadDigest: catalogProductRetirementSourceHeadDigest({
        tenantReference: input.tenantReference,
        brandReference: input.brandReference,
        productReference: input.productReference,
        aggregateVersion: header.sourceAggregateVersion,
        sourceRevision: header.observedSourceRevision,
        latest: [
          ...new Map(
            input.history
              .filter(
                (entry) =>
                  entry.publication.productAggregateVersion < header.sourceAggregateVersion,
              )
              .map((entry) => [entry.publication.versionReference, entry.publication]),
          ).values(),
        ],
      }),
    }),
  );
  const coverage = buildCatalogProductRetirementCoverage(input);
  expect(resolve(coverage, 30, actual)).toMatchObject({
    outcome: "Conflict",
    reason: "AMBIGUOUS_PRODUCT_VERSION_SCOPE",
  });
  expect(resolve(coverage, 31, actual)).toMatchObject({ outcome: "Conflict" });
});
it("revalidates coverage output and rejects forged latest, hashes, profiles, future contexts and accessors", () => {
  const coverage = buildCatalogProductRetirementCoverage(fixture().input);
  for (const value of [
    { ...coverage, extra: true },
    { ...coverage, profile: undefined },
    { ...coverage, digest: hash("wrong") },
    rehash({ ...coverage, latest: [] }),
    rehash({ ...coverage, coverage: "Complete" }),
    rehash({ ...coverage, sourceAuthority: "Trusted" }),
  ])
    expect(() => parseCatalogProductRetirementCoverage(value)).toThrow();
  expect(() => resolve(coverage, 30, "2026-10-02T14:00:00.001Z")).toThrow();
  expect(() =>
    resolveCatalogProductPublicationWithRetirements(
      coverage,
      { ...context(30, actual), extra: true },
      productPublicationScopeLevels,
    ),
  ).toThrow();
  expect(() =>
    resolveCatalogProductPublicationWithRetirements(coverage, context(30, actual), [
      "Store",
      "Store",
      "Region",
      "Channel",
      "OrderType",
      "Brand",
    ]),
  ).toThrow();
  const getter = vi.fn(() => coverage.headers),
    hostile = { ...coverage };
  Object.defineProperty(hostile, "headers", { enumerable: true, get: getter });
  expect(() => parseCatalogProductRetirementCoverage(hostile)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it("rejects a rehashed header whose recorded prewrite source heads differ from actual history", () => {
  const f = fixture();
  expect(() =>
    buildCatalogProductRetirementCoverage({
      ...f.input,
      headers: f.input.headers.map((header, index) =>
        index === 0
          ? rehash({ ...header, observedSourceHeadDigest: hash("unrelated heads") })
          : header,
      ),
    }),
  ).toThrow();
});

function nativeSourceFixture(actorKind: "User" | "System" = "User") {
  let clock = observedAt,
    denial = false,
    missingRoot = false,
    lateCommit = false,
    held = 0;
  const query = vi.fn(async (sql: string) => {
    if (sql.includes("transaction_isolation') isolation"))
      return { rows: [{ isolation: "read committed" }] };
    if (sql.includes(" AS isolation")) return { rows: [{ isolation: "read committed" }] };
    if (sql.includes(") valid")) return { rows: [{ valid: true }] };
    if (sql.includes("SELECT h.source_revision::text"))
      return { rows: missingRoot ? [] : [{ source_revision: "1" }] };
    if (sql.includes("count(*)::int") && sql.includes("retirements"))
      return { rows: [{ revisions: 0, headers: 0, retirements: 0, bytes: "0" }] };
    return { rows: [] };
  });
  const tx = { query } as unknown as ProductLifecycleTransaction;
  const authority = vi.fn(async () => {
    held++;
    if (denial) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(5),
    actorKind,
    clock: { now: () => clock },
    transactions: {
      run: async <T>(work: (tx: ProductLifecycleTransaction) => Promise<T>) => {
        const result = await work(tx);
        if (lateCommit) clock = "2026-10-02T14:00:05.000Z";
        return result;
      },
    },
    authority: { holdUntilTransactionCompletes: authority },
  };
  const source = createPostgresProductPublicationSourceStoreV2(options);
  return {
    source,
    options,
    query,
    authority,
    deny: () => {
      denial = true;
    },
    expire: () => {
      clock = "2026-10-02T14:00:05.000Z";
    },
    missing: () => {
      missingRoot = true;
    },
    lateCommit: () => {
      lateCommit = true;
    },
    holds: () => held,
  };
}
it("holds explicit complete-history fields and preserves recorded-only coverage through the native V2 source facade", async () => {
  const f = nativeSourceFixture();
  const result = await f.source.withCurrentCoverage(
    { productReference: id(3), expectedAggregateVersion: 1 },
    async (coverage) => coverage,
  );
  expect(result).toMatchObject({
    history: [],
    headers: [],
    sourceAuthority: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  expect(f.holds()).toBe(2);
  expect(f.authority).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      owningActions: ["catalog.product.history.read"],
      requiredFields: expect.arrayContaining(["scopeRetirements", "completePublicationHistory"]),
    }),
  );
});
it("keeps native V2 current authority ahead of private reads and refuses missing or late evidence", async () => {
  const denied = nativeSourceFixture(),
    work = vi.fn();
  denied.deny();
  await expect(
    denied.source.withCurrentCoverage(
      { productReference: id(3), expectedAggregateVersion: 1 },
      work,
    ),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(denied.query).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
  const absent = nativeSourceFixture();
  absent.missing();
  await expect(
    absent.source.withCurrentCoverage(
      { productReference: id(3), expectedAggregateVersion: 1 },
      work,
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(work).not.toHaveBeenCalled();
  for (const mode of ["deny", "expire"] as const) {
    const f = nativeSourceFixture();
    await expect(
      f.source.withCurrentCoverage(
        { productReference: id(3), expectedAggregateVersion: 1 },
        async () => {
          f[mode]();
          return "tentative";
        },
      ),
    ).rejects.toHaveProperty(
      "code",
      mode === "deny" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
  }
});
it("captures V2 source ports and enforces System-only due discovery before private reads", async () => {
  const f = nativeSourceFixture(),
    work = vi.fn();
  await expect(
    f.source.discoverDueSchedules({ afterVersionReference: null, limit: 2 }),
  ).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.options.authority = { holdUntilTransactionCompletes: vi.fn() };
  f.deny();
  await expect(
    f.source.withCurrentCoverage({ productReference: id(3), expectedAggregateVersion: 1 }, work),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(f.options.authority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  const system = nativeSourceFixture("System");
  await expect(
    system.source.discoverDueSchedules({ afterVersionReference: null, limit: 2 }),
  ).resolves.toEqual({ candidates: [], nextAfterVersionReference: null });
  expect(system.authority).toHaveBeenCalledWith(
    expect.anything(),
    expect.objectContaining({
      actorKind: "System",
      owningActions: ["catalog.product.history.read", "catalog.product.publish"],
    }),
  );
});
it("rejects undeclared V2 source request fields and accessors before transport", async () => {
  const f = nativeSourceFixture(),
    get = vi.fn(() => id(3));
  await expect(
    f.source.withCurrentCoverage(
      { productReference: id(3), expectedAggregateVersion: 1, extra: true },
      vi.fn(),
    ),
  ).rejects.toThrow();
  const request = {
    expectedAggregateVersion: 1,
    get productReference() {
      return get();
    },
  };
  await expect(f.source.withCurrentCoverage(request, vi.fn())).rejects.toThrow();
  expect(get).not.toHaveBeenCalled();
  expect(f.query).not.toHaveBeenCalled();
});

it("does not return source evidence or due locators after the original deadline crosses during transaction completion", async () => {
  const f = nativeSourceFixture();
  f.lateCommit();
  await expect(
    f.source.withCurrentCoverage(
      { productReference: id(3), expectedAggregateVersion: 1 },
      async (coverage) => coverage,
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  const scheduler = nativeSourceFixture("System");
  scheduler.lateCommit();
  await expect(
    scheduler.source.discoverDueSchedules({ afterVersionReference: null, limit: 1 }),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
});
