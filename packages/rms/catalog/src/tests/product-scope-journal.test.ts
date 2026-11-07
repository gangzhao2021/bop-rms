import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildCatalogProductScopeJournal,
  parseCatalogProductScopeJournal,
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

const old = published(6, [scope("Brand")]);
const incoming = published(7, [scope("Store", id(20))], later, null, at, 8);
const input = () => ({
  incoming,
  latest: [old],
  sourceAggregateVersion: 8,
  sourceRevision: "12",
  scopeOrder: productPublicationScopeLevels,
  policyEvidenceReference: id(99),
  observedAt: later,
  validUntil: "2026-09-29T13:00:30.000Z",
});
describe("owning Product scope journal", () => {
  it("records complete empty coverage without inventing eligibility", () => {
    const j = buildCatalogProductScopeJournal({ ...input(), latest: [] });
    expect(j.coverage).toBe("CompleteLatestOwningPublicationHeads");
    expect(j.plan.overlaps).toEqual([]);
    expect(j.eligibility).toBe("NotEvaluated");
    expect(j.wholeVersionSupersession).toBe("NotEvaluated");
    expect(parseCatalogProductScopeJournal(j)).toEqual(j);
  });
  it("binds original heads and recovers Store preference without changing old Brand state", () => {
    const j = buildCatalogProductScopeJournal(input());
    expect(j.plan.overlaps[0]?.relation).toBe("IncomingSelectorPreferred");
    expect(j.latest[0]?.state).toBe("Published");
    expect(parseCatalogProductScopeJournal(j)).toEqual(j);
  });
  it.each([
    "profile",
    "coverage",
    "sourceHeadDigest",
    "digest",
    "eligibility",
    "wholeVersionSupersession",
  ])("refuses corrupted %s", (key) => {
    expect(() =>
      parseCatalogProductScopeJournal({
        ...buildCatalogProductScopeJournal(input()),
        [key]: "bad",
      }),
    ).toThrow();
  });
  it.each(["0", "01", "9223372036854775808", "-1"])(
    "refuses invalid source revision %s",
    (sourceRevision) =>
      expect(() => buildCatalogProductScopeJournal({ ...input(), sourceRevision })).toThrow(),
  );
  it("refuses a head from a future root and duplicate or foreign heads", () => {
    expect(() =>
      buildCatalogProductScopeJournal({ ...input(), sourceAggregateVersion: 4 }),
    ).toThrow();
    expect(() => buildCatalogProductScopeJournal({ ...input(), latest: [old, old] })).toThrow();
    expect(() =>
      buildCatalogProductScopeJournal({ ...input(), latest: [{ ...old, brandReference: id(90) }] }),
    ).toThrow();
  });
  it("refuses unresolved topology, missing policy order and expired evidence", () => {
    expect(() =>
      buildCatalogProductScopeJournal({
        ...input(),
        incoming: published(7, [scope("StoreGroup", id(20))], later, null, at, 8),
      }),
    ).toThrow();
    expect(() => buildCatalogProductScopeJournal({ ...input(), scopeOrder: [] })).toThrow();
    expect(() => buildCatalogProductScopeJournal({ ...input(), validUntil: later })).toThrow();
  });
  it("detaches arrays and rejects getters without invocation", () => {
    const v = input(),
      j = buildCatalogProductScopeJournal(v);
    v.latest.splice(0);
    expect(j.latest).toHaveLength(1);
    const get = vi.fn(() => []);
    const raw = input();
    Object.defineProperty(raw, "latest", { get, enumerable: true });
    expect(() => buildCatalogProductScopeJournal(raw)).toThrow();
    expect(get).not.toHaveBeenCalled();
  });
  it("refuses silent extra fields and changed recorded plan", () => {
    expect(() => buildCatalogProductScopeJournal({ ...input(), permission: true })).toThrow();
    const j = buildCatalogProductScopeJournal(input());
    expect(() =>
      parseCatalogProductScopeJournal({ ...j, plan: { ...j.plan, overlaps: [] } }),
    ).toThrow();
  });
});
