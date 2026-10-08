import { describe, expect, it } from "vitest";
import {
  buildRecipeDraftVersion,
  parseRecipeDraft,
  recipeDraftOf,
  recipeStandardCostCents,
  scaledDecimal,
} from "../domain/recipe-authoring.js";
import { recipeReviewDigest, recipeSnapshotDigest } from "../infrastructure/recipe-digests.js";

const id = (n: number) => "01909a19-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const milk = id(1),
  beans = id(2),
  station = id(3);
const draft = (overrides: Record<string, unknown> = {}) => ({
  name: "Latte 12 oz",
  code: "LATTE-12",
  yieldQuantity: "1",
  yieldUnit: "EACH",
  ingredients: [
    {
      kind: "InventoryItem",
      sourceReference: milk,
      quantity: "0.25",
      lossPercent: "0",
      unitCostCents: "289",
    },
    {
      kind: "InventoryItem",
      sourceReference: beans,
      quantity: "0.018",
      lossPercent: "5",
      unitCostCents: "2450",
    },
  ],
  steps: [
    { sequence: 0, instruction: "Pull a shot.", durationSeconds: 30, capabilityReference: station },
  ],
  ...overrides,
});
const facts = {
  items: new Map([
    [
      milk,
      { configurationOperationReference: id(11), dimension: "Volume", unitCode: "L", active: true },
    ],
    [
      beans,
      { configurationOperationReference: id(12), dimension: "Mass", unitCode: "KG", active: true },
    ],
  ]),
  subRecipes: new Map(),
  capabilityReferences: new Set([station]),
};
const build = (value = draft(), at = "2026-10-07T10:00:00.000Z") => {
  let n = 100;
  return buildRecipeDraftVersion({
    draft: parseRecipeDraft(value),
    facts,
    recipeReference: id(50),
    brandReference: id(51),
    stableCode: "LATTE-12",
    aggregateVersion: 1,
    versionNumber: 1,
    lifecycle: "Draft",
    at,
    nextReference: () => id(++n),
    snapshotDigest: recipeSnapshotDigest,
  });
};

describe("WP-2423 recipe authoring drafts", () => {
  it("builds a Draft version pinned to Item configuration operations", () => {
    const { snapshot, presentation } = build();
    expect(snapshot.lifecycle).toBe("Draft");
    expect(snapshot.ingredients.map((item) => item.sourceVersionReference)).toEqual([
      id(11),
      id(12),
    ]);
    expect(snapshot.ingredients[1]).toMatchObject({
      quantityMicrounits: "18000",
      lossBasisPoints: 500,
      unitCostMinorNumerator: "24500000",
      unitCostDenominator: "10000000000",
    });
    expect(snapshot.steps[0]?.capabilityCode).toMatch(/^CAP-[0-9A-F]{12}$/u);
    expect(presentation.steps[0]?.instruction).toBe("Pull a shot.");
    expect(recipeStandardCostCents(snapshot)).toBe("119");
    expect(recipeDraftOf(snapshot, "Latte 12 oz", presentation)).toEqual(parseRecipeDraft(draft()));
  });
  it("binds the review digest to name, content and kitchen texts", () => {
    const a = build();
    const renamed = recipeReviewDigest(a.snapshot, "Latte", a.presentation);
    expect(renamed).not.toBe(recipeReviewDigest(a.snapshot, "Latte 12 oz", a.presentation));
  });
  it.each([
    ["a lowercase code", { code: "latte" }],
    ["a zero yield", { yieldQuantity: "0" }],
    ["an unknown yield unit", { yieldUnit: "CUP" }],
    ["no ingredients", { ingredients: [] }],
    ["no steps", { steps: [] }],
    ["a blank name", { name: "  " }],
    ["a client field", { author: id(9) }],
  ])("refuses %s", (_name, overrides) => {
    expect(() => parseRecipeDraft(draft(overrides))).toThrow();
  });
  it("names the invalid line", () => {
    expect(() =>
      parseRecipeDraft(
        draft({
          ingredients: [
            {
              kind: "InventoryItem",
              sourceReference: milk,
              quantity: "0.0000001",
              lossPercent: "0",
              unitCostCents: null,
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ code: "RECIPE_AUTHORING_LINE_INVALID", line: 1 }));
    expect(() =>
      build(
        draft({
          steps: [
            { sequence: 0, instruction: "x", durationSeconds: 30, capabilityReference: id(77) },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ line: 1 }));
    expect(() =>
      parseRecipeDraft(
        draft({
          ingredients: [
            {
              kind: "InventoryItem",
              sourceReference: milk,
              quantity: "1",
              lossPercent: "0",
              unitCostCents: "1",
            },
            {
              kind: "InventoryItem",
              sourceReference: milk,
              quantity: "2",
              lossPercent: "0",
              unitCostCents: "1",
            },
          ],
        }),
      ),
    ).toThrow(expect.objectContaining({ line: 2 }));
  });
  it("scales decimals exactly", () => {
    expect(scaledDecimal("0.018", 6)).toBe(18000n);
    expect(() => scaledDecimal("01", 6)).toThrow();
    expect(() => scaledDecimal("1.1234567", 6)).toThrow();
  });
});
