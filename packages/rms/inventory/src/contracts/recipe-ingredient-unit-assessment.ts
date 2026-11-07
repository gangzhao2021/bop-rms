import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import {
  InventoryItemError,
  parseInventoryInstant,
  parseInventoryUnit,
  parseInventoryDecimal,
  parseInventoryReference,
} from "../domain/inventory-item.js";
import { parseInventoryUnitConversion } from "../domain/inventory-item-snapshot.js";
import {
  parseInventoryConfigurationReferenceRequest,
  parseInventoryOptionPublicationOriginalClock,
} from "./configuration-reference-source.js";
import { unitRecord, unitList } from "./option-consumption-unit-source.js";
import {
  parseRecipeIngredientUnitPins,
  type buildCurrentRecipeIngredientUnitFacts,
} from "./recipe-ingredient-unit-source.js";

type HeldFacts = ReturnType<typeof buildCurrentRecipeIngredientUnitFacts> & {
  readonly validUntil: string;
};
const fail = (): never => {
  throw new InventoryItemError("INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE");
};
const code = (v: unknown) =>
  typeof v === "string" && /^[A-Z0-9][A-Z0-9_-]{0,63}$/.test(v) ? v : fail();
const dimension = (v: unknown) => (v === "Mass" || v === "Volume" || v === "Count" ? v : fail());
const positive = (v: unknown) => {
  if (typeof v !== "string" || !/^[1-9][0-9]{0,30}$/.test(v) || BigInt(v) > 10n ** 30n)
    return fail();
  return v;
};
const pinFields = [
  "recipeReference",
  "recipeVersionReference",
  "requirementReference",
  "itemReference",
  "operationReference",
] as const;
const measurementFields = [
  ...pinFields,
  "usageUnitCode",
  "usageDimension",
  "targetUnitCode",
  "targetDimension",
  "conversionKind",
  "conversionReference",
  "quantityMicrounits",
  "conversionNumerator",
  "conversionDenominator",
] as const;
function measurements(value: unknown) {
  const rows = unitList(value, 4096).map((v) => unitRecord(v, measurementFields));
  const pins = parseRecipeIngredientUnitPins(
    rows.map((r) => Object.fromEntries(pinFields.map((k) => [k, r[k]]))),
  );
  return pins.map((pin) => {
    const r = rows.find(
      (r) =>
        r.recipeVersionReference === pin.recipeVersionReference &&
        r.requirementReference === pin.requirementReference,
    );
    if (!r) return fail();
    if (
      ![
        "InventoryBaseUnitIdentity",
        "InventoryRecordedConversion",
        "StandardDimensionConversion",
      ].includes(r.conversionKind as string)
    )
      return fail();
    const conversionReference =
      r.conversionReference === null ? null : parseInventoryReference(r.conversionReference);
    if ((r.conversionKind === "InventoryRecordedConversion") !== (conversionReference !== null))
      return fail();
    return Object.freeze({
      ...pin,
      usageUnitCode: code(r.usageUnitCode),
      usageDimension: dimension(r.usageDimension),
      targetUnitCode: code(r.targetUnitCode),
      targetDimension: dimension(r.targetDimension),
      conversionKind: r.conversionKind as
        "InventoryBaseUnitIdentity" | "InventoryRecordedConversion" | "StandardDimensionConversion",
      conversionReference,
      quantityMicrounits: positive(r.quantityMicrounits),
      conversionNumerator: positive(r.conversionNumerator),
      conversionDenominator: positive(r.conversionDenominator),
    });
  });
}
export type RecipeIngredientUnitAssessmentStatus =
  | "ExactBaseQuantity"
  | "BaseUnitMismatch"
  | "MissingConversion"
  | "AmbiguousConversion"
  | "ConversionChangesAtActivation"
  | "ConversionPinMismatch"
  | "ConversionFactorMismatch"
  | "IncompatibleDimension"
  | "RoundingRequired"
  | "QuantityOutOfRange";
/** Internal shared strict current-fact decoder. It grants no source authority. */
export function readRecipeIngredientAssessmentFacts(
  facts: HeldFacts,
  expectedPins: unknown,
  nowInput: string,
  activationInput: string,
  originalPublicationClockInput?: unknown,
) {
  const now = parseInventoryInstant(nowInput),
    activationAt = parseInventoryInstant(activationInput);
  const raw = unitRecord(facts, [
    "profile",
    "request",
    "pins",
    "ownerSourceDigest",
    "ownerGeneration",
    "ownerObservedAt",
    "units",
    "unitArithmetic",
    "conversionApplicability",
    "stock",
    "eligibility",
    "digest",
    "validUntil",
  ]);
  const { digest, validUntil, ...body } = raw;
  const observed = parseInventoryInstant(raw.ownerObservedAt),
    expiry = parseInventoryInstant(validUntil);
  if (
    raw.profile !== "CurrentRecipeIngredientUnitFactsV1" ||
    raw.unitArithmetic !== "NotEvaluated" ||
    raw.conversionApplicability !== "NotEvaluated" ||
    raw.stock !== "NotEvaluated" ||
    raw.eligibility !== "NotEvaluated" ||
    Date.parse(expiry) - Date.parse(observed) !== 5000 ||
    now < observed ||
    now >= expiry
  )
    return fail();
  const request = parseInventoryConfigurationReferenceRequest(raw.request),
    originalPublicationClock =
      originalPublicationClockInput === undefined
        ? undefined
        : parseInventoryOptionPublicationOriginalClock(originalPublicationClockInput, request, now);
  if (activationAt < (originalPublicationClock?.observedAt ?? now)) return fail();
  if (
    typeof raw.ownerSourceDigest !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(raw.ownerSourceDigest) ||
    typeof raw.ownerGeneration !== "string" ||
    !/^(0|[1-9][0-9]{0,19})$/.test(raw.ownerGeneration)
  )
    return fail();
  const pins = parseRecipeIngredientUnitPins(raw.pins);
  const expected = parseRecipeIngredientUnitPins(expectedPins);
  if (canonicalizeRfc8785(pins) !== canonicalizeRfc8785(expected)) return fail();
  const units = unitList(raw.units, 4096).map((v) => {
    const r = unitRecord(v, [
      "itemReference",
      "itemVersion",
      "operationReference",
      "recordedAt",
      "baseUnit",
      "unitConversions",
    ]);
    const base = parseInventoryUnit(
      unitRecord(r.baseUnit, [
        "unitCode",
        "dimension",
        "displayPrecision",
        "ledgerPrecision",
        "roundingMode",
      ]),
    );
    const conversions = unitList(r.unitConversions).map((v) =>
      parseInventoryUnitConversion(
        unitRecord(v, [
          "conversionReference",
          "fromUnitCode",
          "toBaseUnitCode",
          "multiplier",
          "effectiveFrom",
          "reasonCode",
          "status",
        ]),
      ),
    );
    if (
      conversions.some((c) => c.multiplier.length > 40 || c.toBaseUnitCode !== base.unitCode) ||
      new Set(conversions.map((c) => c.conversionReference)).size !== conversions.length ||
      typeof r.itemVersion !== "number" ||
      !Number.isSafeInteger(r.itemVersion) ||
      r.itemVersion < 1 ||
      parseInventoryInstant(r.recordedAt) > observed
    )
      return fail();
    return {
      itemReference: parseInventoryReference(r.itemReference),
      operationReference: parseInventoryReference(r.operationReference),
      itemVersion: r.itemVersion,
      base,
      conversions,
    };
  });
  if (
    units.length !== new Set(pins.map((p) => p.itemReference)).size ||
    new Set(units.map((u) => u.itemReference)).size !== units.length
  )
    return fail();
  // Every nested object has now been inspected through data descriptors before hashing.
  if (digest !== "sha256:" + sha256Hex(canonicalizeRfc8785(body))) return fail();
  return { now, activationAt, request, pins, units, observed, expiry, originalPublicationClock };
}
/** Pure owning rule comparison, not provenance or permission authority.
 * Invoke inside the owning withCurrentUnits callback; holder must complete before admitting any write. */
export function assessRecipeIngredientUnits(
  value: unknown,
  facts: HeldFacts,
  nowInput: string,
  activationInput: string,
  originalPublicationClockInput?: unknown,
) {
  try {
    const rows = measurements(value);
    const { now, activationAt, request, units, observed, expiry, originalPublicationClock } =
      readRecipeIngredientAssessmentFacts(
        facts,
        rows.map((r) => Object.fromEntries(pinFields.map((k) => [k, r[k]]))),
        nowInput,
        activationInput,
        originalPublicationClockInput,
      );
    const matches = rows.map((r) => {
      const u = units.find(
        (u) => u.itemReference === r.itemReference && u.operationReference === r.operationReference,
      );
      if (!u) return fail();
      let status: RecipeIngredientUnitAssessmentStatus = "ExactBaseQuantity",
        numerator = 1n,
        denominator = 1n;
      if (r.targetUnitCode !== u.base.unitCode || r.targetDimension !== u.base.dimension)
        status = "BaseUnitMismatch";
      else if (r.conversionKind === "InventoryBaseUnitIdentity") {
        if (r.usageDimension !== r.targetDimension) status = "IncompatibleDimension";
        else if (r.usageUnitCode !== r.targetUnitCode) status = "MissingConversion";
      } else if (r.conversionKind === "StandardDimensionConversion") {
        const pair = r.usageUnitCode + ":" + r.targetUnitCode;
        if (r.usageDimension !== r.targetDimension) status = "IncompatibleDimension";
        else if (
          (r.usageDimension === "Mass" && pair === "KG:G") ||
          (r.usageDimension === "Volume" && pair === "L:ML")
        )
          numerator = 1000n;
        else if (
          (r.usageDimension === "Mass" && pair === "G:KG") ||
          (r.usageDimension === "Volume" && pair === "ML:L")
        )
          denominator = 1000n;
        else status = "MissingConversion";
      } else {
        const available = (at: string) =>
          u.conversions.filter(
            (c) =>
              c.status === "Active" && c.fromUnitCode === r.usageUnitCode && c.effectiveFrom <= at,
          );
        const current = available(now),
          proposed = available(activationAt);
        if (r.usageUnitCode === r.targetUnitCode) status = "MissingConversion";
        else if (!current.length || !proposed.length) status = "MissingConversion";
        else if (current.length !== 1 || proposed.length !== 1) status = "AmbiguousConversion";
        else if (current[0]?.conversionReference !== proposed[0]?.conversionReference)
          status = "ConversionChangesAtActivation";
        else {
          const c = current[0];
          if (!c) return fail();
          if (c.conversionReference !== r.conversionReference) status = "ConversionPinMismatch";
          const [whole, fraction = ""] = c.multiplier.split(".");
          numerator = BigInt(whole + fraction);
          denominator = 10n ** BigInt(fraction.length);
        }
      }
      if (
        status === "ExactBaseQuantity" &&
        BigInt(r.conversionNumerator) * denominator !== BigInt(r.conversionDenominator) * numerator
      )
        status = "ConversionFactorMismatch";
      let baseQuantityMicrounits: string | null = null,
        baseQuantity: string | null = null;
      if (status === "ExactBaseQuantity") {
        const product = BigInt(r.quantityMicrounits) * numerator,
          ledgerStep = 10n ** BigInt(6 - u.base.ledgerPrecision);
        if (product % denominator !== 0n || (product / denominator) % ledgerStep !== 0n)
          status = "RoundingRequired";
        else {
          const q = product / denominator;
          if (q < 1n || q > 10n ** 30n) status = "QuantityOutOfRange";
          else {
            baseQuantityMicrounits = q.toString();
            const digits = q.toString().padStart(7, "0");
            baseQuantity = parseInventoryDecimal(
              (digits.slice(0, -6) + "." + digits.slice(-6)).replace(/0+$/, "").replace(/\.$/, ""),
            );
          }
        }
      }
      return Object.freeze({
        ...r,
        itemVersion: u.itemVersion,
        ledgerPrecision: u.base.ledgerPrecision,
        roundingMode: u.base.roundingMode,
        baseQuantityMicrounits,
        baseQuantity,
        status,
      });
    });
    const result = {
      profile: "RecipeIngredientUnitAssessmentV1" as const,
      request,
      unitSourceDigest: facts.digest,
      ownerSourceDigest: facts.ownerSourceDigest,
      ownerGeneration: facts.ownerGeneration,
      ownerObservedAt: observed,
      validUntil: expiry,
      assessedAt: now,
      activationAt,
      ...(originalPublicationClock ? { originalPublicationClock } : {}),
      matches: Object.freeze(matches),
      unitArithmetic: matches.every((m) => m.status === "ExactBaseQuantity")
        ? ("Pass" as const)
        : ("HardError" as const),
      loss: "NotEvaluated" as const,
      subrecipeYield: "NotEvaluated" as const,
      stock: "NotEvaluated" as const,
      eligibility: "NotEvaluated" as const,
    };
    return Object.freeze({ ...result, digest: "sha256:" + sha256Hex(canonicalizeRfc8785(result)) });
  } catch {
    return fail();
  }
}
