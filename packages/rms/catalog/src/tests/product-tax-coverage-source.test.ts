import { expect, it } from "vitest";
import {
  parseProductTaxCoverageSource,
  buildProductTaxCoverageSource,
} from "../contracts/product-tax-coverage-source.js";
const id = (n: number) => `01902606-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-10-06T14:00:00.000Z",
  until = "2026-10-06T14:00:05.000Z",
  hash = "sha256:" + "a".repeat(64);
function packet(missing = false) {
  const raw = {
    profile: "ProductTaxCoverageSourceV1",
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    entries: [
      {
        productReference: id(5),
        aggregateVersion: 1,
        productLifecycle: "Draft",
        draft: {
          versionReference: id(6),
          sourceDigest: hash,
          taxClassificationReference: missing ? null : id(7),
          skus: [{ skuReference: id(8), lifecycle: "Draft" }],
        },
        published: [],
        publicationCoverage: null,
      },
    ],
    completeness: missing ? "Incomplete" : "CompleteRecordedInputs",
    missingClassifications: missing
      ? [{ productReference: id(5), versionReference: id(6), basis: "SavedDraftPreparation" }]
      : [],
    observedAt: at,
    validUntil: until,
    sourceQualification: "NotEvaluated",
    sellability: "NotEvaluated",
  };
  return { ...raw, sourceDigest: buildProductTaxCoverageSource(raw).sourceDigest };
}
it("retains explicit saved authoring basis and historical authoring SKU state without sale qualification", () => {
  const value = packet(),
    parsed = parseProductTaxCoverageSource(value);
  const draft = value.entries[0]?.draft;
  if (!draft) throw Error("missing controlled draft");
  draft.taxClassificationReference = id(999);
  expect(parsed.entries[0]?.draft?.taxClassificationReference).toBe(id(7));
  expect(parsed.entries[0]?.draft?.skus[0]?.lifecycle).toBe("Draft");
  expect(parsed.completeness).toBe("CompleteRecordedInputs");
  expect(Object.isFrozen(parsed.entries)).toBe(true);
  expect(parsed.sellability).toBe("NotEvaluated");
});
it("requires every unknown classification to be explicitly incomplete", () => {
  expect(parseProductTaxCoverageSource(packet(true)).missingClassifications).toHaveLength(1);
  expect(() =>
    parseProductTaxCoverageSource({ ...packet(true), completeness: "CompleteRecordedInputs" }),
  ).toThrow();
  expect(() =>
    parseProductTaxCoverageSource({ ...packet(true), missingClassifications: [] }),
  ).toThrow();
});
it("rejects duplicate/unordered roots, unproven Published input, scope extras and qualification flags", () => {
  const first = packet().entries[0];
  if (!first) throw Error("missing controlled root");
  for (const value of [
    { ...packet(), entries: [first, first] },
    { ...packet(), sellability: "Eligible" },
    { ...packet(), sourceQualification: "Pass" },
    { ...packet(), entries: [{ ...first, published: [first.draft] }] },
    { ...packet(), approved: true },
  ])
    expect(() => parseProductTaxCoverageSource(value)).toThrow();
});
it("rejects getters, sparse arrays, illegal hash/lifecycle, excessive roots and renewed leases", () => {
  let invoked = false;
  const value = Object.defineProperty(packet(), "entries", {
    enumerable: true,
    get() {
      invoked = true;
      return [];
    },
  });
  expect(() => parseProductTaxCoverageSource(value)).toThrow();
  expect(invoked).toBe(false);
  expect(() => parseProductTaxCoverageSource({ ...packet(), entries: Array(1) })).toThrow();
  const first = packet().entries[0];
  if (!first) throw Error("missing controlled root");
  expect(() =>
    parseProductTaxCoverageSource({
      ...packet(),
      entries: [{ ...first, draft: { ...first.draft, sourceDigest: "a".repeat(64) } }],
    }),
  ).toThrow();
  expect(() =>
    parseProductTaxCoverageSource({
      ...packet(),
      entries: Array.from({ length: 1001 }, () => first),
    }),
  ).toThrow();
  expect(() =>
    parseProductTaxCoverageSource({ ...packet(), validUntil: "2026-10-06T14:00:05.001Z" }),
  ).toThrow();
});

it("binds the complete roster while keeping content digest stable across Actor/observation lease changes", () => {
  const original = packet(),
    { sourceDigest, ...body } = original;
  const later = buildProductTaxCoverageSource({
    ...body,
    actorReference: id(999),
    observedAt: "2026-10-06T14:00:01.000Z",
    validUntil: "2026-10-06T14:00:06.000Z",
  });
  expect(later.sourceDigest).toBe(sourceDigest);
  expect(() => parseProductTaxCoverageSource({ ...original, entries: [] })).toThrow();
  expect(() => parseProductTaxCoverageSource({ ...original, sourceDigest: hash })).toThrow();
});
