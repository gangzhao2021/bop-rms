import { expect, it, vi } from "vitest";
import {
  matchPricingConfigurationReferences as match,
  buildOptionPriceReferenceSourceSnapshot,
  parseOptionPriceReferenceSourceSnapshot,
  parsePromotionReferenceSourceSnapshot,
  buildPromotionReferenceSourceSnapshot,
} from "../index.js";
import { fixture, id, at, past, request } from "./configuration-reference-matches.fixture.js";
const unavailable = { code: "PRICING_REFERENCE_MATCH_UNAVAILABLE" };
it("matches actual neutral membership while preserving all history, timing, Store and segment qualifiers", () => {
  const result = match(fixture());
  expect(result.coverage).toBe("CurrentDraftOnly");
  expect(result.historicalMembershipCoverage).toBe("Unavailable");
  expect(result.priceEntries[0]).toMatchObject({
    lifecycle: "Archived",
    temporalStatus: "Expired",
    scopeKind: "Store",
    channelCode: "DINE_IN",
  });
  expect(result.optionVersions[0]).toMatchObject({
    matchedSkuReferences: [id(11)],
    bindingChannelCodes: ["CUSTOMER_PWA"],
    reference: { temporalStatus: "Future", scopeKind: "Region" },
  });
  expect(result.unresolvedOptionRoots[0]).toMatchObject({
    reference: { bindingReference: id(999) },
    reason: "BindingNotInCurrentDraft",
  });
  expect(result.promotions.map((p) => p.matchedBy)).toEqual([
    ["Category"],
    ["AllSellables"],
    ["OrderSubtotal"],
  ]);
  expect(
    result.promotions[0]?.reference.eligibility.some((e) => e.referenceKind === "Segment"),
  ).toBe(true);
  expect(JSON.stringify(result)).not.toMatch(/"Allowed"|activeReferenceCount|policyVersion/);
  expect(Object.isFrozen(result.optionVersions[0]?.matchedSkuReferences)).toBe(true);
});
it("respects exact selected SKU and binding Include/Exclude without deleting root ownership", () => {
  const f = fixture(),
    result = match({ ...f, target: { ...f.target, skuReference: id(12) } });
  expect(result.priceEntries).toHaveLength(0);
  expect(result.optionVersions).toHaveLength(0);
  expect(result.optionRoots).toHaveLength(1);
  expect(result.historicalMembershipCoverage).toBe("Unavailable");
});
it("preserves disabled choices and unknown SKU qualifications as unresolved", () => {
  const f = fixture();
  expect(
    match({
      ...f,
      target: {
        ...f.target,
        bindings: f.target.bindings.map((b) => ({ ...b, enabledOptionReferences: [] })),
      },
    }).unresolvedOptionRoots.map((r) => r.reason),
  ).toContain("OptionNotEnabledInCurrentDraft");
  const disabled = match({
    ...f,
    target: {
      ...f.target,
      bindings: f.target.bindings.map((b) => ({ ...b, enabledOptionReferences: [] })),
    },
  }).unresolvedOptionRoots.find((r) => r.reference.ruleReference === id(200));
  expect(disabled?.versions).toHaveLength(1);
  expect(disabled?.versions[0]?.temporalStatus).toBe("Future");
  const root = f.optionPrices.roots[0],
    version = f.optionPrices.versions[0];
  if (!root || !version) throw new Error("missing synthetic option fixture");
  const { isCurrentVersion, temporalStatus, ruleReference, ...rawVersion } = version;
  void isCurrentVersion;
  void temporalStatus;
  void ruleReference;
  const options = buildOptionPriceReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [{ root, version: { ...rawVersion, skuReference: id(999) }, precise: true }],
    },
    request,
    at,
  );
  expect(match({ ...f, optionPrices: options }).unresolvedOptionVersions[0]?.reason).toBe(
    "SkuNotInCurrentDraft",
  );
});
it("requires known category coverage when explicit item Category qualifiers exist", () => {
  const f = fixture();
  expect(() => match({ ...f, target: { ...f.target, categoryReferences: null } })).toThrow(
    expect.objectContaining(unavailable),
  );
  const root = f.promotions.roots[1],
    version = f.promotions.versions[1];
  if (!root || !version) throw new Error("missing synthetic promotion fixture");
  const {
    catalogReferenceMode,
    isCurrentVersion,
    temporalStatus,
    promotionReference,
    ...rawVersion
  } = version;
  void catalogReferenceMode;
  void isCurrentVersion;
  void temporalStatus;
  void promotionReference;
  const promos = buildPromotionReferenceSourceSnapshot(
    { observedAt: at, references: [{ root, version: rawVersion, precise: true }] },
    request,
    at,
  );
  expect(
    match({ ...f, promotions: promos, target: { ...f.target, categoryReferences: null } })
      .promotions[0]?.matchedBy,
  ).toEqual(["AllSellables"]);
});
it.each(["priceBooks", "optionPrices", "promotions"] as const)(
  "rejects changed request, coverage, digest and derived fields in %s",
  (key) => {
    const f = fixture();
    for (const change of [
      { coverage: "Partial" },
      { digest: `sha256:${"f".repeat(64)}` },
      { request: { ...request, actorReference: id(99) } },
    ])
      expect(() => match({ ...f, [key]: { ...f[key], ...change } })).toThrow(
        expect.objectContaining(unavailable),
      );
    expect(() => match({ ...f, now: "2026-09-29T12:00:06.000Z" })).toThrow(
      expect.objectContaining(unavailable),
    );
  },
);
it("rejects accessor or incoherent Catalog neutral facts without reading getters", () => {
  const f = fixture(),
    get = vi.fn(() => id(10)),
    target = { ...f.target };
  Object.defineProperty(target, "productReference", { enumerable: true, get });
  expect(() => match({ ...f, target })).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
  for (const overrides of [
    { skuReference: id(99) },
    { skuReferences: [id(11), id(11)] },
    { bindings: [f.target.bindings[0], f.target.bindings[0]] },
    { catalogSourceDigest: "invalid" },
  ])
    expect(() => match({ ...f, target: { ...f.target, ...overrides } as typeof f.target })).toThrow(
      expect.objectContaining(unavailable),
    );
});
it("validates unversioned public roots without inventing versions", () => {
  const f = fixture(),
    root = { ...f.optionPrices.roots[0], currentVersionReference: null };
  const snapshot = buildOptionPriceReferenceSourceSnapshot(
    { observedAt: at, references: [{ root, version: null, precise: true }] },
    request,
    at,
  );
  expect(parseOptionPriceReferenceSourceSnapshot(snapshot, request, at)).toEqual(snapshot);
  const promo = buildPromotionReferenceSourceSnapshot(
    {
      observedAt: at,
      references: [
        {
          root: {
            promotionReference: id(350),
            brandReference: id(1),
            aggregateVersion: 1,
            currentVersionReference: null,
            rootCreatedAt: past,
            updatedAt: past,
          },
          version: null,
          precise: true,
        },
      ],
    },
    request,
    at,
  );
  expect(parsePromotionReferenceSourceSnapshot(promo, request, at)).toEqual(promo);
});
