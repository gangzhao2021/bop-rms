import { it, expect, vi, beforeEach } from "vitest";
import { createCurrentOptionSetDraftRecipeYieldSource as create } from "./current-option-set-draft-recipe-yields.js";
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
                        kind: "Recipe",
                        reference: id(10),
                        versionReference: id(32),
                        quantity: "2",
                        unitCode: "PORTION",
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
      validUntil: "2026-10-01T05:30:30.000Z",
    },
    recipeRequest: request,
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
        validUntil: "2026-10-01T05:30:30.000Z",
      }),
    },
    recipeAuthority: f.options.authority,
    yieldAuthority: f.options.yieldAuthority,
  };
  return { ...f, input, options, source: create(options) };
}
it("derives exact unit/quantity only from held actual-root protocol and owning store", async () => {
  const f = fixture(),
    v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(first(v.recipe.matches).requestedYieldMicrounits).toBe("2000000");
  expect(v.validUntil).toBe("2026-10-01T05:30:05.000Z");
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
for (const mode of ["denial", "expiry", "backward", "generation", "yields", "query", "recursion"]) {
  it("refuses late " + mode, async () => {
    const f = fixture();
    let reached = false;
    await expect(
      f.source.withCurrentAssessment(f.tx, f.input, async () => {
        reached = true;
        if (mode === "denial") f.deny();
        if (mode === "expiry") f.setClock("2026-10-01T05:30:05.000Z");
        if (mode === "backward") f.setClock("2026-10-01T05:29:59.999Z");
        if (mode === "generation") f.changeGeneration();
        if (mode === "yields") f.changeYields();
        if (mode === "query") f.tx.query = vi.fn() as Tx["query"];
        if (mode === "recursion")
          await f.source.withCurrentAssessment(f.tx, f.input, async () => 1).catch(() => 0);
        return 1;
      }),
    ).rejects.toThrow();
    expect(reached).toBe(true);
  });
}
for (const key of ["brandReference", "actorReference"]) {
  it("refuses wrong " + key + " before acquisition", async () => {
    const f = fixture();
    await expect(
      f.source.withCurrentAssessment(
        f.tx,
        { ...f.input, recipeRequest: { ...request, [key]: id(999) } },
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
  f.options.yieldAuthority.holdUntilTransactionCompletes = vi.fn(async (actual: Tx) => {
    expect(actual).toBe(f.tx);
    throw Error("replacement");
  });
  const v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(v.recipe.yieldArithmetic).toBe("Pass");
});
it("does not skip unit fields for empty root pins", async () => {
  const f = fixture();
  state.empty = true;
  f.clear();
  await f.source.withCurrentAssessment(f.tx, f.input, async (v) =>
    expect(v.recipe.matches).toEqual([]),
  );
  expect(f.authorize).toHaveBeenCalled();
});

it("refuses extra caller tenant field in owning Recipe request", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentAssessment(
      f.tx,
      { ...f.input, recipeRequest: { ...request, tenantReference: id(999) } },
      async () => 1,
    ),
  ).rejects.toThrow();
  expect(f.authorize).not.toHaveBeenCalled();
});
