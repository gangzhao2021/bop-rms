import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildCatalogProductScopeJournal,
  buildCatalogProductScopeJournalManagement,
  createPostgresProductPublicationSourceStore,
  CatalogError,
  type ProductPublicationSourceSnapshot,
  planCatalogProductPublication,
  parseProductPublicationCommand,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
  type ProductPublicationScope,
} from "../index.js";
const id = (n: number) => "01902420-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-29T12:00:00.000Z",
  later = "2026-09-29T13:00:00.000Z";
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
const boundary = (instant: string) => ({
  instant,
  localDateTime: instant.slice(0, 23),
  utcOffsetMinutes: 0,
});
const scope = (
  level: ProductPublicationScope["level"],
  reference: string | null = null,
  channelCodes: readonly string[] = [],
  orderTypeCodes: readonly string[] = [],
): ProductPublicationScope => ({ level, reference, channelCodes, orderTypeCodes });
/** Structural publication fixtures; these facts are not current owner approval/policy. */
function published(
  n: number,
  scopeSet: readonly ProductPublicationScope[],
  publishedAt = at,
  effectiveUntil: string | null = null,
  effectiveFrom = at,
  rootVersion = 4,
) {
  const c: ProductPublicationCommand = parseProductPublicationCommand({
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(n + 100),
    productReference: id(5),
    versionReference: id(n),
    expectedProductAggregateVersion: rootVersion,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: hash(n),
    configurationDigest: hash([n]),
    scopeSet,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: boundary(effectiveFrom),
      effectiveUntil: effectiveUntil === null ? null : boundary(effectiveUntil),
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: publishedAt,
    reasonCode: "SYNTHETIC_TEST",
  });
  const f: ProductPublicationFacts = {
    now: publishedAt,
    productAggregateVersion: rootVersion,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      evidenceReference: id(n + 101),
      productAggregateVersion: rootVersion,
      contentDigest: c.contentDigest,
      configurationDigest: c.configurationDigest,
      scopeDigest: hash(c.scopeSet),
      periodDigest: hash(c.effectivePeriod),
      policyReference: id(11),
      policyVersion: 1,
      approvalPolicy: "NotRequired",
      checks: productPublicationCheckCodes.map((code) => ({ code, outcome: "Pass" })),
      warningAcknowledgement: null,
      checkedAt: publishedAt,
      validUntil: "2026-09-30T00:00:00.000Z",
    },
    approval: null,
    reviewReference: null,
    replacement: null,
  };
  const draft = planCatalogProductPublication(c, null, f);
  const reviewed = planCatalogProductPublication(
    { ...c, action: "SubmitReview", expectedPublicationVersion: 1 },
    draft,
    { ...f, reviewReference: id(n + 102) },
  );
  return planCatalogProductPublication(
    {
      ...c,
      action: "Publish",
      expectedPublicationVersion: 2,
      successorDraftVersionReference: id(n + 200),
    },
    reviewed,
    f,
  );
}

function fixture() {
  const old = published(6, [scope("Brand")]);
  const incoming = published(7, [scope("Store", id(20))], later, null, at, 8);
  const journal = buildCatalogProductScopeJournal({
    incoming,
    latest: [old],
    sourceAggregateVersion: 8,
    sourceRevision: "12",
    scopeOrder: productPublicationScopeLevels,
    policyEvidenceReference: id(99),
    observedAt: later,
    validUntil: "2026-09-29T13:00:30.000Z",
  });
  const snapshot: ProductPublicationSourceSnapshot = {
    profile: "CatalogProductPublicationSourceV1",
    tenantReference: id(1),
    brandReference: id(2),
    productReference: id(5),
    aggregateVersion: 12,
    observedAt: "2026-09-30T12:00:00.000Z",
    coverage: "Complete",
    eligibility: "NotEvaluated",
    digest: hash("history"),
    history: [
      { action: "Publish", publication: old, configuration: {} as never },
      { action: "Publish", publication: incoming, configuration: {} as never },
    ],
    latest: [old, incoming],
  };
  const row = {
    operationReference: incoming.operationReference,
    digest: journal.digest,
    journal,
    coherent: true,
  };
  return { old, incoming, journal, snapshot, row };
}
it("projects recorded partial Store preference and explicitly missing legacy Brand history", () => {
  const f = fixture(),
    r = buildCatalogProductScopeJournalManagement(f.snapshot, [f.row]);
  expect(r.versions.map((v) => v.recordStatus)).toEqual(["NotRecorded", "Recorded"]);
  expect(r.versions[1]?.journal?.relations[0]?.relation).toBe("IncomingSelectorPreferred");
  expect(r.currentDisposition).toBe("NotEvaluated");
  expect(r.eligibility).toBe("NotEvaluated");
  expect(r.validUntil).toBe("2026-09-30T12:00:05.000Z");
  // Historical evidence expiry stays historical, not the new read observation.
  expect(r.versions[1]?.journal?.originalEvidenceValidUntil).toBe(f.journal.validUntil);
  for (const key of ["incoming", "latest", "content", "approval", "history"])
    expect(r).not.toHaveProperty(key);
  expect(r.versions[1]?.journal).not.toHaveProperty("latest");
  expect(Object.isFrozen(r.versions)).toBe(true);
});
it("recorded empty relationships remain distinct from NotRecorded and unpublished NotApplicable", () => {
  const f = fixture(),
    empty = buildCatalogProductScopeJournal({
      incoming: f.incoming,
      latest: [],
      sourceAggregateVersion: 8,
      sourceRevision: "12",
      scopeOrder: productPublicationScopeLevels,
      policyEvidenceReference: id(99),
      observedAt: later,
      validUntil: f.journal.validUntil,
    });
  const never = { ...f.old, versionReference: id(9), state: "Draft" as const, publishedAt: null };
  f.snapshot = {
    ...f.snapshot,
    latest: [...f.snapshot.latest, never],
    history: [
      ...f.snapshot.history,
      { action: "Validate", publication: never, configuration: {} as never },
    ],
  };
  const r = buildCatalogProductScopeJournalManagement(f.snapshot, [
    { ...f.row, journal: empty, digest: empty.digest },
  ]);
  expect(r.versions[1]?.recordStatus).toBe("Recorded");
  expect(r.versions[1]?.journal?.relations).toEqual([]);
  expect(r.versions[2]?.recordStatus).toBe("NotApplicable");
  expect(r.versions[2]?.journal).toBeNull();
});
it("retains original journal after the current head becomes Superseded", () => {
  const f = fixture();
  f.snapshot = {
    ...f.snapshot,
    latest: [
      f.old,
      {
        ...f.incoming,
        state: "Superseded",
        publicationVersion: 4,
        supersededAt: f.snapshot.observedAt,
        supersededByVersionReference: id(10),
      },
    ],
  };
  const r = buildCatalogProductScopeJournalManagement(f.snapshot, [f.row]);
  expect(r.versions[1]?.currentState).toBe("Superseded");
  expect(r.versions[1]?.currentPublicationVersion).toBe(4);
  expect(r.versions[1]?.originalPublicationOperationReference).toBe(f.incoming.operationReference);
  expect(r.versions[1]?.journal?.digest).toBe(f.journal.digest);
});
for (const mode of [
  "tuple",
  "digest",
  "coherent",
  "duplicate",
  "unmatched",
  "changed original",
  "changed scope",
  "future journal",
  "oversize",
  "too many",
  "getter",
]) {
  it(`refuses ${mode} recorded provenance`, () => {
    const f = fixture();
    let rows: unknown = [f.row];
    if (mode === "tuple") rows = [{ ...f.row, operationReference: id(88) }];
    if (mode === "digest") rows = [{ ...f.row, digest: hash("wrong") }];
    if (mode === "coherent") rows = [{ ...f.row, coherent: false }];
    if (mode === "duplicate") rows = [f.row, f.row];
    if (mode === "unmatched") f.snapshot = { ...f.snapshot, history: [] };
    if (mode === "changed original")
      f.snapshot = {
        ...f.snapshot,
        history: f.snapshot.history.map((h) => ({
          ...h,
          publication: { ...h.publication, actorReference: id(88) },
        })),
      };
    if (mode === "changed scope")
      f.snapshot = {
        ...f.snapshot,
        latest: [f.old, { ...f.incoming, scopeDigest: hash("wrong") }],
      };
    if (mode === "future journal") f.snapshot = { ...f.snapshot, observedAt: at };
    if (mode === "too many") rows = Array.from({ length: 1001 }, () => f.row);
    if (mode === "oversize") rows = [{ ...f.row, extra: "x".repeat(1_048_577) }];
    const get = vi.fn(() => f.journal);
    if (mode === "getter")
      rows = [
        {
          ...f.row,
          get journal() {
            return get();
          },
        },
      ];
    expect(() => buildCatalogProductScopeJournalManagement(f.snapshot, rows)).toThrow(CatalogError);
    expect(get).not.toHaveBeenCalled();
  });
}
it("requires a separate journal-purpose authority even with ordinary history configured", async () => {
  const tx = { query: vi.fn() },
    run = vi.fn(async (work: (actualTx: typeof tx) => Promise<unknown>) => work(tx)),
    normal = vi.fn();
  const source = createPostgresProductPublicationSourceStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => at },
    transactions: { run: run as never },
    authority: { holdUntilTransactionCompletes: normal },
  });
  await expect(
    source.withCurrentScopeJournals(
      { productReference: id(5), expectedAggregateVersion: 7 },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(run).not.toHaveBeenCalled();
  expect(normal).not.toHaveBeenCalled();
  expect(tx.query).not.toHaveBeenCalled();
});
it("current journal denial precedes all private reads and regular history authorization", async () => {
  const tx = { query: vi.fn() },
    normal = vi.fn(),
    work = vi.fn(),
    journal = vi.fn(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
  const source = createPostgresProductPublicationSourceStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => at },
    transactions: { run: async (cb) => cb(tx) },
    authority: { holdUntilTransactionCompletes: normal },
    scopeJournalAuthority: { holdUntilTransactionCompletes: journal },
  });
  await expect(
    source.withCurrentScopeJournals({ productReference: id(5), expectedAggregateVersion: 7 }, work),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(journal).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      actorKind: "User",
      owningAction: "catalog.product.history.read",
      purposeCode: "CATALOG_PRODUCT_SCOPE_JOURNAL",
    }),
  );
  expect(normal).not.toHaveBeenCalled();
  expect(tx.query).not.toHaveBeenCalled();
  expect(work).not.toHaveBeenCalled();
});

it("captures new scope-journal context and configured authority before later options mutation", async () => {
  const tx = { query: vi.fn() },
    holder = vi.fn(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
  const options = {
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    clock: { now: () => at },
    transactions: { run: async <T>(cb: (actualTx: typeof tx) => Promise<T>) => cb(tx) },
    authority: { holdUntilTransactionCompletes: vi.fn() },
    scopeJournalAuthority: { holdUntilTransactionCompletes: holder },
  };
  const source = createPostgresProductPublicationSourceStore(options);
  options.tenantReference = id(88);
  options.brandReference = id(89);
  options.actorReference = id(90);
  options.scopeJournalAuthority = { holdUntilTransactionCompletes: vi.fn() };
  await expect(
    source.withCurrentScopeJournals(
      { productReference: id(5), expectedAggregateVersion: 7 },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_PERMISSION_DENIED");
  expect(holder).toHaveBeenCalledWith(
    tx,
    expect.objectContaining({
      tenantReference: id(1),
      brandReference: id(2),
      actorReference: id(3),
    }),
  );
  expect(tx.query).not.toHaveBeenCalled();
});
it("System cannot acquire ordinary scope-journal management fields", async () => {
  const run = vi.fn(),
    holder = vi.fn();
  const source = createPostgresProductPublicationSourceStore({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "System",
    clock: { now: () => at },
    transactions: { run },
    authority: { holdUntilTransactionCompletes: holder },
    scopeJournalAuthority: { holdUntilTransactionCompletes: holder },
  });
  await expect(
    source.withCurrentScopeJournals(
      { productReference: id(5), expectedAggregateVersion: 7 },
      vi.fn(),
    ),
  ).rejects.toHaveProperty("code", "CATALOG_DEPENDENCY_UNAVAILABLE");
  expect(holder).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
});
