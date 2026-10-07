import { expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  ProductOptionBindings,
  productOptionBindingsValid,
  removeProductOptionBinding,
  changeProductOptionBindingVariantCondition,
  productOptionBindingRawInputsValid,
  productOptionPickerSaveErrorCode,
  clearProductOptionBindingRawQuantity,
} from "./ProductOptionBindings.js";
import { parseProductVersion, type ProductVersion } from "./catalog-product-command-values.js";
import {
  parseProductOptionPickerView,
  ProductOptionPickerError,
} from "./product-option-picker-client.js";
const id = (n: number) => "01902421-7a00-7000-8000-" + n.toString(16).padStart(12, "0"),
  scope = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
  },
  at = "2026-10-01T12:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function draft(): ProductVersion {
  return {
    versionReference: id(10),
    baseVersionReference: null,
    status: "Draft",
    defaultLocale: "en-CA",
    localizedNames: { "en-CA": "Synthetic product" },
    taxClassificationReference: null,
    createdAt: at,
    updatedAt: at,
    skus: [
      {
        skuReference: id(11),
        productReference: id(12),
        brandReference: id(2),
        skuCode: "BASE",
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic SKU" },
        variantSelections: [],
        unitOfSale: "EA",
        unitQuantity: "1",
        createdAt: at,
        createdByActorReference: id(4),
      },
    ],
    optionBindings: [
      {
        bindingReference: id(7),
        optionSetReference: id(5),
        optionSetVersionReference: id(6),
        purpose: "SELECT",
        sortOrder: 0,
        enabledOptionReferences: [id(8)],
        defaultSelections: [{ optionReference: id(8), quantity: 1 }],
        minimumSelectionOverride: 0,
        maximumSelectionOverride: 2,
        includedSkuReferences: [id(11)],
        excludedSkuReferences: [],
        channelCodes: ["POS"],
        storeOverrideAllowed: false,
      },
    ],
    editorContent: {
      profile: "CatalogProductEditorContentV1",
      localizedShortDescriptions: {},
      localizedDescriptions: { "en-CA": "Retain complete description" },
      preparationNotes: {},
      tagReferences: [],
      attributeValues: [],
      media: [],
      variantDimensions: [],
      variantCombinations: [],
      optionRules: [
        {
          bindingReference: id(7),
          versionResolution: "Pinned",
          pricingRule: { reference: id(20), versionReference: id(21) },
          conditionalRule: { reference: id(22), versionReference: id(23) },
          conflictRule: { reference: id(24), versionReference: id(25) },
          variantCondition: [],
        },
      ],
      allergenReferences: [],
      nutritionProfile: { reference: id(26), versionReference: id(27) },
    },
  };
}
function selected() {
  const now = new Date().toISOString();
  return parseProductOptionPickerView(
    {
      profile: "CatalogProductOptionBindingPickerV1",
      ...scope,
      optionSetReference: id(5),
      versionReference: id(6),
      bindingReference: id(30),
      internalCode: "CHOICES",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic choices" },
      rootSelectionRule: {
        minimumSelection: 0,
        maximumSelection: 2,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 2,
        maximumTotalQuantity: 2,
        displayStyle: "MultiChoice",
      },
      options: [
        {
          optionReference: id(8),
          stableCode: "OLD",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Synthetic original option" },
          sortOrder: 0,
          defaultEligible: true,
          quantityRule: { minimumQuantity: 0, maximumQuantity: 2 },
          selectionDisabled: false,
          disabledReason: null,
        },
      ],
      selectionDisabled: false,
      disabledReason: null,
      originalRecordDigest: digest,
      sourceDigest: digest,
      contentDigest: digest,
      configurationDigest: digest,
      sourceAuthority: "RecordedFrozen",
      publicationReference: null,
      referenceEligibility: "NotEvaluated",
      publishValidation: "Incomplete",
      observedAt: now,
      validUntil: new Date(Date.parse(now) + 5000).toISOString(),
    },
    { optionSetReference: id(5), versionReference: id(6) },
    scope,
  );
}
it("does not replace existing binding identity with the new prepared picker identity", () => {
  const d = draft(),
    s = selected();
  expect(s.bindingReference).not.toBe(d.optionBindings[0]?.bindingReference);
  expect(productOptionBindingsValid(d, { [id(7)]: s })).toBe(true);
  expect(d.optionBindings[0]?.bindingReference).toBe(id(7));
});
it("missing or changed original source blocks save without deleting selected fields", () => {
  const d = draft(),
    before = JSON.stringify(d);
  expect(productOptionBindingsValid(d, {})).toBe(false);
  expect(
    productOptionBindingsValid(d, { [id(7)]: { ...selected(), versionReference: id(90) } }),
  ).toBe(false);
  expect(JSON.stringify(d)).toBe(before);
});
it("default selections require actual enabled eligible Option and owner quantity bounds", () => {
  const d = draft(),
    s = selected(),
    b = d.optionBindings[0];
  if (!b) throw Error("synthetic binding absent");
  expect(
    productOptionBindingsValid(
      {
        ...d,
        optionBindings: [{ ...b, defaultSelections: [{ optionReference: id(8), quantity: 3 }] }],
      },
      { [id(7)]: s },
    ),
  ).toBe(false);
  expect(
    productOptionBindingsValid(d, {
      [id(7)]: { ...s, options: s.options.map((o) => ({ ...o, defaultEligible: false })) },
    }),
  ).toBe(false);
  expect(
    productOptionBindingsValid(
      { ...d, optionBindings: [{ ...b, enabledOptionReferences: [] }] },
      { [id(7)]: s },
    ),
  ).toBe(false);
});
it("rejects an Inactive default but retains the same enabled Option after explicitly clearing the default", () => {
  const d = draft(),
    s = selected(),
    sources = {
      [id(7)]: { ...s, options: s.options.map((o) => ({ ...o, lifecycle: "Inactive" as const })) },
    };
  const before = JSON.stringify(d);
  expect(productOptionBindingsValid(d, sources)).toBe(false);
  expect(JSON.stringify(d)).toBe(before);
  expect(
    productOptionBindingsValid(
      { ...d, optionBindings: d.optionBindings.map((b) => ({ ...b, defaultSelections: [] })) },
      sources,
    ),
  ).toBe(true);
});
it("explicit remove deletes only the selected Draft binding and associated rule and preserves unrelated complete content", () => {
  const d = draft(),
    before = JSON.stringify(d),
    r = removeProductOptionBinding(d, id(7));
  expect(r.optionBindings).toEqual([]);
  expect(r.editorContent?.optionRules).toEqual([]);
  expect(r.skus).toBe(d.skus);
  expect(r.editorContent?.nutritionProfile).toBe(d.editorContent?.nutritionProfile);
  expect(r.editorContent?.localizedDescriptions).toBe(d.editorContent?.localizedDescriptions);
  expect(JSON.stringify(d)).toBe(before);
});
it("rejects unknown SKU scopes and overlapping included/excluded intent", () => {
  const d = draft(),
    b = d.optionBindings[0];
  if (!b) throw Error("synthetic binding absent");
  for (const changed of [
    { ...b, includedSkuReferences: [id(99)] },
    { ...b, excludedSkuReferences: [id(11)] },
  ])
    expect(
      productOptionBindingsValid({ ...d, optionBindings: [changed] }, { [id(7)]: selected() }),
    ).toBe(false);
});
it("initial render exposes retained choices but keeps dispatch locked during trusted identity/source acquisition", () => {
  const d = draft(),
    html = renderToStaticMarkup(
      <ProductOptionBindings
        draft={d}
        brandReference={scope.brandReference}
        storeReference={scope.storeReference}
        csrf={"A".repeat(43)}
        locked={false}
        onChange={vi.fn()}
        onBlockedChange={vi.fn()}
        registerBeforeSave={vi.fn()}
      />,
    );
  expect(html).toContain("Loading Option choices");
  expect(html).toContain("Recorded selection");
  expect(html).toContain("Existing enabled Options and defaults are retained");
  expect(html).toContain("disabled");
  expect(html).not.toContain(id(7));
  expect(html).not.toContain("<textarea");
});
function variantDraft(): ProductVersion {
  const d = draft();
  if (!d.editorContent) throw Error("synthetic complete content absent");
  const selections = [{ dimensionReference: id(40), valueReference: id(41) }];
  return {
    ...d,
    skus: d.skus.map((sku) => ({ ...sku, variantSelections: selections })),
    editorContent: {
      ...d.editorContent,
      variantDimensions: [
        {
          dimensionReference: id(40),
          code: "SIZE",
          localizedNames: { "en-CA": "Size" },
          sortOrder: 0,
          selectionRequirement: "Optional",
          values: [
            {
              valueReference: id(41),
              code: "SMALL",
              localizedNames: { "en-CA": "Small" },
              sortOrder: 0,
              attributeReference: null,
              mediaReference: null,
            },
            {
              valueReference: id(42),
              code: "LARGE",
              localizedNames: { "en-CA": "Large" },
              sortOrder: 1,
              attributeReference: null,
              mediaReference: null,
            },
          ],
        },
      ],
      variantCombinations: [{ selections, disposition: "Valid", skuReference: id(11) }],
    },
  };
}
it("selects and replaces only an actual Draft Dimension value, retaining binding identity and complete rule references", () => {
  const d = variantDraft(),
    before = JSON.stringify(d),
    selected = changeProductOptionBindingVariantCondition(d, id(7), id(40), id(41)),
    replaced = changeProductOptionBindingVariantCondition(selected, id(7), id(40), id(42)),
    rule = replaced.editorContent?.optionRules[0];
  expect(rule?.variantCondition).toEqual([{ dimensionReference: id(40), valueReference: id(42) }]);
  expect(replaced.optionBindings).toBe(d.optionBindings);
  expect(replaced.skus).toBe(d.skus);
  expect(rule?.pricingRule).toBe(d.editorContent?.optionRules[0]?.pricingRule);
  expect(rule?.conditionalRule).toBe(d.editorContent?.optionRules[0]?.conditionalRule);
  expect(rule?.conflictRule).toBe(d.editorContent?.optionRules[0]?.conflictRule);
  expect(replaced.editorContent?.nutritionProfile).toBe(d.editorContent?.nutritionProfile);
  expect(JSON.stringify(d)).toBe(before);
  expect(parseProductVersion(replaced).editorContent?.optionRules[0]?.variantCondition).toEqual(
    rule?.variantCondition,
  );
  expect(
    changeProductOptionBindingVariantCondition(replaced, id(7), id(40), null).editorContent
      ?.optionRules[0]?.variantCondition,
  ).toEqual([]);
});
it("rejects foreign Dimension, Value and binding choices instead of accepting an arbitrary reference", () => {
  const d = variantDraft();
  for (const [binding, dimension, value] of [
    [id(7), id(99), id(41)],
    [id(7), id(40), id(99)],
    [id(99), id(40), id(41)],
  ]) {
    if (!binding || !dimension || !value) throw Error("synthetic choice absent");
    expect(() =>
      changeProductOptionBindingVariantCondition(d, binding, dimension, value),
    ).toThrow();
  }
});
it("retains unavailable original conditions until explicit clear or replacement using an owning choice", () => {
  const d = variantDraft();
  if (!d.editorContent) throw Error("synthetic complete content absent");
  const stale = {
    ...d,
    editorContent: {
      ...d.editorContent,
      optionRules: d.editorContent.optionRules.map((r) => ({
        ...r,
        variantCondition: [
          { dimensionReference: id(40), valueReference: id(98) },
          { dimensionReference: id(97), valueReference: id(96) },
        ],
      })),
    },
  };
  const before = JSON.stringify(stale),
    corrected = changeProductOptionBindingVariantCondition(stale, id(7), id(40), id(42)),
    cleared = changeProductOptionBindingVariantCondition(corrected, id(7), id(97), null);
  expect(corrected.editorContent?.optionRules[0]?.variantCondition).toContainEqual({
    dimensionReference: id(97),
    valueReference: id(96),
  });
  expect(cleared.editorContent?.optionRules[0]?.variantCondition).toEqual([
    { dimensionReference: id(40), valueReference: id(42) },
  ]);
  expect(JSON.stringify(stale)).toBe(before);
  const html = renderToStaticMarkup(
    <ProductOptionBindings
      draft={stale}
      brandReference={scope.brandReference}
      storeReference={scope.storeReference}
      csrf={"A".repeat(43)}
      locked={false}
      onChange={vi.fn()}
      onBlockedChange={vi.fn()}
      registerBeforeSave={vi.fn()}
    />,
  );
  expect(html).toContain("Option binding 1 Size condition");
  expect(html).toContain("Any value (no condition)");
  expect(html).toContain("Large");
  expect(html).toContain("Recorded value unavailable");
  expect(html).toContain('aria-invalid="true"');
  expect(html).toContain("Dimension unavailable");
  expect(html).toContain("Clear unavailable condition 1 for binding 1");
  expect(html).not.toContain("<textarea");
});
it("retains controlled invalid numeric and channel text across picker remounts without changing the full Draft", () => {
  const d = variantDraft(),
    before = JSON.stringify(d),
    rawInputs = {
      [id(7) + "min"]: "2147483648",
      [id(7) + "max"]: "not a number",
      [id(7) + "channels"]: "POS, invalid code",
    },
    onChange = vi.fn(),
    onRawInputsChange = vi.fn();
  const render = () =>
    renderToStaticMarkup(
      <ProductOptionBindings
        draft={d}
        brandReference={scope.brandReference}
        storeReference={scope.storeReference}
        csrf={"A".repeat(43)}
        locked={false}
        onChange={onChange}
        onBlockedChange={vi.fn()}
        registerBeforeSave={vi.fn()}
        rawInputs={rawInputs}
        onRawInputsChange={onRawInputsChange}
      />,
    );
  for (const html of [render(), render()]) {
    expect(html).toContain('value="2147483648"');
    expect(html).toContain('value="not a number"');
    expect(html).toContain('value="POS, invalid code"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="');
    expect(html).toMatch(/maxlength="10"/iu);
    expect(html).toContain("Enter a non-negative whole number up to 2147483647, or leave blank.");
    expect(html).toContain('aria-label="Option binding 1 version resolution"');
    expect(html).toContain('aria-label="Option binding 1 Size condition"');
    expect(html).toContain('aria-label="Option binding 1 Synthetic SKU SKU applicability"');
  }
  expect(productOptionBindingRawInputsValid(rawInputs)).toBe(false);
  expect(onChange).not.toHaveBeenCalled();
  expect(onRawInputsChange).not.toHaveBeenCalled();
  expect(JSON.stringify(d)).toBe(before);
});
it("validates retained raw input boundaries before save rather than using the last accepted numeric candidate", () => {
  expect(
    productOptionBindingRawInputsValid({ [id(7) + "min"]: "", [id(7) + "max"]: "2147483647" }),
  ).toBe(true);
  for (const rawInputs of [
    { [id(7) + "min"]: "-1" },
    { [id(7) + "max"]: "2147483648" },
    { [id(7) + "qty-" + id(8)]: "0" },
    { [id(7) + "channels"]: "POS,POS" },
  ])
    expect(productOptionBindingRawInputsValid(rawInputs)).toBe(false);
});
it("distinguishes a current Option head conflict from Product aggregate CAS recovery", () => {
  expect(productOptionPickerSaveErrorCode(new ProductOptionPickerError("Conflict"))).toBe(
    "OptionSourceConflict",
  );
  expect(productOptionPickerSaveErrorCode(new ProductOptionPickerError("Stale"))).toBe("Stale");
});
it("explicitly clearing a default removes only its now-hidden raw quantity and retains other unsaved input", () => {
  const original = { [id(7) + "qty-" + id(8)]: "0", [id(7) + "channels"]: "POS, invalid code" },
    cleared = clearProductOptionBindingRawQuantity(original, id(7), id(8));
  expect(cleared).toEqual({ [id(7) + "channels"]: "POS, invalid code" });
  expect(original[id(7) + "qty-" + id(8)]).toBe("0");
});
