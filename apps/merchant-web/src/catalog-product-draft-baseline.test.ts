import { expect, it, vi } from "vitest";
import {
  parseCatalogProductDraftBaseline,
  parseProductDraftBaselineView,
  createProductDraftEditingSession,
  type ProductDraftBaselineExpectedScope,
} from "./catalog-product-draft-baseline.js";
import { createProductCommandClient } from "./catalog-product-command-client.js";
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
const expected: ProductDraftBaselineExpectedScope = {
  brandReference: id(2),
  storeReference: id(5),
  productReference: id(1),
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
const make = () => parseProductDraftBaselineView(fixture(), expected, Date.parse(at));
function first(value: ReturnType<typeof fixture>) {
  const sku = value.baseline.draft.skus[0];
  if (!sku) throw new Error("Synthetic SKU missing");
  return sku;
}
it("decodes complete persisted Draft with immutable SKU/Option/classification data", () => {
  const view = make();
  expect(view.baseline.draft).toEqual(fixture().baseline.draft);
  expect(view.baseline.draft.skus).toHaveLength(2);
  expect(view.baseline.draft.optionBindings[0]?.defaultSelections[0]?.quantity).toBe(2);
  expect(Object.isFrozen(view.baseline.draft.skus[0]?.variantSelections)).toBe(true);
  expect(Object.hasOwn(view.baseline, "createdByActorReference")).toBe(false);
});
it.each([
  "outer",
  "scope",
  "brand",
  "store",
  "product",
  "projection",
  "partial",
  "coverage",
  "root-time",
  "draft-time",
  "sku-time",
  "sku-brand",
  "sku-product",
  "sku-duplicate",
  "sku-variants",
  "option-graph",
  "category-primary",
  "names",
  "quantity",
  "root-actor",
  "version",
  "sparse",
])("rejects malformed baseline %s", (kind) => {
  const value = fixture();
  const draft = value.baseline.draft;
  if (kind === "outer") Object.assign(value, { currentPermission: "Allow" });
  if (kind === "scope") Object.assign(value.scope, { actorReference: id(3) });
  if (kind === "brand") value.baseline.brandReference = id(99);
  if (kind === "store") value.scope.storeReference = id(99);
  if (kind === "product") value.baseline.productReference = id(99);
  if (kind === "projection") value.baseline.projection.name = "catalog_product_editor_v1";
  if (kind === "partial") value.baseline.projection.partial = false;
  if (kind === "coverage") value.baseline.classificationCoverage = "Unavailable";
  if (kind === "root-time") value.baseline.updatedAt = "2026-09-28T12:00:00.001Z";
  if (kind === "draft-time") draft.updatedAt = "2026-09-28T12:00:00.001Z";
  if (kind === "sku-time") first(value).createdAt = "2026-09-28T12:00:00.001Z";
  if (kind === "sku-brand") first(value).brandReference = id(99);
  if (kind === "sku-product") first(value).productReference = id(99);
  if (kind === "sku-duplicate") draft.skus.push({ ...first(value) });
  if (kind === "sku-variants") {
    const other = draft.skus[1];
    if (!other) throw new Error("Synthetic SKU missing");
    other.variantSelections = first(value).variantSelections;
  }
  if (kind === "option-graph") {
    const binding = draft.optionBindings[0];
    if (!binding) throw new Error("Synthetic binding missing");
    binding.includedSkuReferences = [id(99)];
  }
  if (kind === "category-primary") draft.categoryClassification.primaryCategoryReference = id(99);
  if (kind === "names") draft.localizedNames = { "en-CA": "  Two  spaces " };
  if (kind === "quantity") first(value).unitQuantity = "1.00";
  if (kind === "root-actor") Object.assign(value.baseline, { createdByActorReference: id(3) });
  if (kind === "version") value.baseline.aggregateVersion = 2147483648;
  if (kind === "sparse") draft.skus = new Array(2);
  expect(() => parseProductDraftBaselineView(value, expected, Date.parse(at))).toThrow();
});
it("does not evaluate getter or cycle input", () => {
  const getter = vi.fn(() => fixture().baseline),
    value = { scope: fixture().scope };
  Object.defineProperty(value, "baseline", { enumerable: true, get: getter });
  expect(() => parseProductDraftBaselineView(value, expected, Date.parse(at))).toThrow();
  expect(getter).not.toHaveBeenCalled();
  const cycle = fixture();
  Object.assign(cycle.baseline, { cycle });
  expect(() => parseProductDraftBaselineView(cycle, expected, Date.parse(at))).toThrow();
});
it("checks source freshness at receipt including exact5sec boundary", () => {
  expect(
    parseProductDraftBaselineView(fixture(), expected, Date.parse(at) + 5000).baseline
      .aggregateVersion,
  ).toBe(4);
  expect(() => parseProductDraftBaselineView(fixture(), expected, Date.parse(at) + 5001)).toThrow(
    expect.objectContaining({ code: "Stale" }),
  );
  expect(() => parseProductDraftBaselineView(fixture(), expected, Date.parse(at) - 1)).toThrow(
    expect.objectContaining({ code: "Unavailable" }),
  );
  expect(() => parseProductDraftBaselineView(fixture(), expected, NaN)).toThrow();
});
it("supports larger legitimate read without reusing smaller command copy budget", () => {
  const value = fixture(),
    base = first(value);
  value.baseline.draft.optionBindings = [];
  value.baseline.draft.skus = Array.from({ length: 700 }, (_, n) => ({
    ...base,
    skuReference: id(100 + n),
    skuCode: "SKU_" + n,
    variantSelections: [{ dimensionReference: id(20), valueReference: id(1000 + n) }],
  }));
  expect(
    parseProductDraftBaselineView(value, expected, Date.parse(at)).baseline.draft.skus,
  ).toHaveLength(700);
  const session = createProductDraftEditingSession(value, expected, Date.parse(at));
  expect(() =>
    session.prepareSave(
      createProductCommandClient(),
      { operationReference: id(90), draft: value.baseline.draft },
      expected,
    ),
  ).toThrow(expect.objectContaining({ code: "Invalid" }));
});
it("keeps canonical key order independent and rejects property budget overflow", () => {
  const value = fixture();
  value.baseline.draft.localizedNames = {
    "fr-CA": "Choix synthétique",
    "en-CA": "Synthetic draft",
  };
  expect(parseCatalogProductDraftBaseline(value.baseline).draft.localizedNames).toEqual(
    value.baseline.draft.localizedNames,
  );
  const large = fixture();
  Object.assign(
    large.baseline.draft.localizedNames,
    Object.fromEntries(Array.from({ length: 129 }, (_, n) => ["unknown" + n, "Synthetic"])),
  );
  expect(() => parseCatalogProductDraftBaseline(large.baseline)).toThrow();
});
it("prepares fixed Product/current expected version/full Draft without mutation or network", () => {
  const value = fixture(),
    session = createProductDraftEditingSession(value, expected, Date.parse(at)),
    fetcher = vi.fn<typeof fetch>(),
    client = createProductCommandClient(fetcher),
    edited = { ...value.baseline.draft, localizedNames: { "en-CA": "Edited synthetic draft" } };
  const prepared = session.prepareSave(
    client,
    { operationReference: id(90), draft: edited },
    expected,
  );
  expect(prepared.command).toMatchObject({
    productReference: id(1),
    expectedAggregateVersion: 4,
    operationReference: id(90),
  });
  expect(prepared.command.draft.optionBindings).toEqual(edited.optionBindings);
  expect(prepared.command.draft.skus).toEqual(edited.skus);
  expect(prepared.command.draft.categoryClassification).toEqual(edited.categoryClassification);
  expect(prepared.scope).toEqual({ brandReference: id(2), storeReference: id(5) });
  expect(session.view.baseline.draft.localizedNames["en-CA"]).toBe("Synthetic draft");
  expect(fetcher).not.toHaveBeenCalled();
});
it("retains original expected version for long forms and does not silently rebase", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(Date.parse(at));
    const value = fixture(),
      session = createProductDraftEditingSession(value, expected, Date.now());
    vi.setSystemTime(Date.parse(at) + 3600000);
    value.baseline.aggregateVersion = 99;
    const prepared = session.prepareSave(
      createProductCommandClient(),
      { operationReference: id(90), draft: fixture().baseline.draft },
      expected,
    );
    expect(prepared.command.expectedAggregateVersion).toBe(4);
    expect(session.observedAt).toBe(Date.parse(at));
  } finally {
    vi.useRealTimers();
  }
});
it.each(["brandReference", "storeReference", "productReference"] as const)(
  "requires new baseline after %s switch before preparation",
  (key) => {
    const value = fixture(),
      session = createProductDraftEditingSession(value, expected, Date.parse(at)),
      prepareDraft = vi.fn();
    expect(() =>
      session.prepareSave(
        { prepareDraft } as Pick<ReturnType<typeof createProductCommandClient>, "prepareDraft">,
        { operationReference: id(90), draft: value.baseline.draft },
        { ...expected, [key]: id(99) },
      ),
    ).toThrow(expect.objectContaining({ code: "Stale" }));
    expect(prepareDraft).not.toHaveBeenCalled();
  },
);
it("preserves unknown classification and allows an explicit empty set without fabricated default", () => {
  const value = fixture(),
    draft = { ...value.baseline.draft } as Partial<typeof value.baseline.draft>;
  delete draft.categoryClassification;
  const legacy = {
    ...value,
    baseline: { ...value.baseline, classificationCoverage: "Unavailable", draft },
  };
  const session = createProductDraftEditingSession(legacy, expected, Date.parse(at)),
    client = createProductCommandClient();
  const absent = session.prepareSave(client, { operationReference: id(90), draft }, expected);
  expect(Object.hasOwn(absent.command.draft, "categoryClassification")).toBe(false);
  const empty = session.prepareSave(
    client,
    {
      operationReference: id(91),
      draft: {
        ...draft,
        categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      },
    },
    expected,
  );
  expect(empty.command.draft.categoryClassification?.categoryReferences).toEqual([]);
});
it.each(["drop-classification", "version", "created", "caller-version", "operation"])(
  "rejects edited intent drift %s before client fetch",
  (kind) => {
    const value = fixture(),
      session = createProductDraftEditingSession(value, expected, Date.parse(at)),
      draft = { ...value.baseline.draft } as Partial<typeof value.baseline.draft>,
      input: Record<string, unknown> = { operationReference: id(90), draft };
    if (kind === "drop-classification") delete draft.categoryClassification;
    if (kind === "version") draft.versionReference = id(99);
    if (kind === "created") draft.createdAt = "2026-09-28T11:59:59.000Z";
    if (kind === "caller-version") input.expectedAggregateVersion = 1;
    if (kind === "operation") input.operationReference = "caller-operation";
    const fetcher = vi.fn<typeof fetch>();
    expect(() =>
      session.prepareSave(createProductCommandClient(fetcher), input, expected),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  },
);
