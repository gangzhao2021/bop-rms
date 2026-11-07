import { expect, it, vi } from "vitest";
import {
  deriveCatalogProductDraftBaseline,
  parseCatalogProductDraftBaseline,
  parseProductAggregate,
  type ProductAggregate,
} from "../index.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
function source(): ProductAggregate {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "DRAFT_1",
    productType: "PreparedFood",
    lifecycle: "Active",
    aggregateVersion: 4,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic draft" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [id(5)], primaryCategoryReference: id(5) },
      skus: [0, 1].map((n) => ({
        skuReference: id(10 + n),
        productReference: id(1),
        brandReference: id(2),
        skuCode: "SKU_" + n,
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic SKU " + n },
        variantSelections: [{ dimensionReference: id(20), valueReference: id(21 + n) }],
        unitOfSale: "EA",
        unitQuantity: "1",
        createdAt: at,
        createdByActorReference: id(30),
      })),
      optionBindings: [
        {
          bindingReference: id(40),
          optionSetReference: id(41),
          optionSetVersionReference: id(42),
          purpose: "SELECT",
          sortOrder: 0,
          enabledOptionReferences: [id(43)],
          defaultSelections: [{ optionReference: id(43), quantity: 2 }],
          minimumSelectionOverride: 0,
          maximumSelectionOverride: 2,
          includedSkuReferences: [id(10)],
          excludedSkuReferences: [],
          channelCodes: ["DINE_IN"],
          storeOverrideAllowed: false,
        },
      ],
    },
  });
}
const make = () => deriveCatalogProductDraftBaseline(source(), at, at);
it("returns full persisted Draft and expected version without needless root actor history", () => {
  const value = make();
  expect(value).toMatchObject({
    productReference: id(1),
    brandReference: id(2),
    lifecycle: "Active",
    aggregateVersion: 4,
    classificationCoverage: "Known",
  });
  expect(value.draft).toEqual(source().draft);
  expect(value.draft.skus).toHaveLength(2);
  expect(value.draft.optionBindings[0]?.defaultSelections).toEqual([
    { optionReference: id(43), quantity: 2 },
  ]);
  expect(value.draft.categoryClassification?.primaryCategoryReference).toBe(id(5));
  expect(Object.isFrozen(value.draft.skus[0])).toBe(true);
  expect(JSON.stringify(value)).not.toContain(id(3));
  expect(JSON.stringify(value)).toContain(id(30));
  expect(value.projection.partial).toBe(true);
});
it("preserves legacy absence distinct from explicit empty classification", () => {
  const legacy = source(),
    draft = { ...legacy.draft };
  delete draft.categoryClassification;
  const unknown = deriveCatalogProductDraftBaseline({ ...legacy, draft }, at, at);
  expect(unknown.classificationCoverage).toBe("Unavailable");
  expect(Object.hasOwn(unknown.draft, "categoryClassification")).toBe(false);
  const known = deriveCatalogProductDraftBaseline(
    {
      ...legacy,
      draft: {
        ...draft,
        categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      },
    },
    at,
    at,
  );
  expect(known.classificationCoverage).toBe("Known");
  expect(known.draft.categoryClassification?.categoryReferences).toEqual([]);
});
it("reads actual Archived root lifecycle without implying mutation or publication", () => {
  const value = deriveCatalogProductDraftBaseline({ ...source(), lifecycle: "Archived" }, at, at);
  expect(value.lifecycle).toBe("Archived");
  expect(value.draft.status).toBe("Draft");
});
it.each([
  "extra",
  "coverage",
  "root-version",
  "root-time",
  "draft-time",
  "sku-time",
  "brand",
  "product",
  "sku-graph",
  "option-graph",
  "noncanonical",
  "partial",
  "name",
  "sparse",
])("rejects incoherent baseline %s", (kind) => {
  const value = JSON.parse(JSON.stringify(make()));
  if (kind === "extra") value.history = [];
  if (kind === "coverage") value.classificationCoverage = "Unavailable";
  if (kind === "root-version") value.aggregateVersion = 2147483648;
  if (kind === "root-time") value.updatedAt = "2026-09-28T12:00:00.001Z";
  if (kind === "draft-time") value.draft.updatedAt = "2026-09-28T12:00:00.001Z";
  if (kind === "sku-time") value.draft.skus[0].createdAt = "2026-09-28T12:00:00.001Z";
  if (kind === "brand") value.draft.skus[0].brandReference = id(99);
  if (kind === "product") value.draft.skus[0].productReference = id(99);
  if (kind === "sku-graph")
    value.draft.skus[1].variantSelections = value.draft.skus[0].variantSelections;
  if (kind === "option-graph") value.draft.optionBindings[0].includedSkuReferences = [id(99)];
  if (kind === "noncanonical") value.draft.localizedNames = { "en-CA": "  Two  spaces " };
  if (kind === "partial") value.projection.partial = false;
  if (kind === "name") value.projection.name = "catalog_product_editor_v1";
  if (kind === "sparse") value.draft.skus = new Array(2);
  expect(() => parseCatalogProductDraftBaseline(value)).toThrow();
});
it("rejects malicious descriptors without evaluating getters", () => {
  const getter = vi.fn(() => source().draft),
    value = { ...make() };
  Object.defineProperty(value, "draft", { get: getter, enumerable: true });
  expect(() => parseCatalogProductDraftBaseline(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const cycle = { ...make() };
  Object.assign(cycle, { cycle });
  expect(() => parseCatalogProductDraftBaseline(cycle)).toThrow();
});
it("rejects future/stale source provenance and accepts exact5sec boundary", () => {
  expect(() =>
    deriveCatalogProductDraftBaseline(source(), at, "2026-09-28T11:59:59.999Z"),
  ).toThrow();
  expect(() =>
    deriveCatalogProductDraftBaseline(source(), at, "2026-09-28T12:00:05.001Z"),
  ).toThrow();
  expect(deriveCatalogProductDraftBaseline(source(), at, "2026-09-28T12:00:05.000Z").draft).toEqual(
    source().draft,
  );
});
