import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  buildCatalogProductEditorSnapshot,
  parseProductAggregate,
  productCategoryAssignmentFields,
  productEditorSnapshotFields,
} from "@rms/catalog";
import { createMerchantProductEditorQuery } from "./merchant-product-editor-query.js";
const state = vi.hoisted(() => ({
  brand: vi.fn(),
  factory: vi.fn(),
  capability: vi.fn(),
  holdCapability: vi.fn(),
  completed: false,
  mode: "normal",
  changed: {},
  ownerChanged: {},
  categoryPolicyChanged: {},
  categoryPolicyCalls: vi.fn(),
  categoryRead: undefined as ((source: Source, tx: Transaction) => Promise<void>) | undefined,
  laterGuard: undefined as (() => void) | undefined,
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => state.brand }));
// Current Brand/action and fixed owning field-profile composition remain real;
// the standalone FeatureControl suite/native cover its current definitions.
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (...args: unknown[]) => state.capability(...args),
}));
vi.mock("@rms/catalog", async (original) => {
  const catalog = await original<typeof import("@rms/catalog")>();
  return {
    ...catalog,
    createPostgresProductEditorSourceStore: (...args: unknown[]) => state.factory(...args),
    createPostgresProductCategoryAssignmentAuthority(
      options: Parameters<typeof catalog.createPostgresProductCategoryAssignmentAuthority>[0],
    ) {
      return catalog.createPostgresProductCategoryAssignmentAuthority({
        ...options,
        async holdPolicyUntilTransactionCompletes(tx, input) {
          state.categoryPolicyCalls(tx, input);
          return options.holdPolicyUntilTransactionCompletes(tx, {
            ...input,
            ...state.categoryPolicyChanged,
          });
        },
      });
    },
  };
});
const id = (n: number) => "01902438-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T20:00:00.000Z",
  until = "2026-09-30T20:00:05.000Z";
type Options = Parameters<typeof createMerchantProductEditorQuery>[0];
type Source = Parameters<typeof import("@rms/catalog").createPostgresProductEditorSourceStore>[0];
type Transaction = Parameters<Source["authority"]["holdUntilTransactionCompletes"]>[0];
function setup() {
  let now = at;
  const events: string[] = [],
    queries: string[] = [],
    authenticate = vi.fn(async () => ({ sessionReference: id(6) })),
    action = vi.fn(async (requested: string) => ({
      effect: "Allow",
      action: requested,
      scopeKind: "Brand",
    })),
    scope = {
      tenantReference: id(1),
      context: { brand: { brandReference: id(2) } },
      selectedStoreReference: id(3),
      actorReference: id(4),
      authorizeAction: action,
      authorizeActions: async (actions: readonly string[]) => Promise.all(actions.map(action)),
      authorizeActionsWithValidity: async (actions: readonly string[]) => ({
        decisions: await Promise.all(actions.map(action)),
        validUntil: null,
      }),
    },
    view = Object.freeze({
      profile: "CatalogProductEditorSnapshotV1",
      tenantReference: id(1),
      brandReference: id(2),
      productReference: id(5),
      aggregateVersion: 7,
      observedAt: at,
      validUntil: until,
      contentStatus: "Present",
      publishValidation: "Incomplete",
      digest: "sha256:" + "2".repeat(64),
      eligibility: "NotEvaluated",
      referenceEligibility: "NotEvaluated",
    });
  state.brand.mockResolvedValue(scope);
  state.capability.mockImplementation(
    (
      host: Parameters<
        typeof import("./merchant-product-store-capability.js").createMerchantProductStoreCapabilityGuard
      >[0],
    ) => ({
      async holdUntilCommit() {
        await state.holdCapability();
        if (state.laterGuard) {
          const later = state.laterGuard;
          state.laterGuard = undefined;
          await host.registerBeforeCommit(
            host.transaction,
            async () => {
              later();
            },
            () => undefined,
          );
        }
      },
    }),
  );
  state.holdCapability.mockResolvedValue(undefined);
  const screen = vi.fn<NonNullable<Options["holdScreenUntilCommit"]>>(async () => {
      events.push(state.completed ? "final-screen" : "screen");
    }),
    history = vi.fn(async () => {
      events.push(state.completed ? "final-history" : "history");
    });
  state.factory.mockImplementation((source: Source) => ({
    async withCurrentSnapshot(query: unknown, work: (v: unknown, tx: unknown) => Promise<unknown>) {
      expect(query).toEqual({ productReference: id(5), expectedAggregateVersion: 7 });
      return source.transactions.run(async (tx) => {
        const common = {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: id(4),
            productReference: id(5),
            permission: "catalog.manage" as const,
            owningAction: "catalog.product.manage" as const,
            observedAt: at,
          },
          h = {
            ...common,
            purposeCode: "CATALOG_PRODUCT_EDITOR_READ" as const,
            actorKind: "User" as const,
            requiredFields: productEditorSnapshotFields,
            ...state.ownerChanged,
          };
        await source.authority.holdUntilTransactionCompletes(tx, h);
        if (state.mode === "none") return view;
        await state.categoryRead?.(source, tx);
        const result = await work(
          { ...view, ...state.changed },
          state.mode === "wrong-tx" ? {} : tx,
        );
        if (state.mode === "twice") await work(view, tx);
        await source.authority.holdUntilTransactionCompletes(tx, h);
        state.completed = true;
        events.push("source-return");
        return state.mode === "rebound" ? { ...(result as object) } : result;
      });
    },
  }));
  const options = {
    merchant: {
      now: () => now,
      transactions: {
        async run(work) {
          events.push("begin");
          const result = await work({
            async query(sql: string) {
              queries.push(sql);
              return {
                rows: sql.includes("transaction_isolation")
                  ? [{ isolation: "read committed" }]
                  : [],
              };
            },
          });
          events.push("commit");
          return result;
        },
      },
    } as Options["merchant"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    contentAuthority: { holdUntilTransactionCompletes: history },
    holdScreenUntilCommit: screen,
  } satisfies Options;
  const request = {
    sessionCookie: "Synthetic opaque credential",
    csrf: "Synthetic csrf",
    query: { productReference: id(5), expectedAggregateVersion: 7 },
    expectedScope: { brandReference: id(2), storeReference: id(3) },
  };
  return {
    options,
    request,
    view,
    screen,
    history,
    scope,
    action,
    authenticate,
    events,
    queries,
    setNow: (v: string) => {
      now = v;
    },
  };
}
beforeEach(() => {
  state.brand.mockReset();
  state.factory.mockReset();
  state.capability.mockReset();
  state.holdCapability.mockReset();
  state.completed = false;
  state.mode = "normal";
  state.changed = {};
  state.ownerChanged = {};
  state.categoryPolicyChanged = {};
  state.categoryPolicyCalls.mockReset();
  state.categoryRead = undefined;
  state.laterGuard = undefined;
});
it("composes owning full editor source with independent scope, screen and content holds before outer COMMIT", async () => {
  const f = setup(),
    result = await createMerchantProductEditorQuery(f.options)(f.request);
  expect(result).toEqual(f.view);
  expect(f.events.slice(-4)).toEqual(["source-return", "final-screen", "final-history", "commit"]);
  expect(f.history).toHaveBeenCalledTimes(3);
  expect(state.factory.mock.calls[0]?.[0]).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
  });
  expect(f.screen.mock.calls[0]?.[1]).toMatchObject({
    productReference: id(5),
    sessionReference: id(6),
    storeReference: id(3),
    screenId: "CAT-PRODUCT-EDIT",
    capability: "catalog.cat_product_edit",
    purposeCode: "CATALOG_PRODUCT_EDITOR_READ",
    requiredFields: productEditorSnapshotFields,
  });
});
it.each([
  null,
  {},
  { productReference: id(5), expectedAggregateVersion: 0 },
  { productReference: id(5), expectedAggregateVersion: 7, journal: {} },
  { productReference: "invalid", expectedAggregateVersion: 7 },
])("rejects closed query before authentication %#", async (query) => {
  const f = setup();
  await expect(
    createMerchantProductEditorQuery(f.options)({ ...f.request, query }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.authenticate).not.toHaveBeenCalled();
  expect(state.factory).not.toHaveBeenCalled();
});
it("refuses getters without invoking them", async () => {
  const f = setup(),
    getter = vi.fn(() => id(5)),
    query = { expectedAggregateVersion: 7 };
  Object.defineProperty(query, "productReference", { enumerable: true, get: getter });
  await expect(
    createMerchantProductEditorQuery(f.options)({ ...f.request, query }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
});
it.each(["brandReference", "storeReference"])(
  "rejects changed selected %s before owning reads",
  async (key) => {
    const f = setup();
    await expect(
      createMerchantProductEditorQuery(f.options)({
        ...f.request,
        expectedScope: { ...f.request.expectedScope, [key]: id(99) },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.factory).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
  },
);
it.each(["catalog.manage", "catalog.product.manage", "catalog.product.read", "catalog.sku.read"])(
  "requires independent current Brand %s and refuses late withdrawal",
  async (required) => {
    for (const late of [false, true]) {
      const f = setup();
      f.action.mockImplementation(async (action) => ({
        effect: action === required && (!late || state.completed) ? "Deny" : "Allow",
        scopeKind: "Brand",
        action,
      }));
      await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
        code: "CATALOG_PERMISSION_DENIED",
      });
      expect(f.events).not.toContain("commit");
      state.completed = false;
    }
  },
);
it.each(["Store", "wrong-action"])(
  "does not substitute allowed %s action evidence",
  async (kind) => {
    const f = setup();
    f.action.mockImplementation(async (action) => ({
      effect: "Allow",
      scopeKind: kind === "Store" ? "Store" : "Brand",
      action: kind === "wrong-action" ? "catalog.product.update" : action,
    }));
    await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it.each(["contentAuthority", "holdScreenUntilCommit"] as const)(
  "requires configured %s without synthetic fallback",
  (key) => {
    const f = setup();
    expect(() =>
      createMerchantProductEditorQuery({
        ...f.options,
        [key]: undefined,
      } as unknown as Options),
    ).toThrow(CatalogError);
  },
);
it.each(["screen", "history"] as const)(
  "drops completed read after outer final %s denial or expiry",
  async (key) => {
    for (const mode of ["deny", "expiry"]) {
      const f = setup();
      f[key].mockImplementation(async () => {
        if (state.completed) {
          if (mode === "deny") throw new CatalogError("CATALOG_PERMISSION_DENIED");
          f.setNow(until);
        }
      });
      await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
        code: mode === "deny" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
      });
      expect(f.events).not.toContain("commit");
      state.completed = false;
    }
  },
);
it("refuses unavailable phase before owner source factory", async () => {
  const f = setup();
  f.screen.mockRejectedValue(Error("private phase facts"));
  await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(state.factory).not.toHaveBeenCalled();
});
it.each(["none", "twice", "wrong-tx", "rebound"])(
  "requires one exact owning callback/result %s",
  async (mode) => {
    const f = setup();
    state.mode = mode;
    await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.events).not.toContain("commit");
  },
);
it.each([
  "tenantReference",
  "brandReference",
  "productReference",
  "aggregateVersion",
  "validUntil",
])("refuses mismatched owning %s", async (key) => {
  const f = setup();
  state.changed = {
    [key]:
      key === "aggregateVersion" ? 8 : key === "validUntil" ? "2026-09-30T20:00:06.000Z" : id(99),
  };
  await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).not.toContain("commit");
});
it.each(["2026-09-30T19:59:59.999Z", until])(
  "uses exclusive original deadline and refuses backwards clock %s",
  async (value) => {
    const f = setup();
    f.setNow(value);
    await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it.each(["none", "twice", "rebound"])(
  "refuses changed outer runner callback/result %s",
  async (mode) => {
    const f = setup(),
      runner = f.options.merchant.transactions.run;
    f.options.merchant.transactions.run = async (work) => {
      if (mode === "none") return {} as Awaited<ReturnType<typeof work>>;
      const result = await runner(work);
      if (mode === "twice") await runner(work);
      return mode === "rebound"
        ? ({ ...(result as object) } as Awaited<ReturnType<typeof work>>)
        : result;
    };
    await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
  },
);
it("suppresses transport if observation expires during outer runner completion", async () => {
  const f = setup(),
    runner = f.options.merchant.transactions.run;
  f.options.merchant.transactions.run = async (work) => {
    const result = await runner(work);
    f.setNow(until);
    return result;
  };
  await expect(createMerchantProductEditorQuery(f.options)(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toContain("commit"); // Read only; no write rollback is claimed after COMMIT.
});
it("captures original configured adapters and does not require create/update/publish grants", async () => {
  const f = setup(),
    load = createMerchantProductEditorQuery(f.options);
  Object.assign(f.options, {
    contentAuthority: {},
    journalAuthority: {},
    holdScreenUntilCommit: undefined,
    authentication: {},
  });
  Object.assign(f.options.merchant, { now: () => until });
  Object.assign(f.options.merchant.transactions, {
    run: vi.fn(() => {
      throw Error("replaced");
    }),
  });
  expect(await load(f.request)).toEqual(f.view);
  expect(f.action.mock.calls.some(([action]) => /\.(?:create|update|publish)$/u.test(action))).toBe(
    false,
  );
});

it("captures original collaborator methods and clock instead of replacement ports", async () => {
  const f = setup(),
    read = createMerchantProductEditorQuery(f.options);
  Object.assign(f.options.authentication, {
    authorize: vi.fn(() => {
      throw Error("replaced");
    }),
  });
  Object.assign(f.options.contentAuthority, {
    holdUntilTransactionCompletes: vi.fn(() => {
      throw Error("replaced");
    }),
  });
  Object.assign(f.options, {
    holdScreenUntilCommit: vi.fn(() => {
      throw Error("replaced");
    }),
  });
  Object.assign(f.options.merchant, { now: () => until });
  Object.assign(f.options.merchant.transactions, {
    run: vi.fn(() => {
      throw Error("replaced");
    }),
  });
  expect(await read(f.request)).toEqual(f.view);
  expect(f.authenticate).toHaveBeenCalledOnce();
  expect(f.history).toHaveBeenCalledTimes(3);
});

function runtimeOptions(f: Pick<ReturnType<typeof setup>, "options">): Options {
  return {
    merchant: f.options.merchant,
    authentication: f.options.authentication,
    currentRuntime: true,
  };
}
it("runtime editor uses actual current Brand authorization and the exact content profile on the original transaction", async () => {
  const f = setup();
  expect(await createMerchantProductEditorQuery(runtimeOptions(f))(f.request)).toEqual(f.view);
  expect(f.screen).not.toHaveBeenCalled();
  expect(f.history).not.toHaveBeenCalled();
  expect(state.factory).toHaveBeenCalledOnce();
  expect(state.capability).toHaveBeenCalledOnce();
  expect(state.capability.mock.calls[0]?.[0]).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    originalValidUntil: until,
    transaction: state.brand.mock.calls[0]?.[0],
  });
  expect(new Set(f.action.mock.calls.map(([action]) => action))).toEqual(
    new Set([
      "catalog.manage",
      "catalog.product.manage",
      "catalog.product.read",
      "catalog.sku.read",
    ]),
  );
  expect(f.events.at(-1)).toBe("commit");
});
it.each(["contentAuthority", "holdScreenUntilCommit"] as const)(
  "runtime editor refuses ambiguous legacy %s",
  (key) => {
    const f = setup();
    expect(() =>
      createMerchantProductEditorQuery({ ...runtimeOptions(f), [key]: f.options[key] }),
    ).toThrow(CatalogError);
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it.each([false, true])(
  "runtime editor refuses current Brand permission denial (late=%s)",
  async (late) => {
    const f = setup();
    f.action.mockImplementation(async (action) => ({
      effect: action === "catalog.product.read" && (!late || state.completed) ? "Deny" : "Allow",
      action,
      scopeKind: "Brand",
    }));
    await expect(
      createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.completed).toBe(late);
    expect(f.events).not.toContain("commit");
  },
);
it("runtime editor refuses a capability failure before acquiring current content", async () => {
  const f = setup();
  state.holdCapability.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(state.factory).not.toHaveBeenCalled();
  expect(f.events).not.toContain("commit");
});
it("runtime editor preserves the authentication-entry deadline through slower scope resolution", async () => {
  const f = setup();
  state.brand.mockImplementation(async () => {
    f.setNow(until);
    return f.scope;
  });
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(state.factory).not.toHaveBeenCalled();
});
it("runtime editor rejects expiry during a later asynchronous transaction guard", async () => {
  const f = setup();
  state.laterGuard = () => {
    f.setNow(until);
  };
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(state.completed).toBe(true);
  expect(f.events).not.toContain("commit");
});
it.each([
  { productReference: id(99) },
  { purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE" },
  { requiredFields: [...productEditorSnapshotFields, "undeclared"] },
])("runtime editor refuses owning content packet drift %j", (changed) => {
  const f = setup();
  state.ownerChanged = changed;
  return expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
it("captures the query and session credential before authentication can yield", async () => {
  const f = setup(),
    originalCookie = f.request.sessionCookie;
  f.authenticate.mockImplementation(async () => {
    f.request.sessionCookie = "replacement credential";
    f.request.query.productReference = id(99);
    f.request.query.expectedAggregateVersion = 99;
    return { sessionReference: id(6) };
  });
  expect(await createMerchantProductEditorQuery(runtimeOptions(f))(f.request)).toEqual(f.view);
  expect(state.brand).toHaveBeenCalledWith(expect.anything(), originalCookie, id(6));
  expect(f.authenticate).toHaveBeenCalledWith({
    sessionCookie: originalCookie,
    csrf: f.request.csrf,
  });
});
it("runtime editor captures its original configuration without allowing a late legacy replacement", async () => {
  const f = setup(),
    options = runtimeOptions(f),
    read = createMerchantProductEditorQuery(options),
    replacement = vi.fn(async () => {
      throw Error("replacement");
    });
  Object.assign(options, {
    currentRuntime: undefined,
    contentAuthority: { holdUntilTransactionCompletes: replacement },
    holdScreenUntilCommit: replacement,
  });
  Object.assign(f.options.merchant, { now: () => until });
  Object.assign(f.options.merchant.transactions, { run: replacement });
  expect(await read(f.request)).toEqual(f.view);
  expect(replacement).not.toHaveBeenCalled();
  expect(state.capability).toHaveBeenCalledOnce();
});

function classifiedFixture(empty = false) {
  const f = setup(),
    aggregate = parseProductAggregate({
      productReference: id(5),
      brandReference: id(2),
      internalCode: "CLASSIFIED",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 7,
      createdAt: at,
      createdByActorReference: id(4),
      updatedAt: at,
      draft: {
        versionReference: id(20),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic classified Product" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        categoryClassification: {
          categoryReferences: empty ? [] : [id(10)],
          primaryCategoryReference: empty ? null : id(10),
        },
      },
    }),
    view = buildCatalogProductEditorSnapshot(
      aggregate,
      { tenantReference: id(1), brandReference: id(2) },
      f.request.query,
      at,
    );
  state.changed = view;
  state.categoryRead = async (source, tx) => {
    if (!source.categoryAssignments) throw Error("Actual category Read holder missing");
    await source.categoryAssignments.holdUntilTransactionCompletes(tx, { mode: "Read", aggregate });
  };
  return { ...f, aggregate, view };
}

it.each([false, true])(
  "runtime editor holds the actual classified Read profile, including known empty=%s",
  async (empty) => {
    const f = classifiedFixture(empty),
      result = await createMerchantProductEditorQuery(runtimeOptions(f))(f.request);
    expect(result).toEqual(f.view);
    expect(result.aggregate.draft.categoryClassification).toEqual(
      f.aggregate.draft.categoryClassification,
    );
    expect(state.categoryPolicyCalls).toHaveBeenCalledTimes(2); // Initial read and actual final owner hold.
    expect(state.categoryPolicyCalls.mock.calls[0]).toEqual([
      state.brand.mock.calls[0]?.[0],
      {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        productReference: id(5),
        productVersionReference: id(20),
        purposeCode: "CATALOG_PRODUCT_CATEGORY_ACCESS",
        permission: "catalog.product.manage",
        referencedPermission: "catalog.manage",
        requiredFields: productCategoryAssignmentFields,
        referencedFields: ["categoryReference", "brandReference", "lifecycle"],
        observedAt: at,
      },
    ]);
    expect(f.queries.filter((sql) => sql.includes("transaction_isolation"))).toHaveLength(2);
    // The actual owning Read retains recorded assignments without applying today's lifecycle rules.
    expect(f.queries.some((sql) => sql.includes("FROM rms_catalog.category"))).toBe(false);
    expect(f.screen).not.toHaveBeenCalled();
    expect(f.history).not.toHaveBeenCalled();
    expect(f.events.at(-1)).toBe("commit");
  },
);

it("runtime editor refuses a configured category policy override while the legacy holder remains supported", async () => {
  const f = classifiedFixture(),
    policy = vi.fn(async () => ({ allowedLifecycles: ["Active"] as const }));
  expect(() =>
    createMerchantProductEditorQuery({ ...runtimeOptions(f), categoryPolicy: policy }),
  ).toThrow(CatalogError);
  expect(policy).not.toHaveBeenCalled();
  expect(
    await createMerchantProductEditorQuery({ ...f.options, categoryPolicy: policy })(f.request),
  ).toEqual(f.view);
  expect(policy).toHaveBeenCalledTimes(2);
});

it.each([
  { tenantReference: id(99) },
  { brandReference: id(99) },
  { actorReference: id(99) },
  { productReference: id(99) },
  { productVersionReference: id(99) },
  { purposeCode: "CATALOG_PRODUCT_CATEGORY_MUTATION" },
  { permission: "catalog.manage" },
  { referencedPermission: "catalog.product.manage" },
  { requiredFields: ["categoryClassification", "categoryReferences"] },
  { referencedFields: ["categoryReference", "brandReference", "lifecycle", "undeclared"] },
  { observedAt: "2026-09-30T19:59:59.999Z" },
  { lifecycle: "Active" },
])("runtime editor rejects changed category access packet %j", async (changed) => {
  const f = classifiedFixture();
  state.categoryPolicyChanged = changed;
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.queries).toEqual([]);
  expect(f.events).not.toContain("commit");
});

it.each(["Write", "other-transaction", "other-root", "other-product", "other-brand"])(
  "runtime editor refuses category %s even if the source catches it",
  async (mode) => {
    const f = classifiedFixture();
    let caught: unknown;
    state.categoryRead = async (source, tx) => {
      if (!source.categoryAssignments) throw Error("Missing holder");
      const aggregate =
        mode === "other-root"
          ? { ...f.aggregate, aggregateVersion: 8 }
          : mode === "other-product"
            ? { ...f.aggregate, productReference: id(99) }
            : mode === "other-brand"
              ? { ...f.aggregate, brandReference: id(99) }
              : f.aggregate;
      try {
        await source.categoryAssignments.holdUntilTransactionCompletes(
          mode === "other-transaction" ? { query: tx.query } : tx,
          {
            mode: mode === "Write" ? "Write" : "Read",
            aggregate: parseProductAggregate(aggregate),
          },
        );
      } catch (error) {
        caught = error;
      }
    };
    await expect(
      createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
    ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(caught).toBeInstanceOf(CatalogError);
    expect(state.categoryPolicyCalls).not.toHaveBeenCalled();
    expect(f.events).not.toContain("commit");
  },
);

it("runtime editor rejects classified content when the owning source skips its category hold", async () => {
  const f = classifiedFixture();
  state.categoryRead = undefined;
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).not.toContain("commit");
});

it("runtime editor binds category authorization to the complete actual returned version", async () => {
  const f = classifiedFixture();
  state.changed = buildCatalogProductEditorSnapshot(
    { ...f.aggregate, draft: { ...f.aggregate.draft, versionReference: id(21) } },
    { tenantReference: id(1), brandReference: id(2) },
    f.request.query,
    at,
  );
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(f.events).not.toContain("commit");
});

it("runtime editor keeps classified authorization current through the final owning category hold", async () => {
  const f = classifiedFixture();
  const original = f.action.getMockImplementation();
  if (!original) throw Error("Missing synthetic current IAM implementation");
  f.action.mockImplementation(async (action) => {
    if (state.categoryPolicyCalls.mock.calls.length >= 2 && action === "catalog.manage")
      return { effect: "Deny", action, scopeKind: "Brand" };
    return original(action);
  });
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(state.completed).toBe(true);
  expect(state.categoryPolicyCalls).toHaveBeenCalledTimes(2);
  expect(f.events).not.toContain("commit");
});

it("runtime editor never extends classified read time after a later final guard expires the original lease", async () => {
  const f = classifiedFixture();
  state.laterGuard = () => f.setNow(until);
  await expect(
    createMerchantProductEditorQuery(runtimeOptions(f))(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
  expect(state.completed).toBe(true);
  expect(f.events).not.toContain("commit");
});
