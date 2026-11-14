import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryDecimal,
  parseInventoryReference,
} from "../domain/inventory-item.js";
import { unitList, unitRecord } from "./option-consumption-unit-source.js";
import { parseRecipeIngredientUnitPins } from "./recipe-ingredient-unit-source.js";
import { readRecipeIngredientAssessmentFacts } from "./recipe-ingredient-unit-assessment.js";
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
const pinFields = [
  "recipeReference",
  "recipeVersionReference",
  "requirementReference",
  "itemReference",
  "operationReference",
] as const;
const fields = [
  ...pinFields,
  "pathDigest",
  "targetUnitCode",
  "targetDimension",
  "quantityNumerator",
  "quantityDenominator",
] as const;
const positive = (v: unknown) => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,1024}$/.test(v) || BigInt(v) > 10n ** 1024n)
    return fail();
  return BigInt(v);
};
function gcd(a: bigint, b: bigint) {
  while (b) {
    const r = a % b;
    a = b;
    b = r;
  }
  return a;
}
export type RecipeBaseDemandStatus =
  "ExactBaseDemand" | "BaseUnitMismatch" | "RoundingRequired" | "QuantityOutOfRange";
/** Pure final target-unit demand qualification. Conversion/provenance authority must be held separately. */
export function assessRecipeBaseDemands(
  value: unknown,
  facts: Parameters<typeof readRecipeIngredientAssessmentFacts>[0],
  nowInput: string,
  activationInput: string,
  originalPublicationClockInput?: unknown,
) {
  try {
    const rows = unitList(value, 4096).map((value) => {
      const r = unitRecord(value, fields);
      const pin = {
        recipeReference: parseInventoryReference(r.recipeReference),
        recipeVersionReference: parseInventoryReference(r.recipeVersionReference),
        requirementReference: parseInventoryReference(r.requirementReference),
        itemReference: parseInventoryReference(r.itemReference),
        operationReference: parseInventoryReference(r.operationReference),
      };
      if (
        typeof r.pathDigest !== "string" ||
        !/^sha256:[a-f0-9]{64}$/.test(r.pathDigest) ||
        typeof r.targetUnitCode !== "string" ||
        !/^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(r.targetUnitCode) ||
        !["Mass", "Volume", "Count"].includes(r.targetDimension as string)
      )
        return fail();
      const n = positive(r.quantityNumerator),
        d = positive(r.quantityDenominator),
        divisor = gcd(n, d);
      return Object.freeze({
        ...pin,
        pathDigest: r.pathDigest,
        targetUnitCode: r.targetUnitCode,
        targetDimension: r.targetDimension as "Mass" | "Volume" | "Count",
        quantityNumerator: (n / divisor).toString(),
        quantityDenominator: (d / divisor).toString(),
      });
    });
    if (new Set(rows.map((r) => r.pathDigest)).size !== rows.length) return fail();
    const selectors = new Map<string, Record<string, unknown>>();
    for (const r of rows) {
      const pin = Object.fromEntries(pinFields.map((k) => [k, r[k]])),
        key = r.recipeVersionReference + ":" + r.requirementReference;
      const prior = selectors.get(key);
      if (prior && canonicalizeRfc8785(prior) !== canonicalizeRfc8785(pin)) return fail();
      selectors.set(key, pin);
    }
    const pins = parseRecipeIngredientUnitPins([...selectors.values()]);
    const held = readRecipeIngredientAssessmentFacts(
      facts,
      pins,
      nowInput,
      activationInput,
      originalPublicationClockInput,
    );
    const totals = new Map<
      string,
      {
        itemReference: string;
        operationReference: string;
        itemVersion: number;
        targetUnitCode: string;
        targetDimension: string;
        ledgerPrecision: number;
        roundingMode: string;
        quantity: bigint;
        paths: string[];
      }
    >();
    const matches = rows.map((r) => {
      const u = held.units.find(
        (u) => u.itemReference === r.itemReference && u.operationReference === r.operationReference,
      );
      if (!u) return fail();
      const n = BigInt(r.quantityNumerator),
        d = BigInt(r.quantityDenominator),
        step = 10n ** BigInt(6 - u.base.ledgerPrecision);
      let status: RecipeBaseDemandStatus = "ExactBaseDemand";
      if (r.targetUnitCode !== u.base.unitCode || r.targetDimension !== u.base.dimension)
        status = "BaseUnitMismatch";
      else if (n > 10n ** 30n * d) status = "QuantityOutOfRange";
      else if (n % (d * step) !== 0n) status = "RoundingRequired";
      const quantity = status === "ExactBaseDemand" ? n / d : null;
      if (quantity !== null) {
        let total = totals.get(u.itemReference);
        if (!total) {
          total = {
            itemReference: u.itemReference,
            operationReference: u.operationReference,
            itemVersion: u.itemVersion,
            targetUnitCode: u.base.unitCode,
            targetDimension: u.base.dimension,
            ledgerPrecision: u.base.ledgerPrecision,
            roundingMode: u.base.roundingMode,
            quantity: 0n,
            paths: [],
          };
          totals.set(u.itemReference, total);
        }
        total.quantity += quantity;
        total.paths.push(r.pathDigest);
      }
      return Object.freeze({
        ...r,
        itemVersion: u.itemVersion,
        ledgerPrecision: u.base.ledgerPrecision,
        roundingMode: u.base.roundingMode,
        status,
        baseQuantityMicrounits: quantity?.toString() ?? null,
      });
    });
    const overflow = [...totals.values()].some((t) => t.quantity > 10n ** 30n),
      pass = !overflow && matches.every((m) => m.status === "ExactBaseDemand");
    const aggregates = pass
      ? [...totals.values()]
          .sort((a, b) => a.itemReference.localeCompare(b.itemReference))
          .map((t) => {
            const { quantity, paths, ...rest } = t,
              digits = quantity.toString().padStart(7, "0");
            return Object.freeze({
              ...rest,
              paths: Object.freeze(paths),
              baseQuantityMicrounits: quantity.toString(),
              baseQuantity: parseInventoryDecimal(
                (digits.slice(0, -6) + "." + digits.slice(-6))
                  .replace(/0+$/, "")
                  .replace(/\.$/, ""),
              ),
            });
          })
      : [];
    const body = {
      profile: "RecipeBaseDemandAssessmentV1" as const,
      request: held.request,
      pins,
      demandDigest: "sha256:" + sha256Hex(canonicalizeRfc8785(rows)),
      unitSourceDigest: facts.digest,
      ownerSourceDigest: facts.ownerSourceDigest,
      ownerGeneration: facts.ownerGeneration,
      ownerObservedAt: held.observed,
      validUntil: held.expiry,
      assessedAt: held.now,
      activationAt: held.activationAt,
      ...(held.originalPublicationClock
        ? { originalPublicationClock: held.originalPublicationClock }
        : {}),
      matches: Object.freeze(matches),
      aggregates: Object.freeze(aggregates),
      aggregateStatus: overflow
        ? ("QuantityOutOfRange" as const)
        : pass
          ? ("ExactBaseDemand" as const)
          : ("HardError" as const),
      inventoryPrecision: pass ? ("Pass" as const) : ("HardError" as const),
      conversionApplicability: "NotEvaluated" as const,
      sourceAuthority: "NotEvaluated" as const,
      stock: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
      publishValidation: "Incomplete" as const,
    };
    return Object.freeze({ ...body, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
  } catch {
    return fail();
  }
}
