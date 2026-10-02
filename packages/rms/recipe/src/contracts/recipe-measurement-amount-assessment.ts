import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  createRecipeSnapshot,
  parseRecipeYieldQuantityMicrounits,
  validateRecipeGraph,
  RecipeError,
  type RecipeSnapshot,
} from "../domain/recipe.js";
import { requireRecipeMeasurementContentDigest } from "./recipe-measurement-content-digest.js";
import { parseRecipeReferenceSourceInstant } from "./recipe-reference-source.js";
const fail = (): never => {
  throw new RecipeError("RECIPE_INPUT_INVALID");
};
function children(value: unknown) {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > 256 ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return createRecipeSnapshot(d.value as RecipeSnapshot);
  }).sort((a, b) => a.versionReference.localeCompare(b.versionReference));
}
function reduced(n: bigint, d: bigint) {
  let a = n,
    b = d;
  while (b !== 0n) {
    const r = a % b;
    a = b;
    b = r;
  }
  return Object.freeze({ numerator: (n / a).toString(), denominator: (d / a).toString() });
}
export type RecipeMeasurementAmountStatus =
  | "ExactAmount"
  | "ConversionRoundingRequired"
  | "LossRoundingRequired"
  | "QuantityOutOfRange"
  | "PinnedYieldUnavailable"
  | "PinnedYieldUnitMismatch";
/** Pure Recipe-owned content arithmetic. Supplied snapshots/digests do not prove current publication or authority. */
export function assessRecipeMeasurementAmounts(
  value: unknown,
  pinnedChildren: unknown,
  nowInput: string,
  activationInput: string,
) {
  const content = requireRecipeMeasurementContentDigest(value),
    root = content.snapshot,
    now = parseRecipeReferenceSourceInstant(nowInput),
    activationAt = parseRecipeReferenceSourceInstant(activationInput),
    snapshots = children(pinnedChildren);
  if (activationAt < now) return fail();
  if (root.ingredients.length + snapshots.reduce((n, s) => n + s.ingredients.length, 0) > 4096)
    return fail();
  parseRecipeYieldQuantityMicrounits(root.yieldQuantityMicrounits);
  validateRecipeGraph(root, snapshots);
  const versions = new Map(snapshots.map((s) => [s.versionReference, s]));
  const reached = new Set<string>(),
    pending = [root];
  while (pending.length) {
    const s = pending.pop();
    if (!s) return fail();
    for (const i of s.ingredients.filter((i) => i.sourceKind === "SubRecipe")) {
      const child = versions.get(i.sourceVersionReference);
      if (!child) return fail();
      if (!reached.has(child.versionReference)) {
        reached.add(child.versionReference);
        pending.push(child);
      }
    }
  }
  if (reached.size !== snapshots.length) return fail();
  const matches = root.ingredients
    .map((i) => {
      const measurement = content.measurements.find(
        (m) => m.requirementReference === i.requirementReference,
      );
      if (!measurement) return fail();
      let status: RecipeMeasurementAmountStatus = "ExactAmount";
      let convertedQuantityMicrounits: string | null = null,
        lossAdjustedQuantityMicrounits: string | null = null,
        batchFactor: ReturnType<typeof reduced> | null = null;
      const product = BigInt(i.quantityMicrounits) * BigInt(i.conversionNumerator),
        denominator = BigInt(i.conversionDenominator);
      if (product % denominator !== 0n) status = "ConversionRoundingRequired";
      else {
        const converted = product / denominator;
        if (converted < 1n || converted > 10n ** 30n) status = "QuantityOutOfRange";
        else {
          convertedQuantityMicrounits = converted.toString();
          const adjusted = converted * BigInt(10000 + i.lossBasisPoints);
          if (adjusted % 10000n !== 0n) status = "LossRoundingRequired";
          else if (adjusted / 10000n > 10n ** 30n) status = "QuantityOutOfRange";
          else lossAdjustedQuantityMicrounits = (adjusted / 10000n).toString();
        }
      }
      let childYieldQuantityMicrounits: string | null = null,
        childSnapshotDigest: string | null = null;
      if (i.sourceKind === "SubRecipe") {
        const child = versions.get(i.sourceVersionReference);
        if (!child || child.recipeReference !== i.sourceReference) return fail();
        childSnapshotDigest = child.snapshotDigest;
        if (
          child.lifecycle !== "Published" ||
          BigInt(child.yieldQuantityMicrounits) <= 0n ||
          child.createdAt > now ||
          child.effectivePeriod.effectiveFrom.instant > now ||
          child.effectivePeriod.effectiveFrom.instant > activationAt ||
          (child.effectivePeriod.effectiveUntil !== null &&
            (now >= child.effectivePeriod.effectiveUntil.instant ||
              activationAt >= child.effectivePeriod.effectiveUntil.instant))
        )
          status = "PinnedYieldUnavailable";
        else {
          childYieldQuantityMicrounits = parseRecipeYieldQuantityMicrounits(
            child.yieldQuantityMicrounits,
          );
          if (
            measurement.targetUnitCode !== child.yieldUnitCode ||
            measurement.targetDimension !== child.yieldDimension
          )
            status = "PinnedYieldUnitMismatch";
          else if (status === "ExactAmount" && lossAdjustedQuantityMicrounits !== null)
            batchFactor = reduced(
              BigInt(lossAdjustedQuantityMicrounits),
              BigInt(childYieldQuantityMicrounits),
            );
        }
      }
      if (status !== "ExactAmount") {
        convertedQuantityMicrounits = null;
        lossAdjustedQuantityMicrounits = null;
        batchFactor = null;
      }
      return Object.freeze({
        requirementReference: i.requirementReference,
        sourceKind: i.sourceKind,
        sourceReference: i.sourceReference,
        sourceVersionReference: i.sourceVersionReference,
        usageUnitCode: measurement.usageUnitCode,
        targetUnitCode: measurement.targetUnitCode,
        targetDimension: measurement.targetDimension,
        quantityMicrounits: i.quantityMicrounits,
        conversionNumerator: i.conversionNumerator,
        conversionDenominator: i.conversionDenominator,
        lossBasisPoints: i.lossBasisPoints,
        convertedQuantityMicrounits,
        lossAdjustedQuantityMicrounits,
        childYieldQuantityMicrounits,
        childSnapshotDigest,
        batchFactor,
        status,
      });
    })
    .sort((a, b) => a.requirementReference.localeCompare(b.requirementReference));
  const body = {
    profile: "RecipeMeasurementAmountAssessmentV1" as const,
    recipeReference: root.recipeReference,
    versionReference: root.versionReference,
    brandReference: root.brandReference,
    contentDigest: root.snapshotDigest,
    pinnedSnapshotDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(snapshots)),
    assessedAt: now,
    activationAt,
    rootYieldQuantityMicrounits: root.yieldQuantityMicrounits,
    matches: Object.freeze(matches),
    quantityArithmetic: matches.every((m) => m.status === "ExactAmount")
      ? ("Pass" as const)
      : ("HardError" as const),
    subrecipeYield: matches.some((m) => m.sourceKind === "SubRecipe")
      ? ("ComparedProvidedPinnedSnapshots" as const)
      : ("NotRequired" as const),
    inventoryPrecision: "NotEvaluated" as const,
    recursiveDemand: "NotEvaluated" as const,
    sourceAuthority: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
