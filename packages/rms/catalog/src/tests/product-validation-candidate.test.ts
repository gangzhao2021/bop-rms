import { expect, it, vi } from "vitest";
import {
  bindCatalogProductValidationCandidate,
  deriveCatalogProductPublicationContentIdentity,
} from "../index.js";
const at = "2026-09-30T06:00:00.000Z";
const id = (n: number) => "01902421-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const until = "2026-09-30T06:00:20.000Z",
  digest = "sha256:" + "a".repeat(64);
function policyFixture() {
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
          variantSelections: [],
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
  const brand = {
    tenantReference: id(6),
    brandReference: id(2),
    brandVersion: 1,
    configurationVersionReference: id(7),
    contentDigest: digest,
    currentPublicationReference: id(8),
    supportedLocales: ["en-CA", "fr-CA"],
    observedAt: at,
    validUntil: until,
    originalIntentDigest: digest,
  };
  const policy = {
    profile: "PublishingProductPublicationPolicyV1",
    tenantReference: id(6),
    brandReference: id(2),
    familyReference: id(9),
    policyReference: id(10),
    policyVersion: 1,
    scopeOrder: ["Store", "StoreGroup", "Region", "Brand", "Channel", "OrderType"],
    approvalPolicy: "Required",
    warningOverrideAllowed: false,
    requiredLocales: ["en-CA"],
    mediaRequirement: "Optional",
    effectiveFrom: at,
    effectiveUntil: until,
  };
  const binding = {
    ...deriveCatalogProductPublicationContentIdentity(aggregate),
    tenantReference: id(6),
    productReference: id(1),
    versionReference: id(4),
    expectedAggregateVersion: 1,
    originalIntentDigest: digest,
    observedAt: at,
    validUntil: until,
  };
  const { referenceConfiguration, ...minimal } = binding;
  void referenceConfiguration;
  return { aggregate, brand, policy, binding: minimal };
}

function fixture() {
  const { aggregate } = policyFixture(),
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const command = {
    purposeCode: "CATALOG_PRODUCT_VERSION_PUBLICATION",
    tenantReference: id(6),
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
      effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
      effectiveUntil: null,
    },
    scheduleReference: null,
    replacementVersionReference: null,
    successorDraftVersionReference: null,
    occurredAt: at,
    reasonCode: "SYNTHETIC_VALIDATE",
  };
  return { aggregate, command };
}
it("binds detached complete content to one original Validate without granting validation", () => {
  const f = fixture(),
    result = bindCatalogProductValidationCandidate(f.command, f.aggregate, at);
  expect(result.aggregate).toEqual(f.aggregate);
  expect(result.aggregate).not.toBe(f.aggregate);
  expect(Object.isFrozen(result.aggregate.draft)).toBe(true);
  expect(result).toMatchObject({
    completeContent: "Present",
    validUntil: "2026-09-30T06:00:30.000Z",
    publicationHead: "NotEvaluated",
    publishValidation: "Incomplete",
    referenceEligibility: "NotEvaluated",
    eligibility: "NotEvaluated",
  });
  expect(result.originalIntentDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it("preserves legacy absence instead of synthesizing complete empty content", () => {
  const f = fixture(),
    { editorContent, ...draft } = f.aggregate.draft;
  void editorContent;
  const aggregate = { ...f.aggregate, draft },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const r = bindCatalogProductValidationCandidate(
    {
      ...f.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    },
    aggregate,
    at,
  );
  expect(r.completeContent).toBe("Unavailable");
  expect(Object.hasOwn(r.aggregate.draft, "editorContent")).toBe(false);
});
it.each([
  { brandReference: id(99) },
  { productReference: id(99) },
  { versionReference: id(99) },
  { expectedProductAggregateVersion: 2 },
  { contentDigest: "sha256:" + "a".repeat(64) },
  { configurationDigest: "sha256:" + "b".repeat(64) },
  { action: "SubmitReview" },
  { actorKind: "System" },
  { occurredAt: "2026-09-30T06:00:01.000Z" },
])("refuses current identity/action drift %j", (patch) => {
  const f = fixture();
  expect(() =>
    bindCatalogProductValidationCandidate({ ...f.command, ...patch }, f.aggregate, at),
  ).toThrow();
});
it("refuses edited content at the same root with the old command identity", () => {
  const f = fixture();
  expect(() =>
    bindCatalogProductValidationCandidate(
      f.command,
      { ...f.aggregate, draft: { ...f.aggregate.draft, localizedNames: { "en-CA": "Changed" } } },
      at,
    ),
  ).toThrow();
});
it("does not execute supplied command or aggregate accessors", () => {
  const f = fixture(),
    getter = vi.fn();
  Object.defineProperty(f.aggregate.draft, "localizedNames", { get: getter });
  expect(() => bindCatalogProductValidationCandidate(f.command, f.aggregate, at)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("does not silently ignore injected full-validation evidence", () => {
  const f = fixture();
  expect(() =>
    bindCatalogProductValidationCandidate(
      { ...f.command, validation: { decision: "Pass" } },
      f.aggregate,
      at,
    ),
  ).toThrow();
});

// Membership is a necessary condition, never target-scope/readiness qualification.
it.each(["Draft", "Active", "Suspended", "Discontinued", "Archived"] as const)(
  "derives actual %s SKU membership without granting publishability",
  (lifecycle) => {
    const f = fixture();
    const sku = f.aggregate.draft.skus[0];
    if (!sku) throw new Error("missing synthetic SKU");
    sku.lifecycle = lifecycle;
    const identity = deriveCatalogProductPublicationContentIdentity(f.aggregate),
      result = bindCatalogProductValidationCandidate(
        {
          ...f.command,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
        },
        f.aggregate,
        at,
      );
    expect(result.skuPrerequisite).toBe(
      lifecycle === "Active" ? "ActiveMemberPresent" : "NoActiveMember",
    );
    expect(result.publishValidation).toBe("Incomplete");
    expect(result.eligibility).toBe("NotEvaluated");
  },
);
it.each(["PreparedFood", "NonAlcoholicBeverage"] as const)(
  "does not invent a no-SKU waiver for %s",
  (productType) => {
    const f = fixture();
    f.aggregate.productType = productType;
    f.aggregate.draft.skus = [];
    const identity = deriveCatalogProductPublicationContentIdentity(f.aggregate),
      result = bindCatalogProductValidationCandidate(
        {
          ...f.command,
          contentDigest: identity.contentDigest,
          configurationDigest: identity.configurationDigest,
        },
        f.aggregate,
        at,
      );
    expect(result.skuPrerequisite).toBe("NoActiveMember");
  },
);

it("observes mixed owning lifecycle without qualifying an incomplete legacy Variant candidate", () => {
  const f = fixture(),
    sku = f.aggregate.draft.skus[0];
  if (!sku) throw new Error("missing synthetic SKU");
  const { editorContent, ...draft } = f.aggregate.draft;
  void editorContent;
  const aggregate = {
    ...f.aggregate,
    draft: {
      ...draft,
      skus: [
        sku,
        {
          ...sku,
          skuReference: id(55),
          skuCode: "TWO",
          lifecycle: "Active",
          variantSelections: [{ dimensionReference: id(80), valueReference: id(81) }],
        },
      ],
    },
  };
  const identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    result = bindCatalogProductValidationCandidate(
      {
        ...f.command,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      },
      aggregate,
      at,
    );
  expect(result.skuPrerequisite).toBe("ActiveMemberPresent");
  expect(result.completeContent).toBe("Unavailable");
  expect(result.publishValidation).toBe("Incomplete");
});

it.each(["Valid", "Invalid", "NotGenerated"] as const)(
  "derives explicit %s Variant prerequisite without mapping qualification",
  (disposition) => {
    const f = fixture(),
      dimensionReference = id(70),
      valueReference = id(71),
      selections = [{ dimensionReference, valueReference }],
      sku = f.aggregate.draft.skus[0];
    if (!sku) throw new Error("missing synthetic SKU");
    const aggregate = {
        ...f.aggregate,
        draft: {
          ...f.aggregate.draft,
          skus: disposition === "Valid" ? [{ ...sku, variantSelections: selections }] : [],
          editorContent: {
            ...f.aggregate.draft.editorContent,
            variantDimensions: [
              {
                dimensionReference,
                code: "SIZE",
                localizedNames: { "en-CA": "Synthetic size" },
                sortOrder: 0,
                selectionRequirement: "Required",
                values: [
                  {
                    valueReference,
                    code: "ONE",
                    localizedNames: { "en-CA": "Synthetic one" },
                    sortOrder: 0,
                    attributeReference: null,
                    mediaReference: null,
                  },
                ],
              },
            ],
            variantCombinations: [
              {
                selections,
                disposition,
                skuReference: disposition === "Valid" ? sku.skuReference : null,
              },
            ],
          },
        },
      },
      identity = deriveCatalogProductPublicationContentIdentity(aggregate);
    const result = bindCatalogProductValidationCandidate(
      {
        ...f.command,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      },
      aggregate,
      at,
    );
    expect(result.variantMappingPrerequisite).toBe(
      disposition === "NotGenerated"
        ? "UnmappedCombinationPresent"
        : "NoExplicitUnmappedCombination",
    );
    expect(result.publishValidation).toBe("Incomplete");
    expect(result.eligibility).toBe("NotEvaluated");
  },
);
it("missing legacy content remains unavailable, never an empty known mapping", () => {
  const f = fixture(),
    { editorContent, ...draft } = f.aggregate.draft;
  void editorContent;
  const aggregate = { ...f.aggregate, draft },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate);
  const result = bindCatalogProductValidationCandidate(
    {
      ...f.command,
      contentDigest: identity.contentDigest,
      configurationDigest: identity.configurationDigest,
    },
    aggregate,
    at,
  );
  expect(result.variantMappingPrerequisite).toBe("Unavailable");
  expect(result.optionSelectionPrerequisite).toBe("Unavailable");
});
it.each([undefined, "Generated", "Unknown"])(
  "refuses unknown stored Variant disposition %s before deriving a prerequisite",
  (disposition) => {
    const f = fixture(),
      aggregate = {
        ...f.aggregate,
        draft: {
          ...f.aggregate.draft,
          editorContent: {
            ...f.aggregate.draft.editorContent,
            variantCombinations: [
              { selections: [], disposition: "NotGenerated", skuReference: null },
            ],
          },
        },
      },
      identity = deriveCatalogProductPublicationContentIdentity(aggregate),
      command = {
        ...f.command,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      };
    expect(
      bindCatalogProductValidationCandidate(command, aggregate, at).variantMappingPrerequisite,
    ).toBe("UnmappedCombinationPresent");
    Object.assign(aggregate.draft.editorContent.variantCombinations[0] ?? {}, { disposition });
    expect(() => deriveCatalogProductPublicationContentIdentity(aggregate)).toThrow();
    expect(() => bindCatalogProductValidationCandidate(command, aggregate, at)).toThrow();
  },
);
it.each([
  { name: "empty positive minimum", quantities: [], min: 1, max: 1, violated: true },
  { name: "below quantity minimum", quantities: [1, 2], min: 4, max: null, violated: true },
  { name: "above quantity maximum", quantities: [1, 2], min: null, max: 2, violated: true },
  { name: "exact quantity edges", quantities: [1, 2], min: 3, max: 3, violated: false },
  { name: "unknown source bounds", quantities: [], min: null, max: null, violated: false },
  { name: "empty zero bounds", quantities: [], min: 0, max: 0, violated: false },
  { name: "repeated units", quantities: [3], min: 3, max: 3, violated: false },
  {
    name: "later violated binding",
    quantities: [2],
    min: null,
    max: 1,
    violated: true,
    priorNeutral: true,
  },
  {
    name: "sum above safe integer",
    quantities: [Number.MAX_SAFE_INTEGER, 1],
    min: null,
    max: Number.MAX_SAFE_INTEGER,
    violated: true,
  },
])("derives explicit default bounds: $name without Option qualification", (row) => {
  const f = fixture(),
    enabled = row.quantities.map((_q, i) => id(100 + i)),
    binding = {
      bindingReference: id(90),
      optionSetReference: id(91),
      optionSetVersionReference: id(92),
      purpose: "CUSTOMIZATION",
      sortOrder: 0,
      enabledOptionReferences: enabled,
      defaultSelections: row.quantities.map((quantity, i) => ({
        optionReference: enabled[i],
        quantity,
      })),
      minimumSelectionOverride: row.min,
      maximumSelectionOverride: row.max,
      includedSkuReferences: [],
      excludedSkuReferences: [],
      channelCodes: [],
      storeOverrideAllowed: false,
    },
    bindings =
      "priorNeutral" in row
        ? [
            {
              ...binding,
              bindingReference: id(89),
              optionSetReference: id(93),
              optionSetVersionReference: id(94),
              sortOrder: 1,
              defaultSelections: [],
              minimumSelectionOverride: 0,
              maximumSelectionOverride: null,
            },
            binding,
          ]
        : [binding],
    aggregate = {
      ...f.aggregate,
      draft: {
        ...f.aggregate.draft,
        optionBindings: bindings,
        editorContent: {
          ...f.aggregate.draft.editorContent,
          optionRules: bindings.map((entry) => ({
            bindingReference: entry.bindingReference,
            versionResolution: "Pinned",
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          })),
        },
      },
    },
    identity = deriveCatalogProductPublicationContentIdentity(aggregate),
    result = bindCatalogProductValidationCandidate(
      {
        ...f.command,
        contentDigest: identity.contentDigest,
        configurationDigest: identity.configurationDigest,
      },
      aggregate,
      at,
    );
  expect(result.optionSelectionPrerequisite).toBe(
    row.violated ? "ExplicitDefaultBoundsViolated" : "NoExplicitDefaultBoundsViolation",
  );
  expect(result.publishValidation).toBe("Incomplete");
  expect(result.referenceEligibility).toBe("NotEvaluated");
});
