import { it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { assessRecipeIngredientUnits as assess } from "../contracts/recipe-ingredient-unit-assessment.js";
import { buildCurrentRecipeIngredientUnitFacts } from "../contracts/recipe-ingredient-unit-source.js";
import { buildInventoryConfigurationReferenceSnapshot } from "../contracts/configuration-reference-source.js";
const id = (n: number) => "01902459-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T05:00:00.000Z",
  later = "2026-10-02T05:00:00.000Z";
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(4),
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: "sha256:" + "a".repeat(64),
};
const pin = {
  recipeReference: id(90),
  recipeVersionReference: id(91),
  requirementReference: id(100),
  itemReference: id(10),
  operationReference: id(32),
};
const row = () => ({
  ...pin,
  usageUnitCode: "KG",
  usageDimension: "Mass",
  targetUnitCode: "KG",
  targetDimension: "Mass",
  conversionKind: "InventoryBaseUnitIdentity",
  conversionReference: null as string | null,
  quantityMicrounits: "2000000",
  conversionNumerator: "1",
  conversionDenominator: "1",
});
function setup() {
  const scope = { tenantReference: id(4), brandReference: id(1) };
  const metadata = buildInventoryConfigurationReferenceSnapshot(
    {
      generation: "2",
      observedAt: at,
      counts: { items: "1", versions: "2", operations: "2" },
      items: [
        { ...scope, itemReference: id(10), itemType: "RawMaterial", createdAt: at, precise: true },
      ],
      versions: [1, 2].map((v) => ({
        ...scope,
        itemReference: id(10),
        itemVersion: String(v),
        itemType: "RawMaterial",
        lifecycle: v === 2 ? "Active" : "Inactive",
        recordedAt: at,
        precise: true,
      })),
      operations: [1, 2].map((v) => ({
        ...scope,
        itemReference: id(10),
        itemVersion: String(v),
        operationReference: id(30 + v),
        action: v === 2 ? "Activate" : "Create",
      })),
    },
    request,
    at,
  );
  const units = [
    {
      itemReference: id(10),
      itemVersion: "2",
      operationReference: id(32),
      recordedAt: at,
      precise: true,
      baseUnit: {
        unitCode: "KG",
        dimension: "Mass",
        displayPrecision: 4,
        ledgerPrecision: 4,
        roundingMode: "HalfEven",
      },
      unitConversions: [
        {
          conversionReference: id(40),
          fromUnitCode: "CASE",
          toBaseUnitCode: "KG",
          multiplier: "6.25",
          effectiveFrom: at,
          reasonCode: "SYNTHETIC_APPROVED_RULE",
          status: "Active",
        },
      ],
    },
  ];
  const facts = () => ({
    ...buildCurrentRecipeIngredientUnitFacts([pin], units, metadata, request, at),
    validUntil: "2026-10-01T05:00:05.000Z",
  });
  return { units, facts };
}
function match(rows: unknown = [row()], fixture = setup(), now = at, activation = at) {
  return assess(rows, fixture.facts(), now, activation).matches[0];
}
it("binds exact identity to full current units without granting loss/yield/stock/sale authority", () => {
  const f = setup(),
    result = assess([row()], f.facts(), at, later);
  expect(result).toMatchObject({
    unitArithmetic: "Pass",
    loss: "NotEvaluated",
    subrecipeYield: "NotEvaluated",
    stock: "NotEvaluated",
    eligibility: "NotEvaluated",
    unitSourceDigest: f.facts().digest,
    ownerGeneration: "2",
  });
  expect(result.matches[0]).toMatchObject({
    baseQuantity: "2",
    baseQuantityMicrounits: "2000000",
    ledgerPrecision: 4,
    roundingMode: "HalfEven",
    status: "ExactBaseQuantity",
  });
  expect(Object.isFrozen(result.matches)).toBe(true);
  expect(Object.isFrozen(result.matches[0])).toBe(true);
});
it.each([
  ["G", "KG", "Mass", "1", "1000", "1000000", "1000"],
  ["KG", "G", "Mass", "1000", "1", "1000000", "1000000000"],
  ["ML", "L", "Volume", "1", "1000", "1000000", "1000"],
  ["L", "ML", "Volume", "1000", "1", "1000000", "1000000000"],
])(
  "compares exact standard %s -> %s only with actual owning base",
  (usage, target, dim, n, d, q, result) => {
    const f = setup();
    const u = f.units[0];
    if (!u) throw Error("fixture");
    if (!target || !dim) throw Error("fixture");
    u.baseUnit.unitCode = target;
    u.baseUnit.dimension = dim;
    u.unitConversions = [];
    expect(
      match(
        [
          {
            ...row(),
            usageUnitCode: usage,
            targetUnitCode: target,
            usageDimension: dim,
            targetDimension: dim,
            conversionKind: "StandardDimensionConversion",
            conversionNumerator: n,
            conversionDenominator: d,
            quantityMicrounits: q,
          },
        ],
        f,
      ),
    ).toMatchObject({ status: "ExactBaseQuantity", baseQuantityMicrounits: result });
  },
);
it("requires current exact recorded reference and equivalent rational factor including cross dimensions", () => {
  expect(
    match([
      {
        ...row(),
        usageUnitCode: "CASE",
        usageDimension: "Count",
        conversionKind: "InventoryRecordedConversion",
        conversionReference: id(40),
        conversionNumerator: "25",
        conversionDenominator: "4",
      },
    ]),
  ).toMatchObject({ status: "ExactBaseQuantity", baseQuantity: "12.5" });
});
it.each([
  ["BaseUnitMismatch", { targetUnitCode: "G" }],
  ["BaseUnitMismatch", { targetDimension: "Volume" }],
  ["IncompatibleDimension", { usageDimension: "Count" }],
  ["MissingConversion", { usageUnitCode: "G" }],
  ["ConversionFactorMismatch", { conversionNumerator: "2" }],
  ["RoundingRequired", { quantityMicrounits: "1" }],
  [
    "RoundingRequired",
    {
      usageUnitCode: "G",
      conversionKind: "StandardDimensionConversion",
      conversionDenominator: "1000",
      quantityMicrounits: "1",
    },
  ],
  [
    "QuantityOutOfRange",
    {
      usageUnitCode: "G",
      targetUnitCode: "KG",
      quantityMicrounits: "1000000000000000000000000000000",
      conversionKind: "InventoryRecordedConversion",
      conversionReference: id(40),
      conversionNumerator: "625",
      conversionDenominator: "100",
    },
  ],
])("returns bounded %s without quantity or silent rounding", (status, patch) => {
  const f = setup();
  if (status === "QuantityOutOfRange") {
    const c = f.units[0]?.unitConversions[0];
    if (!c) throw Error("fixture");
    c.fromUnitCode = "G";
  }
  const result = assess([{ ...row(), ...patch }], f.facts(), at, at);
  expect(result.unitArithmetic).toBe("HardError");
  expect(result.matches[0]).toMatchObject({
    status,
    baseQuantity: null,
    baseQuantityMicrounits: null,
  });
});
it.each(["missing", "retired", "future", "pin", "factor", "ambiguous", "futureAmbiguous"])(
  "refuses recorded %s rules",
  (mode) => {
    const f = setup(),
      u = f.units[0],
      r = {
        ...row(),
        usageUnitCode: "CASE",
        usageDimension: "Count",
        conversionKind: "InventoryRecordedConversion",
        conversionReference: id(40),
        conversionNumerator: "25",
        conversionDenominator: "4",
      };
    if (!u) throw Error("fixture");
    const c = u.unitConversions[0];
    if (!c) throw Error("fixture");
    if (mode === "missing") u.unitConversions = [];
    if (mode === "retired") c.status = "Retired";
    if (mode === "future") c.effectiveFrom = later;
    if (mode === "pin") r.conversionReference = id(41);
    if (mode === "factor") r.conversionNumerator = "26";
    if (mode === "ambiguous" || mode === "futureAmbiguous")
      u.unitConversions.push({
        ...c,
        conversionReference: id(41),
        effectiveFrom: mode === "ambiguous" ? at : later,
      });
    expect(match([r], f, at, later)?.status).toBe(
      ["missing", "retired", "future"].includes(mode)
        ? "MissingConversion"
        : mode === "pin"
          ? "ConversionPinMismatch"
          : mode === "factor"
            ? "ConversionFactorMismatch"
            : "AmbiguousConversion",
    );
  },
);
it("preserves exact 10^30 and non-reduced rational identity", () => {
  expect(
    match([
      {
        ...row(),
        quantityMicrounits: "1000000000000000000000000000000",
        conversionNumerator: "7",
        conversionDenominator: "7",
      },
    ]),
  ).toMatchObject({
    status: "ExactBaseQuantity",
    baseQuantityMicrounits: "1000000000000000000000000000000",
  });
});
it.each([
  "extra",
  "getter",
  "sparse",
  "prototype",
  "duplicate",
  "missing",
  "wrongItem",
  "wrongOp",
  "wrongRecipe",
  "zero",
  "overflow",
  "leadingZero",
  "ratioZero",
  "kind",
  "ref",
  "identityRef",
  "dimension",
  "float",
])("rejects closed input %s before comparison", (mode) => {
  const r: Record<string, unknown> = row();
  let rows: unknown = [r];
  if (mode === "extra") r.extra = true;
  if (mode === "getter")
    Object.defineProperty(r, "usageUnitCode", {
      enumerable: true,
      get: () => {
        throw Error("must not invoke");
      },
    });
  if (mode === "sparse") rows = new Array(1);
  if (mode === "prototype") Object.setPrototypeOf(r, null);
  if (mode === "duplicate") rows = [r, r];
  if (mode === "missing") rows = [];
  if (mode === "wrongItem") r.itemReference = id(11);
  if (mode === "wrongOp") r.operationReference = id(31);
  if (mode === "wrongRecipe") r.recipeReference = id(92);
  if (mode === "zero") r.quantityMicrounits = "0";
  if (mode === "overflow") r.quantityMicrounits = "1000000000000000000000000000001";
  if (mode === "leadingZero") r.quantityMicrounits = "01";
  if (mode === "ratioZero") r.conversionDenominator = "0";
  if (mode === "kind") r.conversionKind = "PinnedSubrecipeYieldIdentity";
  if (mode === "ref") {
    r.conversionKind = "InventoryRecordedConversion";
    r.conversionReference = "invalid";
  }
  if (mode === "identityRef") r.conversionReference = id(40);
  if (mode === "dimension") r.usageDimension = "Other";
  if (mode === "float") r.quantityMicrounits = 1.2;
  expect(() => match(rows)).toThrowError(
    expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
  );
});
it.each(["expiry", "backwards", "pastActivation", "digest", "sourceShape", "lease", "units"])(
  "rejects unavailable held fact boundary %s",
  (mode) => {
    const f = setup(),
      facts = f.facts();
    let now = at,
      activation = at;
    if (mode === "expiry") now = facts.validUntil;
    if (mode === "backwards") now = "2026-10-01T04:59:59.999Z";
    if (mode === "pastActivation") activation = "2026-10-01T04:59:59.999Z";
    if (mode === "digest") facts.digest = "sha256:" + "b".repeat(64);
    if (mode === "sourceShape") Object.defineProperty(facts, "extra", { value: true });
    if (mode === "lease") facts.validUntil = later;
    if (mode === "units") {
      const { digest: old, validUntil, ...body } = facts;
      void old;
      void validUntil;
      Object.assign(body, { units: [] });
      Object.assign(facts, body, { digest: "sha256:" + sha256Hex(canonicalizeRfc8785(body)) });
    }
    expect(() => assess([row()], facts, now, activation)).toThrowError(
      expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
    );
  },
);

it.each(["request", "base", "conversion", "pins"])(
  "rejects nested source %s accessor without invoking it",
  (mode) => {
    const facts = setup().facts();
    let invoked = false;
    const bad = (value: object, key: string) => {
      const copy = { ...value };
      Object.defineProperty(copy, key, {
        enumerable: true,
        get: () => {
          invoked = true;
          throw Error("must not read");
        },
      });
      return copy;
    };
    if (mode === "request") Object.assign(facts, { request: bad(facts.request, "actorReference") });
    if (mode === "pins") Object.assign(facts, { pins: [bad(pin, "itemReference")] });
    if (mode === "base" || mode === "conversion") {
      const u = facts.units[0];
      if (!u) throw Error("fixture");
      const c = u.unitConversions[0];
      if (!c) throw Error("fixture");
      Object.assign(facts, {
        units: [
          {
            ...u,
            ...(mode === "base"
              ? { baseUnit: bad(u.baseUnit, "unitCode") }
              : { unitConversions: [bad(c, "multiplier")] }),
          },
        ],
      });
    }
    expect(() => assess([row()], facts, at, at)).toThrowError(
      expect.objectContaining({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" }),
    );
    expect(invoked).toBe(false);
  },
);
