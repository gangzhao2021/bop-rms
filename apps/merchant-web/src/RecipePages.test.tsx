import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { RecipeEditorScreen, RecipeListScreen, RecipeState } from "./RecipePages.js";
import {
  assertRecipeViewScope,
  parseRecipeEditorView,
  parseRecipeListView,
  RecipeClientError,
  recipeSourceKinds,
} from "./recipe-pages.js";
const id = (n: number) => `018f9b00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const available = <T,>(value: T) => ({
  status: "Available",
  value,
  source: "Recipe",
  sourceVersion: "recipe-v2",
});
const metadata = () => ({
  projectionVersion: 2,
  asOfUtc: "2026-08-13T18:00:00.000Z",
  scope: { tenantReference: id(100), brandReference: id(101) },
  partial: false,
  freshness: "Fresh",
  sources: Object.fromEntries(
    recipeSourceKinds.map((kind) => [
      kind,
      {
        status: "Current",
        version: kind === "Recipe" ? "recipe-v2" : `${kind}-v1`,
        asOfUtc: "2026-08-13T18:00:00.000Z",
      },
    ]),
  ),
});
const item = () => ({
  recipeReference: id(1),
  name: "Synthetic Recipe",
  stableCode: "SYNTHETIC_RECIPE",
  lifecycle: "Published",
  yieldSummary: "10 portions",
  cost: available({ amountMinor: "1200", currencyCode: "USD" }),
  allergenStatus: "Verified",
  usageSummary: available("One Product / SKU"),
  effectiveVersion: "Version 2",
  ingredientSummary: available("Synthetic flour"),
  mappingMissing: false,
  costChanged: true,
  aggregateVersion: 2,
});
const editor = () => ({
  ...metadata(),
  screenId: "RECIPE-EDITOR",
  ...item(),
  ingredients: [
    {
      sourceReference: id(2),
      sourceKind: "InventoryItem",
      sourceName: available("Synthetic flour"),
      quantitySummary: "1000000 microunits",
      lossSummary: "5 percent loss",
      allergenSummary: available("Contains synthetic allergen ref"),
      evidenceSummary: available("Verified evidence version"),
      mappingStatus: "Resolved",
    },
  ],
  preparationSummary: available("Preparation version 2 with ordered steps"),
  substitutionPolicySummary: available("No automatic substitution"),
  allergenUnionSummary: available("Verified structured union"),
  costDerivationSummary: available("Exact minor-unit derivation"),
  productSkuUsageSummary: available("One Product / SKU public reference"),
  reviewSummary: available("Independent Cost and Food Safety approvals"),
  historySummary: available("Version 2 publication history"),
});
const list = () => ({ ...metadata(), screenId: "RECIPE-LIST", items: [item()] });
describe("Recipe screen contracts", () => {
  it("rejects missing authority and cross-Tenant or cross-Brand view scope", () => {
    const view = parseRecipeListView(list());
    expect(() => assertRecipeViewScope(view, view.scope)).not.toThrow();
    for (const scope of [
      null,
      { ...view.scope, brandReference: id(999) },
      { ...view.scope, tenantReference: id(999) },
    ])
      expect(() => assertRecipeViewScope(view, scope)).toThrow("Recipe view is unavailable");
  });
  it("removes effective verification summaries but retains known ingredient hazards", () => {
    const input = editor();
    const view = parseRecipeEditorView({
      ...input,
      partial: true,
      sources: { ...input.sources, Supplier: { status: "Unavailable" } },
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeEditorScreen view={view} />
      </MemoryRouter>,
    );
    expect(html).toContain("Verification unavailable");
    expect(html).toContain("Contains synthetic allergen ref");
    expect(html).not.toContain("Verified evidence version");
    expect(html).not.toContain("Verified structured union");
    expect(html).not.toContain("Independent Cost and Food Safety approvals");
  });
  it("keeps the primary Recipe visible when summaries are missing or restricted", () => {
    const view = parseRecipeListView({
      ...list(),
      partial: true,
      items: [
        {
          ...item(),
          cost: { status: "PermissionHidden" },
          usageSummary: { status: "Unavailable" },
          ingredientSummary: { status: "Unavailable" },
          mappingMissing: null,
          costChanged: null,
        },
      ],
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeListScreen view={view} />
      </MemoryRouter>,
    );
    for (const value of [
      "Synthetic Recipe",
      "Partial data",
      "Restricted",
      "Unavailable",
      "Mapping unavailable",
      "Cost change unavailable",
    ])
      expect(html).toContain(value);
    expect(html).not.toContain("1200");
    expect(html).not.toContain("Cost stable");
  });
  it("supports missing editor summaries independently", () => {
    const view = parseRecipeEditorView({
      ...editor(),
      partial: true,
      preparationSummary: { status: "Unavailable" },
      costDerivationSummary: { status: "PermissionHidden" },
      productSkuUsageSummary: { status: "Unavailable" },
    });
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeEditorScreen view={view} />
      </MemoryRouter>,
    );
    expect(html).toContain("Recipe editor");
    expect(html).toContain("Restricted");
    expect(html).toContain("Unavailable");
  });
  it.each(recipeSourceKinds.filter((kind) => kind !== "Usage"))(
    "suppresses Verified on stale %s evidence without a Recipe version change",
    (kind) => {
      const input = list();
      const view = parseRecipeListView({
        ...input,
        freshness: "Stale",
        sources: {
          ...input.sources,
          [kind]: {
            status: "Stale",
            version: kind === "Recipe" ? "recipe-v2" : `${kind}-v1`,
            asOfUtc: input.asOfUtc,
          },
        },
      });
      expect(view.items[0]?.aggregateVersion).toBe(2);
      expect(view.items[0]?.allergenStatus).toBe("Unverified");
    },
  );
  it.each(["Unavailable", "PermissionHidden"])(
    "suppresses Verified for %s safety evidence",
    (status) => {
      const input = list();
      const view = parseRecipeListView({
        ...input,
        partial: true,
        sources: { ...input.sources, Supplier: { status } },
      });
      expect(view.items[0]?.allergenStatus).toBe("Unverified");
    },
  );
  it("does not let unavailable usage invalidate current safety evidence", () => {
    const input = list();
    const view = parseRecipeListView({
      ...input,
      partial: true,
      sources: { ...input.sources, Usage: { status: "Unavailable" } },
      items: [{ ...item(), usageSummary: { status: "Unavailable" } }],
    });
    expect(view.items[0]?.allergenStatus).toBe("Verified");
  });
  it("retains exact money beyond Number precision and freezes nested values", () => {
    const view = parseRecipeListView({
      ...list(),
      items: [
        { ...item(), cost: available({ amountMinor: "9007199254740993", currencyCode: "JPY" }) },
      ],
    });
    const cost = view.items[0]?.cost;
    expect(cost?.status === "Available" && cost.value.amountMinor).toBe("9007199254740993");
    expect(Object.isFrozen(view.scope)).toBe(true);
    expect(Object.isFrozen(view.sources.Recipe)).toBe(true);
    expect(cost?.status === "Available" && Object.isFrozen(cost.value)).toBe(true);
  });
  it.each([
    { projectionVersion: 1 },
    { scope: { tenantReference: id(100), brandReference: "bad" } },
    { asOfUtc: "yesterday" },
    { partial: "false" },
    { freshness: "Unknown" },
    { sources: {} },
  ])("rejects invalid metadata %j", (change) => {
    expect(() => parseRecipeListView({ ...list(), ...change })).toThrow(RecipeClientError);
  });
  it("rejects inconsistent partial, stale and source-version claims", () => {
    const input = list();
    for (const candidate of [
      { ...input, items: [{ ...item(), usageSummary: { status: "Unavailable" } }] },
      { ...input, sources: { ...input.sources, Supplier: { status: "Unavailable" } } },
      {
        ...input,
        sources: {
          ...input.sources,
          Supplier: { status: "Stale", version: "Supplier-v1", asOfUtc: input.asOfUtc },
        },
      },
      {
        ...input,
        items: [{ ...item(), usageSummary: { ...available("Usage"), sourceVersion: "old" } }],
      },
      {
        ...input,
        partial: true,
        items: [{ ...item(), cost: { status: "PermissionHidden", value: "secret" } }],
      },
      {
        ...input,
        sources: {
          ...input.sources,
          Supplier: {
            status: "Current",
            version: "Supplier-v1",
            asOfUtc: "2026-08-14T18:00:00.000Z",
          },
        },
      },
    ])
      expect(() => parseRecipeListView(candidate)).toThrow(RecipeClientError);
  });
  it("rejects getters without executing them", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "status", {
      enumerable: true,
      get() {
        invoked = true;
        return "Unavailable";
      },
    });
    expect(() =>
      parseRecipeListView({ ...list(), partial: true, items: [{ ...item(), cost: value }] }),
    ).toThrow(RecipeClientError);
    expect(invoked).toBe(false);
  });
  it.each([
    { amountMinor: "1.2", currencyCode: "USD" },
    { amountMinor: "-1", currencyCode: "USD" },
    { amountMinor: 12, currencyCode: "USD" },
    { amountMinor: "12" },
    { amountMinor: "12", currencyCode: "usd" },
  ])("rejects invalid or currency-less cost %j", (value) => {
    expect(() =>
      parseRecipeListView({ ...list(), items: [{ ...item(), cost: available(value) }] }),
    ).toThrow(RecipeClientError);
  });
  it("renders List filters, yield, cost, allergen status and actions", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeListScreen view={parseRecipeListView(list())} />
      </MemoryRouter>,
    );
    for (const value of [
      "COMMERCE",
      "REVIEW",
      "RECIPE-LIST · PHASE 2",
      "Recipe management",
      "Synthetic Recipe",
      "1200 USD minor units",
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
      "COMMERCE",
      "REVIEW",
      "RECIPE-EDITOR · PHASE 2",
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
      parseRecipeEditorView({ ...editor(), historySummary: available("https://bad.example") }),
    ).toThrow(RecipeClientError);
    expect(() =>
      parseRecipeEditorView({
        ...editor(),
        cost: available({ amountMinor: 1200, currencyCode: "CAD" }),
      }),
    ).toThrow(RecipeClientError);
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
    const unavailable = renderToStaticMarkup(
      <MemoryRouter>
        <RecipeState state="Unavailable" />
      </MemoryRouter>,
    );
    expect(unavailable).toContain("Recipe data unavailable");
    expect(unavailable).toContain("authorized Recipe source is unavailable");
  });
});
