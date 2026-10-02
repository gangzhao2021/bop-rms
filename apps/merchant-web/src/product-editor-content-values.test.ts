import { expect, it, vi } from "vitest";
import { parseProductVersion } from "./catalog-product-command-values.js";

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("Synthetic fixture missing");
  return value;
}
const id = (n: number) => "01902485-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-01T13:00:00.000Z";
function fixture() {
  return {
    versionReference: id(1),
    baseVersionReference: null,
    status: "Draft",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic content" },
    taxClassificationReference: null,
    createdAt: at,
    updatedAt: at,
    skus: [
      {
        skuReference: id(2),
        productReference: id(3),
        brandReference: id(4),
        skuCode: "SKU",
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic SKU" },
        variantSelections: [{ dimensionReference: id(5), valueReference: id(6) }],
        unitOfSale: "EACH",
        unitQuantity: "1",
        createdAt: at,
        createdByActorReference: id(7),
      },
    ],
    optionBindings: [
      {
        bindingReference: id(8),
        optionSetReference: id(9),
        optionSetVersionReference: id(10),
        purpose: "CUSTOMIZATION",
        sortOrder: 0,
        enabledOptionReferences: [id(11)],
        defaultSelections: [{ optionReference: id(11), quantity: 1 }],
        minimumSelectionOverride: 0,
        maximumSelectionOverride: 1,
        includedSkuReferences: [id(2)],
        excludedSkuReferences: [],
        channelCodes: [],
        storeOverrideAllowed: false,
      },
    ],
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: { "en-CA": " Short  description " },
      localizedDescriptions: { "en-CA": " First  line\r\n Second line " },
      preparationNotes: { "en-CA": "Synthetic instructions" },
      tagReferences: [id(12)],
      attributeValues: [
        { attributeReference: id(13), type: "Text", value: " Synthetic  text " },
        { attributeReference: id(14), type: "Boolean", value: true },
        { attributeReference: id(15), type: "Decimal", value: "-0.250000", unitCode: "KG" },
        { attributeReference: id(16), type: "Enum", valueReference: id(17) },
      ],
      media: [
        {
          mediaReference: id(18),
          assetReference: id(19),
          assetVersionReference: id(20),
          role: "Primary",
          altText: { "en-CA": "Synthetic media" },
          sortOrder: 0,
          cropReference: id(21),
          focusReference: id(22),
        },
      ],
      variantDimensions: [
        {
          dimensionReference: id(5),
          code: "SIZE",
          localizedNames: { "en-CA": "Size" },
          sortOrder: 0,
          selectionRequirement: "Required",
          values: [
            {
              valueReference: id(6),
              code: "LARGE",
              localizedNames: { "en-CA": "Large" },
              sortOrder: 0,
              attributeReference: id(13),
              mediaReference: id(18),
            },
          ],
        },
      ],
      variantCombinations: [
        {
          selections: [{ dimensionReference: id(5), valueReference: id(6) }],
          disposition: "Valid",
          skuReference: id(2),
        },
      ],
      optionRules: [
        {
          bindingReference: id(8),
          versionResolution: "Pinned",
          pricingRule: { reference: id(23), versionReference: id(24) },
          conditionalRule: { reference: id(25), versionReference: id(26) },
          conflictRule: { reference: id(27), versionReference: id(28) },
          variantCondition: [{ dimensionReference: id(5), valueReference: id(6) }],
        },
      ],
      allergenReferences: [id(29)],
      nutritionProfile: { reference: id(30), versionReference: id(31) },
    },
  };
}
it("preserves exact complete reference tuples and string decimals independently of input mutation", () => {
  const value = fixture(),
    result = parseProductVersion(value),
    content = result.editorContent;
  expect(content?.localizedShortDescriptions).toEqual({ "en-CA": "Short description" });
  expect(content?.localizedDescriptions).toEqual({ "en-CA": "First line\nSecond line" });
  expect(content?.attributeValues[2]).toEqual({
    attributeReference: id(15),
    type: "Decimal",
    value: "-0.25",
    unitCode: "KG",
  });
  expect(content?.optionRules[0]?.pricingRule).toEqual({
    reference: id(23),
    versionReference: id(24),
  });
  expect(content?.media[0]).toMatchObject({
    assetReference: id(19),
    assetVersionReference: id(20),
    cropReference: id(21),
    focusReference: id(22),
  });
  expect(content?.nutritionProfile).toEqual({ reference: id(30), versionReference: id(31) });
  value.editorContent.tagReferences.push(id(99));
  required(value.editorContent.optionRules[0]).pricingRule.reference = id(99);
  expect(content?.tagReferences).toEqual([id(12)]);
  expect(content?.optionRules[0]?.pricingRule?.reference).toBe(id(23));
  expect(Object.isFrozen(content?.variantDimensions[0]?.values[0])).toBe(true);
  expect(Object.isFrozen(content?.optionRules[0]?.pricingRule)).toBe(true);
  expect(Object.keys(content ?? {})).not.toContain("sourceDraft");
  expect(Object.keys(content ?? {})).not.toContain("eligibility");
});
it("keeps absent legacy content absent while refusing an explicit incomplete extension", () => {
  const value = fixture();
  const { editorContent, ...legacy } = value;
  void editorContent;
  expect(Object.hasOwn(parseProductVersion(legacy), "editorContent")).toBe(false);
  expect(() => parseProductVersion({ ...legacy, editorContent: null })).toThrow();
});
it.each(["unknown", "getter", "sparse", "cycle", "symbol", "oversize", "markup", "url", "bidi"])(
  "refuses hostile complete content %s without executing getters",
  (mode) => {
    const value = fixture(),
      getter = vi.fn(() => "PRIVATE_SYNTHETIC");
    if (mode === "unknown") Object.assign(value.editorContent, { eligibility: "Eligible" });
    if (mode === "getter")
      Object.defineProperty(value.editorContent.media[0], "assetReference", {
        enumerable: true,
        get: getter,
      });
    if (mode === "sparse") delete value.editorContent.tagReferences[0];
    if (mode === "cycle") Object.assign(value.editorContent, { circular: value.editorContent });
    if (mode === "symbol") Object.assign(value.editorContent, { [Symbol("synthetic")]: "value" });
    if (mode === "oversize") value.editorContent.localizedDescriptions["en-CA"] = "a".repeat(4097);
    if (mode === "markup")
      value.editorContent.localizedDescriptions["en-CA"] = "<script>synthetic</script>";
    if (mode === "url")
      value.editorContent.localizedDescriptions["en-CA"] = "https://example.invalid";
    if (mode === "bidi") value.editorContent.localizedDescriptions["en-CA"] = "Synthetic\u202e";
    expect(() => parseProductVersion(value)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  },
);
it.each([
  "missing-combination",
  "wrong-sku",
  "wrong-value",
  "required-selection",
  "wrong-binding",
  "missing-option",
  "duplicate-primary",
  "duplicate-tag",
  "missing-media",
  "missing-attribute",
])("refuses an invalid same-Draft content graph %s", (mode) => {
  const value = fixture();
  if (mode === "missing-combination") value.editorContent.variantCombinations = [];
  if (mode === "wrong-sku")
    required(value.editorContent.variantCombinations[0]).skuReference = id(99);
  if (mode === "wrong-value")
    required(required(value.editorContent.variantCombinations[0]).selections[0]).valueReference =
      id(99);
  if (mode === "required-selection") {
    required(value.editorContent.variantCombinations[0]).selections = [];
    required(value.skus[0]).variantSelections = [];
  }
  if (mode === "wrong-binding")
    required(value.editorContent.optionRules[0]).bindingReference = id(99);
  if (mode === "missing-option") value.editorContent.optionRules = [];
  if (mode === "duplicate-primary")
    value.editorContent.media.push({
      ...required(value.editorContent.media[0]),
      mediaReference: id(99),
      sortOrder: 1,
    });
  if (mode === "duplicate-tag") value.editorContent.tagReferences.push(id(12));
  if (mode === "missing-media")
    required(required(value.editorContent.variantDimensions[0]).values[0]).mediaReference = id(99);
  if (mode === "missing-attribute")
    required(required(value.editorContent.variantDimensions[0]).values[0]).attributeReference =
      id(99);
  expect(() => parseProductVersion(value)).toThrow();
});
