import { createEffectivePeriod } from "@bop/effective-period";
import { it, expect } from "vitest";
import {
  calculateRecipeMeasurementDemand as demand,
  digestRecipeMeasurementContentV2,
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
function graph() {
  const { value, child } = candidate(true),
    i = child.ingredients[0];
  if (!i) throw Error("fixture");
  const raw = {
    profile: "RecipeMeasurementContentV2",
    snapshot: {
      ...child,
      ingredients: [{ ...i, conversionNumerator: "1", conversionDenominator: "1" }],
    },
    measurements: [
      {
        requirementReference: i.requirementReference,
        usageUnitCode: "KG",
        usageDimension: "Mass",
        targetUnitCode: "KG",
        targetDimension: "Mass",
        conversionKind: "InventoryBaseUnitIdentity",
        conversionReference: null,
      },
    ],
  };
  return { root: complete(value), children: [complete(raw)] };
}
it("preserves exact fractional final quantity and all content provenance through child batches", () => {
  const g = graph(),
    r = demand(g.root, g.children, "1000000", at, at);
  expect(r).toMatchObject({
    arithmetic: "ExactRational",
    inventoryPrecision: "NotEvaluated",
    sourceAuthority: "NotEvaluated",
    publishValidation: "Incomplete",
    eligibility: "NotEvaluated",
    quantityUnit: "TargetUnitMicrounits",
  });
  expect(r.demands[0]).toMatchObject({
    quantityNumerator: "1210000",
    quantityDenominator: "3",
    targetUnitCode: "KG",
    itemReference: g.children[0]?.snapshot.ingredients[0]?.sourceReference,
  });
  expect(r.demands[0]?.sourcePath).toHaveLength(2);
  expect(r.demands[0]?.sourcePath[0]?.contentDigest).toBe(g.root.snapshot.snapshotDigest);
  expect(Object.isFrozen(r.demands[0]?.sourcePath)).toBe(true);
});
it("scales requested root yield exactly without rounding fractional demand", () => {
  const g = graph();
  expect(demand(g.root, g.children, "2000000", at, at).demands[0]).toMatchObject({
    quantityNumerator: "2420000",
    quantityDenominator: "3",
  });
});
it("preserves both shared-child paths rather than deduplicating consumption", () => {
  const g = graph(),
    i = g.root.snapshot.ingredients[0],
    m = g.root.measurements[0];
  if (!i || !m) throw Error("fixture");
  const root = complete({
    ...g.root,
    snapshot: { ...g.root.snapshot, ingredients: [i, { ...i, requirementReference: id(99) }] },
    measurements: [m, { ...m, requirementReference: id(99) }],
  });
  const r = demand(root, g.children, "1000000", at, at);
  expect(r.demands).toHaveLength(2);
  expect(r.demands[0]?.quantityNumerator).toBe(r.demands[1]?.quantityNumerator);
  expect(r.demands[0]?.sourcePath[0]?.requirementReference).not.toBe(
    r.demands[1]?.sourcePath[0]?.requirementReference,
  );
});
it("requires no children for an Inventory-only complete root", () => {
  const { value } = candidate();
  expect(demand(complete(value), [], "1000000", at, at).demands[0]).toMatchObject({
    quantityNumerator: "1100000",
    quantityDenominator: "1",
  });
});
it.each([
  "missing",
  "legacy",
  "digest",
  "draftChild",
  "target",
  "loss",
  "duplicate",
  "extra",
  "sparse",
  "getter",
  "past",
  "zeroYield",
  "overflowRequest",
  "archivedRoot",
  "conflictingOperation",
])("refuses %s complete demand input", (mode) => {
  const g = graph();
  let children: unknown = g.children,
    root = g.root;
  let requested = "1000000",
    activation = at;
  const child = g.children[0];
  if (!child) throw Error("fixture");
  if (mode === "missing") children = [];
  if (mode === "legacy") children = [child.snapshot];
  if (mode === "digest")
    children = [
      {
        ...child,
        snapshot: {
          ...child.snapshot,
          snapshotDigest: parseRecipeDigest("sha256:" + "f".repeat(64)),
        },
      },
    ];
  if (mode === "draftChild")
    children = [complete({ ...child, snapshot: { ...child.snapshot, lifecycle: "Draft" } })];
  if (mode === "target")
    root = complete({
      ...root,
      measurements: root.measurements.map((m) => ({
        ...m,
        usageUnitCode: "UNKNOWN",
        targetUnitCode: "UNKNOWN",
      })),
    });
  if (mode === "loss")
    children = [
      complete({
        ...child,
        snapshot: {
          ...child.snapshot,
          ingredients: child.snapshot.ingredients.map((i) => ({
            ...i,
            quantityMicrounits: "1",
            lossBasisPoints: 1,
          })),
        },
      }),
    ];
  if (mode === "duplicate") children = [child, child];
  if (mode === "extra")
    children = [
      child,
      complete({
        ...child,
        snapshot: { ...child.snapshot, recipeReference: id(800), versionReference: id(801) },
      }),
    ];
  if (mode === "sparse") children = new Array(1);
  if (mode === "getter") {
    const arr = [child];
    Object.defineProperty(arr, "0", {
      enumerable: true,
      get: () => {
        throw Error("must not read");
      },
    });
    children = arr;
  }
  if (mode === "past") activation = "2026-08-12T18:00:00.000Z";
  if (mode === "zeroYield") requested = "0";
  if (mode === "overflowRequest") requested = "1000000000000000000000000000001";
  if (mode === "archivedRoot")
    root = complete({ ...root, snapshot: { ...root.snapshot, lifecycle: "Archived" } });
  if (mode === "conflictingOperation") {
    const i = child.snapshot.ingredients[0],
      m = child.measurements[0];
    if (!i || !m) throw Error("fixture");
    children = [
      complete({
        ...child,
        snapshot: {
          ...child.snapshot,
          ingredients: [
            i,
            { ...i, requirementReference: id(702), sourceVersionReference: id(703) },
          ],
        },
        measurements: [m, { ...m, requirementReference: id(702) }],
      }),
    ];
  }
  expect(() => demand(root, children, requested, at, activation)).toThrow();
});

function layered(levels: number, branches: number) {
  const g = graph(),
    leaf = g.children[0];
  if (!leaf) throw Error("fixture");
  let last = leaf;
  const children = [leaf];
  const source = leaf.snapshot.ingredients[0],
    measurement = leaf.measurements[0];
  if (!source || !measurement) throw Error("fixture");
  for (let i = 0; i < levels; i++) {
    const ingredients = Array.from({ length: branches }, (_, j) => ({
      ...source,
      requirementReference: id(10000 + i * 10 + j),
      sourceKind: "SubRecipe" as const,
      sourceReference: last.snapshot.recipeReference,
      sourceVersionReference: last.snapshot.versionReference,
      quantityMicrounits: "1000000",
      lossBasisPoints: 0,
    }));
    last = complete({
      ...leaf,
      snapshot: {
        ...leaf.snapshot,
        recipeReference: id(5000 + i),
        versionReference: id(6000 + i),
        ingredients,
      },
      measurements: ingredients.map((r) => ({
        ...measurement,
        requirementReference: r.requirementReference,
        conversionKind: "PinnedSubrecipeYieldIdentity",
      })),
    });
    children.push(last);
  }
  const root = complete({
    ...g.root,
    snapshot: {
      ...g.root.snapshot,
      ingredients: g.root.snapshot.ingredients.map((i) => ({
        ...i,
        sourceReference: last.snapshot.recipeReference,
        sourceVersionReference: last.snapshot.versionReference,
      })),
    },
  });
  return { root, children };
}
it("preserves exactly4096 shared graph paths at the output bound", () => {
  const g = layered(12, 2);
  expect(demand(g.root, g.children, "1000000", at, at).demands).toHaveLength(4096);
});
it("refuses exponential shared paths beyond4096 despite small graph", () => {
  const g = layered(13, 2);
  expect(() => demand(g.root, g.children, "1000000", at, at)).toThrow();
});
it("preserves owning graph depth16 bound", () => {
  const g = layered(17, 1);
  expect(() => demand(g.root, g.children, "1000000", at, at)).toThrow();
});
