import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  parseCatalogReference,
  parseProductLifecycleReviewRequest,
  parseProductCurrentReferenceHistoryPair,
  type ProductLifecycleReviewRequest,
  type RecordedProductReferenceConfiguration,
} from "@rms/catalog";
import {
  parseRecipeReferenceSourceSnapshot,
  parseRecipeInventoryReferenceSnapshot,
  matchRecipeCatalogReferenceGraphs,
  matchRecipeInventoryReferenceRoots,
  type RecipeInventoryReachableRequirement,
} from "@rms/recipe";
import { parseInventorySkuMappingReferenceSnapshot } from "@rms/inventory";
const fail = (): never => {
  throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
};
const hash = (v: unknown) => "sha256:" + sha256Hex(canonicalizeRfc8785(v));
/** Reference-only composition. Cross-Domain joins use public parsed snapshots,
 * operation UUIDs resolve only through Inventory's owning recorded association.
 * It supplies no source authority, stock quantity or active recipe consumption. */
export function composeMerchantProductRecipeInventoryReferenceMatches(input: {
  readonly tenantReference: string;
  readonly request: ProductLifecycleReviewRequest;
  readonly catalogCurrent: unknown;
  readonly catalogHistory: unknown;
  readonly recipeSource: unknown;
  readonly recipeInventorySource: unknown;
  readonly inventorySource: unknown;
  readonly now: string;
}) {
  try {
    const request = parseProductLifecycleReviewRequest(input.request),
      tenant = parseCatalogReference(input.tenantReference),
      intent = hash(request),
      pair = parseProductCurrentReferenceHistoryPair(
        input.catalogCurrent,
        input.catalogHistory,
        request,
        input.now,
      ),
      common = {
        brandReference: request.brandReference,
        actorReference: request.actorReference,
        operationReference: request.operationReference,
        catalogIntentDigest: intent,
      },
      recipeRequest = { purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const, ...common },
      recipeInventoryRequest = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_RECIPE_SOURCE_READ" as const,
        ...common,
      },
      inventoryRequest = {
        purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
        tenantReference: tenant,
        ...common,
      },
      bindings = parseRecipeReferenceSourceSnapshot(input.recipeSource, recipeRequest, input.now),
      recipe = parseRecipeInventoryReferenceSnapshot(
        input.recipeInventorySource,
        recipeInventoryRequest,
        input.now,
      ),
      inventory = parseInventorySkuMappingReferenceSnapshot(
        input.inventorySource,
        inventoryRequest,
        input.now,
      );
    if (
      bindings.generation !== recipe.generation ||
      hash(bindings.recipes) !== hash(recipe.recipes) ||
      hash(bindings.versions) !== hash(recipe.versions)
    )
      return fail();
    const bindingModifiers = bindings.modifiers.map((m) => {
        const { selectedQuantity, ...facts } = m;
        void selectedQuantity;
        return facts;
      }),
      ingredientModifiers = recipe.modifiers.map((m) => {
        const { changeCount, ...facts } = m;
        void changeCount;
        return facts;
      });
    if (hash(bindingModifiers) !== hash(ingredientModifiers)) return fail();
    const currentConfiguration: RecordedProductReferenceConfiguration = {
      versionReference: pair.current.versionReference,
      skuReferences: pair.current.skuReferences,
      categoryCoverage: pair.current.categoryCoverage,
      categoryReferences: pair.current.categoryReferences,
      primaryCategoryReference: pair.current.primaryCategoryReference,
      taxClassificationReference: pair.current.taxClassificationReference,
      bindings: pair.current.bindings,
    };
    const configurations = [currentConfiguration, ...pair.recorded.configurations];
    const catalogMatches = matchRecipeCatalogReferenceGraphs({
      request: recipeRequest,
      source: bindings,
      now: input.now,
      targets: configurations.map((c) => ({
        mappingProfile: "KnownDraftBindings",
        catalogConfigurationDigest: hash(c),
        productReference: request.productReference,
        versionReference: c.versionReference,
        skuReference: request.skuReference,
        skuReferences: c.skuReferences,
        bindings: c.bindings.map((b) => ({
          bindingReference: b.bindingReference,
          enabledOptionReferences: b.enabledOptionReferences,
          includedSkuReferences: b.includedSkuReferences,
          excludedSkuReferences: b.excludedSkuReferences,
        })),
      })),
    });
    const roots = catalogMatches.map((m) =>
        [
          ...new Set(
            [...m.references, ...m.unresolved].map((c) => c.version.recipeVersionReference),
          ),
        ].sort(),
      ),
      reachable = matchRecipeInventoryReferenceRoots({
        request: recipeInventoryRequest,
        source: recipe,
        rootGroups: roots,
        now: input.now,
      });
    const graphs = joinMerchantRecipeInventoryReferenceGraphs({
      inventory,
      catalogMatches,
      roots,
      reachable,
      initialBudget:
        bindings.recipes.length +
        bindings.versions.length +
        bindings.bindings.length +
        bindings.modifiers.length +
        recipe.recipes.length +
        recipe.versions.length +
        recipe.ingredients.length +
        recipe.modifiers.length +
        recipe.changes.length +
        inventory.configuration.items.length +
        inventory.configuration.versions.length +
        inventory.configuration.operations.length +
        inventory.mappings.length,
    });
    const current = graphs[0];
    if (!current) return fail();
    const recorded = Object.freeze(
      pair.recorded.configurations.map((configuration, i) => {
        const matches = graphs[i + 1];
        if (!matches) return fail();
        return Object.freeze({ configuration, matches });
      }),
    );
    const body = {
      request,
      tenantReference: tenant,
      coverage: "KnownCurrentAndRecordedDraftRecipeInventoryReferences" as const,
      applicability: "Unavailable" as const,
      conditionalApplicability: "Unavailable" as const,
      removalResolution: "Unavailable" as const,
      publicationCoverage: pair.recorded.publicationCoverage,
      futureScheduleCoverage: pair.recorded.futureScheduleCoverage,
      recipeSourceDigest: bindings.digest,
      recipeInventorySourceDigest: recipe.digest,
      recipeGeneration: recipe.generation,
      inventorySourceDigest: inventory.digest,
      inventoryGeneration: inventory.generation,
      recordedCatalogSourceDigest: pair.recorded.digest,
      current,
      recorded,
    };
    const observations = Object.freeze({
      catalogCurrent: pair.current.observedAt,
      catalogHistory: pair.recorded.observedAt,
      recipeBindings: bindings.observedAt,
      recipeInventory: recipe.observedAt,
      inventory: inventory.observedAt,
    });
    return Object.freeze({
      ...body,
      digest: hash(body),
      observations,
      observedAt: Object.values(observations).sort()[0] as string,
    });
  } catch {
    return fail();
  }
}

/** Internal API composition kernel over already parsed owning graph facts.
 * Request metadata remains generic; no legacy request is manufactured. */
export function joinMerchantRecipeInventoryReferenceGraphs<Request>({
  inventory,
  catalogMatches,
  roots,
  reachable,
  initialBudget,
}: {
  readonly inventory: {
    readonly configuration: Pick<
      ReturnType<typeof parseInventorySkuMappingReferenceSnapshot>["configuration"],
      "items" | "versions" | "operations"
    >;
  };
  readonly catalogMatches: readonly (Pick<
    ReturnType<typeof matchRecipeCatalogReferenceGraphs>[number],
    "targetMembership" | "references" | "unresolved" | "expandedRows"
  > & { readonly target: { readonly catalogConfigurationDigest: string } })[];
  readonly roots: readonly (readonly string[])[];
  readonly reachable: readonly (Omit<
    ReturnType<typeof matchRecipeInventoryReferenceRoots>[number],
    "request"
  > & { readonly request: Request })[];
  readonly initialBudget: number;
}) {
  const items = new Map(inventory.configuration.items.map((i) => [i.itemReference, i])),
    operations = new Map(inventory.configuration.operations.map((o) => [o.operationReference, o])),
    versions = new Map(
      inventory.configuration.versions.map((v) => [v.itemReference + ":" + v.itemVersion, v]),
    );
  let budget = initialBudget;
  const consume = (n: number) => {
    budget += n;
    if (budget > 10000) return fail();
  };
  const join = (row: RecipeInventoryReachableRequirement) => {
    if (row.kind === "ModifierRemove" || row.reference.sourceKind !== "InventoryItem")
      return fail();
    const item = items.get(row.reference.sourceReference),
      operation = operations.get(row.reference.sourceVersionReference);
    if (!item)
      return Object.freeze({
        state: "Unresolved" as const,
        reason: "InventoryItemNotRecorded" as const,
      });
    if (!operation)
      return Object.freeze({
        state: "Unresolved" as const,
        reason: "InventoryOperationNotRecorded" as const,
      });
    if (operation.itemReference !== item.itemReference)
      return Object.freeze({
        state: "Unresolved" as const,
        reason: "InventoryOperationItemMismatch" as const,
      });
    const version = versions.get(item.itemReference + ":" + operation.itemVersion);
    if (!version) return fail();
    return Object.freeze({
      state: "ResolvedStoredConfiguration" as const,
      item,
      operation,
      version,
      isCurrentItemConfiguration:
        item.currentItemVersion === operation.itemVersion &&
        item.currentOperationReference === operation.operationReference,
    });
  };
  const graphs = catalogMatches.map((m, i) => {
    const reachability = reachable[i];
    if (!reachability) return fail();
    consume(
      m.expandedRows +
        reachability.reachableVersions.length * 2 +
        reachability.requirements.length * 2,
    );
    const rootContexts = Object.freeze(
      roots[i]?.map((root) => {
        const matched = m.references.find((c) => c.version.recipeVersionReference === root),
          unresolved = m.unresolved.find((c) => c.version.recipeVersionReference === root);
        const context = matched ?? unresolved;
        if (!context) return fail();
        return Object.freeze({
          recipeReference: context.recipe.recipeReference,
          recipeVersionReference: root,
          isCurrentRecipeVersion: context.recipe.currentVersionReference === root,
          matchedBindingReferences: Object.freeze(
            matched?.bindings.map((b) => b.bindingReference) ?? [],
          ),
          matchedModifierRuleVersionReferences: Object.freeze(
            matched?.modifiers.map((r) => r.reference.ruleVersionReference) ?? [],
          ),
          unresolvedBindings: Object.freeze(
            unresolved?.bindings.map((b) =>
              Object.freeze({ bindingReference: b.reference.bindingReference, reason: b.reason }),
            ) ?? [],
          ),
          unresolvedModifiers: Object.freeze(
            unresolved?.modifiers.map((r) =>
              Object.freeze({
                ruleVersionReference: r.reference.ruleVersionReference,
                reason: r.reason,
              }),
            ) ?? [],
          ),
        });
      }) ?? fail(),
    );
    const inventoryReferences = Object.freeze(
      reachability.requirements
        .filter(
          (row) => row.kind !== "ModifierRemove" && row.reference.sourceKind === "InventoryItem",
        )
        .map((requirement) => {
          const resolution = join(requirement);
          consume(resolution.state === "ResolvedStoredConfiguration" ? 4 : 1);
          return Object.freeze({ requirement, resolution });
        }),
    );
    const { observedAt, ...stableReachability } = reachability;
    void observedAt;
    return Object.freeze({
      catalogConfigurationDigest: m.target.catalogConfigurationDigest,
      targetMembership: m.targetMembership,
      rootContexts,
      recipeReachability: Object.freeze(stableReachability),
      inventoryReferences,
    });
  });
  return Object.freeze(graphs);
}
