import { createHash } from "node:crypto";
import { createEffectivePeriod } from "@bop/effective-period";
import { canonicalizeRfc8785 } from "@bop/audit";
import { setImmediate } from "node:timers";
import { describe, expect, it, vi } from "vitest";
import {
  applyRecipeIngredientModifiers,
  createRecipeSnapshot,
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeModifierRule,
  parseRecipeReference,
  type RecipeModifierRule,
  type RecipeSnapshot,
} from "../index.js";

const review = vi.hoisted(() => ({ base: null as unknown, rule: null as unknown }));
vi.mock("../infrastructure/persistence/recipe-binding-store.js", () => ({
  createPostgresBaseRecipeSource: () => ({
    resolve: async () => ({
      bindingReference: "018f9800-0000-7000-8000-000000000032",
      brandReference: "018f9800-0000-7000-8000-00000000000a",
      snapshot: review.base,
    }),
  }),
}));
vi.mock("../infrastructure/persistence/recipe-modifier-store.js", () => ({
  createPostgresRecipeModifierSource: () => ({ resolve: async () => [review.rule] }),
}));
const id = (n: number) =>
  parseRecipeReference(`018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-13T18:00:00.000Z";
const period = {
  timeZone: "America/Toronto",
  effectiveFrom: {
    instant: "2026-08-01T04:00:00.000Z" as never,
    localDateTime: "2026-08-01T00:00:00.000",
    utcOffsetMinutes: -240,
  },
  effectiveUntil: null,
};
const raw = (lifecycle: RecipeSnapshot["lifecycle"] = "Published"): RecipeSnapshot => ({
  recipeReference: id(1),
  versionReference: id(2),
  brandReference: id(10),
  stableCode: parseRecipeCode("SYNTHETIC_RECIPE"),
  aggregateVersion: 1,
  versionNumber: 1,
  snapshotDigest: parseRecipeDigest(`sha256:${"1".repeat(64)}`),
  lifecycle,
  displayNameCode: parseRecipeCode("SYNTHETIC_NAME"),
  yieldQuantityMicrounits: "1000000",
  yieldUnitCode: parseRecipeCode("PORTION"),
  yieldDimension: "Count",
  ingredients: [
    {
      requirementReference: id(20),
      sourceKind: "InventoryItem",
      sourceReference: id(21),
      sourceVersionReference: id(22),
      quantityMicrounits: "1000000",
      unitDimension: "Mass",
      conversionNumerator: "2",
      conversionDenominator: "1",
      lossBasisPoints: 1000,
      unitCostMinorNumerator: "3",
      unitCostDenominator: "1000000",
      allergens: [{ allergenReference: id(30), evidenceReference: id(31), verified: true }],
    },
  ],
  preparationVersionReference: id(40),
  steps: [
    {
      stepReference: id(41),
      sequenceGroup: 0,
      instructionCode: parseRecipeCode("MIX"),
      durationSeconds: 60,
      capabilityCode: parseRecipeCode("PREP"),
    },
  ],
  substitutionPolicyReference: null,
  effectivePeriod: period as never,
  invalidationReasonCode: null,
  createdAt: at,
});
const selection = { bindingReference: id(60), optionReference: id(61), quantity: 1 };
const rawRule = (requirement = id(70)) => ({
  ruleReference: id(62),
  ruleVersionReference: id(63),
  ruleDigest: `sha256:${"2".repeat(64)}`,
  brandReference: id(10),
  recipeVersionReference: id(2),
  selection,
  changes: [
    {
      action: "Add",
      ingredient: {
        requirementReference: requirement,
        sourceKind: "InventoryItem",
        sourceReference: id(71),
        sourceVersionReference: id(72),
        quantityMicrounits: "500000",
        unitDimension: "Volume",
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: 0,
        unitCostMinorNumerator: "1",
        unitCostDenominator: "1000000",
        allergens: [],
      },
    },
  ],
});

/**
 * WP-2423 DEC-MERCHANT-LOCK-SCOPE: a review validates the same frozen values for every choice
 * combination. Only what a validator itself produced is returned unchecked; recipe and allergen
 * data from anywhere else, a spread copy or a raw object included, is fully validated every time.
 */
describe("Recipe validation reuse", () => {
  it("returns exactly what the validator produced and froze", () => {
    const first = createRecipeSnapshot(raw());
    expect(createRecipeSnapshot(first)).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.ingredients)).toBe(true);
    expect(Object.isFrozen(first.ingredients[0]?.allergens)).toBe(true);
    const parsedPeriod = createEffectivePeriod(period as never);
    expect(createEffectivePeriod(parsedPeriod)).toBe(parsedPeriod);
    // A spread copy is new; the frozen members inside it keep their identity.
    const copy = createRecipeSnapshot({ ...first });
    expect(copy).not.toBe(first);
    expect(copy.ingredients[0]).toBe(first.ingredients[0]);
    expect(copy.effectivePeriod).toBe(first.effectivePeriod);
    expect(canonicalizeRfc8785(copy)).toBe(canonicalizeRfc8785(first));
  });
  it("fully validates a spread copy carrying anything it did not produce", () => {
    const first = createRecipeSnapshot(raw());
    expect(() =>
      createRecipeSnapshot({
        ...first,
        ingredients: [{ ...first.ingredients[0], lossBasisPoints: -1 } as never],
      }),
    ).toThrow();
    expect(() =>
      createRecipeSnapshot({
        ...first,
        ingredients: [{ ...first.ingredients[0], extra: 1 } as never],
      }),
    ).toThrow();
    expect(() =>
      createRecipeSnapshot({
        ...first,
        effectivePeriod: { ...first.effectivePeriod, timeZone: "Not/AZone" } as never,
      }),
    ).toThrow();
    // A plain object is never trusted, however often an equal one was validated.
    const plain = raw();
    expect(createRecipeSnapshot(plain)).not.toBe(plain);
    expect(() => createRecipeSnapshot({ ...plain, aggregateVersion: 0 })).toThrow();
  });
  it("still refuses a Published recipe with an unverified allergen from a validated Draft's parts", () => {
    const draft = createRecipeSnapshot({
      ...raw("Draft"),
      ingredients: [
        {
          ...raw().ingredients[0],
          allergens: [{ allergenReference: id(30), evidenceReference: id(31), verified: false }],
        } as never,
      ],
    });
    expect(draft.lifecycle).toBe("Draft");
    expect(() =>
      createRecipeSnapshot({ ...draft, lifecycle: "Published", invalidationReasonCode: null }),
    ).toThrow(expect.objectContaining({ code: "RECIPE_ALLERGEN_UNVERIFIED" }));
  });
  it("keeps a parsed rule only for the exact base it was validated against", () => {
    const base = createRecipeSnapshot(raw());
    const parsed = parseRecipeModifierRule(rawRule(), base);
    expect(parseRecipeModifierRule(parsed, base)).toBe(parsed);
    // A different base object (equal or not) revalidates.
    const other = createRecipeSnapshot({ ...base });
    expect(parseRecipeModifierRule(parsed, other)).not.toBe(parsed);
    const elsewhere = createRecipeSnapshot({ ...base, versionReference: id(3) });
    expect(() => parseRecipeModifierRule(parsed, elsewhere)).toThrow();
  });
  it("revalidates a raw rule every time, also after it was changed", () => {
    const base = createRecipeSnapshot(raw());
    const rule = rawRule();
    const parsed = parseRecipeModifierRule(rule, base);
    expect(parseRecipeModifierRule(rule, base)).not.toBe(parsed);
    (rule.changes[0] as { ingredient: { lossBasisPoints: number } }).ingredient.lossBasisPoints =
      -1;
    expect(() => parseRecipeModifierRule(rule, base)).toThrow();
  });
  it("lets other work in while a review loops over its combinations", async () => {
    const { createPostgresRecipeReviewSource } =
      await import("../infrastructure/persistence/recipe-demand-store.js");
    const base = createRecipeSnapshot(raw());
    review.base = base;
    review.rule = parseRecipeModifierRule(rawRule(), base);
    const source = createPostgresRecipeReviewSource({
      brandReference: id(10),
      authorize: async () => true,
    });
    const configurations = Array.from({ length: 10000 }, () => [selection]);
    let turns = 0,
      running = true;
    const count = () => {
      turns += 1;
      if (running) setImmediate(count);
    };
    setImmediate(count);
    const started = Date.now();
    const results = await source.resolveConfigurations(
      { query: async () => ({ rows: [], rowCount: 0 }) } as never,
      {
        actorType: "User",
        actorReference: id(90),
        action: "ResolveMenuRecipeFacts",
        purpose: "ReviewMenu",
        brandReference: id(10),
        storeReference: id(91),
        skuReference: id(92),
        observedAt: at,
      } as never,
      configurations,
    );
    const took = Date.now() - started;
    running = false;
    expect(results).toHaveLength(10000);
    // Every 15 ms of work at most, so others are never held out for the whole review.
    expect(turns).toBeGreaterThanOrEqual(Math.floor(took / 60));
    expect(turns).toBeGreaterThan(1);
  });
  it("produces byte-identical facts: the digest reviews in flight were recorded with", () => {
    const base = createRecipeSnapshot(raw());
    const rule: RecipeModifierRule = parseRecipeModifierRule(rawRule(), base);
    const configured = applyRecipeIngredientModifiers(base, [selection], [rule]);
    const facts = {
      snapshot: base,
      graph: [createRecipeSnapshot({ ...base, ingredients: configured.ingredients })],
      modifierRules: [rule],
      configuredIngredients: configured.ingredients,
    };
    // Recorded from the code before the reuse (a review's sourceDigest is over these values).
    expect("sha256:" + createHash("sha256").update(canonicalizeRfc8785(facts)).digest("hex")).toBe(
      "sha256:546ce9d346bf4bc048b78632fb12527dca41b85ef33c80d003866fd0fee26d32",
    );
  });
});
