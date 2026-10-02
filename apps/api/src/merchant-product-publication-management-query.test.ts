import { BrowserSessionError } from "@bop/identity";
import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  productEditorSnapshotFields,
  productPublicationSourceFields,
  buildCatalogProductEditorSnapshot,
  buildProductPublicationSourceSnapshot,
} from "@rms/catalog";
import { createMerchantProductPublicationManagementQuery } from "./merchant-product-publication-management-query.js";
const state = vi.hoisted(() => ({
  brand: vi.fn(),
  factory: vi.fn(),
  publications: vi.fn(),
  completed: false,
  mode: "normal",
  changed: {},
}));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => state.brand }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductEditorSourceStore: (...args: unknown[]) => state.factory(...args),
  createPostgresProductPublicationSourceStore: (...args: unknown[]) => state.publications(...args),
}));
const id = (n: number) => "01902438-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-30T20:00:00.000Z",
  until = "2026-09-30T20:00:05.000Z";
type Options = Parameters<typeof createMerchantProductPublicationManagementQuery>[0];
type Source = Parameters<typeof import("@rms/catalog").createPostgresProductEditorSourceStore>[0];
function aggregate() {
  return {
    productReference: id(5),
    brandReference: id(2),
    internalCode: "EDITOR",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 7,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(6),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic editor" },
      taxClassificationReference: null,
      skus: [],
      optionBindings: [],
      createdAt: at,
      updatedAt: at,
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: { "en-CA": "Synthetic complete description" },
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [],
        optionRules: [],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  };
}

function setup() {
  let now = at;
  const events: string[] = [],
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
    },
    view = buildCatalogProductEditorSnapshot(
      aggregate(),
      { tenantReference: id(1), brandReference: id(2) },
      { productReference: id(5), expectedAggregateVersion: 7 },
      at,
    );
  state.brand.mockResolvedValue(scope);
  const screen = vi.fn<Options["holdScreenUntilCommit"]>(async () => {
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
          };
        await source.authority.holdUntilTransactionCompletes(tx, h);
        if (state.mode === "none") return view;
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
  const publicationHold = vi.fn(async () => {
    events.push(state.completed ? "final-publication" : "publication");
  });
  state.publications.mockImplementation(
    (
      source: Parameters<
        typeof import("@rms/catalog").createPostgresProductPublicationSourceStore
      >[0],
    ) => ({
      async withCurrentSnapshot(query: unknown, work: (value: unknown) => Promise<unknown>) {
        return source.transactions.run(async (tx) => {
          const held = {
            tenantReference: id(1),
            brandReference: id(2),
            actorReference: id(4),
            productReference: id(5),
            purposeCode: "CATALOG_PRODUCT_PUBLICATION_SOURCE" as const,
            permission: "catalog.manage" as const,
            owningAction: "catalog.product.history.read" as const,
            requiredFields: productPublicationSourceFields,
            observedAt: at,
          };
          await source.authority.holdUntilTransactionCompletes(tx, held);
          const value = buildProductPublicationSourceSnapshot(
            { aggregateVersion: 7, observedAt: at, revisions: [] },
            { tenantReference: id(1), brandReference: id(2) },
            query as Parameters<typeof buildProductPublicationSourceSnapshot>[2],
            at,
          );
          await source.authority.holdUntilTransactionCompletes(tx, held);
          if (state.mode === "history-none") return value;
          const result = await work(value);
          if (state.mode === "history-twice") await work(value);
          await source.authority.holdUntilTransactionCompletes(tx, held);
          return state.mode === "history-rebound" ? { ...(result as object) } : result;
        });
      },
    }),
  );
  const options: Options = {
    merchant: {
      now: () => now,
      transactions: {
        async run(work) {
          events.push("begin");
          const result = await work({
            async query() {
              return { rows: [] };
            },
          });
          events.push("commit");
          return result;
        },
      },
    } as Options["merchant"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
    contentAuthority: { holdUntilTransactionCompletes: history },
    historyAuthority: { holdUntilTransactionCompletes: publicationHold },
    holdScreenUntilCommit: screen,
  };
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
    publicationHold,
    scope,
    action,
    authenticate,
    events,
    setNow: (v: string) => {
      now = v;
    },
  };
}
beforeEach(() => {
  state.brand.mockReset();
  state.factory.mockReset();
  state.publications.mockReset();
  state.completed = false;
  state.mode = "normal";
  state.changed = {};
});
it("composes owning full editor source with independent scope, screen and content holds before outer COMMIT", async () => {
  const f = setup(),
    result = await createMerchantProductPublicationManagementQuery(f.options)(f.request);
  expect(result).toMatchObject({
    profile: "CatalogProductPublicationManagementV1",
    storeReference: id(3),
    versions: [],
    draft: { versionReference: id(6), contentDigest: f.view.contentDigest },
    eligibility: "NotEvaluated",
    publishValidation: "Incomplete",
  });
  expect(f.events.slice(-4)).toEqual([
    "final-screen",
    "final-history",
    "final-publication",
    "commit",
  ]);
  expect(f.publicationHold).toHaveBeenCalledTimes(4);
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
    purposeCode: "CATALOG_PRODUCT_PUBLICATION_MANAGEMENT",
    historyFields: productPublicationSourceFields,
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
    createMerchantProductPublicationManagementQuery(f.options)({ ...f.request, query }),
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
    createMerchantProductPublicationManagementQuery(f.options)({ ...f.request, query }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(getter).not.toHaveBeenCalled();
});
it.each(["brandReference", "storeReference"])(
  "rejects changed selected %s before owning reads",
  async (key) => {
    const f = setup();
    await expect(
      createMerchantProductPublicationManagementQuery(f.options)({
        ...f.request,
        expectedScope: { ...f.request.expectedScope, [key]: id(99) },
      }),
    ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
    expect(state.factory).not.toHaveBeenCalled();
    expect(f.screen).not.toHaveBeenCalled();
  },
);
it.each([
  "catalog.manage",
  "catalog.product.manage",
  "catalog.product.read",
  "catalog.sku.read",
  "catalog.product.history.read",
])("requires independent current Brand %s and refuses late withdrawal", async (required) => {
  for (const late of [false, true]) {
    const f = setup();
    f.action.mockImplementation(async (action) => ({
      effect: action === required && (!late || state.completed) ? "Deny" : "Allow",
      scopeKind: "Brand",
      action,
    }));
    await expect(
      createMerchantProductPublicationManagementQuery(f.options)(f.request),
    ).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.events).not.toContain("commit");
    state.completed = false;
  }
});
it.each(["Store", "wrong-action"])(
  "does not substitute allowed %s action evidence",
  async (kind) => {
    const f = setup();
    f.action.mockImplementation(async (action) => ({
      effect: "Allow",
      scopeKind: kind === "Store" ? "Store" : "Brand",
      action: kind === "wrong-action" ? "catalog.product.update" : action,
    }));
    await expect(
      createMerchantProductPublicationManagementQuery(f.options)(f.request),
    ).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it.each(["contentAuthority", "historyAuthority", "holdScreenUntilCommit"] as const)(
  "requires configured %s without synthetic fallback",
  (key) => {
    const f = setup();
    expect(() =>
      createMerchantProductPublicationManagementQuery({
        ...f.options,
        [key]: undefined,
      } as unknown as Options),
    ).toThrow(CatalogError);
  },
);
it.each(["screen", "history", "publicationHold"] as const)(
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
      await expect(
        createMerchantProductPublicationManagementQuery(f.options)(f.request),
      ).rejects.toMatchObject({
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
  await expect(
    createMerchantProductPublicationManagementQuery(f.options)(f.request),
  ).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(state.factory).not.toHaveBeenCalled();
});
it.each([
  "none",
  "twice",
  "wrong-tx",
  "rebound",
  "history-none",
  "history-twice",
  "history-rebound",
])("requires one exact owning callback/result %s", async (mode) => {
  const f = setup();
  state.mode = mode;
  await expect(
    createMerchantProductPublicationManagementQuery(f.options)(f.request),
  ).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).not.toContain("commit");
});
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
  await expect(
    createMerchantProductPublicationManagementQuery(f.options)(f.request),
  ).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).not.toContain("commit");
});
it.each(["2026-09-30T19:59:59.999Z", until])(
  "uses exclusive original deadline and refuses backwards clock %s",
  async (value) => {
    const f = setup();
    f.setNow(value);
    await expect(
      createMerchantProductPublicationManagementQuery(f.options)(f.request),
    ).rejects.toMatchObject({
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
    await expect(
      createMerchantProductPublicationManagementQuery(f.options)(f.request),
    ).rejects.toMatchObject({
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
  await expect(
    createMerchantProductPublicationManagementQuery(f.options)(f.request),
  ).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toContain("commit"); // Read only; no write rollback is claimed after COMMIT.
});
it("captures original configured adapters and does not require create/update/publish grants", async () => {
  const f = setup(),
    load = createMerchantProductPublicationManagementQuery(f.options);
  Object.assign(f.options, {
    contentAuthority: {},
    historyAuthority: {},
    holdScreenUntilCommit: undefined,
    authentication: {},
  });
  Object.assign(f.options.merchant, { now: () => until });
  Object.assign(f.options.merchant.transactions, {
    run: vi.fn(() => {
      throw Error("replaced");
    }),
  });
  expect(await load(f.request)).toMatchObject({
    profile: "CatalogProductPublicationManagementV1",
    draft: { versionReference: id(6) },
  });
  expect(f.action.mock.calls.some(([action]) => /\.(?:create|update|publish)$/u.test(action))).toBe(
    false,
  );
});

it("captures original collaborator methods and clock instead of replacement ports", async () => {
  const f = setup(),
    read = createMerchantProductPublicationManagementQuery(f.options);
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
  expect(await read(f.request)).toMatchObject({
    profile: "CatalogProductPublicationManagementV1",
    draft: { versionReference: id(6) },
  });
  expect(f.authenticate).toHaveBeenCalledOnce();
  expect(f.history).toHaveBeenCalledTimes(3);
});

it("maps only actual owning session denial to permission refusal", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new BrowserSessionError("BROWSER_SESSION_DENIED"));
  await expect(
    createMerchantProductPublicationManagementQuery(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(state.factory).not.toHaveBeenCalled();
  expect(state.publications).not.toHaveBeenCalled();
});
it("does not treat arbitrary collaborator error text or DTO codes as owning denial", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue({ code: "BROWSER_SESSION_DENIED" });
  await expect(
    createMerchantProductPublicationManagementQuery(f.options)(f.request),
  ).rejects.toMatchObject({ code: "CATALOG_DEPENDENCY_UNAVAILABLE" });
});
