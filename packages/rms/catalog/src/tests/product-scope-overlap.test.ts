import { describe, expect, it, vi } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  buildCatalogProductScopeOverlapPlan,
  planCatalogProductPublication,
  parseProductPublicationCommand,
  productPublicationCheckCodes,
  productPublicationScopeLevels,
  resolveCatalogProductPublication,
  type ProductPublicationCommand,
  type ProductPublicationFacts,
  type ProductPublicationScope,
} from "../index.js";
const id = (n: number) => "01902420-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-29T12:00:00.000Z",
  later = "2026-09-29T13:00:00.000Z",
  end = "2026-09-29T14:00:00.000Z";
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
    expectedProductAggregateVersion: 4,
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
    productAggregateVersion: 4,
    contentDigest: c.contentDigest,
    configurationDigest: c.configurationDigest,
    scopeDigest: hash(c.scopeSet),
    periodDigest: hash(c.effectivePeriod),
    validation: {
      evidenceReference: id(n + 101),
      productAggregateVersion: 4,
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
const brand = published(6, [scope("Brand")]);
const store = published(7, [scope("Store", id(20))], later);
const input = (incoming = store, existing = [brand]) => ({
  incoming,
  existing,
  scopeOrder: productPublicationScopeLevels,
  observedAt: later,
});
describe("Product selector overlap record plan", () => {
  it("records only the Store intersection and preserves Brand outside it", () => {
    const plan = buildCatalogProductScopeOverlapPlan(input());
    expect(plan.analysis).toBe("CompleteSelectorAnalysis");
    expect(plan.overlaps).toMatchObject([
      {
        storeReference: id(20),
        effectiveFrom: later,
        effectiveUntil: null,
        relation: "IncomingSelectorPreferred",
      },
    ]);
    expect(plan.eligibility).toBe("NotEvaluated");
    expect(plan.sourceCoverage).toBe("NotEvaluated");
    expect(plan.currentPolicySource).toBe("NotEvaluated");
    expect(plan.wholeVersionSupersession).toBe("NotEvaluated");
    const context = {
      at: later,
      storeReference: id(21),
      storeGroupReferences: [],
      regionReferences: [],
      channelCode: "WEB",
      orderTypeCode: "PICKUP",
    };
    expect(
      resolveCatalogProductPublication([brand, store], context, productPublicationScopeLevels),
    ).toMatchObject({ outcome: "Selected", versionReference: brand.versionReference });
    expect(brand.state).toBe("Published");
  });
  it("records an existing narrow selector preserved under a later Brand release", () => {
    const plan = buildCatalogProductScopeOverlapPlan(
      input(published(8, [scope("Brand")], later), [published(9, [scope("Store", id(20))])]),
    );
    expect(plan.overlaps[0]?.relation).toBe("ExistingSelectorPreferred");
  });
  it("clips effective overlap to actual publication, without backdated history rewrite", () => {
    const plan = buildCatalogProductScopeOverlapPlan(
      input(published(8, [scope("Store", id(20))], later, end), [brand]),
    );
    expect(plan.overlaps[0]).toMatchObject({ effectiveFrom: later, effectiveUntil: end });
  });
  it("records equal precedence as overlap rather than claiming replacement", () => {
    const plan = buildCatalogProductScopeOverlapPlan(
      input(published(8, [scope("Brand")], later), [brand]),
    );
    expect(plan.overlaps[0]?.relation).toBe("EqualPrecedenceOverlap");
    expect(
      resolveCatalogProductPublication(
        [brand, published(8, [scope("Brand")], later)],
        {
          at: later,
          storeReference: id(20),
          storeGroupReferences: [],
          regionReferences: [],
          channelCode: "WEB",
          orderTypeCode: "PICKUP",
        },
        productPublicationScopeLevels,
      ),
    ).toMatchObject({ outcome: "Conflict" });
  });
  it.each([
    [scope("Store", id(21)), scope("Store", id(20))],
    [scope("Brand", null, ["POS"]), scope("Store", id(20), ["WEB"])],
    [scope("Brand", null, [], ["DINE_IN"]), scope("Store", id(20), [], ["PICKUP"])],
  ])("does not invent overlap across disjoint selectors (%#)", (oldScope, incomingScope) => {
    expect(
      buildCatalogProductScopeOverlapPlan(
        input(published(8, [incomingScope], later), [published(9, [oldScope])]),
      ).overlaps,
    ).toEqual([]);
  });
  it.each([
    [scope("Channel", "WEB"), scope("Brand")],
    [scope("OrderType", "PICKUP"), scope("Brand")],
  ])(
    "uses Channel/OrderType reference even when explicit code set is empty (%#)",
    (oldScope, incomingScope) => {
      const plan = buildCatalogProductScopeOverlapPlan(
        input(published(8, [incomingScope], later), [published(9, [oldScope])]),
      );
      expect(plan.overlaps[0]).toMatchObject(
        oldScope.level === "Channel" ? { channelCodes: ["WEB"] } : { orderTypeCodes: ["PICKUP"] },
      );
      expect(plan.overlaps[0]?.relation).toBe("ExistingSelectorPreferred");
    },
  );
  it("intersects restrictions rather than expanding all channel/order combinations", () => {
    const plan = buildCatalogProductScopeOverlapPlan(
      input(published(8, [scope("Store", id(20), ["POS", "WEB"], ["PICKUP"])], later), [
        published(9, [scope("Brand", null, ["WEB"], ["DINE_IN", "PICKUP"])]),
      ]),
    );
    expect(plan.overlaps[0]).toMatchObject({ channelCodes: ["WEB"], orderTypeCodes: ["PICKUP"] });
  });
  it.each(["Region", "StoreGroup"] as const)("requires current topology for %s", (level) => {
    const plan = buildCatalogProductScopeOverlapPlan(
      input(store, [published(8, [scope(level, id(30))])]),
    );
    expect(plan.analysis).toBe("TopologyRequired");
    expect(plan.overlaps).toEqual([]);
    expect(plan.unresolved[0]?.reason).toBe("CURRENT_TOPOLOGY_REQUIRED");
  });
  it("half-open expired scope needs no membership inference", () => {
    const plan = buildCatalogProductScopeOverlapPlan(
      input(store, [published(8, [scope("Region", id(30))], at, later)]),
    );
    expect(plan.overlaps).toEqual([]);
    expect(plan.unresolved).toEqual([]);
    expect(plan.analysis).toBe("CompleteSelectorAnalysis");
  });
  it("supersession ends only that historical version interval", () => {
    const previous = {
      ...brand,
      state: "Superseded",
      supersededAt: end,
      supersededByVersionReference: id(40),
      occurredAt: end,
      actorKind: "System",
      operationReference: id(41),
    };
    const plan = buildCatalogProductScopeOverlapPlan({
      ...input(store, [previous as typeof brand]),
      observedAt: end,
    });
    expect(plan.overlaps[0]?.effectiveUntil).toBe(end);
  });
  it("keeps pair metadata distinct from whole-union resolution", () => {
    const incoming = published(8, [scope("Store", id(20)), scope("Brand")], later);
    const plan = buildCatalogProductScopeOverlapPlan(input(incoming));
    expect(plan.overlaps).toHaveLength(2);
    expect(new Set(plan.overlaps.map((r) => r.relation))).toEqual(
      new Set(["IncomingSelectorPreferred", "EqualPrecedenceOverlap"]),
    );
    expect(plan.wholeVersionSupersession).toBe("NotEvaluated");
  });
  it("does not hide unresolved topology behind a known Brand relation", () => {
    const previous = published(8, [scope("Brand"), scope("StoreGroup", id(30))]);
    const plan = buildCatalogProductScopeOverlapPlan(input(store, [previous]));
    expect(plan.analysis).toBe("TopologyRequired");
    expect(plan.overlaps).toHaveLength(1);
    expect(plan.unresolved).toHaveLength(1);
    expect(plan.eligibility).toBe("NotEvaluated");
  });
  it("canonicalizes source ordering and detaches returned metadata", () => {
    const a = published(8, [scope("Store", id(20))]),
      b = published(9, [scope("Store", id(21))]);
    const v = published(10, [scope("Brand")], later);
    const plan = buildCatalogProductScopeOverlapPlan(input(v, [a, b]));
    expect(plan.digest).toBe(buildCatalogProductScopeOverlapPlan(input(v, [b, a])).digest);
    expect(Object.isFrozen(plan.overlaps)).toBe(true);
    expect(Object.keys(plan)).not.toContain("actorReference");
  });
  it.each([
    { scopeOrder: [] },
    { scopeOrder: [...productPublicationScopeLevels, "Brand"] },
    { scopeOrder: [...productPublicationScopeLevels].reverse() },
    { observedAt: at },
    { existing: [brand, brand] },
    { existing: [{ ...brand, brandReference: id(99) }] },
    { incoming: { ...store, scopeDigest: hash("tampered") } },
    { unsupported: true },
  ])("refuses unbound, ambiguous or malformed plan inputs (%#)", (patch) => {
    expect(() => buildCatalogProductScopeOverlapPlan({ ...input(), ...patch })).toThrow();
  });
  it("does not invoke nested accessors", () => {
    const getter = vi.fn(() => store.versionReference);
    const incoming = { ...store };
    Object.defineProperty(incoming, "versionReference", { get: getter, enumerable: true });
    expect(() => buildCatalogProductScopeOverlapPlan({ ...input(), incoming })).toThrow();
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects an oversized selector comparison set without truncation", () => {
    const scopes = Array.from({ length: 101 }, (_, i) => scope("Store", id(1000 + i)));
    expect(() =>
      buildCatalogProductScopeOverlapPlan(
        input(published(8, scopes, later), [published(9, scopes)]),
      ),
    ).toThrow();
  });
});
