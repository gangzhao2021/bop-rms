import {
  createRecipeSnapshot,
  parseRecipeCode,
  parseRecipeReference,
  parseRecipeYieldQuantityMicrounits,
  RecipeError,
  type RecipeCode,
  type RecipeReference,
  type RecipeSnapshot,
  type UnitDimension,
} from "./recipe.js";

export type RecipeMeasurementConversionKind =
  | "InventoryBaseUnitIdentity"
  | "InventoryRecordedConversion"
  | "PinnedSubrecipeYieldIdentity"
  | "StandardDimensionConversion";
export interface RecipeIngredientMeasurement {
  readonly requirementReference: RecipeReference;
  readonly usageUnitCode: RecipeCode;
  readonly usageDimension: UnitDimension;
  readonly targetUnitCode: RecipeCode;
  readonly targetDimension: UnitDimension;
  readonly conversionKind: RecipeMeasurementConversionKind;
  readonly conversionReference: RecipeReference | null;
}
/** New complete content representation; syntax does not establish owning provenance.
 * Existing snapshots/writers do not accept this envelope as publication authority. */
export interface RecipeMeasurementContentV2 {
  readonly profile: "RecipeMeasurementContentV2";
  readonly snapshot: RecipeSnapshot;
  readonly measurements: readonly RecipeIngredientMeasurement[];
}
const fail = (): never => {
  throw new RecipeError("RECIPE_INPUT_INVALID");
};
function record(value: unknown, keys: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== keys.length
  )
    return fail();
  const result: Record<string, unknown> = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    result[key] = descriptor.value;
  }
  return result;
}
function list(value: unknown): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length < 1 ||
    value.length > 256 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
    if (!descriptor?.enumerable || !("value" in descriptor)) return fail();
    return descriptor.value;
  });
}
function dimension(value: unknown): UnitDimension {
  if (value !== "Mass" && value !== "Volume" && value !== "Count") return fail();
  return value;
}
/** Exact accepted same-dimensional standards, with explicit endpoints.
 * Unknown unit names and item-specific rules must be resolved by their owning source. */
function standard(row: RecipeIngredientMeasurement): readonly [bigint, bigint] {
  if (row.usageDimension !== row.targetDimension) return fail();
  const pair = `${row.usageUnitCode}:${row.targetUnitCode}`;
  if (
    (row.usageDimension === "Mass" && pair === "KG:G") ||
    (row.usageDimension === "Volume" && pair === "L:ML")
  )
    return [1000n, 1n];
  if (
    (row.usageDimension === "Mass" && pair === "G:KG") ||
    (row.usageDimension === "Volume" && pair === "ML:L")
  )
    return [1n, 1000n];
  return fail();
}
export function createRecipeMeasurementContentV2(value: unknown): RecipeMeasurementContentV2 {
  const raw = record(value, ["profile", "snapshot", "measurements"]);
  if (raw.profile !== "RecipeMeasurementContentV2") return fail();
  const snapshot = createRecipeSnapshot(raw.snapshot as RecipeSnapshot);
  const requirements = new Map(snapshot.ingredients.map((r) => [r.requirementReference, r]));
  const measurements = list(raw.measurements)
    .map((value) => {
      const r = record(value, [
        "requirementReference",
        "usageUnitCode",
        "usageDimension",
        "targetUnitCode",
        "targetDimension",
        "conversionKind",
        "conversionReference",
      ]);
      const reference = parseRecipeReference(r.requirementReference),
        requirement = requirements.get(reference);
      if (!requirement) return fail();
      const usageDimension = dimension(r.usageDimension),
        targetDimension = dimension(r.targetDimension);
      if (usageDimension !== requirement.unitDimension) return fail();
      const usageUnitCode = parseRecipeCode(r.usageUnitCode),
        targetUnitCode = parseRecipeCode(r.targetUnitCode);
      if (
        ![
          "InventoryBaseUnitIdentity",
          "InventoryRecordedConversion",
          "PinnedSubrecipeYieldIdentity",
          "StandardDimensionConversion",
        ].includes(r.conversionKind as string)
      )
        return fail();
      const conversionKind = r.conversionKind as RecipeMeasurementConversionKind;
      const conversionReference =
        r.conversionReference === null ? null : parseRecipeReference(r.conversionReference);
      parseRecipeYieldQuantityMicrounits(requirement.quantityMicrounits);
      const numerator = BigInt(parseRecipeYieldQuantityMicrounits(requirement.conversionNumerator)),
        denominator = BigInt(parseRecipeYieldQuantityMicrounits(requirement.conversionDenominator));
      const row = Object.freeze({
        requirementReference: reference,
        usageUnitCode,
        usageDimension,
        targetUnitCode,
        targetDimension,
        conversionKind,
        conversionReference,
      });
      if (conversionKind === "InventoryRecordedConversion") {
        if (
          requirement.sourceKind !== "InventoryItem" ||
          conversionReference === null ||
          usageUnitCode === targetUnitCode
        )
          return fail();
      } else {
        if (conversionReference !== null) return fail();
        if (conversionKind === "StandardDimensionConversion") {
          const [expectedNumerator, expectedDenominator] = standard(row);
          if (numerator * expectedDenominator !== denominator * expectedNumerator) return fail();
        } else {
          if (
            (conversionKind === "InventoryBaseUnitIdentity" &&
              requirement.sourceKind !== "InventoryItem") ||
            (conversionKind === "PinnedSubrecipeYieldIdentity" &&
              requirement.sourceKind !== "SubRecipe") ||
            usageUnitCode !== targetUnitCode ||
            usageDimension !== targetDimension ||
            numerator !== denominator
          )
            return fail();
        }
      }
      return row;
    })
    .sort((a, b) => a.requirementReference.localeCompare(b.requirementReference));
  if (
    measurements.length !== requirements.size ||
    new Set(measurements.map((r) => r.requirementReference)).size !== requirements.size
  )
    return fail();
  return Object.freeze({
    profile: "RecipeMeasurementContentV2",
    snapshot,
    measurements: Object.freeze(measurements),
  });
}
