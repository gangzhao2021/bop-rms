import { expect, it } from "vitest";
import {
  parsePricingProductPublicationReferenceRequestV2,
  buildProductPublicationPriceBookReferenceSourceSnapshotV2,
  buildProductPublicationOptionPriceReferenceSourceSnapshotV2,
  buildProductPublicationPromotionReferenceSourceSnapshotV2,
  matchProductPublicationPricingConfigurationReferencesV2 as current,
  matchProductPublicationRecordedPricingConfigurationReferencesV2 as recorded,
  matchPricingConfigurationReferences,
  matchRecordedPricingConfigurationReferences,
  type RecordedPricingReferenceTarget,
} from "../index.js";
import { at, fixture, id } from "./configuration-reference-matches.fixture.js";
const digest = (letter: string) => "sha256:" + letter.repeat(64);
const omit = (value: object, keys: readonly string[]) =>
  Object.fromEntries(Object.entries(value).filter(([k]) => !keys.includes(k)));
function input() {
  const f = fixture(),
    request = parsePricingProductPublicationReferenceRequestV2({
      profile: "PricingProductPublicationReferenceRequestV2",
      purposeCode: "CATALOG_PRODUCT_PUBLICATION_PRICING_SOURCE_READ",
      tenantReference: id(9),
      brandReference: id(1),
      actorReference: id(2),
      actorKind: "User",
      operationReference: id(3),
      productReference: f.target.productReference,
      versionReference: id(1001),
      originalIntentDigest: digest("a"),
      replacementIntentDigest: digest("b"),
      aggregateSnapshotDigest: digest("c"),
      currentPublicationDigest: digest("d"),
      observedAt: at,
      validUntil: new Date(Date.parse(at) + 5000).toISOString(),
    });
  const priceBooks = buildProductPublicationPriceBookReferenceSourceSnapshotV2(
    {
      observedAt: at,
      references: f.priceBooks.references.map((v) => ({
        reference: omit(v, ["isCurrentVersion", "temporalStatus"]),
        precise: true,
      })),
    },
    request,
    at,
  );
  const optionPrices = buildProductPublicationOptionPriceReferenceSourceSnapshotV2(
    {
      observedAt: at,
      references: f.optionPrices.roots.flatMap<unknown>((root) => {
        const versions = f.optionPrices.versions.filter(
          (v) => v.ruleReference === root.ruleReference,
        );
        return versions.length
          ? versions.map((v) => ({
              root,
              version: omit(v, ["ruleReference", "isCurrentVersion", "temporalStatus"]),
              precise: true,
            }))
          : [{ root, version: null, precise: true }];
      }),
    },
    request,
    at,
  );
  const promotions = buildProductPublicationPromotionReferenceSourceSnapshotV2(
    {
      observedAt: at,
      references: f.promotions.roots.flatMap<unknown>((root) => {
        const versions = f.promotions.versions.filter(
          (v) => v.promotionReference === root.promotionReference,
        );
        return versions.length
          ? versions.map((v) => ({
              root,
              version: omit(v, [
                "promotionReference",
                "isCurrentVersion",
                "temporalStatus",
                "catalogReferenceMode",
              ]),
              precise: true,
            }))
          : [{ root, version: null, precise: true }];
      }),
    },
    request,
    at,
  );
  const history: RecordedPricingReferenceTarget = {
    mappingProfile: "RecordedDraftConfigurations",
    catalogSourceDigest: digest("e"),
    productReference: f.target.productReference,
    skuReference: id(12),
    configurations: [
      {
        catalogConfigurationDigest: digest("f"),
        versionReference: request.versionReference,
        skuReferences: f.target.skuReferences,
        categoryReferences: f.target.categoryReferences,
        bindings: f.target.bindings,
      },
      {
        catalogConfigurationDigest: digest("0"),
        versionReference: id(1002),
        skuReferences: [id(11)],
        categoryReferences: [],
        bindings: [],
      },
    ],
  };
  return {
    request,
    target: f.target,
    priceBooks,
    optionPrices,
    promotions,
    now: at,
    history,
    legacy: f,
  };
}
function forCurrent(f: ReturnType<typeof input>) {
  return {
    request: f.request,
    target: f.target,
    priceBooks: f.priceBooks,
    optionPrices: f.optionPrices,
    promotions: f.promotions,
    now: f.now,
  };
}
function forRecorded(f: ReturnType<typeof input>) {
  return { ...forCurrent(f), target: f.history };
}
it("retains real matched and unresolved facts, with exact publication binding and no qualification", () => {
  const f = input(),
    result = current(forCurrent(f)),
    old = matchPricingConfigurationReferences(f.legacy);
  expect(result).toMatchObject({
    profile: "ProductPublicationPricingConfigurationReferenceMatchesV2",
    request: f.request,
    validUntil: f.request.validUntil,
    historicalMembershipCoverage: "Unavailable",
  });
  expect(result.priceEntries).toEqual(old.priceEntries);
  expect(result.optionVersions).toEqual(old.optionVersions);
  expect(result.unresolvedOptionRoots).toEqual(old.unresolvedOptionRoots);
  expect(result.promotions).toEqual(old.promotions);
  expect(result.promotions.flatMap((p) => p.matchedBy)).toEqual([
    "Category",
    "AllSellables",
    "OrderSubtotal",
  ]);
  expect(result.unresolvedOptionRoots[0]?.reason).toBe("BindingNotInCurrentDraft");
  expect(result.digest).not.toBe(old.digest);
});
it("preserves historical SKU absence and previous configuration matches without inventing publication coverage", () => {
  const f = input(),
    result = recorded(forRecorded(f));
  const old = matchRecordedPricingConfigurationReferences({ ...f.legacy, target: f.history });
  expect(result.configurations).toEqual(old.configurations);
  expect(result.configurations.map((c) => c.membership)).toEqual(["SkuAbsent", "Included"]);
  expect(result).toMatchObject({
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
    validUntil: f.request.validUntil,
  });
  expect(Object.isFrozen(result.configurations)).toBe(true);
});
it.each(["product", "version", "target", "deadline", "foreign-source", "missing-source"])(
  "rejects changed %s publication binding",
  (mode) => {
    const f = input(),
      args = forRecorded(f);
    if (mode === "product") args.request = { ...f.request, productReference: id(999) };
    if (mode === "version")
      args.target = {
        ...f.history,
        configurations: f.history.configurations.map((c) => ({ ...c, versionReference: id(777) })),
      };
    if (mode === "target") args.target = { ...f.history, productReference: id(999) };
    if (mode === "deadline") args.now = f.request.validUntil;
    if (mode === "foreign-source")
      args.promotions = {
        ...f.promotions,
        request: { ...f.request, replacementIntentDigest: digest("e") },
      };
    if (mode === "missing-source") args.optionPrices = { ...f.optionPrices, roots: [] };
    expect(() => recorded(args)).toThrow();
  },
);
it("does not turn unknown category membership into empty impact", () => {
  const f = input();
  expect(() =>
    current({ ...forCurrent(f), target: { ...f.target, categoryReferences: null } }),
  ).toThrow();
  expect(() =>
    recorded({
      ...forRecorded(f),
      target: {
        ...f.history,
        configurations: f.history.configurations.map((c) => ({ ...c, categoryReferences: null })),
      },
    }),
  ).toThrow();
});
it("retains only the original lease when observation advances and rejects V1 snapshots", () => {
  const f = input();
  expect(
    current({ ...forCurrent(f), now: new Date(Date.parse(at) + 4999).toISOString() }).validUntil,
  ).toBe(f.request.validUntil);
  expect(() => current({ ...forCurrent(f), priceBooks: f.legacy.priceBooks })).toThrow();
  expect(() =>
    current({ ...forCurrent(f), target: { ...f.target, productReference: id(999) } }),
  ).toThrow();
});
it("uses closed inputs without evaluating injected accessors", () => {
  const f = input();
  let reads = 0;
  expect(() =>
    current({
      ...forCurrent(f),
      get target() {
        reads++;
        return f.target;
      },
    }),
  ).toThrow();
  expect(reads).toBe(0);
});
