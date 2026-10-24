import { expect, it, vi } from "vitest";
import {
  selectProductCategoryClassification,
  deriveProductCategorySelectionView,
  replaceProductDraftCategorySelection,
  type ProductCategoryEditingContext,
} from "./catalog-product-category-selection.js";
import { createProductDraftEditingSession } from "./catalog-product-draft-baseline.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
const scope = { brandReference: id(2), storeReference: id(5), productReference: id(1) },
  pickerScope = { brandReference: id(2), storeReference: id(5), locale: "en-CA" };
const context: ProductCategoryEditingContext = {
  scope,
  locale: "en-CA",
  observedAt: Date.parse(at),
};
function fixture() {
  return {
    scope: { brandReference: id(2), storeReference: id(5) },
    baseline: {
      projection: {
        name: "catalog_product_draft_baseline_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      productReference: id(1),
      brandReference: id(2),
      internalCode: "DRAFT_1",
      productType: "PreparedFood",
      lifecycle: "Active",
      aggregateVersion: 4,
      updatedAt: at,
      classificationCoverage: "Known",
      draft: {
        versionReference: id(4),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic draft" } as Record<string, string>,
        taxClassificationReference: null,
        createdAt: at,
        updatedAt: at,
        categoryClassification: { categoryReferences: [id(6)], primaryCategoryReference: id(6) },
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
          createdByActorReference: id(3),
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
            channelCodes: ["QR", "WEB"],
            storeOverrideAllowed: false,
          },
        ],
      },
    },
  };
}
function choices(parentScreenId: "CAT-PRODUCT-CREATE" | "CAT-PRODUCT-EDIT" = "CAT-PRODUCT-EDIT") {
  return {
    scope: { brandReference: id(2), storeReference: id(5) },
    lookup: {
      projection: {
        name: "catalog_product_category_lookup_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      parentScreenId,
      brandReference: id(2),
      locale: "en-CA",
      configuration: "Draft",
      source: { revision: "2", digest: "sha256:" + "a".repeat(64), asOfUtc: at },
      policy: { allowedLifecycles: ["Draft", "Active"] },
      items: [
        {
          categoryReference: id(6),
          internalCode: "CAT_6",
          name: "Synthetic category 6",
          nameLocale: "en-CA",
          localeFallback: false,
          lifecycle: "Draft",
        },
        {
          categoryReference: id(7),
          internalCode: "CAT_7",
          name: "Synthetic category 7",
          nameLocale: "en-CA",
          localeFallback: false,
          lifecycle: "Active",
        },
      ],
    },
  };
}
const setup = () => {
  const value = fixture();
  return { value, session: createProductDraftEditingSession(value, scope, Date.parse(at)) };
};
it.each(["CAT-PRODUCT-CREATE", "CAT-PRODUCT-EDIT"] as const)(
  "selects explicit eligible set under exact %s, nullable primary never defaults",
  (parent) => {
    const source = choices(parent),
      change = { categoryReferences: [id(7), id(6)], primaryCategoryReference: id(7) },
      selected = selectProductCategoryClassification(
        change,
        source,
        parent,
        pickerScope,
        Date.parse(at),
      );
    expect(selected.categoryReferences).toEqual([id(6), id(7)]);
    expect(selected.primaryCategoryReference).toBe(id(7));
    expect(Object.isFrozen(selected.categoryReferences)).toBe(true);
    expect(change.categoryReferences).toEqual([id(7), id(6)]);
    expect(
      selectProductCategoryClassification(
        { ...change, primaryCategoryReference: null },
        source,
        parent,
        pickerScope,
        Date.parse(at),
      ).primaryCategoryReference,
    ).toBeNull();
  },
);
it.each([
  { categoryReferences: [id(99)], primaryCategoryReference: null },
  { categoryReferences: [id(6)], primaryCategoryReference: id(7) },
  { categoryReferences: [id(6), id(6)], primaryCategoryReference: id(6) },
  { categoryReferences: [], primaryCategoryReference: null, actorReference: id(3) },
])("rejects caller eligibility/primary/scope drift %#", (change) => {
  expect(() =>
    selectProductCategoryClassification(
      change,
      choices(),
      "CAT-PRODUCT-EDIT",
      pickerScope,
      Date.parse(at),
    ),
  ).toThrow(expect.objectContaining({ code: "Invalid" }));
});
it("does not evaluate selection descriptors or sparse set", () => {
  const getter = vi.fn(() => id(6)),
    change = { categoryReferences: [id(6)] };
  Object.defineProperty(change, "primaryCategoryReference", { get: getter, enumerable: true });
  expect(() =>
    selectProductCategoryClassification(
      change,
      choices(),
      "CAT-PRODUCT-EDIT",
      pickerScope,
      Date.parse(at),
    ),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    selectProductCategoryClassification(
      { categoryReferences: new Array(1), primaryCategoryReference: null },
      choices(),
      "CAT-PRODUCT-EDIT",
      pickerScope,
      Date.parse(at),
    ),
  ).toThrow();
});
it("keeps known selected member/primary with current eligible name", () => {
  const { value, session } = setup(),
    view = deriveProductCategorySelectionView(session, value.baseline.draft, choices(), context);
  expect(view).toEqual({
    coverage: "Known",
    primaryCategoryReference: id(6),
    selected: [
      {
        categoryReference: id(6),
        primary: true,
        eligibility: "Eligible",
        name: "Synthetic category 6",
        lifecycle: "Draft",
      },
    ],
  });
  expect(Object.isFrozen(view.selected)).toBe(true);
});
it("preserves stored unavailable choice without guessing Archived/deleted/denied", () => {
  const { value, session } = setup(),
    source = choices();
  source.lookup.items = source.lookup.items.filter((item) => item.categoryReference !== id(6));
  const view = deriveProductCategorySelectionView(session, value.baseline.draft, source, context);
  expect(view).toEqual({
    coverage: "Known",
    primaryCategoryReference: id(6),
    selected: [
      {
        categoryReference: id(6),
        primary: true,
        eligibility: "NotInEligibleChoices",
        name: null,
        lifecycle: null,
      },
    ],
  });
  expect(value.baseline.draft.categoryClassification.categoryReferences).toEqual([id(6)]);
  expect(JSON.stringify(view)).not.toContain("Archived");
  expect(() =>
    replaceProductDraftCategorySelection(
      session,
      value.baseline.draft,
      value.baseline.draft.categoryClassification,
      source,
      context,
    ),
  ).toThrow(expect.objectContaining({ code: "Invalid" }));
});
it("distinguishes unknown legacy from known explicit empty even with empty policy choices", () => {
  const { value } = setup(),
    draft = { ...value.baseline.draft } as Partial<typeof value.baseline.draft>;
  delete draft.categoryClassification;
  const session = createProductDraftEditingSession(
      { ...value, baseline: { ...value.baseline, classificationCoverage: "Unavailable", draft } },
      scope,
      Date.parse(at),
    ),
    source = choices();
  source.lookup.items = [];
  source.lookup.policy.allowedLifecycles = [];
  const unknown = deriveProductCategorySelectionView(session, draft, source, context);
  expect(unknown).toEqual({ coverage: "Unavailable", selected: null });
  expect(Object.hasOwn(unknown, "primaryCategoryReference")).toBe(false);
  const explicit = replaceProductDraftCategorySelection(
    session,
    draft,
    { categoryReferences: [], primaryCategoryReference: null },
    source,
    context,
  );
  expect(deriveProductCategorySelectionView(session, explicit, source, context)).toEqual({
    coverage: "Known",
    primaryCategoryReference: null,
    selected: [],
  });
  expect(Object.hasOwn(draft, "categoryClassification")).toBe(false);
});
it("changes only classification in full Draft and prepares original expected version", () => {
  const { value, session } = setup(),
    edited = replaceProductDraftCategorySelection(
      session,
      value.baseline.draft,
      { categoryReferences: [id(7)], primaryCategoryReference: id(7) },
      choices(),
      context,
    ),
    { categoryClassification, ...unchanged } = edited,
    { categoryClassification: old, ...original } = value.baseline.draft;
  expect(categoryClassification?.categoryReferences).toEqual([id(7)]);
  expect(old.categoryReferences).toEqual([id(6)]);
  expect(unchanged).toEqual(original);
  expect(Object.isFrozen(edited.optionBindings[0]?.defaultSelections)).toBe(true);
  const fetcher = vi.fn<typeof fetch>(),
    prepared = session.prepareSave(
      createProductCommandClient(fetcher),
      { operationReference: id(90), draft: edited },
      scope,
    );
  expect(prepared.command.expectedAggregateVersion).toBe(4);
  expect(prepared.command.draft.categoryClassification?.primaryCategoryReference).toBe(id(7));
  expect(prepared.command.draft.skus).toEqual(value.baseline.draft.skus);
  expect(fetcher).not.toHaveBeenCalled();
});
it.each(["parent", "brand", "store", "locale", "policy", "stale", "future", "clock"])(
  "fails lookup %s before changing Draft",
  (kind) => {
    const { value, session } = setup(),
      source = choices();
    let observedAt = Date.parse(at);
    if (kind === "parent") source.lookup.parentScreenId = "CAT-PRODUCT-CREATE";
    if (kind === "brand") source.scope.brandReference = id(99);
    if (kind === "store") source.scope.storeReference = id(99);
    if (kind === "locale") source.lookup.locale = "fr-CA";
    if (kind === "policy") delete (source.lookup as Partial<typeof source.lookup>).policy;
    if (kind === "stale") observedAt += 5001;
    if (kind === "future") observedAt -= 1;
    if (kind === "clock") observedAt = NaN;
    expect(() =>
      replaceProductDraftCategorySelection(
        session,
        value.baseline.draft,
        { categoryReferences: [], primaryCategoryReference: null },
        source,
        { ...context, observedAt },
      ),
    ).toThrow(expect.objectContaining({ code: kind === "stale" ? "Stale" : "Unavailable" }));
    expect(value.baseline.draft.categoryClassification.categoryReferences).toEqual([id(6)]);
  },
);
it.each(["brandReference", "storeReference", "productReference"] as const)(
  "requires new baseline after %s switch",
  (key) => {
    const { value, session } = setup();
    expect(() =>
      deriveProductCategorySelectionView(session, value.baseline.draft, choices(), {
        ...context,
        scope: { ...scope, [key]: id(99) },
      }),
    ).toThrow(expect.objectContaining({ code: "Stale" }));
  },
);
it("supports long editing baseline with a fresh current picker and rejects foreign SKU edited data", () => {
  const { value, session } = setup(),
    source = choices(),
    later = "2026-09-28T13:00:00.000Z";
  source.lookup.projection.asOfUtc = later;
  source.lookup.source.asOfUtc = later;
  expect(
    replaceProductDraftCategorySelection(
      session,
      value.baseline.draft,
      { categoryReferences: [id(7)], primaryCategoryReference: null },
      source,
      { ...context, observedAt: Date.parse(later) },
    ).categoryClassification?.primaryCategoryReference,
  ).toBeNull();
  const foreign = {
    ...value.baseline.draft,
    skus: value.baseline.draft.skus.map((sku) => ({ ...sku, productReference: id(99) })),
  };
  expect(() =>
    deriveProductCategorySelectionView(session, foreign, source, {
      ...context,
      observedAt: Date.parse(later),
    }),
  ).toThrow(expect.objectContaining({ code: "Invalid" }));
});
