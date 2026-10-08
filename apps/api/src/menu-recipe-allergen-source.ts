import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createPostgresAllergenReviewFactsStore,
  enumerateCatalogReviewSelections,
  type CatalogResolvedSelectionRule,
  parseCatalogReference,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import { createPostgresRecipeReviewSource, type RecipeReviewInput } from "@rms/recipe";

export class MenuRecipeAllergenError extends Error {
  readonly code = "MENU_RECIPE_ALLERGEN_UNAVAILABLE";
  constructor() {
    super("Menu recipe provenance is unavailable");
    this.name = "MenuRecipeAllergenError";
  }
}
function fail(): never {
  throw new MenuRecipeAllergenError();
}

/** Public owner composition, no foreign SQL. The caller retains source fences
 * through Menu review persistence and enumerates every applicable configuration.
 * No missing Ingredient evidence is interpreted as an allergen-free claim.
 */
export function createMenuRecipeAllergenSource(options: {
  brandReference: string;
  authorize(
    tx: ProductLifecycleTransaction,
    input: RecipeReviewInput,
    owner: "Recipe" | "Catalog",
  ): Promise<boolean>;
}) {
  const brand = parseCatalogReference(options.brandReference);
  return Object.freeze({
    async resolve(
      tx: ProductLifecycleTransaction,
      input: {
        recipe: RecipeReviewInput;
        registryVersionReference: string;
        defaultLocale: string;
      },
    ) {
      try {
        const recipe = await createPostgresRecipeReviewSource({
          brandReference: brand,
          authorize: async (_tx, query) => options.authorize(tx, query, "Recipe"),
        }).resolve(tx, input.recipe);
        const expected = new Map<
          string,
          {
            subjectReference: string;
            subjectKind: "Ingredient" | "Recipe";
            sourceVersionReference: string;
            allergens: Set<string>;
          }
        >();
        for (const requirement of [
          ...recipe.configuredIngredients,
          ...recipe.graph.flatMap((snapshot) => snapshot.ingredients),
        ]) {
          // DEC-ALLERGEN-DECLARATIONS: an ingredient needs a declaration; one may list no allergens.
          if (
            requirement.sourceKind === "InventoryItem" &&
            !requirement.allergens.length &&
            requirement.allergenDeclarationReference === undefined
          )
            return fail();
          if (requirement.allergenDeclarationReference !== undefined) {
            const reference = requirement.allergenDeclarationReference;
            const existing = expected.get(reference);
            if (
              existing &&
              (existing.subjectReference !== requirement.sourceReference ||
                existing.subjectKind !== "Ingredient" ||
                existing.sourceVersionReference !== requirement.sourceVersionReference)
            )
              return fail();
            if (!existing)
              expected.set(reference, {
                subjectReference: requirement.sourceReference,
                subjectKind: "Ingredient",
                sourceVersionReference: requirement.sourceVersionReference,
                allergens: new Set<string>(),
              });
          }
          for (const assertion of requirement.allergens) {
            if (!assertion.verified) return fail();
            const subjectKind =
              requirement.sourceKind === "InventoryItem" ? "Ingredient" : "Recipe";
            const existing = expected.get(assertion.evidenceReference);
            if (
              existing &&
              (existing.subjectReference !== requirement.sourceReference ||
                existing.subjectKind !== subjectKind ||
                existing.sourceVersionReference !== requirement.sourceVersionReference)
            )
              return fail();
            const subject = existing ?? {
              subjectReference: requirement.sourceReference,
              subjectKind,
              sourceVersionReference: requirement.sourceVersionReference,
              allergens: new Set<string>(),
            };
            subject.allergens.add(assertion.allergenReference);
            expected.set(assertion.evidenceReference, subject);
          }
        }
        if (!expected.size) return fail();
        const evidenceReferences = Object.freeze([...expected.keys()].sort());
        const allergens = await createPostgresAllergenReviewFactsStore({
          brandReference: brand,
          authorize: async () => options.authorize(tx, input.recipe, "Catalog"),
        })(tx, {
          registryVersionReference: input.registryVersionReference,
          evidenceReferences,
          defaultLocale: input.defaultLocale,
          observedAt: recipe.observedAt,
        });
        for (const evidence of allergens.evidence) {
          const subject = expected.get(evidence.evidenceReference);
          if (
            !subject ||
            evidence.subjectReference !== subject.subjectReference ||
            evidence.subjectKind !== subject.subjectKind ||
            evidence.sourceVersionReference !== subject.sourceVersionReference ||
            evidence.assertions.length !== subject.allergens.size ||
            evidence.assertions.some(
              (assertion) => !subject.allergens.has(assertion.allergenReference),
            )
          )
            return fail();
        }
        if ((await options.authorize(tx, input.recipe, "Recipe")) !== true) return fail();
        return Object.freeze({
          recipe,
          allergens,
          evidenceReferences,
          sourceDigest:
            "sha256:" +
            sha256Hex(
              canonicalizeRfc8785({
                recipeSourceDigest: recipe.sourceDigest,
                allergens,
              }),
            ),
        });
      } catch {
        return fail();
      }
    },
  });
}

/** Complete evidence for one SKU/Store/channel rule set. Menu preparation invokes
 * this for every applicable Store/channel and keeps the caller transaction open.
 * This is evidence preparation, never a Publishing approval.
 */
export function createCompleteMenuRecipeAllergenSource(
  options: Parameters<typeof createMenuRecipeAllergenSource>[0],
) {
  const source = createMenuRecipeAllergenSource(options);
  return Object.freeze({
    async resolve(
      tx: ProductLifecycleTransaction,
      input: {
        recipe: Omit<RecipeReviewInput, "selections">;
        rules: readonly CatalogResolvedSelectionRule[];
        registryVersionReference: string;
        defaultLocale: string;
        budget: Parameters<typeof enumerateCatalogReviewSelections>[1];
      },
    ) {
      try {
        const selections = enumerateCatalogReviewSelections(input.rules, input.budget);
        const configurations = [];
        type Source = Awaited<ReturnType<typeof source.resolve>>;
        let registry: Pick<Source["allergens"], "registryVersionReference" | "registry"> | null =
          null;
        const evidence = new Map<string, Source["allergens"]["evidence"][number]>();
        for (const selection of selections) {
          const resolved = await source.resolve(tx, {
            recipe: { ...input.recipe, selections: selection },
            registryVersionReference: input.registryVersionReference,
            defaultLocale: input.defaultLocale,
          });
          const currentRegistry = {
            registryVersionReference: resolved.allergens.registryVersionReference,
            registry: resolved.allergens.registry,
          };
          if (
            registry !== null &&
            canonicalizeRfc8785(registry) !== canonicalizeRfc8785(currentRegistry)
          )
            return fail();
          registry = currentRegistry;
          for (const item of resolved.allergens.evidence) {
            const existing = evidence.get(item.evidenceReference);
            if (existing && canonicalizeRfc8785(existing) !== canonicalizeRfc8785(item))
              return fail();
            evidence.set(item.evidenceReference, item);
          }
          configurations.push(Object.freeze({ selections: selection, ...resolved }));
        }
        if (!registry) return fail();
        const allergens = Object.freeze({
          ...registry,
          evidence: Object.freeze(
            [...evidence.values()].sort((a, b) =>
              a.evidenceReference.localeCompare(b.evidenceReference),
            ),
          ),
        });
        return Object.freeze({
          configurations: Object.freeze(configurations),
          allergens,
          sourceDigest:
            "sha256:" +
            sha256Hex(
              canonicalizeRfc8785({
                brandReference: input.recipe.brandReference,
                storeReference: input.recipe.storeReference,
                skuReference: input.recipe.skuReference,
                defaultLocale: input.defaultLocale,
                rules: input.rules,
                allergens,
                configurations: configurations.map((item) => ({
                  selections: item.selections,
                  sourceDigest: item.sourceDigest,
                })),
              }),
            ),
        });
      } catch {
        return fail();
      }
    },
  });
}
