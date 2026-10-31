import { expect, it, vi } from "vitest";
import { parseCatalogProductEditorContent } from "../contracts/product-editor-content.js";
const id = (n: number) => `019a2421-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Missing synthetic fixture member");
  return value;
}
const at = "2026-09-30T02:20:00.000Z";
function fixture() {
  const source = {
    productReference: id(1),
    brandReference: id(2),
    internalCode: "CONTENT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic content" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [id(6)], primaryCategoryReference: id(6) },
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU" },
          variantSelections: [{ dimensionReference: id(10), valueReference: id(11) }],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [
        {
          bindingReference: id(20),
          optionSetReference: id(21),
          optionSetVersionReference: id(22),
          purpose: "TOPPING",
          sortOrder: 0,
          enabledOptionReferences: [id(23)],
          defaultSelections: [],
          minimumSelectionOverride: 0,
          maximumSelectionOverride: 1,
          includedSkuReferences: [id(5)],
          excludedSkuReferences: [],
          channelCodes: ["WEB"],
          storeOverrideAllowed: false,
        },
      ],
    },
  };
  const content = {
    profile: "CatalogProductEditorContentV1",
    localizedShortDescriptions: { "en-CA": "  Short   description  " },
    localizedDescriptions: { "en-CA": "First  line\r\nSecond line" },
    preparationNotes: { "en-CA": "Synthetic preparation" },
    tagReferences: [id(31), id(30)],
    attributeValues: [
      { attributeReference: id(40), type: "Decimal", value: "-0.250000", unitCode: "KG" },
    ],
    media: [
      {
        mediaReference: id(50),
        assetReference: id(51),
        assetVersionReference: id(52),
        role: "Primary",
        altText: { "en-CA": "Synthetic image" },
        sortOrder: 0,
        cropReference: null,
        focusReference: null,
      },
    ],
    variantDimensions: [
      {
        dimensionReference: id(10),
        code: "SIZE",
        localizedNames: { "en-CA": "Size" },
        sortOrder: 0,
        selectionRequirement: "Required",
        values: [
          {
            valueReference: id(11),
            code: "ONE",
            localizedNames: { "en-CA": "One" },
            sortOrder: 0,
            attributeReference: id(40),
            mediaReference: id(50),
          },
          {
            valueReference: id(12),
            code: "TWO",
            localizedNames: { "en-CA": "Two" },
            sortOrder: 1,
            attributeReference: null,
            mediaReference: null,
          },
        ],
      },
    ],
    variantCombinations: [
      {
        selections: [{ dimensionReference: id(10), valueReference: id(11) }],
        disposition: "Valid",
        skuReference: id(5),
      },
      {
        selections: [{ dimensionReference: id(10), valueReference: id(12) }],
        disposition: "NotGenerated",
        skuReference: null,
      },
    ],
    optionRules: [
      {
        bindingReference: id(20),
        versionResolution: "Pinned",
        pricingRule: { reference: id(60), versionReference: id(61) },
        conditionalRule: null,
        conflictRule: null,
        variantCondition: [{ dimensionReference: id(10), valueReference: id(11) }],
      },
    ],
    allergenReferences: [id(70)],
    nutritionProfile: { reference: id(80), versionReference: id(81) },
  };
  return { source, content };
}
function run(source: unknown, content: unknown) {
  return parseCatalogProductEditorContent(source, content);
}
it("copies complete configured content and produces immutable identity without eligibility", () => {
  const f = fixture(),
    before = JSON.stringify(f),
    r = run(f.source, f.content);
  expect(JSON.stringify(f)).toBe(before);
  expect(r).toMatchObject({
    brandReference: id(2),
    productReference: id(1),
    versionReference: id(4),
    sourceAggregateVersion: 1,
    tenantCoverage: "NotEvaluated",
    referenceEligibility: "NotEvaluated",
  });
  expect(r.content.localizedShortDescriptions["en-CA"]).toBe("Short description");
  expect(r.content.localizedDescriptions["en-CA"]).toBe("First line\nSecond line");
  expect(r.content.attributeValues[0]).toMatchObject({ value: "-0.25" });
  expect(r.content.tagReferences).toEqual([id(30), id(31)]);
  expect(r.contentDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  expect(Object.isFrozen(r.content.variantDimensions[0]?.values)).toBe(true);
  f.content.tagReferences.push(id(99));
  expect(r.content.tagReferences).toHaveLength(2);
});
it("canonical set order and normalized equivalent text retain content identity", () => {
  const f = fixture(),
    initial = run(f.source, f.content);
  f.content.tagReferences.reverse();
  f.content.variantCombinations.reverse();
  f.content.localizedShortDescriptions["en-CA"] = "Short description";
  expect(run(f.source, f.content).contentDigest).toBe(initial.contentDigest);
});
it("every additional content family affects the exact content identity", () => {
  const f = fixture(),
    initial = run(f.source, f.content).contentDigest;
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.content.localizedDescriptions["en-CA"] = "Changed";
    },
    (f: ReturnType<typeof fixture>) => {
      f.content.preparationNotes["en-CA"] = "Changed";
    },
    (f: ReturnType<typeof fixture>) => {
      f.content.tagReferences.push(id(99));
    },
    (f: ReturnType<typeof fixture>) => {
      required(f.content.attributeValues[0]).value = "1.5";
    },
    (f: ReturnType<typeof fixture>) => {
      required(f.content.media[0]).assetVersionReference = id(99);
    },
    (f: ReturnType<typeof fixture>) => {
      required(required(f.content.variantDimensions[0]).values[1]).code = "THREE";
    },
    (f: ReturnType<typeof fixture>) => {
      required(f.content.optionRules[0]).pricingRule.versionReference = id(99);
    },
    (f: ReturnType<typeof fixture>) => {
      f.content.allergenReferences.push(id(99));
    },
    (f: ReturnType<typeof fixture>) => {
      f.content.nutritionProfile.versionReference = id(99);
    },
  ]) {
    const next = fixture();
    mutate(next);
    expect(run(next.source, next.content).contentDigest).not.toBe(initial);
  }
});
it.each(["accessor", "symbol", "prototype", "sparse", "cycle", "unknown", "omitted"])(
  "refuses closed boundary %s",
  (kind) => {
    const f = fixture(),
      getter = vi.fn(() => []);
    const c = f.content as unknown as Record<string, unknown>;
    if (kind === "accessor")
      Object.defineProperty(c, "tagReferences", { get: getter, enumerable: true });
    if (kind === "symbol")
      Object.defineProperty(c, Symbol("hidden"), { value: 1, enumerable: true });
    if (kind === "prototype") Object.setPrototypeOf(c, { hidden: 1 });
    if (kind === "sparse") c.tagReferences = new Array(3);
    if (kind === "cycle") c.tagReferences = c;
    if (kind === "unknown") c.price = "1.00";
    if (kind === "omitted") delete c.media;
    expect(() => run(f.source, c)).toThrow(
      expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
    );
    expect(getter).not.toHaveBeenCalled();
  },
);
it.each([
  "<b>text</b>",
  "**bold**",
  "# heading",
  "- Markdown list",
  "1. Markdown list",
  "https://example.invalid",
  "\u202Ehidden",
  "x".repeat(241),
])("rejects unsafe or oversize short description", (value) => {
  const f = fixture();
  f.content.localizedShortDescriptions["en-CA"] = value;
  expect(() => run(f.source, f.content)).toThrow();
});
it.each(["0.0000001", "01", "1e3", "1.2.3", "NaN", "999999999999999"])(
  "rejects unsupported decimal %s",
  (value) => {
    const f = fixture();
    required(f.content.attributeValues[0]).value = value;
    expect(() => run(f.source, f.content)).toThrow();
  },
);
it("rejects binary floating point rather than silently serializing it", () => {
  const f = fixture();
  (f.content.attributeValues[0] as unknown as { value: unknown }).value = 0.1;
  expect(() => run(f.source, f.content)).toThrow();
});
it.each([
  "media-primary",
  "media-order",
  "tag",
  "attribute",
  "dimension-code",
  "value-code",
  "value-global-id",
  "combination",
  "binding",
  "allergen",
])("rejects duplicate %s", (kind) => {
  const f = fixture();
  if (kind === "media-primary")
    f.content.media.push({ ...required(f.content.media[0]), mediaReference: id(55), sortOrder: 1 });
  if (kind === "media-order")
    f.content.media.push({
      ...required(f.content.media[0]),
      mediaReference: id(55),
      role: "Gallery",
    });
  if (kind === "tag") f.content.tagReferences.push(id(30));
  if (kind === "attribute")
    f.content.attributeValues.push({ ...required(f.content.attributeValues[0]) });
  if (kind === "dimension-code")
    f.content.variantDimensions.push({
      ...required(f.content.variantDimensions[0]),
      dimensionReference: id(15),
      sortOrder: 1,
      values: [],
    });
  if (kind === "value-code")
    required(required(f.content.variantDimensions[0]).values[1]).code = "ONE";
  if (kind === "value-global-id")
    f.content.variantDimensions.push({
      ...required(f.content.variantDimensions[0]),
      dimensionReference: id(15),
      code: "OTHER",
      sortOrder: 1,
    });
  if (kind === "combination")
    f.content.variantCombinations.push({ ...required(f.content.variantCombinations[0]) });
  if (kind === "binding") f.content.optionRules.push({ ...required(f.content.optionRules[0]) });
  if (kind === "allergen") f.content.allergenReferences.push(id(70));
  expect(() => run(f.source, f.content)).toThrow();
});
it.each([
  "variant",
  "sku",
  "mapped-value",
  "missing-map",
  "required-dimension",
  "invalid-with-sku",
  "unmapped-with-sku",
  "variant-media",
  "variant-attribute",
  "option-binding",
  "option-condition",
  "missing-option",
])("rejects dangling/inconsistent %s", (kind) => {
  const f = fixture();
  if (kind === "variant")
    required(required(f.source.draft.skus[0]).variantSelections[0]).dimensionReference = id(99);
  if (kind === "sku") required(f.content.variantCombinations[0]).skuReference = id(99);
  if (kind === "mapped-value")
    required(required(f.content.variantCombinations[0]).selections[0]).valueReference = id(12);
  if (kind === "missing-map") f.content.variantCombinations.shift();
  if (kind === "required-dimension") {
    required(f.source.draft.skus[0]).variantSelections = [];
    required(f.content.variantCombinations[0]).selections = [];
  }
  if (kind === "invalid-with-sku")
    required(f.content.variantCombinations[0]).disposition = "Invalid";
  if (kind === "unmapped-with-sku") required(f.content.variantCombinations[1]).skuReference = id(5);
  if (kind === "variant-media")
    required(required(f.content.variantDimensions[0]).values[0]).mediaReference = id(99);
  if (kind === "variant-attribute")
    required(required(f.content.variantDimensions[0]).values[0]).attributeReference = id(99);
  if (kind === "option-binding") required(f.content.optionRules[0]).bindingReference = id(99);
  if (kind === "option-condition")
    required(required(f.content.optionRules[0]).variantCondition[0]).valueReference = id(99);
  if (kind === "missing-option") f.content.optionRules = [];
  expect(() => run(f.source, f.content)).toThrow();
});
it("allows explicitly incomplete optional Draft content without inventing reference readiness", () => {
  const f = fixture();
  f.content.media = [];
  f.content.attributeValues = [];
  f.content.tagReferences = [];
  f.content.allergenReferences = [];
  required(required(f.content.variantDimensions[0]).values[0]).mediaReference = null;
  required(required(f.content.variantDimensions[0]).values[0]).attributeReference = null;
  const result = run(f.source, {
    ...f.content,
    nutritionProfile: null,
    localizedShortDescriptions: {},
    localizedDescriptions: {},
    preparationNotes: {},
  });
  expect(result.referenceEligibility).toBe("NotEvaluated");
});
it("does not accept missing legacy content as a known empty set", () => {
  const f = fixture();
  expect(() => run(f.source, undefined)).toThrow();
  expect(() => run(f.source, null)).toThrow();
});
it("rejects a foreign-brand SKU in the actual candidate", () => {
  const f = fixture();
  required(f.source.draft.skus[0]).brandReference = id(99);
  expect(() => run(f.source, f.content)).toThrow();
});

it("text changes affect content but preserve the reference configuration identity", () => {
  const f = fixture(),
    initial = run(f.source, f.content);
  f.content.localizedDescriptions["en-CA"] = "Changed text";
  required(f.content.media[0]).altText["en-CA"] = "Changed accessible description";
  const changed = run(f.source, f.content);
  expect(changed.contentDigest).not.toBe(initial.contentDigest);
  expect(changed.configurationDigest).toBe(initial.configurationDigest);
  required(f.content.media[0]).assetVersionReference = id(99);
  expect(run(f.source, f.content).configurationDigest).not.toBe(initial.configurationDigest);
});

it("owning ProductVersion carries the closed content without invoking nested accessors", async () => {
  const { parseProductAggregate } = await import("../contracts/product.js");
  const f = fixture(),
    getter = vi.fn(() => id(99));
  const source = { ...f.source, draft: { ...f.source.draft, editorContent: f.content } };
  expect(parseProductAggregate(source).draft.editorContent?.localizedDescriptions["en-CA"]).toBe(
    "First line\nSecond line",
  );
  Object.defineProperty(required(f.content.media[0]), "assetReference", {
    get: getter,
    enumerable: true,
  });
  expect(() => parseProductAggregate(source)).toThrow(
    expect.objectContaining({ code: "CATALOG_INPUT_INVALID" }),
  );
  expect(getter).not.toHaveBeenCalled();
});
it("legacy owning ProductVersion stays absent rather than receiving invented content", async () => {
  const { parseProductAggregate } = await import("../contracts/product.js");
  const f = fixture();
  expect(Object.hasOwn(parseProductAggregate(f.source).draft, "editorContent")).toBe(false);
  expect(() =>
    parseProductAggregate({ ...f.source, draft: { ...f.source.draft, editorContent: null } }),
  ).toThrow();
});
