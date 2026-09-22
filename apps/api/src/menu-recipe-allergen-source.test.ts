import { parseCatalogReference } from "@rms/catalog";
import { beforeEach, expect, it, vi } from "vitest";
import {
  createMenuRecipeAllergenSource,
  createCompleteMenuRecipeAllergenSource,
} from "./menu-recipe-allergen-source.js";

const fixtures = vi.hoisted(() => ({
  recipe: null as unknown,
  allergens: null as unknown,
  requests: [] as unknown[],
  failAt: 0,
}));
vi.mock("@rms/recipe", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/recipe")>()),
  createPostgresRecipeReviewSource: () => ({
    resolve: async (_tx: unknown, query: unknown) => {
      fixtures.requests.push(query);
      if (fixtures.failAt === fixtures.requests.length) throw new Error("synthetic missing source");
      return fixtures.recipe;
    },
  }),
}));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  createPostgresAllergenReviewFactsStore: () => async () => fixtures.allergens,
}));
const id = (n: number) => "01902405-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const requirement = () => ({
  sourceKind: "InventoryItem",
  sourceReference: id(2),
  sourceVersionReference: id(3),
  allergens: [{ evidenceReference: id(4), allergenReference: id(5), verified: true }],
});
const evidence = () => ({
  evidenceReference: id(4),
  subjectReference: id(2),
  sourceVersionReference: id(3),
  subjectKind: "Ingredient",
  assertions: [{ allergenReference: id(5), classification: "Contains" }],
});
const input = {
  recipe: {
    actorType: "User" as const,
    actorReference: id(10),
    action: "ResolveMenuRecipeFacts" as const,
    purpose: "ReviewMenu" as const,
    brandReference: id(1),
    storeReference: id(11),
    skuReference: id(12),
    observedAt: "2026-08-13T18:00:00.000Z",
    selections: [],
  },
  registryVersionReference: id(13),
  defaultLocale: "en-CA",
};
const tx = { query: async <Row>() => ({ rows: [] as Row[] }) };
const load = () =>
  createMenuRecipeAllergenSource({
    brandReference: id(1),
    authorize: async () => true,
  }).resolve(tx, input);

beforeEach(() => {
  fixtures.requests = [];
  fixtures.failAt = 0;
  fixtures.recipe = {
    configuredIngredients: [requirement()],
    graph: [],
    observedAt: input.recipe.observedAt,
    sourceDigest: "sha256:" + "a".repeat(64),
  };
  fixtures.allergens = { registryVersionReference: id(13), registry: [], evidence: [evidence()] };
});
it("binds shared evidence once across repeated uses of the same ingredient version", async () => {
  fixtures.recipe = {
    configuredIngredients: [requirement()],
    graph: [{ ingredients: [requirement()] }],
    observedAt: input.recipe.observedAt,
    sourceDigest: "sha256:" + "a".repeat(64),
  };
  expect((await load()).evidenceReferences).toEqual([id(4)]);
});
it.each([
  { subjectReference: id(99) },
  { sourceVersionReference: id(99) },
  { subjectKind: "Recipe" },
  { assertions: [] },
  { assertions: [{ allergenReference: id(99), classification: "Contains" }] },
  {
    assertions: [
      ...evidence().assertions,
      { allergenReference: id(99), classification: "Contains" },
    ],
  },
])("rejects inconsistent subject/version/assertions %j", async (patch) => {
  fixtures.allergens = { evidence: [{ ...evidence(), ...patch }] };
  await expect(load()).rejects.toMatchObject({ code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" });
});
it("rejects one evidence reference reused for different ingredient subjects", async () => {
  fixtures.recipe = {
    configuredIngredients: [requirement(), { ...requirement(), sourceReference: id(99) }],
    graph: [],
    observedAt: input.recipe.observedAt,
  };
  await expect(load()).rejects.toMatchObject({ code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" });
});
it("does not infer allergen absence from a leaf with no evidence", async () => {
  fixtures.recipe = {
    configuredIngredients: [{ ...requirement(), allergens: [] }],
    graph: [],
    observedAt: input.recipe.observedAt,
  };
  await expect(load()).rejects.toMatchObject({ code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" });
});

const completeInput = () => {
  const ref = (n: number) => parseCatalogReference(id(n));
  return {
    recipe: input.recipe,
    registryVersionReference: input.registryVersionReference,
    defaultLocale: input.defaultLocale,
    budget: { maximumConfigurations: 10, maximumSearchSteps: 1000 },
    rules: [
      {
        bindingReference: ref(20),
        optionSetVersionReference: ref(21),
        activationOptionReferences: [],
        minimumQuantity: 0,
        maximumQuantity: 2,
        options: [{ optionReference: ref(22), maximumQuantity: 2, conflictOptionReferences: [] }],
      },
    ],
  };
};
const complete = () =>
  createCompleteMenuRecipeAllergenSource({
    brandReference: id(1),
    authorize: async () => true,
  });
it("resolves every legal quantity and deduplicates shared source evidence", async () => {
  const result = await complete().resolve(tx, completeInput());
  expect(
    result.configurations.map((item) => item.selections.map((selection) => selection.quantity)),
  ).toEqual([[], [1], [2]]);
  expect(fixtures.requests).toHaveLength(3);
  expect(result.allergens.evidence).toHaveLength(1);
  expect(result.sourceDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
});
it("rejects the whole coverage when a later configuration has no source", async () => {
  fixtures.failAt = 3;
  await expect(complete().resolve(tx, completeInput())).rejects.toMatchObject({
    code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE",
  });
  expect(fixtures.requests).toHaveLength(3);
});
it("does not start owner queries for an incomplete enumeration", async () => {
  await expect(
    complete().resolve(tx, {
      ...completeInput(),
      budget: { maximumConfigurations: 1, maximumSearchSteps: 1000 },
    }),
  ).rejects.toMatchObject({ code: "MENU_RECIPE_ALLERGEN_UNAVAILABLE" });
  expect(fixtures.requests).toHaveLength(0);
});
