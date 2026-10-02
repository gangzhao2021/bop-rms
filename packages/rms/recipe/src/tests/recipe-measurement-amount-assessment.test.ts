import { createEffectivePeriod } from "@bop/effective-period";
import { it, expect } from "vitest";
import {
  assessRecipeMeasurementAmounts as assess,
  digestRecipeMeasurementContentV2,
  calculateRecipe,
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

function candidate(sub = false) {
  const child = createRecipeSnapshot({
    ...recipe({ lifecycle: "Published" }),
    recipeReference: id(50),
    versionReference: id(51),
    yieldUnitCode: parseRecipeCode("KG"),
    yieldDimension: "Mass",
    yieldQuantityMicrounits: "3000000",
  });
  const core = recipe(sub ? { sub: child } : {}),
    ingredient = core.ingredients[0];
  if (!ingredient) throw Error("fixture");
  const value = {
    profile: "RecipeMeasurementContentV2",
    snapshot: {
      ...core,
      ingredients: [{ ...ingredient, conversionNumerator: "1", conversionDenominator: "1" }],
    },
    measurements: [
      {
        requirementReference: ingredient.requirementReference,
        usageUnitCode: "KG",
        usageDimension: "Mass",
        targetUnitCode: "KG",
        targetDimension: "Mass",
        conversionKind: sub ? "PinnedSubrecipeYieldIdentity" : "InventoryBaseUnitIdentity",
        conversionReference: null,
      },
    ],
  };
  return { value, child };
}
function complete(value: ReturnType<typeof candidate>["value"]) {
  return {
    ...value,
    snapshot: { ...value.snapshot, snapshotDigest: digestRecipeMeasurementContentV2(value) },
  };
}
function requirement(value: ReturnType<typeof candidate>["value"]) {
  const r = value.snapshot.ingredients[0];
  if (!r) throw Error("fixture");
  return r;
}
it("computes exact loss without changing legacy HalfUp calculator or granting unit/publish authority", () => {
  const { value } = candidate(),
    c = complete(value),
    result = assess(c, [], at, at);
  expect(result).toMatchObject({
    quantityArithmetic: "Pass",
    inventoryPrecision: "NotEvaluated",
    recursiveDemand: "NotEvaluated",
    sourceAuthority: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
    contentDigest: c.snapshot.snapshotDigest,
  });
  expect(result.matches[0]).toMatchObject({
    convertedQuantityMicrounits: "1000000",
    lossAdjustedQuantityMicrounits: "1100000",
    batchFactor: null,
    status: "ExactAmount",
  });
  expect(calculateRecipe(c.snapshot).requirements[0]?.baseQuantityMicrounits).toBe("1100000");
  expect(Object.isFrozen(result.matches[0])).toBe(true);
});
it("compares exact child target and reduced fractional batch yield, not an assumed one batch", () => {
  const { value, child } = candidate(true),
    result = assess(complete(value), [child], at, at);
  expect(result.matches[0]).toMatchObject({
    childYieldQuantityMicrounits: "3000000",
    childSnapshotDigest: child.snapshotDigest,
    batchFactor: { numerator: "11", denominator: "30" },
    status: "ExactAmount",
  });
  expect(Object.isFrozen(result.matches[0]?.batchFactor)).toBe(true);
});
it.each([0, 10000])("preserves accepted loss boundary %i", (loss) => {
  const { value } = candidate();
  requirement(value).lossBasisPoints = loss;
  expect(assess(complete(value), [], at, at).matches[0]?.lossAdjustedQuantityMicrounits).toBe(
    loss === 0 ? "1000000" : "2000000",
  );
});
it("accepts explicit standard conversion against actual child yield units", () => {
  const { value, child } = candidate(true),
    r = requirement(value),
    m = value.measurements[0];
  if (!m) throw Error("fixture");
  m.usageUnitCode = "G";
  m.conversionKind = "StandardDimensionConversion";
  r.conversionDenominator = "1000";
  expect(assess(complete(value), [child], at, at).matches[0]).toMatchObject({
    convertedQuantityMicrounits: "1000",
    lossAdjustedQuantityMicrounits: "1100",
    batchFactor: { numerator: "11", denominator: "30000" },
  });
});
it.each(["conversion", "loss", "convertedOverflow", "lossOverflow"])(
  "refuses %s amount without hiding rounding",
  (mode) => {
    const { value } = candidate(),
      r = requirement(value),
      m = value.measurements[0];
    if (!m) throw Error("fixture");
    if (mode === "conversion") {
      m.usageUnitCode = "G";
      m.conversionKind = "StandardDimensionConversion";
      r.conversionDenominator = "1000";
      r.quantityMicrounits = "1";
    }
    if (mode === "loss") {
      r.quantityMicrounits = "1";
      r.lossBasisPoints = 1;
    }
    if (mode === "convertedOverflow") {
      m.usageUnitCode = "G";
      m.conversionKind = "InventoryRecordedConversion";
      Object.assign(m, { conversionReference: id(80) });
      r.conversionNumerator = "2";
      r.quantityMicrounits = "1000000000000000000000000000000";
    }
    if (mode === "lossOverflow") {
      r.quantityMicrounits = "1000000000000000000000000000000";
      r.lossBasisPoints = 1;
    }
    const result = assess(complete(value), [], at, at);
    expect(result.quantityArithmetic).toBe("HardError");
    expect(result.matches[0]).toMatchObject({
      status:
        mode === "conversion"
          ? "ConversionRoundingRequired"
          : mode === "loss"
            ? "LossRoundingRequired"
            : "QuantityOutOfRange",
      convertedQuantityMicrounits: null,
      lossAdjustedQuantityMicrounits: null,
      batchFactor: null,
    });
  },
);
it.each(["code", "dimension", "draft", "archived", "future", "expired", "activationExpired"])(
  "refuses pinned child yield %s",
  (mode) => {
    const { value, child } = candidate(true);
    let next = { ...child };
    let activation = at;
    if (mode === "code") next.yieldUnitCode = parseRecipeCode("G");
    if (mode === "dimension") next.yieldDimension = "Count";
    if (mode === "draft") next.lifecycle = "Draft";
    if (mode === "archived") next.lifecycle = "Archived";
    if (mode === "future") next.createdAt = "2026-08-14T18:00:00.000Z";
    if (mode === "expired" || mode === "activationExpired") {
      next = {
        ...next,
        effectivePeriod: createEffectivePeriod({
          timeZone: "America/Toronto",
          effectiveFrom: period.effectiveFrom,
          effectiveUntil: {
            instant: "2026-08-14T04:00:00.000Z" as never,
            localDateTime: "2026-08-14T00:00:00.000",
            utcOffsetMinutes: -240,
          },
        }),
      };
      activation = "2026-08-14T04:00:00.000Z";
      if (mode === "expired")
        next = {
          ...next,
          effectivePeriod: createEffectivePeriod({
            timeZone: "America/Toronto",
            effectiveFrom: period.effectiveFrom,
            effectiveUntil: {
              instant: "2026-08-13T04:00:00.000Z" as never,
              localDateTime: "2026-08-13T00:00:00.000",
              utcOffsetMinutes: -240,
            },
          }),
        };
    }
    const result = assess(complete(value), [next], at, activation);
    expect(result.matches[0]).toMatchObject({
      status: ["code", "dimension"].includes(mode)
        ? "PinnedYieldUnitMismatch"
        : "PinnedYieldUnavailable",
      batchFactor: null,
      lossAdjustedQuantityMicrounits: null,
    });
  },
);
it.each([
  "missing",
  "wrongRoot",
  "wrongVersion",
  "wrongBrand",
  "duplicate",
  "extra",
  "sparse",
  "getter",
  "cycle",
  "digest",
  "zeroRoot",
  "pastActivation",
])("rejects invalid content/graph %s", (mode) => {
  const { value, child } = candidate(true);
  let input: unknown = [child];
  if (mode === "missing") input = [];
  if (mode === "wrongRoot") input = [{ ...child, recipeReference: id(55) }];
  if (mode === "wrongVersion") input = [{ ...child, versionReference: id(56) }];
  if (mode === "wrongBrand") input = [{ ...child, brandReference: id(57) }];
  if (mode === "duplicate") input = [child, child];
  if (mode === "extra")
    input = [child, { ...child, recipeReference: id(58), versionReference: id(59) }];
  if (mode === "sparse") input = new Array(1);
  if (mode === "getter") {
    const array = [child];
    Object.defineProperty(array, "0", {
      enumerable: true,
      get: () => {
        throw Error("must not read");
      },
    });
    input = array;
  }
  if (mode === "cycle") {
    const r = child.ingredients[0];
    if (!r) throw Error("fixture");
    input = [
      {
        ...child,
        ingredients: [
          {
            ...r,
            sourceKind: "SubRecipe",
            sourceReference: value.snapshot.recipeReference,
            sourceVersionReference: value.snapshot.versionReference,
          },
        ],
      },
    ];
  }
  const c = complete(value);
  if (mode === "zeroRoot") c.snapshot.yieldQuantityMicrounits = "0";
  if (mode === "digest") c.snapshot.snapshotDigest = parseRecipeDigest("sha256:" + "f".repeat(64));
  expect(() =>
    assess(c, input, at, mode === "pastActivation" ? "2026-08-12T18:00:00.000Z" : at),
  ).toThrow();
});

it("rejects zero pinned yield at the unchanged core parser boundary", () => {
  const { value, child } = candidate(true);
  expect(() =>
    assess(complete(value), [{ ...child, yieldQuantityMicrounits: "0" }], at, at),
  ).toThrow();
});
it("accepts exact maximum amount with zero loss and preserves fractional batch ratio", () => {
  const { value, child } = candidate(true),
    r = requirement(value);
  r.quantityMicrounits = "1000000000000000000000000000000";
  r.lossBasisPoints = 0;
  expect(assess(complete(value), [child], at, at).matches[0]).toMatchObject({
    status: "ExactAmount",
    lossAdjustedQuantityMicrounits: r.quantityMicrounits,
    batchFactor: { numerator: "1000000000000000000000000", denominator: "3" },
  });
});
it("binds all quantity/loss inputs to complete content digest", () => {
  const { value } = candidate(),
    c = complete(value);
  requirement(c).lossBasisPoints = 999;
  expect(() => assess(c, [], at, at)).toThrow();
});

it.each([255, 256])(
  "enforces whole graph 4096 requirement bound with %i requirements per child",
  (count) => {
    const { value, child } = candidate(true),
      source = child.ingredients[0],
      parent = requirement(value),
      measurement = value.measurements[0];
    if (!source || !measurement) throw Error("fixture");
    const snapshots = Array.from({ length: 16 }, (_, i) => ({
      ...child,
      recipeReference: id(1000 + i),
      versionReference: id(2000 + i),
      ingredients: Array.from({ length: count }, (_, j) => ({
        ...source,
        requirementReference: id(10000 + i * 256 + j),
      })),
    }));
    value.snapshot.ingredients = snapshots.map((s, i) => ({
      ...parent,
      requirementReference: id(200000 + i),
      sourceReference: s.recipeReference,
      sourceVersionReference: s.versionReference,
    }));
    value.measurements = value.snapshot.ingredients.map((i) => ({
      ...measurement,
      requirementReference: i.requirementReference,
    }));
    const c = complete(value);
    if (count === 255) expect(assess(c, snapshots, at, at).matches).toHaveLength(16);
    else expect(() => assess(c, snapshots, at, at)).toThrow();
  },
);
