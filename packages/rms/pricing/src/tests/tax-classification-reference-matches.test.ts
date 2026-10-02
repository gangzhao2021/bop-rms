import { expect, it, vi } from "vitest";
import {
  matchProductVersionTaxReferences as match,
  buildTaxConfigurationReferenceSourceSnapshot,
  type ProductVersionTaxReferenceTarget,
} from "../index.js";
import { fixture, id, hash } from "./tax-classification-reference-matches.fixture.js";
const unavailable = { code: "TAX_CLASSIFICATION_REFERENCE_MATCH_UNAVAILABLE" };
it("keeps explicit historical classifications/rule versions separate and leaves null default unresolved", () => {
  const f = fixture(),
    r = match(f);
  expect(r.productReference).toBe(id(10));
  expect(r.skuReference).toBeNull();
  expect(r.classificationCoverage).toBe("DefaultUnavailable");
  expect(r.configurations.find((c) => c.catalogConfigurationDigest === hash(1))).toMatchObject({
    classificationCoverage: "DefaultUnavailable",
    references: null,
  });
  expect(
    r.configurations.find((c) => c.catalogConfigurationDigest === hash(2))?.references,
  ).toMatchObject([
    {
      lifecycle: "Published",
      temporalStatus: "Expired",
      rule: { taxClassificationReference: id(11), orderType: "Pickup", chargeType: "Sellable" },
    },
  ]);
  expect(
    r.configurations.find((c) => c.catalogConfigurationDigest === hash(3))?.references,
  ).toMatchObject([
    {
      lifecycle: "Draft",
      temporalStatus: "Future",
      rule: {
        taxClassificationReference: id(12),
        orderType: "DineIn",
        chargeType: "ServiceCharge",
      },
    },
  ]);
  expect(r).toMatchObject({
    crossStoreCoverage: "Unavailable",
    skuTaxOverrideCoverage: "Unavailable",
    publicationCoverage: "Unavailable",
    futureScheduleCoverage: "Unavailable",
  });
  expect(JSON.stringify(r)).not.toMatch(/"Allowed"|rate|registration|professional/);
  expect(
    match({ ...f, target: { ...f.target, configurations: [...f.target.configurations].reverse() } })
      .digest,
  ).toBe(r.digest);
});
it("current explicit classification can have zero references without resolving a null default", () => {
  const f = fixture(),
    c = f.target.configurations[1];
  if (!c) throw new Error("missing synthetic fixture");
  const target: ProductVersionTaxReferenceTarget = {
    ...f.target,
    profile: "CurrentDraftBindings",
    configurations: [{ ...c, taxClassificationReference: id(99) }],
  };
  expect(match({ ...f, target })).toMatchObject({
    classificationCoverage: "CompleteExplicit",
    configurations: [{ classificationCoverage: "Explicit", references: [] }],
  });
  expect(
    match({
      ...f,
      target: { ...target, configurations: [{ ...c, taxClassificationReference: null }] },
    }),
  ).toMatchObject({
    classificationCoverage: "DefaultUnavailable",
    configurations: [{ references: null }],
  });
});
it("exact removed SKU retains its original classification and marks later absence", () => {
  const f = fixture(),
    r = match({ ...f, target: { ...f.target, skuReference: id(11) } });
  expect(
    r.configurations.find((c) => c.catalogConfigurationDigest === hash(2))?.references,
  ).toHaveLength(1);
  expect(r.configurations.find((c) => c.catalogConfigurationDigest === hash(3))).toMatchObject({
    membership: "SkuAbsent",
    classificationCoverage: "NotApplicableToSelectedSku",
    references: null,
  });
  expect(() => match({ ...f, target: { ...f.target, skuReference: id(99) } })).toThrow(
    expect.objectContaining(unavailable),
  );
});
it.each([
  { digest: hash(999) },
  { crossStoreCoverage: "Complete" },
  { request: { ...fixture().request, storeReference: id(99) } },
])("rejects altered Tax snapshot %s", (change) => {
  const f = fixture();
  expect(() => match({ ...f, taxConfigurations: { ...f.taxConfigurations, ...change } })).toThrow(
    expect.objectContaining(unavailable),
  );
});
it("rejects staleness/accessors/unknown profile/duplicate graphs/current-history confusion", () => {
  const f = fixture(),
    c = f.target.configurations[0];
  if (!c) throw new Error("missing synthetic fixture");
  expect(() => match({ ...f, now: "2026-09-29T12:00:06.000Z" })).toThrow(
    expect.objectContaining(unavailable),
  );
  const get = vi.fn(() => []),
    target = { ...f.target };
  Object.defineProperty(target, "configurations", { enumerable: true, get });
  expect(() => match({ ...f, target })).toThrow(expect.objectContaining(unavailable));
  expect(get).not.toHaveBeenCalled();
  for (const target of [
    { ...f.target, configurations: [c, c] },
    { ...f.target, profile: "CurrentDraftBindings" },
    { ...f.target, configurations: [] },
    { ...f.target, configurations: new Array(1) },
    { ...f.target, configurations: [{ ...c, skuReferences: [id(11), id(11)] }] },
  ])
    expect(() => match({ ...f, target: target as ProductVersionTaxReferenceTarget })).toThrow(
      expect.objectContaining(unavailable),
    );
});

it("rejects oversized configuration sets and multiplied rule output without partial coverage", () => {
  const f = fixture(),
    c = f.target.configurations[2],
    root = f.taxConfigurations.roots[0],
    current = f.taxConfigurations.versions.find((v) => v.versionNumber === 2);
  if (!c || !root || !current) throw new Error("missing synthetic Tax fixture");
  expect(() =>
    match({ ...f, target: { ...f.target, configurations: Array.from({ length: 1001 }, () => c) } }),
  ).toThrow(expect.objectContaining(unavailable));
  const { configurationReference, isCurrentVersion, temporalStatus, ...version } = current;
  void configurationReference;
  void isCurrentVersion;
  void temporalStatus;
  const taxConfigurations = buildTaxConfigurationReferenceSourceSnapshot(
    {
      observedAt: f.now,
      references: [
        {
          root,
          precise: true,
          version: {
            ...version,
            rules: Array.from({ length: 20 }, (_, i) => ({
              ruleReference: id(1000 + i),
              taxClassificationReference: id(12),
              orderType: i % 2 === 0 ? "Pickup" : "DineIn",
              chargeType: "Sellable",
              taxComponentCode: "HST_" + i,
            })),
          },
        },
      ],
    },
    f.request,
    f.now,
  );
  expect(() =>
    match({
      ...f,
      taxConfigurations,
      target: {
        ...f.target,
        configurations: Array.from({ length: 1000 }, (_, i) => ({
          ...c,
          catalogConfigurationDigest: hash(1000 + i),
        })),
      },
    }),
  ).toThrow(expect.objectContaining(unavailable));
});
