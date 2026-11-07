import { it, expect, vi, beforeEach } from "vitest";
import { createCurrentOptionSetDraftInventoryUnitSource as create } from "./current-option-set-draft-inventory-units.js";
type Tx = Parameters<ReturnType<typeof create>["withCurrentAssessment"]>[0];
const state = vi.hoisted(() => ({ mode: "Once", empty: false }));
vi.mock("./current-option-set-draft-graph.js", () => ({
  createCurrentOptionSetDraftGraphSource: (options: Record<string, unknown>) => ({
    context: options,
    async withCurrentGraph(
      _tx: unknown,
      r: Record<string, unknown>,
      work: (v: unknown) => Promise<unknown>,
    ) {
      if (state.mode === "NoCall") return 1;
      const root = {
        sourceAuthority: "CurrentDraftRootOnly",
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
        originalObservedAt: r.observedAt,
        observedAt: r.observedAt,
        validUntil: r.validUntil,
        sourceDigest: r.sourceDigest,
        contentDigest: r.contentDigest,
        configurationDigest: r.configurationDigest,
        graphDigest: r.sourceDigest,
        graph: {
          rootOptionSetReference: r.optionSetReference,
          rootVersionReference: r.versionReference,
          contents: [
            {
              optionDetails: state.empty
                ? []
                : [
                    {
                      optionReference: id(100),
                      consumption: {
                        kind: "Inventory",
                        reference: id(10),
                        versionReference: id(32),
                        quantity: "2",
                        unitCode: "CASE",
                      },
                    },
                  ],
            },
          ],
        },
      };
      const result = await work(root);
      if (state.mode === "Twice") await work(root);
      if (state.mode === "LateDenial") throw Error("synthetic root denial");
      return state.mode === "WrongReturn" ? null : result;
    },
  }),
}));
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

beforeEach(() => {
  state.mode = "Once";
  state.empty = false;
});
function fixture() {
  const f = wire();
  const input = {
    graphRequest: {
      optionSetReference: id(200),
      versionReference: id(201),
      expectedAggregateVersion: 1,
      sourceDigest: digest,
      contentDigest: digest,
      configurationDigest: digest,
      observedAt: at,
      validUntil: "2026-10-01T05:00:30.000Z",
    },
    inventoryRequest: request,
    activationAt: later,
  };
  const options = {
    tenantReference: id(4),
    brandReference: id(1),
    actorReference: id(2),
    clock: f.options.clock,
    readAuthority: {
      holdUntilTransactionCompletes: async (_tx: Tx, input: { observedAt: string }) => ({
        observedAt: input.observedAt,
        validUntil: "2026-10-01T05:00:30.000Z",
      }),
    },
    inventoryAuthority: f.options.authority,
    unitAuthority: f.options.unitAuthority,
  };
  return { ...f, input, options, source: create(options) };
}
it("derives exact unit/quantity only from held actual-root protocol and owning store", async () => {
  const f = fixture(),
    v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(first(v.inventory.matches).baseQuantity).toBe("12");
  expect(v.validUntil).toBe("2026-10-01T05:00:05.000Z");
  expect(v.publishValidation).toBe("Incomplete");
  expect(v.eligibility).toBe("NotEvaluated");
  expect(Object.isFrozen(v)).toBe(true);
});
for (const mode of ["NoCall", "Twice", "WrongReturn", "LateDenial"]) {
  it("refuses root " + mode, async () => {
    const f = fixture();
    state.mode = mode;
    await expect(f.source.withCurrentAssessment(f.tx, f.input, async () => 1)).rejects.toThrow();
  });
}
for (const mode of ["denial", "expiry", "backward", "generation", "units", "query", "recursion"]) {
  it("refuses late " + mode, async () => {
    const f = fixture();
    let reached = false;
    await expect(
      f.source.withCurrentAssessment(f.tx, f.input, async () => {
        reached = true;
        if (mode === "denial") f.deny();
        if (mode === "expiry") f.setClock("2026-10-01T05:00:05.000Z");
        if (mode === "backward") f.setClock("2026-10-01T04:59:59.999Z");
        if (mode === "generation") f.changeGeneration();
        if (mode === "units") f.changeUnits();
        if (mode === "query") f.tx.query = vi.fn() as Tx["query"];
        if (mode === "recursion")
          await f.source.withCurrentAssessment(f.tx, f.input, async () => 1).catch(() => 0);
        return 1;
      }),
    ).rejects.toThrow();
    expect(reached).toBe(true);
  });
}
for (const key of ["tenantReference", "brandReference", "actorReference"]) {
  it("refuses wrong " + key + " before acquisition", async () => {
    const f = fixture();
    await expect(
      f.source.withCurrentAssessment(
        f.tx,
        { ...f.input, inventoryRequest: { ...request, [key]: id(999) } },
        async () => 1,
      ),
    ).rejects.toThrow();
    expect(f.authorize).not.toHaveBeenCalled();
  });
}
it("rejects source bodies and caller readiness", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentAssessment(f.tx, { ...f.input, Ready: true }, async () => 1),
  ).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
});
it("captures methods and detached original input", async () => {
  const f = fixture();
  f.options.unitAuthority.holdUntilTransactionCompletes = vi.fn(async (actual: Tx) => {
    expect(actual).toBe(f.tx);
    throw Error("replacement");
  });
  const v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(v.inventory.unitArithmetic).toBe("Pass");
});
it("does not skip unit fields for empty root pins", async () => {
  const f = fixture();
  state.empty = true;
  f.clear();
  await f.source.withCurrentAssessment(f.tx, f.input, async (v) =>
    expect(v.inventory.matches).toEqual([]),
  );
  expect(f.authorize).toHaveBeenCalled();
});
