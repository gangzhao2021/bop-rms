import {
  buildRecipeReferenceSourceSnapshot,
  type RecipeReferenceSourceRequest,
  type RecipeCatalogReferenceTarget,
} from "../index.js";
export const recipeMatchId = (n: number) =>
  `01902409-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const id = recipeMatchId;
export const recipeMatchAt = "2026-09-29T12:00:00.000Z",
  recipeMatchDigest = "sha256:" + "a".repeat(64);
export const recipeMatchRequest: RecipeReferenceSourceRequest = {
  purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(4),
  catalogIntentDigest: recipeMatchDigest,
};
export function recipeMatchTarget(sku = 6, option = 80): RecipeCatalogReferenceTarget {
  return {
    mappingProfile: "KnownDraftBindings",
    catalogConfigurationDigest: recipeMatchDigest,
    productReference: id(3),
    versionReference: id(5),
    skuReference: null,
    skuReferences: [id(sku)],
    bindings: [
      {
        bindingReference: id(20),
        enabledOptionReferences: [id(option)],
        includedSkuReferences: [id(sku)],
        excludedSkuReferences: [],
      },
    ],
  };
}
export function recipeMatchRaw() {
  const period = {
      effectiveFrom: "2027-01-01T00:00:00.000Z",
      effectiveUntil: null as string | null,
    },
    parent = { recipeReference: id(10), brandReference: id(1) };
  const bindings = [
    {
      ...parent,
      recipeVersionReference: id(11),
      bindingReference: id(60),
      skuReference: id(6),
      storeReference: id(99) as string | null,
      optionBindingReference: null as string | null,
      ...period,
      precise: true,
    },
    {
      ...parent,
      recipeVersionReference: id(12),
      bindingReference: id(61),
      skuReference: id(7),
      storeReference: null as string | null,
      optionBindingReference: id(20) as string | null,
      ...period,
      precise: true,
    },
    {
      ...parent,
      recipeVersionReference: id(12),
      bindingReference: id(62),
      skuReference: id(6),
      storeReference: null as string | null,
      optionBindingReference: id(29) as string | null,
      ...period,
      precise: true,
    },
  ];
  const modifiers = [
    {
      rule: 40,
      ruleVersion: 41,
      version: 1,
      recipeVersion: 11,
      option: 80,
      binding: 20,
      lifecycle: "Draft",
    },
    {
      rule: 40,
      ruleVersion: 42,
      version: 2,
      recipeVersion: 11,
      option: 80,
      binding: 20,
      lifecycle: "Archived",
    },
    {
      rule: 45,
      ruleVersion: 45,
      version: 1,
      recipeVersion: 12,
      option: 81,
      binding: 20,
      lifecycle: "Draft",
    },
    {
      rule: 46,
      ruleVersion: 46,
      version: 1,
      recipeVersion: 11,
      option: 82,
      binding: 20,
      lifecycle: "Draft",
    },
    {
      rule: 49,
      ruleVersion: 49,
      version: 1,
      recipeVersion: 12,
      option: 80,
      binding: 29,
      lifecycle: "Draft",
    },
  ].map((m) => ({
    ...parent,
    recipeVersionReference: id(m.recipeVersion),
    ruleReference: id(m.rule),
    ruleVersionReference: id(m.ruleVersion),
    bindingReference: id(m.binding),
    optionReference: id(m.option),
    version: m.version,
    selectedQuantity: 1,
    lifecycle: m.lifecycle,
    ruleDigest: recipeMatchDigest,
    ...period,
    occurredAt: recipeMatchAt,
    precise: true,
  }));
  return {
    generation: "7",
    bindingCount: String(bindings.length),
    observedAt: recipeMatchAt,
    counts: {
      recipes: "1",
      versions: "2",
      bindings: String(bindings.length),
      modifiers: String(modifiers.length),
    },
    recipes: [
      {
        ...parent,
        aggregateVersion: 3,
        currentVersionReference: id(11) as string | null,
        updatedAt: recipeMatchAt,
        precise: true,
      },
    ],
    versions: [11, 12].map((n, i) => ({
      ...parent,
      recipeVersionReference: id(n),
      versionNumber: i + 1,
      lifecycle: i === 0 ? "Draft" : "Archived",
      snapshotDigest: recipeMatchDigest,
      ...period,
      timeZone: "America/Toronto",
      createdAt: recipeMatchAt,
      precise: true,
    })),
    bindings,
    modifiers,
  };
}
export const recipeMatchSource = (
  request = recipeMatchRequest,
  raw = recipeMatchRaw(),
  now = recipeMatchAt,
) => buildRecipeReferenceSourceSnapshot(raw, request, now);
