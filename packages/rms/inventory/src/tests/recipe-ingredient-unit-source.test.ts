import { it, expect, vi } from "vitest";
import {
  buildCurrentRecipeIngredientUnitFacts as buildUnits,
  inventoryRecipeIngredientUnitFields,
} from "../contracts/recipe-ingredient-unit-source.js";
import {
  createPostgresInventoryRecipeIngredientUnitSource as create,
  type InventoryRecipeIngredientUnitOptions,
} from "../infrastructure/persistence/recipe-ingredient-unit-source-store.js";
import { buildInventoryConfigurationReferenceSnapshot as build } from "../contracts/configuration-reference-source.js";
type Tx = Parameters<
  InventoryRecipeIngredientUnitOptions["unitAuthority"]["holdUntilTransactionCompletes"]
>[0];
const id = (n: number) => "01902459-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T05:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ" as const,
  tenantReference: id(4),
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
const pin = () => ({
  recipeReference: id(90),
  recipeVersionReference: id(91),
  requirementReference: id(100),
  itemReference: id(10),
  operationReference: id(32),
});
function rawMetadata() {
  const scope = { tenantReference: id(4), brandReference: id(1) };
  return {
    generation: "2",
    observedAt: at,
    counts: { items: "1", versions: "2", operations: "2" },
    items: [
      { ...scope, itemReference: id(10), itemType: "FinishedGood", createdAt: at, precise: true },
    ],
    versions: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      itemType: "FinishedGood",
      lifecycle: v === 2 ? "Active" : "Inactive",
      recordedAt: at,
      precise: true,
    })),
    operations: [1, 2].map((v) => ({
      ...scope,
      itemReference: id(10),
      itemVersion: String(v),
      operationReference: id(30 + v),
      action: v === 1 ? "Create" : "Activate",
    })),
  };
}
function rawUnits() {
  return [
    {
      itemReference: id(10),
      itemVersion: "2",
      operationReference: id(32),
      recordedAt: at,
      precise: true,
      baseUnit: {
        unitCode: "EA",
        dimension: "Count",
        displayPrecision: 0,
        ledgerPrecision: 0,
        roundingMode: "HalfEven",
      },
      unitConversions: [
        {
          conversionReference: id(40),
          fromUnitCode: "CASE",
          toBaseUnitCode: "EA",
          multiplier: "6",
          effectiveFrom: at,
          reasonCode: "INITIAL_CONFIGURATION",
          status: "Active",
        },
      ],
    },
  ];
}
function first<T>(values: readonly T[]): T {
  const v = values[0];
  if (!v) throw Error("fixture missing");
  return v;
}
function wire() {
  let clock = at,
    generation = "2",
    denied = false,
    units = rawUnits(),
    metadata = rawMetadata();
  const tx = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
      if (sql.includes(" AS units")) return { rows: [{ units: { items: units } }] };
      if (sql.includes(" AS header")) return { rows: [{ header: { generation } }] };
      if (sql.includes("'counts'")) return { rows: [{ source: metadata }] };
      return { rows: [] };
    }),
  } as unknown as Tx;
  const authorize = vi.fn(async (actual: Tx) => {
    expect(actual).toBe(tx);
    if (denied) throw Error("synthetic denial");
  });
  const options = {
    ...request,
    clock: { now: () => clock },
    transactions: { run: async <T>(action: (tx: Tx) => Promise<T>) => action(tx) },
    authority: { holdUntilTransactionCompletes: authorize },
    unitAuthority: { holdUntilTransactionCompletes: authorize },
  };
  return {
    tx,
    units: () => units,
    metadata: () => metadata,
    options,
    authorize,
    setClock: (v: string) => (clock = v),
    deny: () => (denied = true),
    changeGeneration: () => (generation = "3"),
    changeUnits: () =>
      (units = [{ ...first(units), baseUnit: { ...first(units).baseUnit, ledgerPrecision: 1 } }]),
    clear: () => {
      units = [];
      metadata = {
        ...metadata,
        counts: { items: "0", versions: "0", operations: "0" },
        items: [],
        versions: [],
        operations: [],
      };
    },
  };
}

const evaluate = (pins: unknown = [pin()], units: unknown = rawUnits(), now = at) =>
  buildUnits(pins, units, build(rawMetadata(), request, at), request, now);
it("returns owning full current unit facts with exact operation and no arithmetic qualification", () => {
  const v = evaluate();
  expect(first(v.units)).toMatchObject({
    itemReference: id(10),
    itemVersion: 2,
    operationReference: id(32),
    baseUnit: { unitCode: "EA", ledgerPrecision: 0, roundingMode: "HalfEven" },
    unitConversions: [{ conversionReference: id(40), multiplier: "6" }],
  });
  expect(v.unitArithmetic).toBe("NotEvaluated");
  expect(v.conversionApplicability).toBe("NotEvaluated");
  expect(v.eligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(v.units)).toBe(true);
  expect(Object.isFrozen(first(v.units).unitConversions)).toBe(true);
});
it("retains future and retired recorded conversions as facts without selecting them", () => {
  const units = rawUnits(),
    c = first(first(units).unitConversions);
  c.status = "Retired";
  c.effectiveFrom = "2026-12-01T05:00:00.000Z";
  expect(first(first(evaluate([pin()], units).units).unitConversions)).toMatchObject({
    status: "Retired",
    effectiveFrom: c.effectiveFrom,
  });
});
it("shares a current Item across distinct exact Recipe requirements without fake Option pins", () => {
  expect(evaluate([pin(), { ...pin(), requirementReference: id(101) }]).pins).toHaveLength(2);
  expect(evaluate([pin(), { ...pin(), requirementReference: id(101) }]).units).toHaveLength(1);
  expect(JSON.stringify(evaluate())).not.toContain("optionReference");
});
it.each([
  "stale",
  "parent",
  "duplicate",
  "ambiguous",
  "extra",
  "getter",
  "sparse",
  "prototype",
  "expired",
  "missing",
  "duplicateRow",
  "imprecise",
  "recordedAt",
  "futureRow",
  "base",
  "conversionDuplicate",
  "conversionBase",
  "conversionGetter",
  "multiplierBound",
  "extraSource",
])("refuses malformed %s source/pins before interpretation", (mode) => {
  let pins: unknown = [pin()],
    units: unknown = rawUnits(),
    now = at;
  if (mode === "stale") pins = [{ ...pin(), operationReference: id(31) }];
  if (mode === "parent") pins = [{ ...pin(), itemReference: id(11) }];
  if (mode === "duplicate") pins = [pin(), pin()];
  if (mode === "ambiguous")
    pins = [pin(), { ...pin(), requirementReference: id(101), operationReference: id(31) }];
  if (mode === "extra") pins = [{ ...pin(), Ready: true }];
  if (mode === "getter")
    pins = [
      Object.defineProperty(pin(), "operationReference", {
        get: () => {
          throw Error("getter must not run");
        },
        enumerable: true,
      }),
    ];
  if (mode === "sparse") pins = new Array(1);
  if (mode === "prototype") pins = [Object.assign(Object.create(null), pin())];
  if (mode === "expired") now = "2026-10-01T05:00:05.000Z";
  if (mode === "missing") units = [];
  if (mode === "duplicateRow") units = [...rawUnits(), ...rawUnits()];
  if (
    [
      "imprecise",
      "recordedAt",
      "futureRow",
      "base",
      "conversionDuplicate",
      "conversionBase",
      "conversionGetter",
      "multiplierBound",
      "extraSource",
    ].includes(mode)
  ) {
    const u = rawUnits(),
      r = first(u),
      c = first(r.unitConversions);
    if (mode === "imprecise") r.precise = false;
    if (mode === "recordedAt") r.recordedAt = "2026-10-01T04:59:59.999Z";
    if (mode === "futureRow") r.recordedAt = "2026-10-01T05:00:00.001Z";
    if (mode === "base") Object.assign(r.baseUnit, { Ready: true });
    if (mode === "conversionDuplicate") r.unitConversions.push({ ...c });
    if (mode === "conversionBase") c.toBaseUnitCode = "KG";
    if (mode === "conversionGetter")
      Object.defineProperty(c, "multiplier", {
        get: () => {
          throw Error("getter");
        },
        enumerable: true,
      });
    if (mode === "multiplierBound") c.multiplier = "9".repeat(41);
    if (mode === "extraSource") Object.assign(r, { Ready: true });
    units = u;
  }
  expect(() => evaluate(pins, units, now)).toThrow();
});
it("actual factory protocol holds complete metadata/fields and exclusive original observation lease", async () => {
  const f = wire(),
    v = await create(f.options).withCurrentUnits(request, [pin()], async (v) => v);
  expect(v.validUntil).toBe("2026-10-01T05:00:05.000Z");
  expect(v.units).toHaveLength(1);
  expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(inventoryRecipeIngredientUnitFields).toContain("baseUnit.ledgerPrecision");
});
it.each([
  "denial",
  "expiry",
  "backward",
  "generation",
  "units",
  "conversion",
  "query",
  "recursion",
  "duplicate",
  "result",
])("refuses late %s and poisons original Tx (synthetic SQL rows)", async (mode) => {
  const f = wire();
  let reached = false;
  const options = {
    ...f.options,
    transactions: {
      run: async <T>(work: (tx: Tx) => Promise<T>) => {
        const value = await work(f.tx);
        if (mode === "duplicate") await work(f.tx).catch(() => undefined);
        return mode === "result" ? ({ replaced: true } as T) : value;
      },
    },
  };
  const source = create(options);
  await expect(
    source.withCurrentUnits(request, [pin()], async () => {
      reached = true;
      if (mode === "denial") f.deny();
      if (mode === "expiry") f.setClock("2026-10-01T05:00:05.000Z");
      if (mode === "backward") f.setClock("2026-10-01T04:59:59.999Z");
      if (mode === "generation") f.changeGeneration();
      if (mode === "units") f.changeUnits();
      if (mode === "conversion") first(first(f.units()).unitConversions).reasonCode = "CHANGED";
      if (mode === "query") f.tx.query = vi.fn() as Tx["query"];
      if (mode === "recursion")
        await source.withCurrentUnits(request, [pin()], async () => 1).catch(() => undefined);
      return 1;
    }),
  ).rejects.toMatchObject({ code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE" });
  expect(reached).toBe(true);
  await expect(source.withCurrentUnits(request, [pin()], async () => 1)).rejects.toMatchObject({
    code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
  });
});
it("pre-work field denial never calls consumer", async () => {
  const f = wire();
  f.deny();
  const work = vi.fn();
  await expect(create(f.options).withCurrentUnits(request, [pin()], work)).rejects.toMatchObject({
    code: "INVENTORY_ITEM_DEPENDENCY_UNAVAILABLE",
  });
  expect(work).not.toHaveBeenCalled();
});
it("empty selectors retain metadata/field authority without granting eligibility", async () => {
  const f = wire();
  f.clear();
  await create(f.options).withCurrentUnits(request, [], async (v) => expect(v.units).toEqual([]));
  expect(f.authorize).toHaveBeenCalled();
});

it("covers the complete4096 Recipe ingredient budget without partial source packets", () => {
  const pins = Array.from({ length: 4096 }, (_, i) => ({
    ...pin(),
    requirementReference: id(i + 1000),
  }));
  expect(evaluate(pins).pins).toHaveLength(4096);
  expect(evaluate(pins).units).toHaveLength(1);
  expect(() => evaluate([...pins, { ...pin(), requirementReference: id(6000) }])).toThrow();
});
