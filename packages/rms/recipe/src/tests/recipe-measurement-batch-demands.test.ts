import { createEffectivePeriod } from "@bop/effective-period";
import { it, expect } from "vitest";
import {
  calculateRecipeMeasurementBatchDemands as batches,
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

it("qualifies independent selected roots with shared pinned child paths", () => {
  const {
    root: parent,
    children: [child],
  } = graph();
  if (!child) throw Error("fixture");
  const p = complete({ ...parent, snapshot: { ...parent.snapshot, lifecycle: "Published" } });
  const r = batches(
    [p.snapshot.versionReference, child.snapshot.versionReference],
    [p, child],
    at,
    at,
  );
  expect(r.batches).toHaveLength(2);
  expect(r.quantityBasis).toBe("OneIndependentRecipeBatchPerRoot");
  expect(r.productQuantity).toBe("NotEvaluated");
  expect(r.batches.map((b) => b.demands[0]?.sourcePath.length).sort()).toEqual([1, 2]);
  expect(r.batches[0]?.requestedYieldMicrounits).toBe(p.snapshot.yieldQuantityMicrounits);
});
it("normalizes graph order without summing independent batches", () => {
  const { root: parent, children: children } = graph(),
    child = children[0];
  if (!child) throw Error("fixture");
  const p = complete({ ...parent, snapshot: { ...parent.snapshot, lifecycle: "Published" } });
  expect(
    batches([child.snapshot.versionReference, p.snapshot.versionReference], [child, p], at, at),
  ).toEqual(
    batches([p.snapshot.versionReference, child.snapshot.versionReference], [p, child], at, at),
  );
});
it.each([
  "empty",
  "duplicate",
  "missing",
  "orphan",
  "draft",
  "legacy",
  "cycle",
  "pin",
  "brand",
  "sparse",
  "accessor",
  "extra",
  "tooManyRoots",
  "tooManyContents",
])("refuses %s batch graph", (mode) => {
  const { root: parent, children: children } = graph(),
    child = children[0];
  if (!child) throw Error("fixture");
  const p = complete({ ...parent, snapshot: { ...parent.snapshot, lifecycle: "Published" } });
  let roots: unknown = [p.snapshot.versionReference],
    contents: unknown = [p, child];
  if (mode === "empty") roots = [];
  if (mode === "duplicate") roots = [p.snapshot.versionReference, p.snapshot.versionReference];
  if (mode === "missing") contents = [p];
  if (mode === "orphan") roots = [child.snapshot.versionReference];
  if (mode === "draft") contents = [parent, child];
  if (mode === "legacy") contents = [{ ...p, profile: "RecipeCoreV1" }, child];
  if (mode === "cycle") {
    const i = p.snapshot.ingredients[0];
    if (!i) throw Error("fixture");
    const loop = complete({
      ...p,
      snapshot: {
        ...p.snapshot,
        ingredients: [
          {
            ...i,
            sourceReference: p.snapshot.recipeReference,
            sourceVersionReference: p.snapshot.versionReference,
          },
        ],
      },
    });
    contents = [loop, child];
  }
  if (mode === "pin") {
    const i = p.snapshot.ingredients[0];
    if (!i) throw Error("fixture");
    contents = [
      complete({
        ...p,
        snapshot: { ...p.snapshot, ingredients: [{ ...i, sourceReference: id(999) }] },
      }),
      child,
    ];
  }
  if (mode === "brand")
    contents = [p, complete({ ...child, snapshot: { ...child.snapshot, brandReference: id(99) } })];
  if (mode === "sparse") roots = Array(1);
  if (mode === "accessor") {
    const r: unknown[] = [];
    Object.defineProperty(r, "0", {
      enumerable: true,
      get() {
        throw Error("never read");
      },
    });
    roots = r;
  }
  if (mode === "extra") roots = Object.assign([p.snapshot.versionReference], { extra: true });
  if (mode === "tooManyRoots") roots = Array(257).fill(p.snapshot.versionReference);
  if (mode === "tooManyContents") contents = Array(257).fill(p);
  expect(() => batches(roots, contents, at, at)).toThrow();
});
it("rejects duplicate exact content rather than overriding a version", () => {
  const { root: parent, children } = graph(),
    child = children[0];
  if (!child) throw Error("fixture");
  const p = complete({ ...parent, snapshot: { ...parent.snapshot, lifecycle: "Published" } });
  expect(() => batches([p.snapshot.versionReference], [p, child, child], at, at)).toThrow();
});

function sharedPaths() {
  const { root, children } = graph(),
    leaf = children[0];
  if (!leaf) throw Error("fixture");
  const contents = [leaf];
  let child = leaf;
  for (let level = 0; level < 12; level++) {
    const ingredient = root.snapshot.ingredients[0],
      measurement = root.measurements[0];
    if (!ingredient || !measurement) throw Error("fixture");
    const requirements = [id(1000 + level * 2), id(1001 + level * 2)];
    child = complete({
      ...root,
      snapshot: {
        ...root.snapshot,
        lifecycle: "Published",
        recipeReference: id(2000 + level),
        versionReference: id(3000 + level),
        ingredients: requirements.map((requirementReference) => ({
          ...ingredient,
          requirementReference,
          sourceReference: child.snapshot.recipeReference,
          sourceVersionReference: child.snapshot.versionReference,
          unitDimension: child.snapshot.yieldDimension,
          quantityMicrounits: child.snapshot.yieldQuantityMicrounits,
          lossBasisPoints: 0,
        })),
      },
      measurements: requirements.map((requirementReference) => ({
        ...measurement,
        requirementReference,
        usageUnitCode: child.snapshot.yieldUnitCode,
        usageDimension: child.snapshot.yieldDimension,
        targetUnitCode: child.snapshot.yieldUnitCode,
        targetDimension: child.snapshot.yieldDimension,
      })),
    });
    contents.push(child);
  }
  return { contents, root: child };
}
it("accepts 4096 shared consumption paths without deduplicating a batch", () => {
  const { contents, root } = sharedPaths();
  expect(
    batches([root.snapshot.versionReference], contents, at, at).batches[0]?.demands,
  ).toHaveLength(4096);
});
it("bounds total consumption paths across independent selected roots", () => {
  const { contents, root } = sharedPaths(),
    second = contents[contents.length - 2];
  if (!second) throw Error("fixture");
  expect(() =>
    batches([root.snapshot.versionReference, second.snapshot.versionReference], contents, at, at),
  ).toThrow();
});
