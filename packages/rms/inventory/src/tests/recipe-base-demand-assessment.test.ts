import { it, expect } from "vitest";
import { canonicalizeRfc8785, sha256Hex } from "@bop/audit";
import { assessRecipeBaseDemands as assess } from "../contracts/recipe-base-demand-assessment.js";
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
const path = (n: number) => "sha256:" + n.toString(16).padStart(64, "0");
const row = () => ({
  ...pin,
  pathDigest: path(1),
  targetUnitCode: "KG",
  targetDimension: "Mass",
  quantityNumerator: "2000000",
  quantityDenominator: "1",
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

function result(rows: unknown = [row()], f = setup(), now = at, activation = later) {
  return assess(rows, f.facts(), now, activation);
}
it("binds current full owner facts and exact final demand without granting conversion/source/stock/sale", () => {
  const f = setup(),
    r = result([row()], f);
  expect(r).toMatchObject({
    inventoryPrecision: "Pass",
    aggregateStatus: "ExactBaseDemand",
    unitSourceDigest: f.facts().digest,
    ownerGeneration: "2",
    conversionApplicability: "NotEvaluated",
    sourceAuthority: "NotEvaluated",
    stock: "NotEvaluated",
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(r.aggregates[0]).toMatchObject({
    baseQuantity: "2",
    baseQuantityMicrounits: "2000000",
    ledgerPrecision: 4,
    roundingMode: "HalfEven",
    paths: [path(1)],
  });
  expect(Object.isFrozen(r.aggregates)).toBe(true);
  expect(Object.isFrozen(r.matches[0])).toBe(true);
});
it("reduces exact fractions and preserves repeated selector consumption paths", () => {
  const r = result([
    { ...row(), quantityNumerator: "3000000", quantityDenominator: "3" },
    { ...row(), pathDigest: path(2) },
  ]);
  expect(r.inventoryPrecision).toBe("Pass");
  expect(r.matches[0]?.quantityDenominator).toBe("1");
  expect(r.aggregates[0]).toMatchObject({ baseQuantity: "3", paths: [path(1), path(2)] });
});
it.each([0, 1, 2, 3, 4, 5, 6])("uses actual ledger precision %i", (precision) => {
  const f = setup(),
    u = f.units[0];
  if (!u) throw Error("fixture");
  u.baseUnit.ledgerPrecision = precision;
  u.baseUnit.displayPrecision = precision;
  const step = (10n ** BigInt(6 - precision)).toString();
  expect(result([{ ...row(), quantityNumerator: step }], f).inventoryPrecision).toBe("Pass");
  if (precision < 6)
    expect(
      result([{ ...row(), quantityNumerator: (BigInt(step) - 1n).toString() }], f).matches[0]
        ?.status,
    ).toBe("RoundingRequired");
});
it.each([
  ["BaseUnitMismatch", { targetUnitCode: "G" }],
  ["BaseUnitMismatch", { targetDimension: "Volume" }],
  ["RoundingRequired", { quantityNumerator: "1" }],
  ["RoundingRequired", { quantityNumerator: "100", quantityDenominator: "3" }],
  ["QuantityOutOfRange", { quantityNumerator: (10n ** 30n + 1n).toString() }],
])("refuses %s with no usable aggregate or failed-path quantity", (status, patch) => {
  const r = result([{ ...row(), ...patch }]);
  expect(r.inventoryPrecision).toBe("HardError");
  expect(r.aggregates).toEqual([]);
  expect(r.matches[0]).toMatchObject({ status, baseQuantityMicrounits: null });
});
it("does not use aggregate cancellation to admit unrepresentable individual paths", () => {
  const r = result([
    { ...row(), quantityNumerator: "50" },
    { ...row(), quantityNumerator: "50", pathDigest: path(2) },
  ]);
  expect(r.inventoryPrecision).toBe("HardError");
  expect(r.aggregates).toEqual([]);
});
it("allows exact10^30 but rejects same-Item aggregate overflow", () => {
  const r = { ...row(), quantityNumerator: (10n ** 30n).toString() };
  expect(result([r]).inventoryPrecision).toBe("Pass");
  expect(result([r, { ...row(), quantityNumerator: "100", pathDigest: path(2) }])).toMatchObject({
    inventoryPrecision: "HardError",
    aggregateStatus: "QuantityOutOfRange",
    aggregates: [],
  });
});
it("accepts4096 shared paths without deduplicating and rejects4097", () => {
  const rows = Array.from({ length: 4096 }, (_, i) => ({
    ...row(),
    pathDigest: path(i + 1),
    quantityNumerator: "100",
  }));
  expect(result(rows).aggregates[0]?.baseQuantityMicrounits).toBe("409600");
  expect(() => result([...rows, { ...row(), pathDigest: path(5000) }])).toThrow();
});
it.each([
  { quantityNumerator: "0" },
  { quantityDenominator: "0" },
  { quantityNumerator: "01" },
  { quantityNumerator: "-1" },
  { quantityNumerator: "1.5" },
  { quantityDenominator: (10n ** 1024n + 1n).toString() },
  { targetUnitCode: "kg" },
  { targetDimension: "Length" },
  { pathDigest: "bad" },
  { operationReference: id(999) },
  { itemReference: id(999) },
  { recipeVersionReference: id(999) },
  { extra: true },
])("rejects malformed or mismatched selector %#", (patch) =>
  expect(() => result([{ ...row(), ...patch }])).toThrow(),
);
it("refuses duplicate path and conflicting same-requirement selector", () => {
  expect(() => result([row(), row()])).toThrow();
  expect(() =>
    result([row(), { ...row(), pathDigest: path(2), recipeReference: id(999) }]),
  ).toThrow();
});
it.each(["2026-10-01T04:59:59.999Z", "2026-10-01T05:00:05.000Z"])(
  "rejects current time outside original lease %s",
  (now) => expect(() => result([row()], setup(), now)).toThrow(),
);
it("rejects proposed activation before assessment", () =>
  expect(() => result([row()], setup(), at, "2026-10-01T04:59:59.999Z")).toThrow());
it("rejects tampered complete facts, wrong source flags and shortened/rebased lease", () => {
  const f = setup(),
    facts = f.facts();
  for (const patch of [
    { digest: "sha256:" + "f".repeat(64) },
    { stock: "Pass" },
    { validUntil: "2026-10-01T05:00:06.000Z" },
  ])
    expect(() => assess([row()], { ...facts, ...patch } as typeof facts, at, later)).toThrow();
});
it.each(["input", "facts", "unit", "conversion"])(
  "does not invoke %s accessors while validating",
  (mode) => {
    const f = setup(),
      facts = JSON.parse(JSON.stringify(f.facts())) as ReturnType<typeof f.facts>,
      input = { ...row() };
    let calls = 0;
    const poison = (v: object, key: string) =>
      Object.defineProperty(v, key, {
        enumerable: true,
        get() {
          calls++;
          throw Error("getter");
        },
      });
    if (mode === "input") poison(input, "quantityNumerator");
    else if (mode === "facts") poison(facts, "ownerGeneration");
    else if (mode === "unit") {
      const u = facts.units[0];
      if (!u) throw Error("fixture");
      poison(u.baseUnit, "ledgerPrecision");
    } else {
      const c = facts.units[0]?.unitConversions[0];
      if (!c) throw Error("fixture");
      poison(c, "multiplier");
    }
    expect(() => assess([input], facts, at, later)).toThrow();
    expect(calls).toBe(0);
  },
);
it("rejects sparse arrays and hidden extra properties", () => {
  const sparse = [row(), row()];
  delete sparse[0];
  expect(() => result(sparse)).toThrow();
  const input = { ...row() };
  Object.defineProperty(input, "extra", { value: true });
  expect(() => result([input])).toThrow();
});
it("binds complete demand content and path digest", () => {
  const a = result(),
    b = result([{ ...row(), pathDigest: path(2) }]);
  expect(a.demandDigest).not.toBe(b.demandDigest);
  const { digest, ...body } = a;
  expect(digest).toBe("sha256:" + sha256Hex(canonicalizeRfc8785(body)));
});
