import { beforeEach, expect, it, vi } from "vitest";
import { createCurrentOptionSetDraftConsumptionReferenceSource } from "./current-option-set-draft-consumption-references.js";
const state = vi.hoisted(() => ({
  mode: "Once",
  inventoryMode: "Once",
  recipeMode: "Once",
  inventoryRaw: undefined as unknown,
  recipeRaw: undefined as unknown,
  root: undefined as unknown,
  inventoryCalls: 0,
  recipeCalls: 0,
}));
vi.mock("./current-option-set-draft-graph.js", () => ({
  createCurrentOptionSetDraftGraphSource: (options: {
    tenantReference: string;
    brandReference: string;
    actorReference: string;
  }) => ({
    context: options,
    async withCurrentGraph(
      _tx: unknown,
      r: Record<string, unknown>,
      work: (v: unknown) => Promise<unknown>,
    ) {
      if (state.mode === "NoCall") return 1;
      const first = state.root;
      const root = {
        profile: "CurrentOptionSetDraftGraphV1",
        sourceAuthority: "CurrentDraftRootOnly",
        publishValidation: "Incomplete",
        eligibility: "NotEvaluated",
        originalObservedAt: r.observedAt,
        observedAt: r.observedAt,
        validUntil: r.validUntil,
        aggregateVersion: r.expectedAggregateVersion,
        sourceDigest: r.sourceDigest,
        contentDigest: r.contentDigest,
        configurationDigest: r.configurationDigest,
        graph: first,
      };
      const result = await work(root);
      if (state.mode === "Twice") await work(root);
      if (first !== state.root || state.mode === "LateDenial") throw Error("synthetic late root");
      return state.mode === "WrongReturn" ? null : result;
    },
  }),
}));
vi.mock("@rms/inventory", async (original) => {
  const real = await original<typeof import("@rms/inventory")>();
  return {
    ...real,
    createPostgresInventoryConfigurationReferenceSourceStore: (
      options: Parameters<typeof real.createPostgresInventoryConfigurationReferenceSourceStore>[0],
    ) => ({
      async withCurrentSnapshot(
        input: Parameters<typeof real.parseInventoryConfigurationReferenceRequest>[0],
        work: (
          v: ReturnType<typeof real.buildInventoryConfigurationReferenceSnapshot>,
        ) => Promise<unknown>,
      ) {
        state.inventoryCalls++;
        if (state.inventoryMode === "NoCall") return 1;
        const first = state.inventoryRaw;
        return options.transactions.run(async (tx) => {
          const request = real.parseInventoryConfigurationReferenceRequest(input),
            authorize = () =>
              options.authority.holdUntilTransactionCompletes(tx, {
                tenantReference: options.tenantReference,
                request,
                requiredPermissions: real.inventoryConfigurationReferencePermissions,
                requiredScope: "FullBrandScope",
                requiredFields: real.inventoryConfigurationReferenceFields,
                observedAt: options.clock.now(),
              });
          await authorize();
          const source = real.buildInventoryConfigurationReferenceSnapshot(
            first,
            request,
            options.clock.now(),
          );
          const result = await work(source);
          if (state.inventoryMode === "Twice") await work(source);
          await authorize();
          if (first !== state.inventoryRaw || state.inventoryMode === "LateDenial")
            throw Error("synthetic late Inventory");
          return state.inventoryMode === "WrongReturn" ? null : result;
        });
      },
    }),
  };
});
vi.mock("@rms/recipe", async (original) => {
  const real = await original<typeof import("@rms/recipe")>();
  return {
    ...real,
    createPostgresRecipeReferenceSourceStore: (
      options: Parameters<typeof real.createPostgresRecipeReferenceSourceStore>[0],
    ) => ({
      async withCurrentSnapshot(
        input: Parameters<typeof real.parseRecipeReferenceSourceRequest>[0],
        work: (v: ReturnType<typeof real.buildRecipeReferenceSourceSnapshot>) => Promise<unknown>,
      ) {
        state.recipeCalls++;
        if (state.recipeMode === "NoCall") return 1;
        const first = state.recipeRaw;
        return options.transactions.run(async (tx) => {
          const request = real.parseRecipeReferenceSourceRequest(input),
            authorize = () =>
              options.authority.holdUntilTransactionCompletes(tx, {
                tenantReference: options.tenantReference,
                request,
                permission: "recipe.manage",
                requiredScope: "FullBrandScope",
                requiredFields: real.recipeReferenceSourceFields,
                observedAt: options.clock.now(),
              });
          await authorize();
          const source = real.buildRecipeReferenceSourceSnapshot(
            first,
            request,
            options.clock.now(),
          );
          const result = await work(source);
          if (state.recipeMode === "Twice") await work(source);
          await authorize();
          if (first !== state.recipeRaw || state.recipeMode === "LateDenial")
            throw Error("synthetic late Recipe");
          return state.recipeMode === "WrongReturn" ? null : result;
        });
      },
    }),
  };
});
const id = (n: number) => "01902458-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-01T04:00:00.000Z",
  digest = "sha256:" + "a".repeat(64);
function fixture() {
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  let clock = at;
  const scope = { tenantReference: id(4), brandReference: id(1) };
  state.inventoryRaw = {
    generation: "1",
    observedAt: at,
    counts: { items: "1", versions: "1", operations: "1" },
    items: [
      { ...scope, itemReference: id(100), itemType: "FinishedGood", createdAt: at, precise: true },
    ],
    versions: [
      {
        ...scope,
        itemReference: id(100),
        itemVersion: "1",
        itemType: "FinishedGood",
        lifecycle: "Active",
        recordedAt: at,
        precise: true,
      },
    ],
    operations: [
      {
        ...scope,
        itemReference: id(100),
        itemVersion: "1",
        operationReference: id(101),
        action: "Create",
      },
    ],
  };
  state.recipeRaw = {
    generation: "1",
    bindingCount: "0",
    observedAt: at,
    counts: { recipes: "1", versions: "1", bindings: "0", modifiers: "0" },
    recipes: [
      {
        recipeReference: id(200),
        brandReference: id(1),
        aggregateVersion: 2,
        currentVersionReference: id(201),
        updatedAt: at,
        precise: true,
      },
    ],
    versions: [
      {
        recipeVersionReference: id(201),
        recipeReference: id(200),
        brandReference: id(1),
        versionNumber: 1,
        lifecycle: "Published",
        snapshotDigest: digest,
        effectiveFrom: at,
        effectiveUntil: null,
        timeZone: "UTC",
        createdAt: at,
        precise: true,
      },
    ],
    bindings: [],
    modifiers: [],
  };
  const details = [
    {
      optionReference: id(110),
      consumption: { kind: "Inventory", reference: id(100), versionReference: id(101) },
    },
    {
      optionReference: id(120),
      consumption: { kind: "Recipe", reference: id(200), versionReference: id(201) },
    },
  ];
  state.root = {
    rootOptionSetReference: id(10),
    rootVersionReference: id(11),
    contents: [{ optionDetails: details }],
  };
  const authority = {
    holdUntilTransactionCompletes: vi.fn(async (actual: unknown) => {
      expect(actual).toBe(tx);
    }),
  };
  const options = {
    ...scope,
    actorReference: id(2),
    clock: { now: () => clock },
    readAuthority: {
      holdUntilTransactionCompletes: async () => ({
        observedAt: at,
        validUntil: "2026-10-01T04:00:30.000Z",
      }),
    },
    inventoryAuthority: authority,
    recipeAuthority: authority,
  };
  const input = {
    graphRequest: {
      optionSetReference: id(10),
      versionReference: id(11),
      expectedAggregateVersion: 1,
      sourceDigest: digest,
      contentDigest: digest,
      configurationDigest: digest,
      observedAt: at,
      validUntil: "2026-10-01T04:00:30.000Z",
    },
    inventoryRequest: {
      purposeCode: "CATALOG_LIFECYCLE_INVENTORY_CONFIGURATION_SOURCE_READ",
      ...scope,
      actorReference: id(2),
      operationReference: id(3),
      catalogIntentDigest: digest,
    },
    recipeRequest: {
      purposeCode: "CATALOG_LIFECYCLE_RECIPE_SOURCE_READ",
      brandReference: id(1),
      actorReference: id(2),
      operationReference: id(3),
      catalogIntentDigest: digest,
    },
    activationAt: "2026-10-01T04:00:02.000Z",
  };
  return {
    tx,
    options,
    input,
    details,
    authority,
    source: createCurrentOptionSetDraftConsumptionReferenceSource(options),
    advance: (v: string) => {
      clock = v;
    },
  };
}
beforeEach(() =>
  Object.assign(state, {
    mode: "Once",
    inventoryMode: "Once",
    recipeMode: "Once",
    inventoryCalls: 0,
    recipeCalls: 0,
  }),
);
const refused = expect.objectContaining({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
it("derives both sets of pins and preserves earliest original current source deadline", async () => {
  const f = fixture(),
    v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(v.inventory.decision).toBe("PassForMetadata");
  expect(v.recipe.decision).toBe("PassForMetadata");
  expect(v.inventory.matches[0]?.optionReference).toBe(id(110));
  expect(v.recipe.matches[0]?.optionReference).toBe(id(120));
  expect(v.validUntil).toBe("2026-10-01T04:00:05.000Z");
  expect(v.eligibility).toBe("NotEvaluated");
  expect(v.publishValidation).toBe("Incomplete");
  expect(Object.isFrozen(v)).toBe(true);
  expect(v.tenantReference).toBe(id(4));
});
it("does not skip complete owner permissions with empty pins", async () => {
  const f = fixture();
  f.details.splice(0);
  const v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(v.inventory.matches).toEqual([]);
  expect(v.recipe.matches).toEqual([]);
  expect(state.inventoryCalls).toBe(1);
  expect(state.recipeCalls).toBe(1);
  expect(f.authority.holdUntilTransactionCompletes).toHaveBeenCalledTimes(4);
});
it("returns hard metadata error for wrong actual pinned identity without qualification", async () => {
  const f = fixture();
  const d = f.details[0];
  if (!d) throw Error("fixture");
  d.consumption.versionReference = id(999);
  const v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => v);
  expect(v.inventory.decision).toBe("HardError");
  expect(v.eligibility).toBe("NotEvaluated");
});
it.each(["mode", "inventoryMode", "recipeMode"] as const)(
  "refuses repeated owner %s",
  async (field) => {
    const f = fixture();
    state[field] = "Twice";
    await expect(f.source.withCurrentAssessment(f.tx, f.input, async () => 1)).rejects.toThrowError(
      refused,
    );
  },
);
it.each(["inventoryMode", "recipeMode"] as const)(
  "refuses missing or wrong-return owner %s",
  async (field) => {
    for (const mode of ["NoCall", "WrongReturn", "LateDenial"]) {
      const f = fixture();
      state[field] = mode;
      await expect(
        f.source.withCurrentAssessment(f.tx, f.input, async () => 1),
      ).rejects.toThrowError(refused);
      state[field] = "Once";
    }
  },
);
it.each(["fields", "inventory", "recipe", "root", "expiry", "backward", "query"])(
  "refuses late %s",
  async (mode) => {
    const f = fixture();
    await expect(
      f.source.withCurrentAssessment(f.tx, f.input, async () => {
        if (mode === "fields")
          f.authority.holdUntilTransactionCompletes.mockImplementation(async () => {
            throw Error("synthetic denial");
          });
        if (mode === "inventory") state.inventoryRaw = {};
        if (mode === "recipe") state.recipeRaw = {};
        if (mode === "root") state.root = {};
        if (mode === "expiry") f.advance("2026-10-01T04:00:05.000Z");
        if (mode === "backward") f.advance("2026-10-01T03:59:59.999Z");
        if (mode === "query") f.tx.query = vi.fn(async () => ({ rows: [] }));
        return 1;
      }),
    ).rejects.toThrowError(refused);
  },
);
it.each(["tenant", "actor", "intent", "operation", "graph"])(
  "refuses %s scope/intent before owning source",
  async (mode) => {
    const f = fixture();
    if (mode === "tenant") f.input.inventoryRequest.tenantReference = id(999);
    if (mode === "actor") f.input.recipeRequest.actorReference = id(999);
    if (mode === "intent") f.input.recipeRequest.catalogIntentDigest = "sha256:" + "b".repeat(64);
    if (mode === "operation") f.input.recipeRequest.operationReference = id(999);
    const v = mode === "graph" ? { ...f.input, graph: { Ready: true } } : f.input;
    await expect(f.source.withCurrentAssessment(f.tx, v, async () => 1)).rejects.toThrowError(
      refused,
    );
    expect(state.inventoryCalls).toBe(0);
  },
);
it("captures clock/authority and detaches original intent", async () => {
  const f = fixture();
  f.options.clock.now = () => "2026-10-01T04:00:30.000Z";
  f.options.inventoryAuthority.holdUntilTransactionCompletes = vi.fn(async () => {
    throw Error("replacement");
  });
  const v = await f.source.withCurrentAssessment(f.tx, f.input, async (v) => {
    f.input.inventoryRequest.catalogIntentDigest = "sha256:" + "b".repeat(64);
    return v;
  });
  expect(v.inventory.catalogIntentDigest).toBe(digest);
});
it("poisons caught recursion and refuses accessors without invoking them", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentAssessment(f.tx, f.input, async () => {
      await expect(
        f.source.withCurrentAssessment(f.tx, f.input, async () => 2),
      ).rejects.toThrowError(refused);
      return 1;
    }),
  ).rejects.toThrowError(refused);
  const g = fixture(),
    getter = vi.fn(() => g.input.graphRequest),
    input = { ...g.input };
  Object.defineProperty(input, "graphRequest", { get: getter, enumerable: true });
  await expect(g.source.withCurrentAssessment(g.tx, input, async () => 1)).rejects.toThrowError(
    refused,
  );
  expect(getter).not.toHaveBeenCalled();
});
