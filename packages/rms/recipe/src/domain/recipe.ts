import { createEffectivePeriod, type EffectivePeriod } from "@bop/effective-period";

export type RecipeReference = string & { readonly __recipeReference: unique symbol };
export type RecipeCode = string & { readonly __recipeCode: unique symbol };
export type RecipeDigest = string & { readonly __recipeDigest: unique symbol };
export type RecipeLifecycle = "Draft" | "Published" | "Invalidated" | "Archived";
export type UnitDimension = "Mass" | "Volume" | "Count";

export interface AllergenEvidence {
  readonly allergenReference: RecipeReference;
  readonly evidenceReference: RecipeReference;
  readonly verified: boolean;
}
export interface IngredientRequirement {
  readonly requirementReference: RecipeReference;
  readonly sourceKind: "InventoryItem" | "SubRecipe";
  readonly sourceReference: RecipeReference;
  readonly sourceVersionReference: RecipeReference;
  readonly quantityMicrounits: string;
  readonly unitDimension: UnitDimension;
  readonly conversionNumerator: string;
  readonly conversionDenominator: string;
  readonly lossBasisPoints: number;
  readonly unitCostMinorNumerator: string;
  readonly unitCostDenominator: string;
  readonly allergens: readonly AllergenEvidence[];
}
export interface PreparationStep {
  readonly stepReference: RecipeReference;
  readonly sequenceGroup: number;
  readonly instructionCode: RecipeCode;
  readonly durationSeconds: number;
  readonly capabilityCode: RecipeCode;
}
export interface RecipeSnapshot {
  readonly recipeReference: RecipeReference;
  readonly versionReference: RecipeReference;
  readonly brandReference: RecipeReference;
  readonly stableCode: RecipeCode;
  readonly aggregateVersion: number;
  readonly versionNumber: number;
  readonly snapshotDigest: RecipeDigest;
  readonly lifecycle: RecipeLifecycle;
  readonly displayNameCode: RecipeCode;
  readonly yieldQuantityMicrounits: string;
  readonly yieldUnitCode: RecipeCode;
  readonly yieldDimension: UnitDimension;
  readonly ingredients: readonly IngredientRequirement[];
  readonly preparationVersionReference: RecipeReference;
  readonly steps: readonly PreparationStep[];
  readonly substitutionPolicyReference: RecipeReference | null;
  readonly effectivePeriod: EffectivePeriod;
  readonly invalidationReasonCode: RecipeCode | null;
  readonly createdAt: string;
}
export interface RecipeCalculation {
  readonly recipeReference: RecipeReference;
  readonly versionReference: RecipeReference;
  readonly yieldQuantityMicrounits: string;
  readonly totalCostMinor: string;
  readonly allergenReferences: readonly RecipeReference[];
  readonly requirements: readonly {
    readonly requirementReference: RecipeReference;
    readonly sourceReference: RecipeReference;
    readonly baseQuantityMicrounits: string;
    readonly costMinor: string;
  }[];
}

export type RecipeErrorCode =
  | "RECIPE_INPUT_INVALID"
  | "RECIPE_GRAPH_CYCLE"
  | "RECIPE_GRAPH_UNRESOLVED"
  | "RECIPE_ALLERGEN_UNVERIFIED";
export class RecipeError extends Error {
  constructor(readonly code: RecipeErrorCode) {
    super("Recipe is unavailable");
    this.name = "RecipeError";
  }
}
const fail = (code: RecipeErrorCode): never => {
  throw new RecipeError(code);
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const code = /^[A-Z][A-Z0-9_-]{0,63}$/u;
const digest = /^sha256:[0-9a-f]{64}$/u;
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export function parseRecipeReference(value: unknown): RecipeReference {
  if (typeof value !== "string" || !uuid.test(value)) return fail("RECIPE_INPUT_INVALID");
  return value as RecipeReference;
}
export function parseRecipeCode(value: unknown): RecipeCode {
  if (typeof value !== "string" || !code.test(value)) return fail("RECIPE_INPUT_INVALID");
  return value as RecipeCode;
}
export function parseRecipeDigest(value: unknown): RecipeDigest {
  if (typeof value !== "string" || !digest.test(value)) return fail("RECIPE_INPUT_INVALID");
  return value as RecipeDigest;
}
function instant(value: unknown) {
  if (
    typeof value !== "string" ||
    !instantPattern.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return fail("RECIPE_INPUT_INVALID");
  return value;
}
function natural(value: unknown, positive = false): bigint {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/u.test(value))
    return fail("RECIPE_INPUT_INVALID");
  const parsed = BigInt(value);
  if ((positive && parsed === 0n) || parsed > 10n ** 30n) return fail("RECIPE_INPUT_INVALID");
  return parsed;
}
function plain(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length ||
    Reflect.ownKeys(value).some((key) => typeof key !== "string" || !keys.includes(key))
  )
    return fail("RECIPE_INPUT_INVALID");
  return value as Record<string, unknown>;
}
function allergen(value: unknown): AllergenEvidence {
  const raw = plain(value, ["allergenReference", "evidenceReference", "verified"]);
  if (typeof raw.verified !== "boolean") return fail("RECIPE_INPUT_INVALID");
  return Object.freeze({
    allergenReference: parseRecipeReference(raw.allergenReference),
    evidenceReference: parseRecipeReference(raw.evidenceReference),
    verified: raw.verified,
  });
}
function ingredient(value: unknown): IngredientRequirement {
  const raw = plain(value, [
    "requirementReference",
    "sourceKind",
    "sourceReference",
    "sourceVersionReference",
    "quantityMicrounits",
    "unitDimension",
    "conversionNumerator",
    "conversionDenominator",
    "lossBasisPoints",
    "unitCostMinorNumerator",
    "unitCostDenominator",
    "allergens",
  ]);
  if (
    (raw.sourceKind !== "InventoryItem" && raw.sourceKind !== "SubRecipe") ||
    !["Mass", "Volume", "Count"].includes(raw.unitDimension as string) ||
    !Number.isSafeInteger(raw.lossBasisPoints) ||
    (raw.lossBasisPoints as number) < 0 ||
    (raw.lossBasisPoints as number) > 10000 ||
    !Array.isArray(raw.allergens)
  )
    return fail("RECIPE_INPUT_INVALID");
  const allergens = raw.allergens.map(allergen);
  if (new Set(allergens.map((item) => item.allergenReference)).size !== allergens.length)
    return fail("RECIPE_INPUT_INVALID");
  return Object.freeze({
    requirementReference: parseRecipeReference(raw.requirementReference),
    sourceKind: raw.sourceKind,
    sourceReference: parseRecipeReference(raw.sourceReference),
    sourceVersionReference: parseRecipeReference(raw.sourceVersionReference),
    quantityMicrounits: natural(raw.quantityMicrounits, true).toString(),
    unitDimension: raw.unitDimension as UnitDimension,
    conversionNumerator: natural(raw.conversionNumerator, true).toString(),
    conversionDenominator: natural(raw.conversionDenominator, true).toString(),
    lossBasisPoints: raw.lossBasisPoints as number,
    unitCostMinorNumerator: natural(raw.unitCostMinorNumerator).toString(),
    unitCostDenominator: natural(raw.unitCostDenominator, true).toString(),
    allergens: Object.freeze(allergens),
  });
}
function step(value: unknown): PreparationStep {
  const raw = plain(value, [
    "stepReference",
    "sequenceGroup",
    "instructionCode",
    "durationSeconds",
    "capabilityCode",
  ]);
  if (
    !Number.isSafeInteger(raw.sequenceGroup) ||
    (raw.sequenceGroup as number) < 0 ||
    !Number.isSafeInteger(raw.durationSeconds) ||
    (raw.durationSeconds as number) < 1 ||
    (raw.durationSeconds as number) > 86400
  )
    return fail("RECIPE_INPUT_INVALID");
  return Object.freeze({
    stepReference: parseRecipeReference(raw.stepReference),
    sequenceGroup: raw.sequenceGroup as number,
    instructionCode: parseRecipeCode(raw.instructionCode),
    durationSeconds: raw.durationSeconds as number,
    capabilityCode: parseRecipeCode(raw.capabilityCode),
  });
}

export function createRecipeSnapshot(input: RecipeSnapshot): RecipeSnapshot {
  const raw = plain(input, [
    "recipeReference",
    "versionReference",
    "brandReference",
    "stableCode",
    "aggregateVersion",
    "versionNumber",
    "snapshotDigest",
    "lifecycle",
    "displayNameCode",
    "yieldQuantityMicrounits",
    "yieldUnitCode",
    "yieldDimension",
    "ingredients",
    "preparationVersionReference",
    "steps",
    "substitutionPolicyReference",
    "effectivePeriod",
    "invalidationReasonCode",
    "createdAt",
  ]);
  if (
    !Number.isSafeInteger(raw.aggregateVersion) ||
    (raw.aggregateVersion as number) < 1 ||
    !Number.isSafeInteger(raw.versionNumber) ||
    (raw.versionNumber as number) < 1 ||
    !["Draft", "Published", "Invalidated", "Archived"].includes(raw.lifecycle as string) ||
    !["Mass", "Volume", "Count"].includes(raw.yieldDimension as string) ||
    !Array.isArray(raw.ingredients) ||
    raw.ingredients.length === 0 ||
    raw.ingredients.length > 256 ||
    !Array.isArray(raw.steps) ||
    raw.steps.length === 0 ||
    raw.steps.length > 128
  )
    return fail("RECIPE_INPUT_INVALID");
  const ingredients = raw.ingredients.map(ingredient);
  const steps = raw.steps.map(step);
  if (
    new Set(ingredients.map((item) => item.requirementReference)).size !== ingredients.length ||
    new Set(steps.map((item) => item.stepReference)).size !== steps.length
  )
    return fail("RECIPE_INPUT_INVALID");
  if (
    raw.lifecycle === "Published" &&
    ingredients.some((item) => item.allergens.some((evidence) => !evidence.verified))
  )
    return fail("RECIPE_ALLERGEN_UNVERIFIED");
  if ((raw.lifecycle === "Invalidated") !== (raw.invalidationReasonCode !== null))
    return fail("RECIPE_INPUT_INVALID");
  let effectivePeriod: EffectivePeriod;
  try {
    effectivePeriod = createEffectivePeriod(raw.effectivePeriod as EffectivePeriod);
  } catch {
    return fail("RECIPE_INPUT_INVALID");
  }
  return Object.freeze({
    recipeReference: parseRecipeReference(raw.recipeReference),
    versionReference: parseRecipeReference(raw.versionReference),
    brandReference: parseRecipeReference(raw.brandReference),
    stableCode: parseRecipeCode(raw.stableCode),
    aggregateVersion: raw.aggregateVersion as number,
    versionNumber: raw.versionNumber as number,
    snapshotDigest: parseRecipeDigest(raw.snapshotDigest),
    lifecycle: raw.lifecycle as RecipeLifecycle,
    displayNameCode: parseRecipeCode(raw.displayNameCode),
    yieldQuantityMicrounits: natural(raw.yieldQuantityMicrounits, true).toString(),
    yieldUnitCode: parseRecipeCode(raw.yieldUnitCode),
    yieldDimension: raw.yieldDimension as UnitDimension,
    ingredients: Object.freeze(ingredients),
    preparationVersionReference: parseRecipeReference(raw.preparationVersionReference),
    steps: Object.freeze(steps),
    substitutionPolicyReference:
      raw.substitutionPolicyReference === null
        ? null
        : parseRecipeReference(raw.substitutionPolicyReference),
    effectivePeriod,
    invalidationReasonCode:
      raw.invalidationReasonCode === null ? null : parseRecipeCode(raw.invalidationReasonCode),
    createdAt: instant(raw.createdAt),
  });
}

function divideHalfUp(numerator: bigint, denominator: bigint) {
  return (numerator * 2n + denominator) / (denominator * 2n);
}
export function calculateRecipe(snapshotInput: RecipeSnapshot): RecipeCalculation {
  const snapshot = createRecipeSnapshot(snapshotInput);
  const allergens = new Set<RecipeReference>();
  let totalCost = 0n;
  const requirements = snapshot.ingredients.map((item) => {
    const converted = divideHalfUp(
      BigInt(item.quantityMicrounits) * BigInt(item.conversionNumerator),
      BigInt(item.conversionDenominator),
    );
    const baseQuantity = divideHalfUp(converted * BigInt(10000 + item.lossBasisPoints), 10000n);
    const cost = divideHalfUp(
      baseQuantity * BigInt(item.unitCostMinorNumerator),
      BigInt(item.unitCostDenominator),
    );
    totalCost += cost;
    for (const evidence of item.allergens) {
      if (!evidence.verified) return fail("RECIPE_ALLERGEN_UNVERIFIED");
      allergens.add(evidence.allergenReference);
    }
    return Object.freeze({
      requirementReference: item.requirementReference,
      sourceReference: item.sourceReference,
      baseQuantityMicrounits: baseQuantity.toString(),
      costMinor: cost.toString(),
    });
  });
  return Object.freeze({
    recipeReference: snapshot.recipeReference,
    versionReference: snapshot.versionReference,
    yieldQuantityMicrounits: snapshot.yieldQuantityMicrounits,
    totalCostMinor: totalCost.toString(),
    allergenReferences: Object.freeze([...allergens].sort()),
    requirements: Object.freeze(requirements),
  });
}

export function validateRecipeGraph(
  rootInput: RecipeSnapshot,
  availableInputs: readonly RecipeSnapshot[],
) {
  const root = createRecipeSnapshot(rootInput);
  const available = new Map(
    availableInputs.map((input) => {
      const snapshot = createRecipeSnapshot(input);
      return [snapshot.versionReference, snapshot] as const;
    }),
  );
  available.set(root.versionReference, root);
  const visiting = new Set<RecipeReference>();
  const visited = new Set<RecipeReference>();
  const visit = (snapshot: RecipeSnapshot, depth: number): void => {
    if (depth > 16) return fail("RECIPE_GRAPH_UNRESOLVED");
    if (visiting.has(snapshot.versionReference)) return fail("RECIPE_GRAPH_CYCLE");
    if (visited.has(snapshot.versionReference)) return;
    visiting.add(snapshot.versionReference);
    for (const item of snapshot.ingredients.filter(
      (candidate) => candidate.sourceKind === "SubRecipe",
    )) {
      const child = available.get(item.sourceVersionReference);
      if (child === undefined || child.recipeReference !== item.sourceReference)
        return fail("RECIPE_GRAPH_UNRESOLVED");
      visit(child, depth + 1);
    }
    visiting.delete(snapshot.versionReference);
    visited.add(snapshot.versionReference);
  };
  visit(root, 0);
  return true as const;
}
