import { expect, it } from "vitest";
import { parseProductAggregate } from "../contracts/product.js";
import { buildCatalogProductEditorSnapshot } from "../contracts/product-editor-snapshot.js";
import {
  buildProductOptionPriceContextSnapshot,
  parseProductOptionPriceContextRequest,
  parseProductOptionPriceContextSnapshot,
} from "../contracts/product-option-price-context-source.js";
export const contextId = (n: number) =>
  "01902441-0000-7000-8000-" + n.toString(16).padStart(12, "0");
export const contextAt = "2026-09-30T22:00:00.000Z",
  contextUntil = "2026-09-30T22:00:05.000Z";
export const contextRequest = () => ({
  productReference: contextId(5),
  expectedAggregateVersion: 3,
  bindingReference: contextId(20),
  optionReference: contextId(23),
});
export function contextAggregate() {
  return parseProductAggregate({
    productReference: contextId(5),
    brandReference: contextId(2),
    internalCode: "PRICE_CONTEXT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 3,
    createdAt: contextAt,
    createdByActorReference: contextId(3),
    updatedAt: contextAt,
    draft: {
      versionReference: contextId(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic context" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [
        {
          bindingReference: contextId(20),
          optionSetReference: contextId(21),
          optionSetVersionReference: contextId(22),
          purpose: "CUSTOMIZATION",
          sortOrder: 0,
          enabledOptionReferences: [contextId(23)],
          defaultSelections: [],
          minimumSelectionOverride: null,
          maximumSelectionOverride: null,
          includedSkuReferences: [],
          excludedSkuReferences: [],
          channelCodes: [],
          storeOverrideAllowed: false,
        },
      ],
      createdAt: contextAt,
      updatedAt: contextAt,
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: { "en-CA": "Synthetic complete content" },
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [
          {
            bindingReference: contextId(20),
            versionResolution: "CurrentPublished",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          },
        ],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
}
const scope = {
  tenantReference: contextId(1),
  brandReference: contextId(2),
  actorReference: contextId(3),
};
it("projects real complete owning identity without Category or aggregate exposure", () => {
  const aggregate = contextAggregate(),
    packet = buildProductOptionPriceContextSnapshot(
      aggregate,
      scope,
      contextRequest(),
      contextAt,
      contextUntil,
    ),
    full = buildCatalogProductEditorSnapshot(
      aggregate,
      scope,
      { productReference: contextId(5), expectedAggregateVersion: 3 },
      contextAt,
    );
  expect(packet.productSnapshotDigest).toBe(full.digest);
  expect(packet.contentDigest).toBe(full.contentDigest);
  expect(packet.optionRule.versionResolution).toBe("CurrentPublished");
  expect(packet.binding).toEqual(aggregate.draft.optionBindings[0]);
  expect(packet).not.toHaveProperty("aggregate");
  expect(packet).not.toHaveProperty("categoryClassification");
  expect(Object.isFrozen(packet.binding)).toBe(true);
  expect(parseProductOptionPriceContextSnapshot(packet)).toEqual(packet);
});
it("allows null Choice for actual saved Binding discovery", () => {
  expect(
    buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      scope,
      { ...contextRequest(), optionReference: null },
      contextAt,
      contextUntil,
    ).binding.bindingReference,
  ).toBe(contextId(20));
});
it("rejects absent or disabled actual Choice", () => {
  expect(() =>
    buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      scope,
      { ...contextRequest(), optionReference: contextId(99) },
      contextAt,
      contextUntil,
    ),
  ).toThrow();
});
it("tracks complete unrelated content in stable owning aggregate digest", () => {
  const a = contextAggregate(),
    b = parseProductAggregate({
      ...a,
      draft: { ...a.draft, localizedNames: { "en-CA": "Changed unrelated name" } },
    });
  const old = buildProductOptionPriceContextSnapshot(
      a,
      scope,
      contextRequest(),
      contextAt,
      contextUntil,
    ),
    changed = buildProductOptionPriceContextSnapshot(
      b,
      scope,
      contextRequest(),
      contextAt,
      contextUntil,
    );
  expect(changed.aggregateDigest).not.toBe(old.aggregateDigest);
  expect(changed.binding).toEqual(old.binding);
});
it("observation changes original envelope digest but not full aggregate identity", () => {
  const a = buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      scope,
      contextRequest(),
      contextAt,
      contextUntil,
    ),
    b = buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      scope,
      contextRequest(),
      "2026-09-30T22:00:01.000Z",
      contextUntil,
    );
  expect(b.productSnapshotDigest).not.toBe(a.productSnapshotDigest);
  expect(b.aggregateDigest).toBe(a.aggregateDigest);
});
it.each([
  { ...contextRequest(), extra: true },
  { ...contextRequest(), expectedAggregateVersion: 0 },
  { ...contextRequest(), optionReference: "unknown" },
])("rejects unclosed or malformed requests", (value) => {
  expect(() => parseProductOptionPriceContextRequest(value)).toThrow();
});
it("refuses accessor, extra fields and extended original lease", () => {
  const p = buildProductOptionPriceContextSnapshot(
    contextAggregate(),
    scope,
    contextRequest(),
    contextAt,
    contextUntil,
  );
  expect(() =>
    parseProductOptionPriceContextSnapshot({ ...p, validUntil: "2026-09-30T22:00:06.000Z" }),
  ).toThrow();
  expect(() => parseProductOptionPriceContextSnapshot({ ...p, extra: true })).toThrow();
  const getter = { ...p };
  Object.defineProperty(getter, "binding", {
    enumerable: true,
    get() {
      throw new Error("must not execute");
    },
  });
  expect(() => parseProductOptionPriceContextSnapshot(getter)).toThrow();
});
it("rejects actual wrong root revision and absent saved Binding", () => {
  expect(() =>
    buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      scope,
      { ...contextRequest(), expectedAggregateVersion: 2 },
      contextAt,
      contextUntil,
    ),
  ).toThrow(expect.objectContaining({ code: "CATALOG_VERSION_CONFLICT" }));
  expect(() =>
    buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      scope,
      { ...contextRequest(), bindingReference: contextId(99) },
      contextAt,
      contextUntil,
    ),
  ).toThrow(expect.objectContaining({ code: "CATALOG_VERSION_CONFLICT" }));
});
it("refuses wrong owning Brand and mismatched projected rule", () => {
  expect(() =>
    buildProductOptionPriceContextSnapshot(
      contextAggregate(),
      { ...scope, brandReference: contextId(90) },
      contextRequest(),
      contextAt,
      contextUntil,
    ),
  ).toThrow();
  const p = buildProductOptionPriceContextSnapshot(
    contextAggregate(),
    scope,
    contextRequest(),
    contextAt,
    contextUntil,
  );
  expect(() =>
    parseProductOptionPriceContextSnapshot({
      ...p,
      optionRule: { ...p.optionRule, bindingReference: contextId(99) },
    }),
  ).toThrow();
});
it.each([
  "productSnapshotDigest",
  "aggregateDigest",
  "contentDigest",
  "configurationDigest",
] as const)("requires canonical prefixed sha256 for %s", (field) => {
  const packet = buildProductOptionPriceContextSnapshot(
    contextAggregate(),
    scope,
    contextRequest(),
    contextAt,
    contextUntil,
  );
  for (const malformed of [
    "a".repeat(64),
    "sha256:" + "A".repeat(64),
    "sha256:" + "a".repeat(63),
    "sha256:" + "g".repeat(64),
    "sha256:" + "a".repeat(64) + "\n",
  ]) {
    expect(() =>
      parseProductOptionPriceContextSnapshot({ ...packet, [field]: malformed }),
    ).toThrow();
  }
  const missing = Object.fromEntries(Object.entries(packet).filter(([key]) => key !== field));
  expect(() => parseProductOptionPriceContextSnapshot(missing)).toThrow();
});
