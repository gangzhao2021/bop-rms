import { createEffectivePeriod } from "@bop/effective-period";
import { expect, it } from "vitest";
import {
  createRecipeMeasurementContentV2 as create,
  createRecipeSnapshot,
  parseRecipeReference,
  parseRecipeCode,
  parseRecipeDigest,
  type RecipeSnapshot,
} from "../index.js";
const id = (n: number) =>
  parseRecipeReference(`018f9800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`);
const at = "2026-08-13T18:00:00.000Z";
const period = createEffectivePeriod({
  timeZone: "America/Toronto",
  effectiveFrom: {
    instant: "2026-08-01T04:00:00.000Z" as never,
    localDateTime: "2026-08-01T00:00:00.000",
    utcOffsetMinutes: -240,
  },
  effectiveUntil: null,
});
function recipe(
  options: { version?: number; lifecycle?: RecipeSnapshot["lifecycle"]; sub?: RecipeSnapshot } = {},
): RecipeSnapshot {
  const version = options.version ?? 1;
  return {
    recipeReference: id(1),
    versionReference: id(version + 1),
    brandReference: id(10),
    stableCode: parseRecipeCode("SYNTHETIC_RECIPE"),
    aggregateVersion: version,
    versionNumber: version,
    snapshotDigest: parseRecipeDigest(`sha256:${version.toString(16).repeat(64)}`),
    lifecycle: options.lifecycle ?? "Draft",
    displayNameCode: parseRecipeCode("SYNTHETIC_NAME"),
    yieldQuantityMicrounits: "1000000",
    yieldUnitCode: parseRecipeCode("PORTION"),
    yieldDimension: "Count",
    ingredients: [
      {
        requirementReference: id(20),
        sourceKind: options.sub ? "SubRecipe" : "InventoryItem",
        sourceReference: options.sub?.recipeReference ?? id(21),
        sourceVersionReference: options.sub?.versionReference ?? id(22),
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
    effectivePeriod: period,
    invalidationReasonCode:
      options.lifecycle === "Invalidated" ? parseRecipeCode("SAFETY_REVIEW") : null,
    createdAt: at,
  };
}

function content(kind = "InventoryBaseUnitIdentity", sourceKind = "InventoryItem") {
  const base = recipe(),
    ingredient = base.ingredients[0];
  if (!ingredient) throw new Error("synthetic missing ingredient");
  return {
    profile: "RecipeMeasurementContentV2",
    snapshot: {
      ...base,
      ingredients: [
        { ...ingredient, sourceKind, conversionNumerator: "1", conversionDenominator: "1" },
      ],
    },
    measurements: [
      {
        requirementReference: id(20),
        usageUnitCode: "KG",
        usageDimension: "Mass",
        targetUnitCode: "KG",
        targetDimension: "Mass",
        conversionKind: kind,
        conversionReference: null as string | null,
      },
    ],
  };
}
function row(value: ReturnType<typeof content>) {
  const r = value.measurements[0];
  if (!r) throw new Error("synthetic missing measurement");
  return r;
}
function ingredient(value: ReturnType<typeof content>) {
  const r = value.snapshot.ingredients[0];
  if (!r) throw new Error("synthetic missing ingredient");
  return r;
}
it("preserves exact legacy core and explicit identity without claiming actual Inventory provenance", () => {
  const value = content(),
    before = JSON.stringify(value.snapshot),
    result = create(value);
  expect(JSON.stringify(result.snapshot)).toBe(before);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.measurements)).toBe(true);
  expect(Object.isFrozen(result.measurements[0])).toBe(true);
  expect(result.profile).toBe("RecipeMeasurementContentV2");
  expect(result).not.toHaveProperty("publishValidation");
  expect(() => createRecipeSnapshot(value as unknown as RecipeSnapshot)).toThrow();
  expect(JSON.stringify(createRecipeSnapshot(value.snapshot as RecipeSnapshot))).toBe(before);
});
it("represents a pinned Subrecipe yield identity separately from Inventory identity", () => {
  expect(
    create(content("PinnedSubrecipeYieldIdentity", "SubRecipe")).measurements[0]?.conversionKind,
  ).toBe("PinnedSubrecipeYieldIdentity");
});
it("represents an explicit Item-specific cross-dimension conversion pin without asserting it exists", () => {
  const v = content("InventoryRecordedConversion");
  Object.assign(row(v), {
    usageUnitCode: "PIECE",
    usageDimension: "Count",
    targetUnitCode: "G",
    targetDimension: "Mass",
    conversionReference: id(70),
  });
  ingredient(v).unitDimension = "Count";
  ingredient(v).conversionNumerator = "250";
  expect(create(v).measurements[0]).toMatchObject({
    usageDimension: "Count",
    targetDimension: "Mass",
    conversionReference: id(70),
  });
});
it.each([
  ["G", "KG", "Mass", "1", "1000"],
  ["KG", "G", "Mass", "1000", "1"],
  ["ML", "L", "Volume", "1", "1000"],
  ["L", "ML", "Volume", "1000", "1"],
])("accepts explicit standard %s to %s using exact rational endpoints", (from, to, dim, n, d) => {
  const v = content("StandardDimensionConversion");
  Object.assign(row(v), {
    usageUnitCode: from,
    targetUnitCode: to,
    usageDimension: dim,
    targetDimension: dim,
  });
  Object.assign(ingredient(v), {
    unitDimension: dim,
    conversionNumerator: n,
    conversionDenominator: d,
  });
  expect(create(v).measurements).toHaveLength(1);
});
it("accepts equivalent exact rational identity and standard ratios without floating point", () => {
  const v = content();
  Object.assign(ingredient(v), {
    conversionNumerator: "1000000000000000000000000000000",
    conversionDenominator: "1000000000000000000000000000000",
  });
  expect(create(v).measurements).toHaveLength(1);
  const standard = content("StandardDimensionConversion");
  row(standard).usageUnitCode = "G";
  Object.assign(ingredient(standard), { conversionNumerator: "2", conversionDenominator: "2000" });
  expect(create(standard).measurements).toHaveLength(1);
});
it.each([
  "missing",
  "duplicate",
  "extra",
  "unknownField",
  "unknownProfile",
  "unknownKind",
  "unknownDimension",
  "dimensionMismatch",
  "identityCode",
  "identityDimension",
  "identityRatio",
  "identityReference",
  "inventoryKindOnSubrecipe",
  "subrecipeKindOnInventory",
  "recordedOnSubrecipe",
  "recordedMissingPin",
  "recordedSameUnit",
  "recordedBadPin",
  "standardRatio",
  "standardCrossDimension",
  "standardUnknownPair",
  "standardWrongDimension",
  "standardReference",
  "numericBound",
  "numericBoundaryOverflow",
  "zeroQuantity",
  "negativeRatio",
])("refuses %s content", (key) => {
  const v = content(),
    r = row(v),
    i = ingredient(v);
  if (key === "missing") v.measurements = [];
  if (key === "duplicate") v.measurements.push({ ...r });
  if (key === "extra") v.measurements.push({ ...r, requirementReference: id(99) });
  if (key === "unknownField") Object.assign(r, { untrusted: true });
  if (key === "unknownProfile") v.profile = "RecipeMeasurementContentV3";
  if (key === "unknownKind") r.conversionKind = "Unknown";
  if (key === "unknownDimension") r.usageDimension = "Other";
  if (key === "dimensionMismatch") r.usageDimension = "Count";
  if (key === "identityCode") r.usageUnitCode = "G";
  if (key === "identityDimension") r.targetDimension = "Count";
  if (key === "identityRatio") i.conversionNumerator = "2";
  if (key === "identityReference") r.conversionReference = id(70);
  if (key === "inventoryKindOnSubrecipe") i.sourceKind = "SubRecipe";
  if (key === "subrecipeKindOnInventory") r.conversionKind = "PinnedSubrecipeYieldIdentity";
  if (key === "recordedOnSubrecipe") {
    r.conversionKind = "InventoryRecordedConversion";
    r.usageUnitCode = "G";
    r.conversionReference = id(70);
    i.sourceKind = "SubRecipe";
  }
  if (key === "recordedMissingPin") {
    r.conversionKind = "InventoryRecordedConversion";
    r.usageUnitCode = "G";
  }
  if (key === "recordedSameUnit") {
    r.conversionKind = "InventoryRecordedConversion";
    r.conversionReference = id(70);
  }
  if (key === "recordedBadPin") {
    r.conversionKind = "InventoryRecordedConversion";
    r.usageUnitCode = "G";
    r.conversionReference = "unrestricted";
  }
  if (key.startsWith("standard")) {
    r.conversionKind = "StandardDimensionConversion";
    r.usageUnitCode = "G";
    i.conversionDenominator = "1000";
  }
  if (key === "standardRatio") i.conversionNumerator = "2";
  if (key === "standardCrossDimension") r.targetDimension = "Volume";
  if (key === "standardUnknownPair") r.usageUnitCode = "OUNCE";
  if (key === "standardWrongDimension") {
    r.usageDimension = r.targetDimension = "Count";
    i.unitDimension = "Count";
  }
  if (key === "standardReference") r.conversionReference = id(70);
  if (key === "numericBoundaryOverflow") i.quantityMicrounits = "1000000000000000000000000000001";
  if (key === "numericBound") i.conversionNumerator = "1".repeat(32);
  if (key === "zeroQuantity") i.quantityMicrounits = "0";
  if (key === "negativeRatio") i.conversionNumerator = "-1";
  expect(() => create(v)).toThrowError(expect.objectContaining({ code: "RECIPE_INPUT_INVALID" }));
});
it.each(["accessor", "prototype", "symbol", "sparse", "arrayExtra", "rowAccessor"])(
  "refuses closed-record %s without executing getters",
  (key) => {
    const v = content();
    let accessed = false;
    if (key === "accessor")
      Object.defineProperty(v, "profile", {
        get() {
          accessed = true;
          return "RecipeMeasurementContentV2";
        },
        enumerable: true,
      });
    if (key === "prototype") Object.setPrototypeOf(row(v), { inherited: true });
    if (key === "symbol") Object.assign(row(v), { [Symbol("untrusted")]: true });
    if (key === "sparse") delete (v.measurements as unknown[])[0];
    if (key === "arrayExtra") Object.assign(v.measurements, { untrusted: true });
    if (key === "rowAccessor")
      Object.defineProperty(row(v), "usageUnitCode", {
        get() {
          accessed = true;
          return "KG";
        },
        enumerable: true,
      });
    expect(() => create(v)).toThrowError(expect.objectContaining({ code: "RECIPE_INPUT_INVALID" }));
    expect(accessed).toBe(false);
  },
);
it("requires every explicit measurement and sorts immutable rows by exact requirement", () => {
  const v = content(),
    r = row(v),
    i = ingredient(v);
  v.snapshot.ingredients.push({ ...i, requirementReference: id(19) });
  expect(() => create(v)).toThrow();
  v.measurements.push({ ...r, requirementReference: id(19) });
  expect(create(v).measurements.map((r) => r.requirementReference)).toEqual([id(19), id(20)]);
});
