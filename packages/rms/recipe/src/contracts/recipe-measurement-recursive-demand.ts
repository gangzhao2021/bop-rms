import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  RecipeError,
  parseRecipeYieldQuantityMicrounits,
  validateRecipeGraph,
  type RecipeReference,
} from "../domain/recipe.js";
import { requireRecipeMeasurementContentDigest } from "./recipe-measurement-content-digest.js";
import { assessRecipeMeasurementAmounts } from "./recipe-measurement-amount-assessment.js";
const fail = (): never => {
  throw new RecipeError("RECIPE_GRAPH_UNRESOLVED");
};
function ratio(n: bigint, d: bigint): readonly [bigint, bigint] {
  if (n <= 0n || d <= 0n) return fail();
  let a = n,
    b = d;
  while (b) {
    const r = a % b;
    a = b;
    b = r;
  }
  n /= a;
  d /= a;
  if (n > 10n ** 1024n || d > 10n ** 1024n) return fail();
  return [n, d];
}
/** Pure complete V2 theoretical demand. Owner source holders and Inventory ledger qualification remain required. */
export function calculateRecipeMeasurementDemand(
  rootInput: unknown,
  childrenInput: unknown,
  requestedInput: string,
  now: string,
  activationAt: string,
) {
  const root = requireRecipeMeasurementContentDigest(rootInput),
    requestedYieldMicrounits = parseRecipeYieldQuantityMicrounits(requestedInput);
  if (root.snapshot.lifecycle !== "Draft" && root.snapshot.lifecycle !== "Published") return fail();
  if (
    !Array.isArray(childrenInput) ||
    Object.getPrototypeOf(childrenInput) !== Array.prototype ||
    childrenInput.length > 255 ||
    Reflect.ownKeys(childrenInput).length !== childrenInput.length + 1
  )
    return fail();
  const children = Array.from({ length: childrenInput.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(childrenInput, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return requireRecipeMeasurementContentDigest(d.value);
  }).sort((a, b) => a.snapshot.versionReference.localeCompare(b.snapshot.versionReference));
  if (
    root.snapshot.ingredients.length +
      children.reduce((n, c) => n + c.snapshot.ingredients.length, 0) >
    4096
  )
    return fail();
  validateRecipeGraph(
    root.snapshot,
    children.map((c) => c.snapshot),
  );
  const contents = new Map([root, ...children].map((c) => [c.snapshot.versionReference, c]));
  const descendants = (start: typeof root) => {
    const found = new Set<RecipeReference>(),
      pending = [start];
    while (pending.length) {
      const c = pending.pop();
      if (!c) return fail();
      for (const i of c.snapshot.ingredients.filter((i) => i.sourceKind === "SubRecipe")) {
        const child = contents.get(i.sourceVersionReference);
        if (!child) return fail();
        if (!found.has(child.snapshot.versionReference)) {
          found.add(child.snapshot.versionReference);
          pending.push(child);
        }
      }
    }
    return [...found].map((v) => {
      const c = contents.get(v);
      if (!c) return fail();
      return c.snapshot;
    });
  };
  if (descendants(root).length !== children.length) return fail();
  const assessments = new Map(
    [root, ...children].map((c) => {
      const a = assessRecipeMeasurementAmounts(c, descendants(c), now, activationAt);
      if (a.quantityArithmetic !== "Pass") return fail();
      return [c.snapshot.versionReference, a] as const;
    }),
  );
  type Path = readonly {
    readonly recipeReference: string;
    readonly versionReference: string;
    readonly contentDigest: string;
    readonly requirementReference: string;
  }[];
  const demands: {
    readonly itemReference: string;
    readonly operationReference: string;
    readonly recipeReference: string;
    readonly recipeVersionReference: string;
    readonly requirementReference: string;
    readonly usageUnitCode: string;
    readonly targetUnitCode: string;
    readonly targetDimension: string;
    readonly conversionKind: string;
    readonly conversionReference: string | null;
    readonly conversionNumerator: string;
    readonly conversionDenominator: string;
    readonly quantityNumerator: string;
    readonly quantityDenominator: string;
    readonly sourcePath: Path;
  }[] = [];
  const operations = new Map<string, string>();
  function visit(content: typeof root, n: bigint, d: bigint, path: Path): void {
    if (path.length > 16) return fail();
    const a = assessments.get(content.snapshot.versionReference);
    if (!a) return fail();
    const [batchN, batchD] = ratio(n, d * BigInt(content.snapshot.yieldQuantityMicrounits));
    for (const i of content.snapshot.ingredients) {
      const amount = a.matches.find((m) => m.requirementReference === i.requirementReference),
        measurement = content.measurements.find(
          (m) => m.requirementReference === i.requirementReference,
        );
      if (!amount?.lossAdjustedQuantityMicrounits || !measurement) return fail();
      const [qN, qD] = ratio(batchN * BigInt(amount.lossAdjustedQuantityMicrounits), batchD);
      if (qN > 10n ** 30n * qD) return fail();
      const sourcePath = Object.freeze([
        ...path,
        Object.freeze({
          recipeReference: content.snapshot.recipeReference,
          versionReference: content.snapshot.versionReference,
          contentDigest: content.snapshot.snapshotDigest,
          requirementReference: i.requirementReference,
        }),
      ]);
      if (i.sourceKind === "SubRecipe") {
        const child = contents.get(i.sourceVersionReference);
        if (!child) return fail();
        visit(child, qN, qD, sourcePath);
      } else {
        const prior = operations.get(i.sourceReference);
        if (prior !== undefined && prior !== i.sourceVersionReference) return fail();
        operations.set(i.sourceReference, i.sourceVersionReference);
        if (demands.length >= 4096) return fail();
        demands.push(
          Object.freeze({
            itemReference: i.sourceReference,
            operationReference: i.sourceVersionReference,
            recipeReference: content.snapshot.recipeReference,
            recipeVersionReference: content.snapshot.versionReference,
            requirementReference: i.requirementReference,
            usageUnitCode: measurement.usageUnitCode,
            targetUnitCode: measurement.targetUnitCode,
            targetDimension: measurement.targetDimension,
            conversionKind: measurement.conversionKind,
            conversionReference: measurement.conversionReference,
            conversionNumerator: i.conversionNumerator,
            conversionDenominator: i.conversionDenominator,
            quantityNumerator: qN.toString(),
            quantityDenominator: qD.toString(),
            sourcePath,
          }),
        );
      }
    }
  }
  visit(root, BigInt(requestedYieldMicrounits), 1n, []);
  const body = {
    profile: "RecipeMeasurementRecursiveDemandV1" as const,
    recipeReference: root.snapshot.recipeReference,
    versionReference: root.snapshot.versionReference,
    brandReference: root.snapshot.brandReference,
    contentGraphDigest: "sha256:" + sha256Hex(canonicalizeRfc8785([root, ...children])),
    requestedYieldMicrounits,
    assessedAt: now,
    activationAt,
    demands: Object.freeze(demands),
    arithmetic: "ExactRational" as const,
    quantityUnit: "TargetUnitMicrounits" as const,
    inventoryPrecision: "NotEvaluated" as const,
    sourceAuthority: "NotEvaluated" as const,
    publishValidation: "Incomplete" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
