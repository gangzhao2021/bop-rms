import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  parseRecipeReference,
  parseRecipeCode,
  parseRecipeDigest,
  parseRecipeYieldQuantityMicrounits,
} from "../domain/recipe.js";
import { RecipeWorkflowError } from "../application/recipe-service.js";
import {
  parseRecipeReferenceSourceSnapshot,
  parseRecipeReferenceSourceInstant,
  validateRecipeOptionPublicationActivation,
  type RecipeReferenceSourceRequest,
} from "./recipe-reference-source.js";
const fail = (): never => {
  throw new RecipeWorkflowError("RECIPE_DEPENDENCY_UNAVAILABLE");
};
export const recipeOptionConsumptionYieldFields = Object.freeze([
  "recipeReference",
  "versionReference",
  "versionNumber",
  "snapshotDigest",
  "yieldQuantityMicrounits",
  "yieldUnitCode",
  "yieldDimension",
] as const);
export function yieldRecord(value: unknown, fields: readonly string[]) {
  if (
    !value ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype ||
    Reflect.ownKeys(value).length !== fields.length
  )
    return fail();
  const r: Record<string, unknown> = {};
  for (const k of fields) {
    const d = Object.getOwnPropertyDescriptor(value, k);
    if (!d?.enumerable || !("value" in d)) return fail();
    r[k] = d.value;
  }
  return r;
}
export function yieldList(value: unknown, max = 100): unknown[] {
  if (
    !Array.isArray(value) ||
    Object.getPrototypeOf(value) !== Array.prototype ||
    value.length > max ||
    Reflect.ownKeys(value).length !== value.length + 1
  )
    return fail();
  return Array.from({ length: value.length }, (_, i) => {
    const d = Object.getOwnPropertyDescriptor(value, String(i));
    if (!d?.enumerable || !("value" in d)) return fail();
    return d.value;
  });
}

export function parseRecipeOptionConsumptionPins(value: unknown) {
  const pins = yieldList(value)
    .map((v) => {
      const r = yieldRecord(v, [
        "optionReference",
        "reference",
        "versionReference",
        "quantity",
        "unitCode",
      ]);
      if (
        typeof r.quantity !== "string" ||
        r.quantity.length > 40 ||
        !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(r.quantity) ||
        !/[1-9]/.test(r.quantity)
      )
        return fail();
      return Object.freeze({
        optionReference: parseRecipeReference(r.optionReference),
        reference: parseRecipeReference(r.reference),
        versionReference: parseRecipeReference(r.versionReference),
        quantity: r.quantity,
        unitCode: parseRecipeCode(r.unitCode),
      });
    })
    .sort((a, b) => a.optionReference.localeCompare(b.optionReference));
  if (new Set(pins.map((p) => p.optionReference)).size !== pins.length) return fail();
  return Object.freeze(pins);
}
export function assessRecipeOptionConsumptionYields(
  value: unknown,
  raw: unknown,
  metadata: unknown,
  request: RecipeReferenceSourceRequest,
  nowInput: string,
  activationInput: string,
  originalPublicationClockValue?: unknown,
) {
  const now = parseRecipeReferenceSourceInstant(nowInput),
    activationAt = parseRecipeReferenceSourceInstant(activationInput),
    source = parseRecipeReferenceSourceSnapshot(metadata, request, now),
    pins = parseRecipeOptionConsumptionPins(value),
    rows = yieldList(raw),
    originalPublicationClock = validateRecipeOptionPublicationActivation(
      request,
      now,
      activationAt,
      originalPublicationClockValue,
    );
  const expected = new Map(pins.map((p) => [p.versionReference, p.reference]));
  if (rows.length !== expected.size) return fail();
  for (const p of pins) if (expected.get(p.versionReference) !== p.reference) return fail();
  const yields = rows
    .map((v) => {
      const r = yieldRecord(v, [
          "recipeReference",
          "versionReference",
          "versionNumber",
          "snapshotDigest",
          "yieldQuantityMicrounits",
          "yieldUnitCode",
          "yieldDimension",
          "precise",
        ]),
        reference = parseRecipeReference(r.recipeReference),
        versionReference = parseRecipeReference(r.versionReference),
        parent = source.recipes.find((x) => x.recipeReference === reference),
        version = source.versions.find((x) => x.recipeVersionReference === versionReference);
      const covers = (at: string) =>
        !!version &&
        version.effectiveFrom <= at &&
        (version.effectiveUntil === null || at < version.effectiveUntil);
      if (
        r.precise !== true ||
        expected.get(versionReference) !== reference ||
        !parent ||
        !version ||
        version.recipeReference !== reference ||
        parent.currentVersionReference !== versionReference ||
        version.lifecycle !== "Published" ||
        !covers(now) ||
        !covers(activationAt) ||
        String(version.versionNumber) !== r.versionNumber ||
        parseRecipeDigest(r.snapshotDigest) !== version.snapshotDigest ||
        !["Mass", "Volume", "Count"].includes(r.yieldDimension as string)
      )
        return fail();
      return Object.freeze({
        reference,
        versionReference,
        versionNumber: version.versionNumber,
        snapshotDigest: version.snapshotDigest,
        yieldQuantityMicrounits: parseRecipeYieldQuantityMicrounits(r.yieldQuantityMicrounits),
        yieldUnitCode: parseRecipeCode(r.yieldUnitCode),
        yieldDimension: r.yieldDimension as "Mass" | "Volume" | "Count",
      });
    })
    .sort((a, b) => a.versionReference.localeCompare(b.versionReference));
  if (new Set(yields.map((y) => y.versionReference)).size !== yields.length) return fail();
  const gcd = (a: bigint, b: bigint): bigint => {
    while (b) {
      const next = a % b;
      a = b;
      b = next;
    }
    return a;
  };
  const matches = pins.map((p) => {
    const y = yields.find((y) => y.versionReference === p.versionReference);
    if (!y) return fail();
    let status: "ExactYieldQuantity" | "UnknownYieldUnit" | "QuantityOutOfRange" =
        "ExactYieldQuantity",
      requestedYieldMicrounits: string | null = null,
      batchNumerator: string | null = null,
      batchDenominator: string | null = null;
    const [n, f = ""] = p.quantity.split("."),
      quantity = BigInt(n + f.padEnd(6, "0"));
    if (p.unitCode !== y.yieldUnitCode) status = "UnknownYieldUnit";
    else if (quantity > 10n ** 30n) status = "QuantityOutOfRange";
    else {
      requestedYieldMicrounits = parseRecipeYieldQuantityMicrounits(quantity.toString());
      const batch = BigInt(y.yieldQuantityMicrounits),
        divisor = gcd(quantity, batch);
      batchNumerator = (quantity / divisor).toString();
      batchDenominator = (batch / divisor).toString();
    }
    return Object.freeze({
      optionReference: p.optionReference,
      reference: p.reference,
      versionReference: p.versionReference,
      unitCode: p.unitCode,
      yieldUnitCode: y.yieldUnitCode,
      yieldDimension: y.yieldDimension,
      requestedYieldMicrounits,
      batchNumerator,
      batchDenominator,
      status,
    });
  });
  const body = {
    profile: "RecipeOptionConsumptionYieldsV1" as const,
    brandReference: request.brandReference,
    operationReference: request.operationReference,
    catalogIntentDigest: request.catalogIntentDigest,
    ownerSourceDigest: source.digest,
    ownerGeneration: source.generation,
    ownerObservedAt: source.observedAt,
    yieldSourceDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(yields)),
    assessedAt: now,
    activationAt,
    ...(originalPublicationClock === undefined ? {} : { originalPublicationClock }),
    matches: Object.freeze(matches),
    yieldArithmetic: matches.every((m) => m.status === "ExactYieldQuantity")
      ? ("Pass" as const)
      : ("HardError" as const),
    quantityPolicy: "NotEvaluated" as const,
    ingredientEligibility: "NotEvaluated" as const,
    bindingApplicability: "NotEvaluated" as const,
    scopeApplicability: "NotEvaluated" as const,
    referenceEligibility: "NotEvaluated" as const,
    eligibility: "NotEvaluated" as const,
  };
  return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
}
