import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { RecipeEditorScreen, RecipeListScreen, RecipeState } from "./RecipePages.js";
import { parseRecipeEditorView, parseRecipeListView, RecipeClientError } from "./recipe-pages.js";
const id = (n: number) => `018f9b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const item = () => ({
  recipeReference: id(1),
  name: "Synthetic Recipe",
  stableCode: "SYNTHETIC_RECIPE",
  lifecycle: "Published",
  yieldSummary: "10 portions",
  costMinor: "1200",
  allergenStatus: "Verified",
  usageSummary: "One Product / SKU",
  effectiveVersion: "Version 2",
  ingredientSummary: "Synthetic flour",
  mappingMissing: false,
  costChanged: true,
  aggregateVersion: 2,
});
const editor = () => ({
  screenId: "RECIPE-EDITOR",
  ...item(),
  ingredients: [
    {
      sourceReference: id(2),
      sourceKind: "InventoryItem",
      sourceName: "Synthetic flour",
      quantitySummary: "1000000 microunits",
      lossSummary: "5 percent loss",
      allergenSummary: "Contains synthetic allergen ref",
      evidenceSummary: "Verified evidence version",
      mappingStatus: "Resolved",
    },
  ],
  preparationSummary: "Preparation version 2 with ordered steps",
  substitutionPolicySummary: "No automatic substitution",
  allergenUnionSummary: "Verified structured union",
  costDerivationSummary: "Exact minor-unit derivation",
  productSkuUsageSummary: "One Product / SKU public reference",
  reviewSummary: "Independent Cost and Food Safety approvals",
  historySummary: "Version 2 publication history",
});
describe("Recipe screen contracts", () => {
  it("renders List filters, yield, cost, allergen status and actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeListScreen
          view={parseRecipeListView({
            screenId: "RECIPE-LIST",
            asOfUtc: "2026-08-13T18:00:00.000Z",
            items: [item()],
          })}
        />
      </MemoryRouter>,
    );
    for (const value of [
      "Recipe management",
      "Synthetic Recipe",
      "1200 CAD minor units",
      "Verified",
      "Name / code / Ingredient",
      "Missing mapping",
      "Review",
      "Publish",
      "Archive",
    ])
      expect(html).toContain(value);
  });
  it("renders Editor graph, preparation, cost, dual review and invalidation", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeEditorScreen view={parseRecipeEditorView(editor())} />
      </MemoryRouter>,
    );
    for (const value of [
      "Recipe editor",
      "Ingredient requirements",
      "Synthetic flour",
      "Preparation version",
      "Cost derivation",
      "Dual review",
      "Recalculate yield / cost / allergens",
      "Invalidate",
    ])
      expect(html).toContain(value);
  });
  it("rejects markup, URLs and numeric money, and renders every required state", () => {
    expect(() =>
      parseRecipeEditorView({ ...editor(), historySummary: "https://bad.example" }),
    ).toThrow(RecipeClientError);
    expect(() => parseRecipeEditorView({ ...editor(), costMinor: 1200 })).toThrow(
      RecipeClientError,
    );
    for (const state of [
      "Loading",
      "PermissionDenied",
      "NotFound",
      "FeatureDisabled",
      "Stale",
      "Conflict",
      "CommandFailed",
      "Offline",
      "Unavailable",
    ] as const)
      expect(
        renderToStaticMarkup(
          <MemoryRouter>
            <RecipeState state={state} />
          </MemoryRouter>,
        ).length,
      ).toBeGreaterThan(50);
  });
});
