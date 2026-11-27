import { expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
} from "@rms/catalog";
import { createMerchantProductLifecycleCommand } from "./merchant-product-lifecycle-command.js";
// The decode-only runner stops before invoking any owning scope callback.
const currentScope = vi.hoisted(() => ({ resolve: null as null | (() => unknown) }));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => () => {
    if (!currentScope.resolve) throw new Error("Owning scope cannot run in decode-only unit");
    return currentScope.resolve();
  },
}));
const runtimeState = vi.hoisted(() => ({
  enabled: false,
  store: vi.fn(),
  service: vi.fn(),
  bridge: vi.fn(),
  capability: vi.fn(),
}));
vi.mock("@rms/catalog", async (original) => {
  const catalog = await original<typeof import("@rms/catalog")>();
  return {
    ...catalog,
    createPostgresProductLifecycleStore: (
      ...args: Parameters<typeof catalog.createPostgresProductLifecycleStore>
    ) =>
      runtimeState.enabled
        ? runtimeState.store(...args)
        : catalog.createPostgresProductLifecycleStore(...args),
    createCatalogProductService: (
      ...args: Parameters<typeof catalog.createCatalogProductService>
    ) =>
      runtimeState.enabled
        ? runtimeState.service(...args)
        : catalog.createCatalogProductService(...args),
  };
});
vi.mock("./merchant-product-current-authorization.js", async (original) => {
  const module = await original<typeof import("./merchant-product-current-authorization.js")>();
  return {
    ...module,
    createMerchantProductCurrentAuthorization: (
      ...args: Parameters<typeof module.createMerchantProductCurrentAuthorization>
    ) =>
      runtimeState.enabled
        ? runtimeState.bridge(...args)
        : module.createMerchantProductCurrentAuthorization(...args),
  };
});
vi.mock("./merchant-product-store-capability.js", async (original) => {
  const module = await original<typeof import("./merchant-product-store-capability.js")>();
  return {
    ...module,
    createMerchantProductStoreCapabilityGuard: (
      ...args: Parameters<typeof module.createMerchantProductStoreCapabilityGuard>
    ) =>
      runtimeState.enabled
        ? runtimeState.capability(...args)
        : module.createMerchantProductStoreCapabilityGuard(...args),
  };
});
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const command = {
  productReference: id(1),
  skuReference: id(2),
  targetLifecycle: "Suspended",
  expectedAggregateVersion: 3,
  operationReference: id(4),
};
function setup() {
  // Closed decode only: owner SQL/IAM composition is covered by actual persistence fixtures.
  const run = vi.fn(async () => {
    throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
  });
  const execute = createMerchantProductLifecycleCommand({
    merchant: { transactions: { run }, now: () => "2026-09-29T12:00:00.000Z" } as never,
    authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
    auditReference: () => id(6),
  });
  return {
    run,
    post: (value: unknown) =>
      execute({
        sessionCookie: "synthetic",
        csrf: "synthetic",
        command: value,
        expectedScope: { brandReference: id(6), storeReference: id(7) },
      }),
  };
}
it.each(["Suspended", "Discontinued", "Archived", "Draft"])(
  "requires explicit reason before source read for %s",
  async (targetLifecycle) => {
    const f = setup();
    await expect(f.post({ ...command, targetLifecycle })).rejects.toMatchObject({
      code: "CATALOG_INPUT_INVALID",
    });
    expect(f.run).not.toHaveBeenCalled();
  },
);
it.each([
  undefined,
  null,
  "",
  "lower_case",
  "A".repeat(129),
  "REASON\n",
  " REASON",
  "REASON ",
  "REASON:OTHER",
  {},
  1,
])("rejects malformed reason %s before owner read", async (reasonCode) => {
  const f = setup();
  await expect(f.post({ ...command, reasonCode })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(f.run).not.toHaveBeenCalled();
});
it("rejects accessor reason without invoking it", async () => {
  const f = setup(),
    getter = vi.fn(() => "SYNTHETIC");
  const value = Object.defineProperty({ ...command }, "reasonCode", {
    enumerable: true,
    get: getter,
  });
  await expect(f.post(value)).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it.each(["SYNTHETIC_REASON", "A".repeat(128)])(
  "passes provided stable reason %s to server authority flow",
  async (reasonCode) => {
    const f = setup();
    await expect(f.post({ ...command, reasonCode })).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.run).toHaveBeenCalledTimes(1);
  },
);
it("keeps reason optional for Activate/Resume target without claiming mutation authorization", async () => {
  const f = setup();
  await expect(f.post({ ...command, targetLifecycle: "Active" })).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});

function scopeSetup() {
  const query = vi.fn<
    (
      sql: string,
      values: readonly unknown[],
    ) => Promise<{ rows: readonly unknown[]; rowCount: number }>
  >(async () => ({ rows: [], rowCount: 0 }));
  const run = vi.fn(async (work: (tx: { query: typeof query }) => Promise<unknown>) =>
    work({ query }),
  );
  const scope = {
    tenantReference: id(9),
    selectedStoreReference: id(7),
    actorReference: id(8),
    context: { brand: { brandReference: id(6) } },
    authorizeAction: vi.fn(async (action: string) => ({
      action,
      effect: "Allow",
      scopeKind: "Brand",
    })),
  };
  const authorize = vi.fn(async () => ({ sessionReference: id(5) }));
  currentScope.resolve = () => scope;
  const execute = createMerchantProductLifecycleCommand({
    merchant: { transactions: { run }, now: () => "2026-09-29T12:00:00.000Z" } as never,
    authentication: { authorize } as never,
    auditReference: () => id(10),
    writeAuthority: async () => "Allowed",
  });
  return {
    query,
    run,
    scope,
    authorize,
    post: (expectedScope: unknown, value: unknown = { ...command, targetLifecycle: "Active" }) =>
      execute({ sessionCookie: "synthetic", csrf: "synthetic", command: value, expectedScope }),
  };
}
it.each([
  undefined,
  null,
  {},
  { brandReference: id(6) },
  { brandReference: id(6), storeReference: id(7), tenantReference: id(9) },
  { brandReference: id(6), storeReference: "bad" },
])("rejects malformed scope %s before authority/source", async (expected) => {
  const f = scopeSetup();
  try {
    await expect(f.post(expected)).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(f.authorize).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
    expect(f.query).not.toHaveBeenCalled();
  } finally {
    currentScope.resolve = null;
  }
});
it.each([
  { brandReference: id(20), storeReference: id(7) },
  { brandReference: id(6), storeReference: id(21) },
])("denies wrong actual Brand/Store %s before private source", async (expected) => {
  const f = scopeSetup();
  try {
    await expect(f.post(expected)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.query).not.toHaveBeenCalled();
    expect(f.scope.authorizeAction).not.toHaveBeenCalled();
  } finally {
    currentScope.resolve = null;
  }
});
it("denies later server scope drift against the copied original request before Product read", async () => {
  const f = scopeSetup();
  let changed = false;
  f.scope.authorizeAction.mockImplementation(async (action) => {
    if (!changed) {
      f.scope.selectedStoreReference = id(21);
      changed = true;
    }
    return { action, effect: "Allow", scopeKind: "Brand" };
  });
  try {
    await expect(f.post({ brandReference: id(6), storeReference: id(7) })).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.query.mock.calls.every(([sql]) => !/rms_catalog\./u.test(String(sql)))).toBe(true);
  } finally {
    currentScope.resolve = null;
  }
});
it("rejects scope injected into command body", async () => {
  const f = scopeSetup();
  try {
    await expect(
      f.post(
        { brandReference: id(6), storeReference: id(7) },
        {
          ...command,
          targetLifecycle: "Active",
          expectedScope: { brandReference: id(6), storeReference: id(7) },
        },
      ),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(f.run).not.toHaveBeenCalled();
  } finally {
    currentScope.resolve = null;
  }
});

type LifecycleOptions = Parameters<typeof createMerchantProductLifecycleCommand>[0];
type StoreOptions = Parameters<
  typeof import("@rms/catalog").createPostgresProductLifecycleStore
>[0];
const runtimeAt = "2026-10-04T12:00:00.000Z";
function runtimeSetup(before: "Draft" | "Active" = "Draft") {
  runtimeState.enabled = true;
  for (const mock of [
    runtimeState.store,
    runtimeState.service,
    runtimeState.bridge,
    runtimeState.capability,
  ])
    mock.mockReset();
  let now = runtimeAt,
    denied = false,
    replay = false,
    commits = 0;
  const events: string[] = [],
    actions: string[][] = [];
  const original = parseProductAggregate({
    productReference: id(1),
    brandReference: id(6),
    internalCode: "PRODUCT",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 3,
    createdAt: runtimeAt,
    updatedAt: runtimeAt,
    createdByActorReference: id(8),
    draft: {
      versionReference: id(11),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Product" },
      taxClassificationReference: null,
      optionBindings: [],
      skus: [
        {
          skuReference: id(2),
          productReference: id(1),
          brandReference: id(6),
          skuCode: "SKU",
          lifecycle: before,
          localizedNames: { "en-CA": "SKU" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: runtimeAt,
          createdByActorReference: id(8),
        },
      ],
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [{ selections: [], disposition: "Valid", skuReference: id(2) }],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
      createdAt: runtimeAt,
      updatedAt: runtimeAt,
    },
  });
  const resultAggregate = parseProductAggregate({
    ...original,
    aggregateVersion: 4,
    draft: {
      ...original.draft,
      skus: original.draft.skus.map((sku) => ({ ...sku, lifecycle: "Active" })),
    },
  });
  const scope = {
    tenantReference: id(9),
    selectedStoreReference: id(7),
    actorReference: id(8),
    context: { brand: { brandReference: id(6) } },
    authorizeAction: vi.fn(async (action: string) => {
      if (denied) return null;
      return { effect: "Allow", action, scopeKind: "Brand" };
    }),
  };
  currentScope.resolve = () => scope;
  runtimeState.bridge.mockImplementation(() => ({
    assertCurrent: () => now,
    async authorizeActions(requested: readonly string[]) {
      actions.push([...requested]);
      if (denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    },
  }));
  let late: undefined | (() => void);
  runtimeState.capability.mockImplementation(
    (
      host: Parameters<
        typeof import("./merchant-product-store-capability.js").createMerchantProductStoreCapabilityGuard
      >[0],
    ) => {
      let registered = false;
      return {
        async holdUntilCommit() {
          events.push("capability:" + host.capabilityKey);
          if (!registered) {
            registered = true;
            await host.registerBeforeCommit(host.transaction, async () => {
              late?.();
            });
          }
        },
      };
    },
  );
  let storeOptions: StoreOptions | undefined;
  let storedHistory: Parameters<StoreOptions["authorize"]>[1] | undefined;
  let priorOverride: NonNullable<Parameters<StoreOptions["authorize"]>[1]["record"]> | undefined;
  runtimeState.store.mockImplementation((options: StoreOptions) => {
    storeOptions = options;
    const read = async (
      value: typeof original,
      ownerInput?: Parameters<StoreOptions["authorize"]>[1],
    ) =>
      options.transactions.run(async (tx) => {
        if (!(await options.authorize(tx, ownerInput ?? { productReference: id(1) })))
          throw new CatalogError("CATALOG_PERMISSION_DENIED");
        await options.editorContentAuthority?.holdUntilTransactionCompletes(tx, {
          mode: "Read",
          aggregate: value,
          requiredFields: productEditorContentFields,
          requiredReferenceChecks: [],
        });
        await options.categoryAssignments?.holdUntilTransactionCompletes(tx, {
          mode: "Read",
          aggregate: value,
        });
        return value;
      });
    return {
      async resolveOperation() {
        events.push("receipt");
        if (priorOverride) {
          await read(priorOverride.aggregate, {
            productReference: id(1),
            record: priorOverride,
            recordOrigin: "StoredOperation",
          });
          return priorOverride;
        }
        return replay
          ? { action: "ChangeLifecycle", aggregate: await read(resultAggregate) }
          : null;
      },
      async load() {
        events.push("current");
        return read(original);
      },
      async loadAggregateVersion(product: string, version: number) {
        events.push("original:" + version);
        expect(product).toBe(id(1));
        return read(original, storedHistory);
      },
    };
  });
  runtimeState.service.mockImplementation(() => ({
    async changeLifecycle(input: Record<string, unknown>) {
      events.push("change");
      expect(input.targetLifecycle).toBe("Active");
      return { status: replay ? "AlreadyApplied" : "Applied", aggregate: resultAggregate };
    },
  }));
  const authenticate = vi.fn(async () => ({ sessionReference: id(5) }));
  const options = {
    currentRuntime: true,
    merchant: {
      now: () => now,
      transactions: {
        async run(work: Parameters<LifecycleOptions["merchant"]["transactions"]["run"]>[0]) {
          const result = await work({
            async query<Row>(sql: string) {
              return {
                rows: (sql.includes("transaction_isolation")
                  ? [{ isolation: "read committed" }]
                  : []) as unknown as readonly Row[],
              };
            },
          });
          commits++;
          return result;
        },
      },
    },
    authentication: { authorize: authenticate },
    auditReference: () => id(10),
  } as unknown as LifecycleOptions;
  const request = {
    sessionCookie: "Synthetic credential",
    csrf: "Synthetic csrf",
    command: { ...command, targetLifecycle: "Active" },
    expectedScope: { brandReference: id(6), storeReference: id(7) },
  };
  return {
    options,
    request,
    original,
    setStoredHistory(input: Parameters<StoreOptions["authorize"]>[1]) {
      storedHistory = input;
    },
    setPrior(record: NonNullable<typeof priorOverride>) {
      priorOverride = record;
    },
    events,
    actions,
    authenticate,
    scope,
    get storeOptions() {
      return storeOptions;
    },
    get commits() {
      return commits;
    },
    deny() {
      denied = true;
    },
    replay() {
      replay = true;
    },
    setNow(value: string) {
      now = value;
    },
    setLate(value: () => void) {
      late = value;
    },
    post: () => createMerchantProductLifecycleCommand(options)(request),
    close() {
      runtimeState.enabled = false;
      currentScope.resolve = null;
    },
  };
}
it("composes actual runtime read/ACCESS holders and derives Activate after original snapshot recovery", async () => {
  const f = runtimeSetup();
  try {
    await expect(f.post()).resolves.toMatchObject({
      status: "Applied",
      aggregateVersion: 4,
      skuLifecycle: "Active",
    });
    expect(
      f.events.filter((e) => ["receipt", "current", "original:3", "change"].includes(e)),
    ).toEqual(["receipt", "current", "original:3", "change"]);
    expect(f.actions.some((actions) => actions.includes("catalog.sku.activate"))).toBe(true);
    expect(f.events).toContain("capability:catalog.cat_sku_detail");
    expect(f.storeOptions?.editorContentAuthority).toBeDefined();
    expect(f.storeOptions?.categoryAssignments).toBeDefined();
    expect(f.commits).toBe(1);
  } finally {
    f.close();
  }
});
it("original receipt skips current-root admission but still reads original action and holds current permissions", async () => {
  const f = runtimeSetup();
  try {
    f.replay();
    f.setNow("2026-10-05T12:00:00.000Z");
    await expect(f.post()).resolves.toMatchObject({
      status: "AlreadyApplied",
      aggregateVersion: 4,
    });
    expect(f.events).not.toContain("current");
    expect(f.events.indexOf("receipt")).toBeLessThan(f.events.indexOf("original:3"));
    expect(f.actions.some((actions) => actions.includes("catalog.sku.activate"))).toBe(true);
  } finally {
    f.close();
  }
});
it.each(["writeAuthority", "categoryPolicy"] as const)(
  "refuses mixed currentRuntime and %s configuration",
  (key) => {
    const f = runtimeSetup();
    try {
      expect(() =>
        createMerchantProductLifecycleCommand({ ...f.options, [key]: async () => "Allowed" }),
      ).toThrow(CatalogError);
      expect(f.authenticate).not.toHaveBeenCalled();
    } finally {
      f.close();
    }
  },
);
it("captures original request/credential before asynchronous authentication", async () => {
  const f = runtimeSetup();
  try {
    f.authenticate.mockImplementation(async () => {
      f.request.command.operationReference = id(99);
      f.request.command.targetLifecycle = "Archived";
      f.request.sessionCookie = "changed";
      return { sessionReference: id(5) };
    });
    await expect(f.post()).resolves.toMatchObject({ skuLifecycle: "Active" });
    expect(runtimeState.bridge.mock.calls[0]?.[0]).toMatchObject({
      sessionCookie: "Synthetic credential",
    });
    expect(f.events).toContain("capability:catalog.cat_sku_detail");
  } finally {
    f.close();
  }
});
it("late current denial rejects the original runtime transaction", async () => {
  const f = runtimeSetup();
  try {
    let deniedNow = false;
    // The controlled owner revokes during a later host guard. The native case
    // supplies actual current IAM and FeatureControl instead of this boundary.
    runtimeState.bridge.mockImplementation(() => ({
      assertCurrent() {
        if (deniedNow) throw new CatalogError("CATALOG_PERMISSION_DENIED");
        return runtimeAt;
      },
      async authorizeActions() {
        if (deniedNow) throw new CatalogError("CATALOG_PERMISSION_DENIED");
      },
    }));
    f.setLate(() => {
      deniedNow = true;
    });
    await expect(f.post()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(f.commits).toBe(0);
  } finally {
    f.close();
  }
});
it("later async guard expiry is rejected in the final synchronous phase", async () => {
  const f = runtimeSetup();
  try {
    f.setLate(() => f.setNow("2026-10-04T12:00:05.000Z"));
    await expect(f.post()).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
    expect(f.commits).toBe(0);
  } finally {
    f.close();
  }
});
it("keeps the required lifecycle review instead of treating Suspend as an activation", async () => {
  const f = runtimeSetup("Active");
  try {
    f.request.command.targetLifecycle = "Suspended";
    const request = { ...f.request, command: { ...f.request.command, reasonCode: "PAUSE" } };
    // Active-to-Suspended is valid, but the independent review is absent.
    await expect(createMerchantProductLifecycleCommand(f.options)(request)).rejects.toMatchObject({
      code: "CATALOG_DEPENDENCY_UNAVAILABLE",
    });
    expect(f.events).not.toContain("change");
    expect(f.commits).toBe(0);
  } finally {
    f.close();
  }
});

// Controlled owning-store callback fixtures: the Catalog owner separately proves
// SQL tuple validation before issuing this immutable StoredOperation marker.
function originalHistory(f: ReturnType<typeof runtimeSetup>, action: "Create" | "ReplaceDraft") {
  return {
    productReference: id(1),
    recordOrigin: "StoredOperation" as const,
    record: {
      action,
      operationReference: parseCatalogReference(id(77)),
      operationIntentHash: parseCatalogHash("a".repeat(64)),
      aggregate: f.original,
    },
  };
}
it.each(["Create", "ReplaceDraft"] as const)(
  "reads actual validated original %s history before fresh SKU Activate",
  async (action) => {
    const f = runtimeSetup();
    try {
      f.setStoredHistory(originalHistory(f, action));
      await expect(f.post()).resolves.toMatchObject({
        status: "Applied",
        aggregateVersion: 4,
        skuLifecycle: "Active",
      });
      expect(f.events).toContain("change");
      expect(f.actions.some((actions) => actions.includes("catalog.sku.activate"))).toBe(true);
      expect(
        f.actions.some(
          (actions) =>
            actions.includes("catalog.product.read") && actions.includes("catalog.sku.read"),
        ),
      ).toBe(true);
      expect(f.commits).toBe(1);
    } finally {
      f.close();
    }
  },
);
it.each(["marker", "product", "Brand", "root", "requestedProduct"])(
  "refuses mismatched original lifecycle Read %s without write",
  async (field) => {
    const f = runtimeSetup();
    try {
      const history = originalHistory(f, "Create");
      if (field === "marker") {
        const { recordOrigin, ...unmarked } = history;
        expect(recordOrigin).toBe("StoredOperation");
        f.setStoredHistory(unmarked);
      } else if (field === "requestedProduct") {
        f.setStoredHistory({ ...history, productReference: id(99) });
      } else {
        const aggregate = parseProductAggregate({
          ...f.original,
          ...(field === "product"
            ? {
                productReference: id(99),
                draft: {
                  ...f.original.draft,
                  skus: f.original.draft.skus.map((sku) => ({ ...sku, productReference: id(99) })),
                },
              }
            : {}),
          ...(field === "Brand"
            ? {
                brandReference: id(99),
                draft: {
                  ...f.original.draft,
                  skus: f.original.draft.skus.map((sku) => ({ ...sku, brandReference: id(99) })),
                },
              }
            : {}),
          ...(field === "root" ? { aggregateVersion: 4 } : {}),
        });
        f.setStoredHistory({ ...history, record: { ...history.record, aggregate } });
      }
      await expect(f.post()).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
      expect(f.events).not.toContain("change");
      expect(f.commits).toBe(0);
    } finally {
      f.close();
    }
  },
);
it("keeps a same-operation original Create collision separate from a ChangeLifecycle receipt", async () => {
  const f = runtimeSetup();
  try {
    const history = originalHistory(f, "Create");
    f.setPrior({
      ...history.record,
      operationReference: parseCatalogReference(f.request.command.operationReference),
    });
    await expect(f.post()).rejects.toMatchObject({ code: "CATALOG_IDEMPOTENCY_CONFLICT" });
    expect(f.events).not.toContain("change");
    expect(f.events).not.toContain("original:3");
    expect(f.commits).toBe(0);
  } finally {
    f.close();
  }
});
