import { it, expect, vi } from "vitest";
import {
  assessRecipeOptionConsumptionYields as assess,
  recipeOptionConsumptionYieldFields,
} from "../contracts/option-consumption-yield-source.js";
import {
  createPostgresRecipeOptionConsumptionYieldSource as create,
  type RecipeOptionConsumptionYieldOptions,
} from "../infrastructure/persistence/option-consumption-yield-source-store.js";
import { buildRecipeReferenceSourceSnapshot as build } from "../contracts/recipe-reference-source.js";
type Tx = Parameters<
  RecipeOptionConsumptionYieldOptions["yieldAuthority"]["holdUntilTransactionCompletes"]
>[0];
const id = (n: number) => "01902460-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T05:30:00.000Z",
  later = "2026-10-01T05:30:02.000Z",
  digest = "sha256:" + "a".repeat(64);
const request = {
  purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ" as const,
  brandReference: id(1),
  actorReference: id(2),
  operationReference: id(3),
  catalogIntentDigest: digest,
};
const pin = () => ({
  optionReference: id(100),
  reference: id(10),
  versionReference: id(32),
  quantity: "2",
  unitCode: "PORTION",
});
function rawMetadata() {
  return {
    generation: "2",
    bindingCount: "0",
    observedAt: at,
    counts: { recipes: "1", versions: "2", bindings: "0", modifiers: "0" },
    recipes: [
      {
        recipeReference: id(10),
        brandReference: id(1),
        aggregateVersion: 3,
        currentVersionReference: id(32),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [1, 2].map((v) => ({
      recipeVersionReference: id(30 + v),
      recipeReference: id(10),
      brandReference: id(1),
      versionNumber: v,
      lifecycle: "Published",
      snapshotDigest: digest,
      effectiveFrom: at,
      effectiveUntil: null as string | null,
      timeZone: "UTC",
      createdAt: at,
      precise: true,
    })),
    bindings: [],
    modifiers: [],
  };
}
function rawYields() {
  return [
    {
      recipeReference: id(10),
      versionReference: id(32),
      versionNumber: "2",
      snapshotDigest: digest,
      yieldQuantityMicrounits: "3000000",
      yieldUnitCode: "PORTION",
      yieldDimension: "Count",
      precise: true,
    },
  ];
}
function first<T>(a: readonly T[]): T {
  const x = a[0];
  if (!x) throw Error("fixture missing");
  return x;
}
function wire() {
  let clock = at,
    generation = "2",
    denied = false,
    yields = rawYields(),
    metadata = rawMetadata();
  const tx = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes("transaction_isolation")) return { rows: [{ isolation: "read committed" }] };
      if (sql.includes(" AS yields")) return { rows: [{ yields: { items: yields } }] };
      if (sql.includes(" AS header"))
        return { rows: [{ header: { generation, bindingCount: "0" } }] };
      if (sql.includes("'counts'")) return { rows: [{ source: metadata }] };
      return { rows: [] };
    }),
  } as unknown as Tx;
  const authorize = vi.fn(async (actual: Tx) => {
    expect(actual).toBe(tx);
    if (denied) throw Error("synthetic denial");
  });
  const options = {
    tenantReference: id(4),
    ...request,
    clock: { now: () => clock },
    transactions: { run: async <T>(action: (tx: Tx) => Promise<T>) => action(tx) },
    authority: { holdUntilTransactionCompletes: authorize },
    yieldAuthority: { holdUntilTransactionCompletes: authorize },
  };
  return {
    tx,
    options,
    authorize,
    setClock: (v: string) => (clock = v),
    deny: () => (denied = true),
    changeGeneration: () => (generation = "3"),
    changeYields: () => (yields = [{ ...first(yields), yieldQuantityMicrounits: "6000000" }]),
    clear: () => {
      yields = [];
      metadata = {
        ...metadata,
        counts: { recipes: "0", versions: "0", bindings: "0", modifiers: "0" },
        recipes: [],
        versions: [],
      };
    },
  };
}
const evaluate = (
  pins: unknown = [pin()],
  yields: unknown = rawYields(),
  r = rawMetadata(),
  now = at,
  activation = later,
) => assess(pins, yields, build(r, request, at), request, now, activation);
it("keeps exact microunits and reduced partial-batch ratio", () => {
  const v = evaluate();
  expect(first(v.matches)).toMatchObject({
    requestedYieldMicrounits: "2000000",
    batchNumerator: "2",
    batchDenominator: "3",
    status: "ExactYieldQuantity",
  });
  expect(v.yieldArithmetic).toBe("Pass");
  expect(v.referenceEligibility).toBe("NotEvaluated");
  expect(v.ingredientEligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(v.matches)).toBe(true);
});
it("supports exact smallest microunit without rounding", () =>
  expect(first(evaluate([{ ...pin(), quantity: "0.000001" }]).matches)).toMatchObject({
    requestedYieldMicrounits: "1",
    batchNumerator: "1",
    batchDenominator: "3000000",
  }));
it("supports existing owning maximum positive yield bound", () =>
  expect(
    first(evaluate([{ ...pin(), quantity: "1000000000000000000000000" }]).matches)
      .requestedYieldMicrounits,
  ).toBe("1000000000000000000000000000000"));
it.each(["unit", "overflow"])("refuses %s arithmetic without qualification", (mode) => {
  const v = evaluate([
    { ...pin(), ...(mode === "unit" ? { unitCode: "CASE" } : { quantity: "9".repeat(40) }) },
  ]);
  expect(v.yieldArithmetic).toBe("HardError");
  expect(first(v.matches).requestedYieldMicrounits).toBeNull();
  expect(first(v.matches).batchNumerator).toBeNull();
});
it.each([
  "stale",
  "parent",
  "duplicate",
  "extra",
  "getter",
  "zero",
  "negative",
  "precision",
  "long",
  "101pins",
  "missing",
  "duplicate-yield",
  "yield-zero",
  "yield-large",
  "dimension",
  "unit-code",
  "version-number",
  "digest",
  "precise",
  "unpublished",
  "period",
  "activation",
  "expired",
])("refuses malformed %s", (mode) => {
  const r = rawMetadata();
  let p: unknown = [pin()],
    y: unknown = rawYields(),
    now = at,
    activation = later;
  if (mode === "stale") p = [{ ...pin(), versionReference: id(31) }];
  if (mode === "parent") p = [{ ...pin(), reference: id(11) }];
  if (mode === "duplicate") p = [pin(), pin()];
  if (mode === "extra") p = [{ ...pin(), Ready: true }];
  if (mode === "getter")
    p = [Object.defineProperty(pin(), "quantity", { get: () => "2", enumerable: true })];
  if (["zero", "negative", "precision", "long"].includes(mode))
    p = [
      {
        ...pin(),
        quantity:
          mode === "zero"
            ? "0"
            : mode === "negative"
              ? "-1"
              : mode === "precision"
                ? "0.1234567"
                : "9".repeat(41),
      },
    ];
  if (mode === "101pins")
    p = Array.from({ length: 101 }, (_, i) => ({ ...pin(), optionReference: id(1000 + i) }));
  if (mode === "missing") y = [];
  if (mode === "duplicate-yield") y = [...rawYields(), ...rawYields()];
  const row = first(rawYields());
  if (mode === "yield-zero") y = [{ ...row, yieldQuantityMicrounits: "0" }];
  if (mode === "yield-large") y = [{ ...row, yieldQuantityMicrounits: "9".repeat(31) }];
  if (mode === "dimension") y = [{ ...row, yieldDimension: "Length" }];
  if (mode === "unit-code") y = [{ ...row, yieldUnitCode: "portion" }];
  if (mode === "version-number") y = [{ ...row, versionNumber: "1" }];
  if (mode === "digest") y = [{ ...row, snapshotDigest: "sha256:" + "b".repeat(64) }];
  if (mode === "precise") y = [{ ...row, precise: false }];
  if (mode === "unpublished")
    first(r.versions.filter((v) => v.versionNumber === 2)).lifecycle = "Draft";
  if (mode === "period")
    first(r.versions.filter((v) => v.versionNumber === 2)).effectiveUntil = later;
  if (mode === "activation") activation = "2026-10-01T05:29:59.999Z";
  if (mode === "expired") {
    now = "2026-10-01T05:30:05.001Z";
    activation = "2026-10-01T05:30:07.000Z";
  }
  expect(() => evaluate(p, y, r, now, activation)).toThrow();
});
it("holds actual owner protocols, exact field set and original deadline", async () => {
  const f = wire();
  const v = await create(f.options).withCurrentYields(request, [pin()], later, async (v) => v);
  expect(v.validUntil).toBe("2026-10-01T05:30:05.000Z");
  expect(first(v.matches).batchNumerator).toBe("2");
  expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(f.authorize.mock.calls.every(([tx]) => tx === f.tx)).toBe(true);
  expect(recipeOptionConsumptionYieldFields).toContain("yieldUnitCode");
});
it.each(["denial", "expiry", "backward", "generation", "yields", "query", "recursion"])(
  "refuses late %s after callback",
  async (mode) => {
    const f = wire(),
      source = create(f.options);
    let reached = false;
    await expect(
      source.withCurrentYields(request, [pin()], later, async () => {
        reached = true;
        if (mode === "denial") f.deny();
        if (mode === "expiry") f.setClock("2026-10-01T05:30:05.000Z");
        if (mode === "backward") f.setClock("2026-10-01T05:29:59.999Z");
        if (mode === "generation") f.changeGeneration();
        if (mode === "yields") f.changeYields();
        if (mode === "query") f.tx.query = vi.fn() as Tx["query"];
        if (mode === "recursion")
          await source.withCurrentYields(request, [pin()], later, async () => 1).catch(() => 0);
        return 1;
      }),
    ).rejects.toThrow();
    expect(reached).toBe(true);
  },
);
it("holds yield and complete fields even without pins", async () => {
  const f = wire();
  f.clear();
  const v = await create(f.options).withCurrentYields(request, [], later, async (v) => v);
  expect(v.matches).toEqual([]);
  expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
});

function originalClock() {
  return {
    profile: "OptionPublicationOriginalClockV1" as const,
    operationReference: request.operationReference,
    catalogIntentDigest: request.catalogIntentDigest,
    observedAt: at,
    validUntil: "2026-10-01T05:30:05.000Z",
  };
}
it("assesses immediate original activation at real forward time without granting ingredient qualification", () => {
  const source = build(rawMetadata(), request, at),
    clock = originalClock();
  const result = assess([pin()], rawYields(), source, request, later, at, clock);
  expect(result.yieldArithmetic).toBe("Pass");
  expect(result.assessedAt).toBe(later);
  expect(result.activationAt).toBe(at);
  expect(result.originalPublicationClock).toEqual(clock);
  expect(result.ingredientEligibility).toBe("NotEvaluated");
  expect(() => assess([pin()], rawYields(), source, request, later, at)).toThrow();
});
it.each([
  { operationReference: id(999) },
  { catalogIntentDigest: "sha256:" + "b".repeat(64) },
  { profile: "OtherClock" },
  { validUntil: "2026-10-01T05:30:05.001Z" },
  { validUntil: at },
  { extra: true },
  { observedAt: "2026-10-01T05:30:03.000Z" },
])("rejects malformed or mismatched yield publication clock %j", (change) => {
  expect(() =>
    assess([pin()], rawYields(), build(rawMetadata(), request, at), request, later, at, {
      ...originalClock(),
      ...change,
    }),
  ).toThrow();
});
it("retains the immutable origin and half-open expiry under actual yield assessment time", () => {
  const source = build(rawMetadata(), request, at);
  expect(() =>
    assess([pin()], rawYields(), source, request, originalClock().validUntil, at, originalClock()),
  ).toThrow();
  expect(() =>
    assess([pin()], rawYields(), source, request, at, "2026-10-01T05:29:59.999Z", originalClock()),
  ).toThrow();
  expect(() => assess([pin()], rawYields(), source, request, later, at, null)).toThrow();
});
it("rejects original-clock getters in assessment and factory without invoking them", () => {
  const clock = originalClock(),
    getter = vi.fn(() => at);
  Object.defineProperty(clock, "observedAt", { get: getter, enumerable: true });
  expect(() =>
    assess([pin()], rawYields(), build(rawMetadata(), request, at), request, later, at, clock),
  ).toThrow();
  expect(() => create({ ...wire().options, originalPublicationClock: clock })).toThrow();
  const options = { ...wire().options },
    factoryGetter = vi.fn(originalClock);
  Object.defineProperty(options, "originalPublicationClock", {
    get: factoryGetter,
    enumerable: true,
  });
  expect(() => create(options)).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(factoryGetter).not.toHaveBeenCalled();
});
it("captures a detached original clock, forwards actual current time and never extends its held deadline", async () => {
  const f = wire(),
    clock = originalClock(),
    source = create({ ...f.options, originalPublicationClock: clock });
  clock.operationReference = id(999);
  clock.validUntil = "2026-10-01T05:30:30.000Z";
  f.setClock(later);
  const result = await source.withCurrentYields(request, [pin()], at, async (packet) => packet);
  expect(result.assessedAt).toBe(later);
  expect(result.activationAt).toBe(at);
  expect(result.yieldArithmetic).toBe("Pass");
  expect(result.validUntil).toBe("2026-10-01T05:30:05.000Z");
  expect(result.originalPublicationClock).toEqual(originalClock());
  expect(f.authorize).toHaveBeenCalled();
  f.setClock("2026-10-01T05:30:05.000Z");
  await expect(
    source.withCurrentYields(request, [pin()], at, async (packet) => packet),
  ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
});
it("does not let an original clock replace current yield source permission", async () => {
  const f = wire(),
    source = create({ ...f.options, originalPublicationClock: originalClock() });
  f.setClock(later);
  f.deny();
  await expect(
    source.withCurrentYields(request, [pin()], at, async (packet) => packet),
  ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
});
it("retains future-only activation for the legacy source without an original clock", async () => {
  const f = wire();
  f.setClock(later);
  await expect(
    create(f.options).withCurrentYields(request, [pin()], at, async (packet) => packet),
  ).rejects.toMatchObject({ code: "RECIPE_DEPENDENCY_UNAVAILABLE" });
});
