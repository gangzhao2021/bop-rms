import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  CatalogError,
  createPostgresAllergenReviewFactsStore,
  enumerateCatalogReviewSelections,
  type CatalogResolvedSelectionRule,
  parseCatalogReference,
  type ProductLifecycleTransaction,
} from "@rms/catalog";
import {
  createPostgresRecipeReviewSource,
  RecipeReviewGapError,
  type RecipeReviewInput,
} from "@rms/recipe";

/** WP-2423 (v15 2026-10-22): what a menu review is missing, so staff can be told which item,
 * size, option or ingredient to fix. References only; the merchant API names them.
 */
export interface MenuReviewGap {
  readonly skuReference: string;
  readonly storeReference: string;
  readonly missing:
    "Recipe" | "SubRecipe" | "OptionRecipe" | "AllergenDeclaration" | "AllergenList";
  readonly optionReference: string | null;
  readonly quantity: number | null;
  /** The Inventory Item whose allergen declaration is missing, unverified or out of date. */
  readonly ingredientReference: string | null;
}
type Gap = Omit<MenuReviewGap, "skuReference" | "storeReference">;

export class MenuRecipeAllergenError extends Error {
  readonly code = "MENU_RECIPE_ALLERGEN_UNAVAILABLE";
  constructor(readonly gap: MenuReviewGap | null = null) {
    super("Menu recipe provenance is unavailable");
    this.name = "MenuRecipeAllergenError";
  }
}
/** The Catalog failure a menu review raises when it knows what is missing. */
export class MenuReviewGapError extends CatalogError {
  constructor(readonly gap: MenuReviewGap) {
    super("CATALOG_DEPENDENCY_UNAVAILABLE");
    this.name = "MenuReviewGapError";
  }
}
function fail(): never {
  throw new MenuRecipeAllergenError();
}
class IngredientGap extends Error {
  constructor(
    readonly requirementReference: string,
    readonly ingredientReference: string | null,
  ) {
    super("Ingredient allergen declaration is unavailable");
  }
}

type ReviewedRecipe = Awaited<
  ReturnType<ReturnType<typeof createPostgresRecipeReviewSource>["resolve"]>
>;
type ReviewFacts = Awaited<ReturnType<ReturnType<typeof createPostgresAllergenReviewFactsStore>>>;
interface ExpectedEvidence {
  subjectReference: string;
  subjectKind: "Ingredient" | "Recipe";
  sourceVersionReference: string;
  allergens: Set<string>;
}

/** The evidence a configured recipe's ingredients pin. No missing Ingredient evidence is
 * interpreted as an allergen-free claim.
 */
function expectedEvidence(recipe: ReviewedRecipe) {
  const expected = new Map<string, ExpectedEvidence>();
  for (const requirement of [
    ...recipe.configuredIngredients,
    ...recipe.graph.flatMap((snapshot) => snapshot.ingredients),
  ]) {
    const gap = () => {
      throw new IngredientGap(
        requirement.requirementReference,
        requirement.sourceKind === "InventoryItem" ? requirement.sourceReference : null,
      );
    };
    // DEC-ALLERGEN-DECLARATIONS: an ingredient needs a declaration; one may list no allergens.
    if (
      requirement.sourceKind === "InventoryItem" &&
      !requirement.allergens.length &&
      requirement.allergenDeclarationReference === undefined
    )
      return gap();
    if (requirement.allergenDeclarationReference !== undefined) {
      const reference = requirement.allergenDeclarationReference;
      const existing = expected.get(reference);
      if (
        existing &&
        (existing.subjectReference !== requirement.sourceReference ||
          existing.subjectKind !== "Ingredient" ||
          existing.sourceVersionReference !== requirement.sourceVersionReference)
      )
        return gap();
      if (!existing)
        expected.set(reference, {
          subjectReference: requirement.sourceReference,
          subjectKind: "Ingredient",
          sourceVersionReference: requirement.sourceVersionReference,
          allergens: new Set<string>(),
        });
    }
    for (const assertion of requirement.allergens) {
      if (!assertion.verified) return gap();
      const subjectKind = requirement.sourceKind === "InventoryItem" ? "Ingredient" : "Recipe";
      const existing = expected.get(assertion.evidenceReference);
      if (
        existing &&
        (existing.subjectReference !== requirement.sourceReference ||
          existing.subjectKind !== subjectKind ||
          existing.sourceVersionReference !== requirement.sourceVersionReference)
      )
        return gap();
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
  return expected;
}
/** The current evidence records must say exactly what the recipe pinned. */
function matchEvidence(expected: ReadonlyMap<string, ExpectedEvidence>, allergens: ReviewFacts) {
  for (const evidence of allergens.evidence) {
    const subject = expected.get(evidence.evidenceReference);
    if (
      !subject ||
      evidence.subjectReference !== subject.subjectReference ||
      evidence.subjectKind !== subject.subjectKind ||
      evidence.sourceVersionReference !== subject.sourceVersionReference ||
      evidence.assertions.length !== subject.allergens.size ||
      evidence.assertions.some((assertion) => !subject.allergens.has(assertion.allergenReference))
    )
      throw new IngredientGap(
        "",
        subject?.subjectKind === "Ingredient" ? subject.subjectReference : null,
      );
  }
}
const configurationDigest = (recipe: ReviewedRecipe, allergens: ReviewFacts) =>
  "sha256:" +
  sha256Hex(canonicalizeRfc8785({ recipeSourceDigest: recipe.sourceDigest, allergens }));

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
        const expected = expectedEvidence(recipe);
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
        matchEvidence(expected, allergens);
        if ((await options.authorize(tx, input.recipe, "Recipe")) !== true) return fail();
        return Object.freeze({
          recipe,
          allergens,
          evidenceReferences,
          sourceDigest: configurationDigest(recipe, allergens),
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
  const brand = parseCatalogReference(options.brandReference);
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
      const missing = (gap: Gap): never => {
        throw new MenuRecipeAllergenError({
          skuReference: input.recipe.skuReference,
          storeReference: input.recipe.storeReference,
          ...gap,
        });
      };
      try {
        // Allergens follow which ingredients a configuration uses, and each option's recipe rule
        // depends only on its own quantity, so covering every distinct set of chosen options and
        // every option at every quantity proves the same as every quantity combination (v15
        // 2026-10-22: a Latte with milk, shots, syrups and sweeteners has 13,440 quantity
        // combinations per size, which exceeded the whole menu's review budget).
        const selections = enumerateCatalogReviewSelections(
          input.rules,
          input.budget,
          "distinct-options",
        );
        // Each configuration's facts equal a separate `createMenuRecipeAllergenSource` resolution
        // (the evidence reader orders by reference, so one read of every pinned record filtered
        // per configuration is the same record list), but the recipe, option rules, SubRecipes and
        // allergen records are read once: one resolution per configuration took 50 s on v15.
        const recipes = await createPostgresRecipeReviewSource({
          brandReference: brand,
          authorize: async (_tx, query) => options.authorize(tx, query, "Recipe"),
        })
          .resolveConfigurations(tx, input.recipe, selections)
          .catch((error: unknown) => {
            if (error instanceof RecipeReviewGapError)
              return missing({
                missing: error.gap.missing,
                optionReference:
                  error.gap.missing === "OptionRecipe" ? error.gap.selection.optionReference : null,
                quantity:
                  error.gap.missing === "OptionRecipe" ? error.gap.selection.quantity : null,
                ingredientReference: null,
              });
            throw error;
          });
        const expected = recipes.map((recipe) => {
          try {
            return expectedEvidence(recipe);
          } catch (error) {
            if (!(error instanceof IngredientGap)) throw error;
            // Name the option whose recipe change brought the ingredient in, if any.
            const rule = recipe.modifierRules.find((item) =>
              item.changes.some(
                (change) =>
                  change.action !== "Remove" &&
                  change.ingredient.requirementReference === error.requirementReference,
              ),
            );
            return missing({
              missing: "AllergenDeclaration",
              optionReference: rule?.selection.optionReference ?? null,
              quantity: rule?.selection.quantity ?? null,
              ingredientReference: error.ingredientReference,
            });
          }
        });
        const observedAt = recipes[0]?.observedAt ?? fail();
        const pinned = [...new Set(expected.flatMap((item) => [...item.keys()]))].sort();
        const read = (evidenceReferences: readonly string[]) =>
          createPostgresAllergenReviewFactsStore({
            brandReference: brand,
            authorize: async () =>
              options.authorize(tx, { ...input.recipe, selections: [] }, "Catalog"),
          })(tx, {
            registryVersionReference: input.registryVersionReference,
            evidenceReferences,
            defaultLocale: input.defaultLocale,
            observedAt: observedAt,
          });
        const facts = await read(pinned).catch(async (error: unknown) => {
          if (!(error instanceof CatalogError) || error.code !== "CATALOG_DEPENDENCY_UNAVAILABLE")
            throw error;
          // Find the record at fault: an expired or unapproved declaration, or the allergen list.
          for (const reference of pinned) {
            const usable = await read([reference]).then(
              () => true,
              () => false,
            );
            if (usable) continue;
            const subject = expected.find((item) => item.has(reference))?.get(reference);
            return missing({
              missing: "AllergenDeclaration",
              optionReference: null,
              quantity: null,
              ingredientReference:
                subject?.subjectKind === "Ingredient" ? subject.subjectReference : null,
            });
          }
          return missing({
            missing: "AllergenList",
            optionReference: null,
            quantity: null,
            ingredientReference: null,
          });
        });
        const configurations = recipes.map((recipe, index) => {
          const pins = expected[index] ?? fail();
          const allergens = Object.freeze({
            registryVersionReference: facts.registryVersionReference,
            registry: facts.registry,
            evidence: Object.freeze(
              facts.evidence.filter((item) => pins.has(item.evidenceReference)),
            ),
          });
          try {
            matchEvidence(pins, allergens);
          } catch (error) {
            if (!(error instanceof IngredientGap)) throw error;
            return missing({
              missing: "AllergenDeclaration",
              optionReference: null,
              quantity: null,
              ingredientReference: error.ingredientReference,
            });
          }
          return Object.freeze({
            selections: selections[index] ?? fail(),
            recipe,
            allergens,
            evidenceReferences: Object.freeze([...pins.keys()].sort()),
            sourceDigest: configurationDigest(recipe, allergens),
          });
        });
        if ((await options.authorize(tx, { ...input.recipe, selections: [] }, "Recipe")) !== true)
          return fail();
        type Evidence = ReviewFacts["evidence"][number];
        let registry: Pick<ReviewFacts, "registryVersionReference" | "registry"> | null = null;
        const evidence = new Map<string, Evidence>();
        for (const resolved of configurations) {
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
      } catch (error) {
        if (error instanceof MenuRecipeAllergenError) throw error;
        return fail();
      }
    },
  });
}
