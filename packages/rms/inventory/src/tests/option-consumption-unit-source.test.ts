import { it, expect, vi } from "vitest";
import {
  assessInventoryOptionConsumptionUnits as assess,
  inventoryOptionConsumptionUnitFields,
} from "../contracts/option-consumption-unit-source.js";
import {
  createPostgresInventoryOptionConsumptionUnitSource as create,
  type InventoryOptionConsumptionUnitOptions,
} from "../infrastructure/persistence/option-consumption-unit-source-store.js";
import { buildInventoryConfigurationReferenceSnapshot as build } from "../contracts/configuration-reference-source.js";
type Tx = Parameters<
  InventoryOptionConsumptionUnitOptions["unitAuthority"]["holdUntilTransactionCompletes"]
>[0];
const id = (n: number) => "01902459-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T05:00:00.000Z",
  later = "2026-10-01T05:00:02.000Z",
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
  optionReference: id(100),
  reference: id(10),
  versionReference: id(32),
  quantity: "2",
  unitCode: "CASE",
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
    options,
    authorize,
    setClock: (v: string) => (clock = v),
    deny: () => (denied = true),
    changeGeneration: () => (generation = "3"),
    scheduleConversion: () => {
      const row = first(units);
      units = [
        {
          ...row,
          unitConversions: [
            ...row.unitConversions,
            {
              ...first(row.unitConversions),
              conversionReference: id(41),
              multiplier: "12",
              effectiveFrom: "2026-10-01T05:00:01.000Z",
            },
          ],
        },
      ];
    },
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

const evaluate = (
  pins: unknown = [pin()],
  units: unknown = rawUnits(),
  now = at,
  activation = later,
) => assess(pins, units, build(rawMetadata(), request, now), request, now, activation);
it("normalizes only exact configured conversion and preserves unassessed qualification", () => {
  const v = evaluate();
  expect(first(v.matches)).toMatchObject({
    baseQuantity: "12",
    baseUnitCode: "EA",
    conversionReference: id(40),
    status: "ExactBaseQuantity",
  });
  expect(v.unitArithmetic).toBe("Pass");
  expect(v.quantityPolicy).toBe("NotEvaluated");
  expect(v.referenceEligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(v.matches)).toBe(true);
  expect(JSON.stringify(v)).not.toContain("INITIAL_CONFIGURATION");
});
it("uses exact base identity without inventing a conversion", () =>
  expect(first(evaluate([{ ...pin(), unitCode: "EA" }]).matches)).toMatchObject({
    baseQuantity: "2",
    conversionReference: null,
  }));
it("uses BigInt decimal multiplication without binary rounding", () => {
  const u = rawUnits(),
    row = first(u);
  row.baseUnit.ledgerPrecision = 6;
  first(row.unitConversions).multiplier = "0.5";
  expect(first(evaluate([{ ...pin(), quantity: "1.000002" }], u).matches).baseQuantity).toBe(
    "0.500001",
  );
});
for (const mode of [
  "missing",
  "retired",
  "future",
  "ambiguous",
  "activation-ambiguous",
  "rounding",
  "overflow",
]) {
  it("refuses " + mode + " arithmetic", () => {
    const u = rawUnits(),
      row = first(u),
      c = first(row.unitConversions);
    let quantity = "2";
    if (mode === "missing") row.unitConversions = [];
    if (mode === "retired") c.status = "Retired";
    if (mode === "future") c.effectiveFrom = later;
    if (mode === "ambiguous" || mode === "activation-ambiguous")
      row.unitConversions.push({
        ...c,
        conversionReference: id(41),
        effectiveFrom: mode === "ambiguous" ? at : later,
      });
    if (mode === "rounding") quantity = "0.1";
    if (mode === "overflow") {
      quantity = "9".repeat(40);
      c.multiplier = "9".repeat(40);
    }
    const v = evaluate([{ ...pin(), quantity }], u);
    expect(v.unitArithmetic).toBe("HardError");
    expect(first(v.matches).baseQuantity).toBeNull();
  });
}
for (const mode of [
  "stale-pin",
  "wrong-parent",
  "duplicate",
  "extra",
  "getter",
  "zero",
  "negative",
  "too-long",
  "precision",
  "missing-row",
  "duplicate-row",
  "wrong-base",
  "duplicate-conversion",
  "extra-source",
  "101pins",
  "past-activation",
  "expired",
]) {
  it("rejects malformed " + mode + " source/pins", () => {
    let p: unknown = [pin()],
      u: unknown = rawUnits(),
      now = at,
      activation = later;
    if (mode === "stale-pin") p = [{ ...pin(), versionReference: id(31) }];
    if (mode === "wrong-parent") p = [{ ...pin(), reference: id(11) }];
    if (mode === "duplicate") p = [pin(), pin()];
    if (mode === "extra") p = [{ ...pin(), Ready: true }];
    if (mode === "getter")
      p = [Object.defineProperty(pin(), "quantity", { get: () => "2", enumerable: true })];
    if (mode === "zero" || mode === "negative" || mode === "too-long" || mode === "precision")
      p = [
        {
          ...pin(),
          quantity:
            mode === "zero"
              ? "0"
              : mode === "negative"
                ? "-1"
                : mode === "too-long"
                  ? "9".repeat(41)
                  : "0.1234567",
        },
      ];
    if (mode === "missing-row") u = [];
    if (mode === "duplicate-row") u = [...rawUnits(), ...rawUnits()];
    if (mode === "wrong-base") {
      const x = rawUnits();
      first(first(x).unitConversions).toBaseUnitCode = "KG";
      u = x;
    }
    if (mode === "duplicate-conversion") {
      const x = rawUnits(),
        r = first(x);
      r.unitConversions.push({ ...first(r.unitConversions) });
      u = x;
    }
    if (mode === "extra-source") u = [{ ...first(rawUnits()), privateBody: {} }];
    if (mode === "101pins")
      p = Array.from({ length: 101 }, (_, i) => ({ ...pin(), optionReference: id(1000 + i) }));
    if (mode === "past-activation") activation = "2026-10-01T04:59:59.999Z";
    if (mode === "expired") {
      now = "2026-10-01T05:00:05.001Z";
      activation = "2026-10-01T05:00:07.000Z";
    }
    expect(() => evaluate(p, u, now, activation)).toThrow();
  });
}
it("holds actual protocol metadata and full unit fields, exact window and detached result", async () => {
  const f = wire();
  const v = await create(f.options).withCurrentUnits(request, [pin()], later, async (v) => v);
  expect(v.validUntil).toBe("2026-10-01T05:00:05.000Z");
  expect(v.unitArithmetic).toBe("Pass");
  expect(f.authorize.mock.calls.length).toBeGreaterThanOrEqual(6);
  expect(inventoryOptionConsumptionUnitFields).toContain("baseUnit.ledgerPrecision");
});
for (const mode of ["denial", "expiry", "backward", "generation", "units", "query", "recursion"]) {
  it("refuses late " + mode + " on real owning SQL protocol", async () => {
    const f = wire(),
      source = create(f.options);
    let reached = false;
    await expect(
      source.withCurrentUnits(request, [pin()], later, async () => {
        reached = true;
        if (mode === "denial") f.deny();
        if (mode === "expiry") f.setClock("2026-10-01T05:00:05.000Z");
        if (mode === "backward") f.setClock("2026-10-01T04:59:59.999Z");
        if (mode === "generation") f.changeGeneration();
        if (mode === "units") f.changeUnits();
        if (mode === "query") f.tx.query = vi.fn() as Tx["query"];
        if (mode === "recursion")
          await source.withCurrentUnits(request, [pin()], later, async () => 1).catch(() => 0);
        return 1;
      }),
    ).rejects.toThrow();
    expect(reached).toBe(true);
  });
}
it("holds fields and complete metadata even without pins", async () => {
  const f = wire();
  f.clear();
  await create(f.options).withCurrentUnits(request, [], later, async (v) =>
    expect(v.matches).toEqual([]),
  );
  expect(f.authorize).toHaveBeenCalled();
});

const originalClock = () => ({
  profile: "OptionPublicationOriginalClockV1" as const,
  operationReference: request.operationReference,
  catalogIntentDigest: request.catalogIntentDigest,
  observedAt: at,
  validUntil: "2026-10-01T05:00:05.000Z",
});
it("assesses immediate original activation at the actual forward current instant", () => {
  const value = assess(
    [pin()],
    rawUnits(),
    build(rawMetadata(), request, later),
    request,
    later,
    at,
    originalClock(),
  );
  expect(first(value.matches).status).toBe("ExactBaseQuantity");
  expect(value.assessedAt).toBe(later);
  expect(value.activationAt).toBe(at);
  expect(value.originalPublicationClock).toEqual(originalClock());
  expect(() =>
    assess([pin()], rawUnits(), build(rawMetadata(), request, later), request, later, at),
  ).toThrow();
});
it("continues comparing actual current and original activation conversions", () => {
  const row = first(rawUnits());
  const units = [
    {
      ...row,
      unitConversions: [
        ...row.unitConversions,
        {
          ...first(row.unitConversions),
          conversionReference: id(41),
          multiplier: "12",
          effectiveFrom: "2026-10-01T05:00:01.000Z",
        },
      ],
    },
  ];
  const value = assess(
    [pin()],
    units,
    build(rawMetadata(), request, later),
    request,
    later,
    at,
    originalClock(),
  );
  expect(first(value.matches).status).toBe("AmbiguousConversion");
});
it.each([
  { profile: "Other" },
  { operationReference: id(99) },
  { catalogIntentDigest: "sha256:" + "f".repeat(64) },
  { observedAt: "2026-10-01T05:00:03.000Z" },
  { validUntil: later },
  { validUntil: "2026-10-01T05:00:05.001Z" },
  { extra: true },
])("rejects rebound or invalid original unit assessment clock %#", (patch) => {
  expect(() =>
    assess([pin()], rawUnits(), build(rawMetadata(), request, later), request, later, at, {
      ...originalClock(),
      ...patch,
    }),
  ).toThrow();
});
it("rejects accessors and activation before original unit observation without reading getters", () => {
  const getter = vi.fn(() => at),
    value = Object.defineProperty(originalClock(), "observedAt", { enumerable: true, get: getter });
  expect(() =>
    assess([pin()], rawUnits(), build(rawMetadata(), request, at), request, at, at, value),
  ).toThrow();
  expect(getter).not.toHaveBeenCalled();
  expect(() =>
    assess(
      [pin()],
      rawUnits(),
      build(rawMetadata(), request, at),
      request,
      at,
      "2026-10-01T04:59:59.999Z",
      originalClock(),
    ),
  ).toThrow();
});
it("captures immutable original factory clock and preserves its shortest exclusive lease under forward reads", async () => {
  const f = wire(),
    clock = originalClock(),
    source = create({ ...f.options, originalPublicationClock: clock });
  clock.observedAt = "2026-10-01T05:00:01.000Z";
  f.setClock(later);
  const value = await source.withCurrentUnits(request, [pin()], at, async (packet) => packet);
  expect(value.originalPublicationClock).toEqual(originalClock());
  expect(Object.isFrozen(value.originalPublicationClock)).toBe(true);
  expect(value.validUntil).toBe(originalClock().validUntil);
  expect(first(value.matches).status).toBe("ExactBaseQuantity");
});
it.each(["operation", "intent", "expiry", "activation"])(
  "refuses factory original clock %s rebinding before owning SQL",
  async (cause) => {
    const f = wire(),
      source = create({ ...f.options, originalPublicationClock: originalClock() });
    if (cause === "expiry") f.setClock(originalClock().validUntil);
    const changed = {
      ...request,
      ...(cause === "operation" ? { operationReference: id(99) } : {}),
      ...(cause === "intent" ? { catalogIntentDigest: "sha256:" + "f".repeat(64) } : {}),
    };
    await expect(
      source.withCurrentUnits(
        changed,
        [pin()],
        cause === "activation" ? "2026-10-01T04:59:59.999Z" : at,
        async () => undefined,
      ),
    ).rejects.toThrow();
    expect(f.tx.query).not.toHaveBeenCalled();
  },
);
it("refuses getter-bearing factory clock options without invoking the getter", () => {
  const f = wire(),
    getter = vi.fn(() => originalClock());
  const options = Object.defineProperty({ ...f.options }, "originalPublicationClock", {
    enumerable: true,
    get: getter,
  });
  expect(() => create(options)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});
it("poisons late original clock expiry instead of renewing from a later metadata observation", async () => {
  const f = wire(),
    source = create({ ...f.options, originalPublicationClock: originalClock() });
  f.setClock(later);
  await expect(
    source.withCurrentUnits(request, [pin()], at, async () => {
      f.setClock(originalClock().validUntil);
    }),
  ).rejects.toThrow();
  f.setClock(later);
  await expect(
    source.withCurrentUnits(request, [pin()], at, async () => undefined),
  ).rejects.toThrow();
});

it("refuses a scheduled current conversion change during work despite identical locked source rows", async () => {
  const f = wire();
  f.scheduleConversion();
  const source = create({ ...f.options, originalPublicationClock: originalClock() });
  await expect(
    source.withCurrentUnits(request, [pin()], at, async (packet) => {
      expect(first(packet.matches).status).toBe("ExactBaseQuantity");
      f.setClock(later);
    }),
  ).rejects.toThrow();
});
