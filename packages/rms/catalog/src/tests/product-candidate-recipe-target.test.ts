import { expect, it, vi } from "vitest";
import {
  deriveCatalogProductCandidateRecipeTarget,
  deriveCatalogProductPublicationContentIdentity,
} from "../index.js";
const at = "2026-09-30T06:00:00.000Z";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const aggregate = {
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
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [
        {
          skuReference: id(5),
          productReference: id(1),
          brandReference: id(2),
          skuCode: "ONE",
          lifecycle: "Draft",
          localizedNames: { "en-CA": "Synthetic SKU" },
          variantSelections: [] as { dimensionReference: string; valueReference: string }[],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(3),
        },
      ],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  };

  const first = aggregate.draft.skus[0];
  if (!first) throw new Error("missing synthetic SKU");
  aggregate.draft.skus.push({
    ...first,
    skuReference: id(6),
    skuCode: "TWO",
    variantSelections: [{ dimensionReference: id(70), valueReference: id(71) }],
  } as typeof first);
  const binding = {
    bindingReference: id(20),
    optionSetReference: id(21),
    optionSetVersionReference: id(22),
    purpose: "CUSTOMIZATION",
    sortOrder: 0,
    enabledOptionReferences: [id(81), id(80)],
    defaultSelections: [],
    minimumSelectionOverride: null,
    maximumSelectionOverride: null,
    includedSkuReferences: [id(6)],
    excludedSkuReferences: [id(5)],
    channelCodes: [],
    storeOverrideAllowed: false,
  };
  const full = {
    ...aggregate,
    draft: {
      ...aggregate.draft,
      optionBindings: [binding],
      editorContent: {
        ...aggregate.draft.editorContent,
        variantDimensions: [
          {
            dimensionReference: id(70),
            code: "SIZE",
            localizedNames: { "en-CA": "Size" },
            sortOrder: 0,
            selectionRequirement: "Optional",
            values: [
              {
                valueReference: id(71),
                code: "LARGE",
                localizedNames: { "en-CA": "Large" },
                sortOrder: 0,
                attributeReference: null,
                mediaReference: null,
              },
            ],
          },
        ],
        variantCombinations: [
          { selections: [], disposition: "Valid", skuReference: id(5) },
          {
            selections: [{ dimensionReference: id(70), valueReference: id(71) }],
            disposition: "Valid",
            skuReference: id(6),
          },
        ],
        optionRules: [
          {
            bindingReference: id(20),
            versionResolution: "Pinned",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          },
        ],
      },
    },
  };
  const identity = deriveCatalogProductPublicationContentIdentity(full);
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(9),
    brandReference: id(2),
    actorReference: id(3),
    actorKind: "User",
    operationReference: id(40),
    productReference: id(1),
    versionReference: id(4),
    expectedProductAggregateVersion: 1,
    expectedPublicationVersion: 0,
    action: "Validate",
    contentDigest: identity.contentDigest,
    configurationDigest: identity.configurationDigest,
    scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: "2026-10-01T06:00:00.000Z",
        localDateTime: "2026-10-01T06:00:00.000",
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_VALIDATE",
  };
  return { aggregate: full, command };
}

it("derives entire current candidate membership with deterministic detached collections", () => {
  const f = fixture(),
    target = deriveCatalogProductCandidateRecipeTarget(f.command, f.aggregate, at);
  expect(target.skuReference).toBe(null);
  expect(target.skuReferences).toEqual([id(5), id(6)]);
  expect(target.catalogConfigurationDigest).toBe(f.command.configurationDigest);
  expect(target.bindings).toEqual([
    {
      bindingReference: id(20),
      enabledOptionReferences: [id(80), id(81)],
      includedSkuReferences: [id(6)],
      excludedSkuReferences: [id(5)],
    },
  ]);
  expect(Object.isFrozen(target)).toBe(true);
  expect(Object.isFrozen(target.bindings[0])).toBe(true);
  f.aggregate.draft.optionBindings[0]?.enabledOptionReferences.push(id(82));
  expect(target.bindings[0]?.enabledOptionReferences).toEqual([id(80), id(81)]);
  expect(target).not.toHaveProperty("eligibility");
  expect(target).not.toHaveProperty("aggregate");
});
it("preserves empty whole graph as membership, never an executable Recipe", () => {
  const f = fixture(),
    aggregate = {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        skus: [],
        optionBindings: [],
        editorContent: {
          ...f.aggregate.draft.editorContent,
          variantDimensions: [],
          variantCombinations: [],
          optionRules: [],
        },
      },
    };
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const target = deriveCatalogProductCandidateRecipeTarget(
    {
      ...f.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    },
    aggregate,
    at,
  );
  expect(target.skuReferences).toEqual([]);
  expect(target.bindings).toEqual([]);
});
it("sorts membership while retaining the exact owning order-sensitive configuration identity", () => {
  const f = fixture(),
    a = deriveCatalogProductCandidateRecipeTarget(f.command, f.aggregate, at);
  f.aggregate.draft.skus.reverse();
  f.aggregate.draft.optionBindings[0]?.enabledOptionReferences.reverse();
  const identity = deriveCatalogProductPublicationContentIdentity(f.aggregate);
  const b = deriveCatalogProductCandidateRecipeTarget(
    {
      ...f.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    },
    f.aggregate,
    at,
  );
  const { catalogConfigurationDigest: before, ...beforeMembership } = a,
    { catalogConfigurationDigest: after, ...afterMembership } = b;
  expect(afterMembership).toEqual(beforeMembership);
  expect(after).toBe(identity.configurationDigest);
  expect(after).not.toBe(before);
});
it.each([
  { action: "SubmitReview" },
  { actorKind: "System" },
  { brandReference: id(99) },
  { versionReference: id(99) },
  { expectedProductAggregateVersion: 2 },
  { configurationDigest: "sha256:" + "f".repeat(64) },
  { skuReference: id(5) },
])("refuses altered Validate identity/selector %j", (patch) => {
  const f = fixture();
  expect(() =>
    deriveCatalogProductCandidateRecipeTarget({ ...f.command, ...patch }, f.aggregate, at),
  ).toThrow();
});
it("rejects modified option membership with unchanged Validate identity", () => {
  const f = fixture();
  f.aggregate.draft.optionBindings[0]?.enabledOptionReferences.push(id(82));
  expect(() => deriveCatalogProductCandidateRecipeTarget(f.command, f.aggregate, at)).toThrow();
});
it.each(["sparse", "accessor", "extra"])(
  "refuses malformed collections without invoking accessors: %s",
  (mode) => {
    const f = fixture(),
      getter = vi.fn(),
      values = f.aggregate.draft.skus;
    if (mode === "sparse") delete values[0];
    if (mode === "accessor") Object.defineProperty(values, "0", { get: getter });
    if (mode === "extra") Object.defineProperty(values, "ready", { value: true });
    expect(() => deriveCatalogProductCandidateRecipeTarget(f.command, f.aggregate, at)).toThrow();
    expect(getter).not.toHaveBeenCalled();
  },
);
