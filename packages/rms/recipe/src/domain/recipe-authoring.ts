import {
  createRecipeSnapshot,
  parseRecipeReference,
  type RecipeDigest,
  type RecipeSnapshot,
  type UnitDimension,
} from "./recipe.js";

/**
 * WP-2423 / DEC-RECIPE-AUTHORING: Merchant recipe drafts. A draft names its yield (portions sold as a
 * SKU, or a batch measured by mass or volume), its ingredients (Inventory Items in their base unit, or
 * published sub-recipes in their yield unit) with loss and standard cost, and its kitchen steps (text,
 * duration, kitchen station capability). Every save creates a new immutable Recipe version.
 */
export type RecipeAuthoringErrorCode =
  | "RECIPE_AUTHORING_INVALID"
  | "RECIPE_AUTHORING_LINE_INVALID"
  | "RECIPE_AUTHORING_NOT_FOUND"
  | "RECIPE_AUTHORING_CONFLICT"
  | "RECIPE_AUTHORING_CODE_TAKEN"
  | "RECIPE_AUTHORING_REVIEW_REQUIRED"
  | "RECIPE_AUTHORING_REVIEWER_NOT_INDEPENDENT"
  | "RECIPE_AUTHORING_LIFECYCLE"
  | "RECIPE_AUTHORING_IN_USE"
  | "RECIPE_AUTHORING_ALLERGEN_UNDECLARED";
export class RecipeAuthoringError extends Error {
  constructor(
    readonly code: RecipeAuthoringErrorCode,
    readonly line: number | null = null,
  ) {
    super(code);
    this.name = "RecipeAuthoringError";
  }
}
const invalid = (line: number | null = null): never => {
  throw new RecipeAuthoringError(
    line === null ? "RECIPE_AUTHORING_INVALID" : "RECIPE_AUTHORING_LINE_INVALID",
    line,
  );
};

export const recipeYieldUnits: Readonly<Record<string, UnitDimension>> = Object.freeze({
  EACH: "Count",
  KG: "Mass",
  G: "Mass",
  L: "Volume",
  ML: "Volume",
});
export interface RecipeDraftIngredient {
  readonly kind: "InventoryItem" | "SubRecipe";
  readonly sourceReference: string;
  /** In the Item's base unit, or the sub-recipe's yield unit; up to 6 decimals. */
  readonly quantity: string;
  /** Preparation loss as a percentage, up to 2 decimals (0–100). */
  readonly lossPercent: string;
  /** Standard cost in CAD cents per base unit, up to 4 decimals (Inventory Items only). */
  readonly unitCostCents: string | null;
}
export interface RecipeDraftStep {
  readonly sequence: number;
  readonly instruction: string;
  readonly durationSeconds: number;
  readonly capabilityReference: string;
}
export interface RecipeDraft {
  readonly name: string;
  readonly code: string;
  readonly yieldQuantity: string;
  readonly yieldUnit: string;
  readonly ingredients: readonly RecipeDraftIngredient[];
  readonly steps: readonly RecipeDraftStep[];
}
/** Kitchen texts and stations per step, in the snapshot's step order. */
export interface RecipePresentation {
  readonly profile: "RecipePresentationV1";
  readonly steps: readonly {
    readonly stepReference: string;
    readonly instruction: string;
    readonly capabilityReference: string;
  }[];
  readonly ingredientCosts: readonly {
    readonly requirementReference: string;
    readonly unitCostCents: string | null;
  }[];
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const codePattern = /^[A-Z][A-Z0-9_-]{1,39}$/u;
function closed(value: unknown, fields: readonly string[], line: number | null = null) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !== [...fields].sort().join(",")
  )
    return invalid(line);
  return value as Record<string, unknown>;
}
function text(value: unknown, maximum: number, line: number | null = null): string {
  if (typeof value !== "string" || !value.isWellFormed()) return invalid(line);
  const normalized = value.normalize("NFC").trim();
  if (
    normalized.length === 0 ||
    [...normalized].length > maximum ||
    /[\p{Cc}\p{Cf}\u2028\u2029]/u.test(normalized)
  )
    return invalid(line);
  return normalized;
}
/** Exact decimal to integer units at a fixed scale; refuses more fraction digits than the scale. */
export function scaledDecimal(value: unknown, scale: number, line: number | null = null): bigint {
  if (typeof value !== "string") return invalid(line);
  const match = /^(0|[1-9]\d{0,11})(?:\.(\d+))?$/u.exec(value);
  if (!match || (match[2]?.length ?? 0) > scale) return invalid(line);
  return BigInt((match[1] ?? "0") + (match[2] ?? "").padEnd(scale, "0"));
}
function reference(value: unknown, line: number | null = null): string {
  return typeof value === "string" && uuid.test(value) ? value : invalid(line);
}

export function parseRecipeDraft(value: unknown): RecipeDraft {
  const r = closed(value, ["name", "code", "yieldQuantity", "yieldUnit", "ingredients", "steps"]);
  const yieldUnit = typeof r.yieldUnit === "string" ? r.yieldUnit : "";
  if (
    recipeYieldUnits[yieldUnit] === undefined ||
    typeof r.code !== "string" ||
    !codePattern.test(r.code) ||
    scaledDecimal(r.yieldQuantity, 6) === 0n ||
    !Array.isArray(r.ingredients) ||
    r.ingredients.length < 1 ||
    r.ingredients.length > 100 ||
    !Array.isArray(r.steps) ||
    r.steps.length < 1 ||
    r.steps.length > 50
  )
    return invalid();
  const sources = new Set<string>();
  const ingredients = r.ingredients.map((raw: unknown, index: number) => {
    const line = index + 1;
    const i = closed(
      raw,
      ["kind", "sourceReference", "quantity", "lossPercent", "unitCostCents"],
      line,
    );
    if (i.kind !== "InventoryItem" && i.kind !== "SubRecipe") return invalid(line);
    const source = reference(i.sourceReference, line);
    if (sources.has(i.kind + ":" + source)) return invalid(line);
    sources.add(i.kind + ":" + source);
    if (
      scaledDecimal(i.quantity, 6, line) === 0n ||
      scaledDecimal(i.lossPercent, 2, line) > 10_000n ||
      (i.kind === "SubRecipe" && i.unitCostCents !== null) ||
      (i.unitCostCents !== null && scaledDecimal(i.unitCostCents, 4, line) > 10_000_000_000n)
    )
      return invalid(line);
    return Object.freeze({
      kind: i.kind,
      sourceReference: source,
      quantity: i.quantity as string,
      lossPercent: i.lossPercent as string,
      unitCostCents: i.unitCostCents as string | null,
    });
  });
  const steps = r.steps.map((raw: unknown, index: number) => {
    const line = index + 1;
    const s = closed(
      raw,
      ["sequence", "instruction", "durationSeconds", "capabilityReference"],
      line,
    );
    if (
      !Number.isSafeInteger(s.sequence) ||
      (s.sequence as number) < 0 ||
      (s.sequence as number) > 99 ||
      !Number.isSafeInteger(s.durationSeconds) ||
      (s.durationSeconds as number) < 1 ||
      (s.durationSeconds as number) > 86_400
    )
      return invalid(line);
    return Object.freeze({
      sequence: s.sequence as number,
      instruction: text(s.instruction, 500, line),
      durationSeconds: s.durationSeconds as number,
      capabilityReference: reference(s.capabilityReference, line),
    });
  });
  return Object.freeze({
    name: text(r.name, 120),
    code: r.code,
    yieldQuantity: r.yieldQuantity as string,
    yieldUnit,
    ingredients: Object.freeze(ingredients),
    steps: Object.freeze(steps),
  });
}

/** Current owning facts the draft refers to, resolved by the caller from their owners. */
export interface RecipeDraftFacts {
  readonly items: ReadonlyMap<
    string,
    {
      readonly configurationOperationReference: string;
      readonly dimension: string;
      readonly unitCode: string;
      readonly active: boolean;
      /**
       * WP-2423 / DEC-ALLERGEN-DECLARATIONS: the item's current, valid allergen declaration for
       * this item version (its allergens may be none), or null when the item has none.
       */
      readonly allergenDeclaration?: {
        readonly evidenceReference: string;
        readonly allergenReferences: readonly string[];
      } | null;
    }
  >;
  readonly subRecipes: ReadonlyMap<
    string,
    {
      readonly versionReference: string;
      readonly yieldDimension: UnitDimension;
      readonly yieldUnitCode: string;
    }
  >;
  readonly capabilityReferences: ReadonlySet<string>;
}
/** The requirement's allergens from the ingredient declaration (empty and undeclared without one). */
function allergensOf(
  declaration: {
    readonly evidenceReference: string;
    readonly allergenReferences: readonly string[];
  } | null,
) {
  if (declaration === null) return { allergens: [] };
  const evidence = parseRecipeReference(declaration.evidenceReference);
  return {
    allergens: [...new Set(declaration.allergenReferences)].sort().map((allergen) => ({
      allergenReference: parseRecipeReference(allergen),
      evidenceReference: evidence,
      verified: true,
    })),
    allergenDeclarationReference: evidence,
  };
}
const stepCode = (reference: string) =>
  "CAP-" + reference.replaceAll("-", "").slice(-12).toUpperCase();

/**
 * Builds the immutable Draft version (new requirement, step and preparation references every
 * version) and its presentation. Refuses references that are not current facts of the Brand.
 */
export function buildRecipeDraftVersion(input: {
  readonly draft: RecipeDraft;
  readonly facts: RecipeDraftFacts;
  readonly recipeReference: string;
  readonly brandReference: string;
  readonly stableCode: string;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly lifecycle: "Draft" | "Published";
  readonly at: string;
  readonly nextReference: () => string;
  /** Content digest of the version without its own digest (infrastructure supplies SHA-256). */
  readonly snapshotDigest: (core: Omit<RecipeSnapshot, "snapshotDigest">) => RecipeDigest;
}): { readonly snapshot: RecipeSnapshot; readonly presentation: RecipePresentation } {
  const { draft, facts } = input;
  const yieldDimension = recipeYieldUnits[draft.yieldUnit] as UnitDimension;
  const ingredients = draft.ingredients.map((ingredient, index) => {
    const line = index + 1;
    const quantity = scaledDecimal(ingredient.quantity, 6, line);
    const loss = Number(scaledDecimal(ingredient.lossPercent, 2, line));
    if (ingredient.kind === "InventoryItem") {
      const item = facts.items.get(ingredient.sourceReference);
      if (
        item === undefined ||
        !item.active ||
        !["Mass", "Volume", "Count"].includes(item.dimension)
      )
        return invalid(line);
      const cost =
        ingredient.unitCostCents === null ? 0n : scaledDecimal(ingredient.unitCostCents, 4, line);
      return {
        requirementReference: parseRecipeReference(input.nextReference()),
        sourceKind: "InventoryItem" as const,
        sourceReference: parseRecipeReference(ingredient.sourceReference),
        sourceVersionReference: parseRecipeReference(item.configurationOperationReference),
        quantityMicrounits: quantity.toString(),
        unitDimension: item.dimension as UnitDimension,
        conversionNumerator: "1",
        conversionDenominator: "1",
        lossBasisPoints: loss,
        // Cents per base unit with 4 decimals, applied to microunits: cost = q·c / (10^6·10^4).
        unitCostMinorNumerator: cost.toString(),
        unitCostDenominator: "10000000000",
        ...allergensOf(item.allergenDeclaration ?? null),
      };
    }
    const sub = facts.subRecipes.get(ingredient.sourceReference);
    if (sub === undefined || ingredient.sourceReference === input.recipeReference)
      return invalid(line);
    return {
      requirementReference: parseRecipeReference(input.nextReference()),
      sourceKind: "SubRecipe" as const,
      sourceReference: parseRecipeReference(ingredient.sourceReference),
      sourceVersionReference: parseRecipeReference(sub.versionReference),
      quantityMicrounits: quantity.toString(),
      unitDimension: sub.yieldDimension,
      conversionNumerator: "1",
      conversionDenominator: "1",
      lossBasisPoints: loss,
      unitCostMinorNumerator: "0",
      unitCostDenominator: "1",
      allergens: [],
    };
  });
  const steps = draft.steps.map((step, index) => {
    if (!facts.capabilityReferences.has(step.capabilityReference)) return invalid(index + 1);
    return {
      stepReference: parseRecipeReference(input.nextReference()),
      sequenceGroup: step.sequence,
      instructionCode: "STEP-" + String(index + 1),
      durationSeconds: step.durationSeconds,
      capabilityCode: stepCode(step.capabilityReference),
    };
  });
  const core = {
    recipeReference: parseRecipeReference(input.recipeReference),
    versionReference: parseRecipeReference(input.nextReference()),
    brandReference: parseRecipeReference(input.brandReference),
    stableCode: input.stableCode,
    aggregateVersion: input.aggregateVersion,
    versionNumber: input.versionNumber,
    lifecycle: input.lifecycle,
    displayNameCode: input.stableCode,
    yieldQuantityMicrounits: scaledDecimal(draft.yieldQuantity, 6).toString(),
    yieldUnitCode: draft.yieldUnit,
    yieldDimension,
    ingredients,
    preparationVersionReference: parseRecipeReference(input.nextReference()),
    steps,
    substitutionPolicyReference: null,
    effectivePeriod: {
      timeZone: "UTC",
      effectiveFrom: {
        instant: input.at,
        localDateTime: input.at.slice(0, -1),
        utcOffsetMinutes: 0,
      },
      effectiveUntil: null,
    },
    invalidationReasonCode: null,
    createdAt: input.at,
  };
  const snapshot = createRecipeSnapshot({
    ...core,
    snapshotDigest: input.snapshotDigest(core as never),
  } as never);
  const presentation: RecipePresentation = Object.freeze({
    profile: "RecipePresentationV1",
    steps: Object.freeze(
      snapshot.steps.map((step, index) =>
        Object.freeze({
          stepReference: step.stepReference,
          instruction: draft.steps[index]?.instruction ?? invalid(index + 1),
          capabilityReference: draft.steps[index]?.capabilityReference ?? invalid(index + 1),
        }),
      ),
    ),
    ingredientCosts: Object.freeze(
      snapshot.ingredients.map((requirement, index) =>
        Object.freeze({
          requirementReference: requirement.requirementReference,
          unitCostCents: draft.ingredients[index]?.unitCostCents ?? null,
        }),
      ),
    ),
  });
  return { snapshot, presentation };
}

/** The draft as an author edits it, recovered from a stored version and its presentation. */
export function recipeDraftOf(
  snapshot: RecipeSnapshot,
  displayName: string,
  presentation: RecipePresentation,
): RecipeDraft {
  const decimal = (micro: string, scale: number) => {
    const digits = micro.padStart(scale + 1, "0");
    const whole = digits.slice(0, -scale),
      fraction = digits.slice(-scale).replace(/0+$/u, "");
    return fraction ? whole + "." + fraction : whole;
  };
  return Object.freeze({
    name: displayName,
    code: snapshot.stableCode,
    yieldQuantity: decimal(snapshot.yieldQuantityMicrounits, 6),
    yieldUnit: snapshot.yieldUnitCode,
    ingredients: snapshot.ingredients.map((requirement, index) => ({
      kind: requirement.sourceKind,
      sourceReference: requirement.sourceReference,
      quantity: decimal(requirement.quantityMicrounits, 6),
      lossPercent: decimal(String(requirement.lossBasisPoints), 2),
      unitCostCents:
        requirement.sourceKind === "InventoryItem"
          ? (presentation.ingredientCosts[index]?.unitCostCents ?? null)
          : null,
    })),
    steps: snapshot.steps.map((step, index) => ({
      sequence: step.sequenceGroup,
      instruction: presentation.steps[index]?.instruction ?? "",
      durationSeconds: step.durationSeconds,
      capabilityReference: presentation.steps[index]?.capabilityReference ?? "",
    })),
  });
}

/** Theoretical cost of one yield in CAD cents (sub-recipes excluded), rounded half-even. */
export function recipeStandardCostCents(snapshot: RecipeSnapshot): string {
  let numerator = 0n;
  const denominator = 1_000_000n * 10_000n * 10_000n;
  for (const requirement of snapshot.ingredients) {
    if (requirement.sourceKind !== "InventoryItem") continue;
    // quantity(µ) × (1 + loss) × cents·10^4 → cents × 10^6 × 10^4 × 10^4
    numerator +=
      BigInt(requirement.quantityMicrounits) *
      BigInt(10_000 + requirement.lossBasisPoints) *
      BigInt(requirement.unitCostMinorNumerator);
  }
  const quotient = numerator / denominator,
    remainder = numerator % denominator;
  const twice = remainder * 2n;
  return (
    twice > denominator || (twice === denominator && quotient % 2n === 1n)
      ? quotient + 1n
      : quotient
  ).toString();
}
