import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogHash,
  parseCatalogReference,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "@rms/catalog";
import { createMerchantProductDraftCommand as create } from "./merchant-product-draft-command.js";
type StoreOptions = Parameters<typeof import("@rms/catalog").createPostgresProductDraftStore>[0];
type ServiceOptions = Parameters<typeof import("@rms/catalog").createCatalogProductService>[0];
type MediaOptions = Parameters<
  typeof import("./merchant-product-editor-media-safety-authority.js").createMerchantProductEditorMediaSafetyAuthority
>[0];
// Composition fixtures only; actual owner SQL/source guards have independent evidence.
const mock = vi.hoisted(() => ({
  scope: null as unknown,
  store: null as StoreOptions | null,
  media: null as MediaOptions | null,
  runtimeMediaHost: null as unknown,
  runtimeBrandHost: null as unknown,
  runtimeBrandSources: null as unknown,
  runtimeRemaining: vi.fn(async (tx: unknown, input: unknown) => {
    void tx;
    void input;
  }),
  storedRead: vi.fn(async (_tx: unknown, _record: unknown) => {
    void _tx;
    void _record;
  }),
  ownerRead: null as
    null | ((tx: Parameters<StoreOptions["authorize"]>[0], store: StoreOptions) => Promise<void>),
  policySourcePorts: null as unknown,
  historySourcePort: null as unknown,
  optionSourcePort: null as unknown,
  registeredOptions: null as unknown,
  variantOptions: null as unknown,
  pinnedOptions: null as unknown,
  stages: [] as string[],
  inputs: [] as unknown[],
  baseline: null as unknown,
  borrowed: null as unknown,
  actions: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  bridgeOptions: null as unknown,
  capabilityOptions: null as unknown,
  compose(
    stage: string,
    options: { remainingAuthority(tx: unknown, input: unknown): Promise<void> },
  ) {
    return async (tx: unknown, input: unknown) => {
      this.stages.push(stage);
      await options.remainingAuthority(tx, input);
    };
  },
}));
vi.mock("./merchant-product-editor-runtime-brand-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-product-editor-runtime-brand-sources.js")>()),
  createMerchantProductEditorRuntimeBrandSources: (host: unknown) => {
    mock.runtimeBrandHost = host;
    const sources = {
      registryAuthority: { holdUntilTransactionCompletes: vi.fn() },
      brandAuthority: { withCurrentContentRead: vi.fn(), isCurrent: vi.fn() },
      policyAuthority: { holdUntilTransactionCompletes: vi.fn() },
      creationAuthority: { holdUntilTransactionCompletes: vi.fn() },
      historyAuthority: { holdUntilTransactionCompletes: vi.fn() },
      optionAuthority: { holdUntilTransactionCompletes: vi.fn() },
      remainingAuthority: mock.runtimeRemaining,
      admitStoredOperationRead: mock.storedRead,
      categoryPolicy: vi.fn(async () => ({ allowedLifecycles: ["Draft", "Active"] })),
      withCurrentBrandContent: vi.fn(),
    };
    mock.runtimeBrandSources = sources;
    return sources;
  },
}));
vi.mock("./merchant-product-editor-runtime-media-safety.js", () => ({
  createMerchantProductEditorRuntimeMediaSafetyAuthority: (
    host: unknown,
    options: Parameters<typeof mock.compose>[1],
  ) => {
    mock.runtimeMediaHost = host;
    return mock.compose("media-safety", options);
  },
}));
vi.mock("./merchant-product-current-authorization.js", () => ({
  createMerchantProductCurrentAuthorization: (options: unknown) => {
    mock.bridgeOptions = options;
    return { authorizeActions: mock.actions, assertCurrent: mock.current };
  },
}));
vi.mock("./merchant-product-store-capability.js", () => ({
  createMerchantProductStoreCapabilityGuard: (options: unknown) => {
    mock.capabilityOptions = options;
    return { holdUntilCommit: mock.capability };
  },
}));
vi.mock("./merchant-brand-scope.js", () => ({
  createMerchantBrandScope: () => async () => mock.scope,
}));
vi.mock("./merchant-product-content-registry-authority.js", () => ({
  createMerchantProductContentRegistryAuthority: () => ({
    holdUntilTransactionCompletes: async () => undefined,
  }),
}));
vi.mock("./merchant-product-variant-history-authority.js", () => ({
  createMerchantProductVariantHistoryAuthority: (options: { authority: unknown }) => {
    mock.historySourcePort = options.authority;
    return { authority: options.authority, assertCurrent: async () => undefined };
  },
}));
vi.mock("./merchant-product-frozen-option-authority.js", () => ({
  createMerchantProductFrozenOptionAuthority: (options: { authority: unknown }) => {
    mock.optionSourcePort = options.authority;
    return { authority: options.authority, assertCurrent: async () => undefined };
  },
}));
vi.mock("./merchant-product-editor-registered-content-authority.js", () => ({
  createMerchantProductEditorRegisteredContentAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => {
    mock.registeredOptions = options;
    return mock.compose("registry", options);
  },
}));
vi.mock("./merchant-product-editor-variant-content-authority.js", () => ({
  createMerchantProductEditorVariantContentAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => {
    mock.variantOptions = options;
    return mock.compose("history", options);
  },
}));
vi.mock("./merchant-product-editor-policy-content-authority.js", () => ({
  createMerchantProductEditorPolicyContentAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => {
    mock.policySourcePorts = options;
    return mock.compose("policy", options);
  },
}));
vi.mock("./merchant-product-editor-pinned-option-authority.js", () => ({
  createMerchantProductEditorPinnedOptionAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => {
    mock.pinnedOptions = options;
    return mock.compose("pinned", options);
  },
}));
vi.mock("./merchant-product-editor-media-safety-authority.js", () => ({
  createMerchantProductEditorMediaSafetyAuthority: (options: MediaOptions) => {
    mock.media = options;
    return mock.compose("media-safety", options as never);
  },
}));
vi.mock("@rms/catalog", async (original) => {
  const catalog = await original<typeof import("@rms/catalog")>();
  return {
    ...catalog,
    createPostgresFrozenFullOptionSetContentStore: () => ({}),
    createPostgresProductCreationStore: () => ({ codeAvailable: async () => true }),
    createPostgresProductDraftStore: (options: StoreOptions) => {
      mock.store = options;
      return {
        resolveOperation: async () => null,
        load: async () => mock.baseline,
        loadAggregateVersion: async () => mock.baseline,
        transactions: options.transactions,
      };
    },
    createCatalogProductService: (options: ServiceOptions) => {
      void options;
      return {
        async replaceDraft(command: { draft: unknown }) {
          const baseline = catalog.parseProductAggregate(mock.baseline),
            aggregate = catalog.parseProductAggregate({
              ...baseline,
              aggregateVersion: 2,
              draft: command.draft,
            });
          if (!mock.store) throw new Error("Missing controlled Store");
          await mock.store.transactions.run(async (tx) => {
            mock.borrowed = tx;
            if (mock.ownerRead && mock.store) await mock.ownerRead(tx, mock.store);
            for (const [mode, value] of [
              ["Read", baseline],
              ["DraftWrite", aggregate],
            ] as const) {
              await mock.store?.editorContentAuthority?.holdUntilTransactionCompletes(tx, {
                mode,
                aggregate: value,
                requiredFields: productEditorContentFields,
                requiredReferenceChecks: mode === "Read" ? [] : productEditorContentReferenceChecks,
              });
            }
          });
          return { status: "Applied", aggregate };
        },
      };
    },
  };
});
const id = (n: number) => "019a2421-3000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T21:00:00.000Z",
  until = "2026-10-04T21:00:05.000Z";
const editorContent = {
  profile: "CatalogProductEditorContentV1",
  localizedShortDescriptions: {},
  localizedDescriptions: {},
  preparationNotes: {},
  media: [],
  tagReferences: [],
  attributeValues: [],
  variantDimensions: [],
  variantCombinations: [],
  optionRules: [],
  allergenReferences: [],
  nutritionProfile: null,
};
function fixture() {
  let committed = false,
    clock = at;
  const tx = { query: vi.fn(async () => ({ rows: [] })) },
    baseline = parseProductAggregate({
      productReference: id(6),
      brandReference: id(2),
      internalCode: "DRAFT_COMPOSITION",
      productType: "PreparedFood",
      lifecycle: "Draft",
      aggregateVersion: 1,
      createdAt: at,
      updatedAt: at,
      createdByActorReference: id(4),
      draft: {
        versionReference: id(8),
        baseVersionReference: null,
        status: "Draft",
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Synthetic" },
        taxClassificationReference: null,
        skus: [],
        optionBindings: [],
        createdAt: at,
        updatedAt: at,
        editorContent,
      },
    }),
    scope = {
      tenantReference: id(1),
      selectedStoreReference: id(3),
      actorReference: id(4),
      context: { brand: { brandReference: id(2) } },
      authorizeAction: async (action: string) => ({ action, scopeKind: "Brand", effect: "Allow" }),
    },
    hold = { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    mediaSafety = {
      allergenRegistryVersionReference: id(11),
      mediaAuthority: {
        holdUntilTransactionCompletes: vi.fn(async () => ({ observedAt: at, validUntil: until })),
      },
      safetyAuthority: hold,
      remainingAuthority: vi.fn(async (_tx: unknown, input: unknown) => {
        mock.inputs.push(input);
      }),
    },
    options: Parameters<typeof create>[0] = {
      merchant: {
        now: () => clock,
        transactions: {
          async run<T>(work: (borrowed: typeof tx) => Promise<T>) {
            const result = await work(tx);
            committed = true;
            return result;
          },
        },
      } as never,
      authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
      auditReference: () => id(9),
      writeAuthority: async () => "Allowed",
      registeredEditorContent: {
        registryAuthority: hold,
        variantHistory: {
          authority: hold,
          contentPolicy: {
            configurationVersionReference: id(12),
            expectedBrandVersion: 1,
            policyReference: id(13),
            policyVersion: 1,
            brandAuthority: {
              withCurrentContentRead: async (_tx, _r, work) => work(),
              isCurrent: async () => true,
            },
            policyAuthority: hold,
            pinnedOptions: {
              optionAuthority: {
                holdUntilTransactionCompletes: async () => ({ observedAt: at, validUntil: until }),
              },
              mediaSafety,
            },
          },
        },
      },
    },
    request = {
      sessionCookie: "controlled draft session",
      csrf: "controlled draft csrf",
      expectedScope: { brandReference: id(2), storeReference: id(3) },
      command: {
        productReference: id(6),
        operationReference: id(7),
        expectedAggregateVersion: 1,
        draft: baseline.draft,
      },
    };
  mock.scope = scope;
  mock.baseline = baseline;
  return {
    options,
    mediaSafety,
    request,
    execute: create(options),
    tx,
    get committed() {
      return committed;
    },
    setClock: (value: string) => {
      clock = value;
    },
  };
}
beforeEach(() => {
  mock.scope = null;
  mock.store = null;
  mock.media = null;
  mock.runtimeMediaHost = null;
  mock.runtimeBrandHost = null;
  mock.runtimeBrandSources = null;
  mock.runtimeRemaining.mockReset();
  mock.runtimeRemaining.mockResolvedValue(undefined);
  mock.storedRead.mockReset().mockResolvedValue(undefined);
  mock.ownerRead = null;
  mock.policySourcePorts = null;
  mock.historySourcePort = null;
  mock.optionSourcePort = null;
  mock.registeredOptions = null;
  mock.variantOptions = null;
  mock.pinnedOptions = null;
  mock.stages.length = 0;
  mock.inputs.length = 0;
  mock.borrowed = null;
  mock.actions.mockReset().mockResolvedValue(undefined);
  mock.current.mockReset().mockReturnValue(at);
  mock.capability.mockReset().mockResolvedValue(undefined);
  mock.bridgeOptions = null;
  mock.capabilityOptions = null;
});
it("Draft connects original borrowed transaction and replacement intent to all configured source stages", async () => {
  const f = fixture(),
    result = await f.execute(f.request);
  expect(result.aggregateVersion).toBe(2);
  expect(f.committed).toBe(true);
  expect(mock.historySourcePort).not.toBeNull();
  expect(mock.optionSourcePort).not.toBeNull();
  expect(mock.stages.slice(0, 5)).toEqual([
    "registry",
    "history",
    "policy",
    "pinned",
    "media-safety",
  ]);
  expect(mock.media).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    actorReference: id(4),
    allergenRegistryVersionReference: id(11),
  });
  expect(mock.inputs).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        mode: "Read",
        purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE",
        operationReference: id(7),
        sessionReference: id(5),
      }),
      expect.objectContaining({
        mode: "DraftWrite",
        aggregate: expect.objectContaining({ aggregateVersion: 2 }),
      }),
    ]),
  );
  for (const [tx] of f.mediaSafety.remainingAuthority.mock.calls) expect(tx).toBe(mock.borrowed);
});
it("Draft captures fixed Media/Safety selection and ports before later configuration mutation", async () => {
  const f = fixture(),
    replacement = vi.fn(async () => undefined);
  Object.assign(f.mediaSafety, {
    allergenRegistryVersionReference: id(99),
    remainingAuthority: replacement,
  });
  Object.assign(f.mediaSafety.mediaAuthority, { holdUntilTransactionCompletes: replacement });
  Object.assign(f.mediaSafety.safetyAuthority, { holdUntilTransactionCompletes: replacement });
  await f.execute(f.request);
  expect(mock.media?.allergenRegistryVersionReference).toBe(id(11));
  await mock.media?.mediaAuthority.holdUntilTransactionCompletes({} as never, {} as never);
  await mock.media?.safetyAuthority.holdUntilTransactionCompletes({} as never, {} as never);
  expect(replacement).not.toHaveBeenCalled();
});
it("Draft remaining reference denial rolls back before receipt", async () => {
  const f = fixture();
  f.mediaSafety.remainingAuthority.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.execute(f.request)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.committed).toBe(false);
});
it("Draft original complete-content deadline cannot be renewed during source work", async () => {
  const f = fixture();
  f.mediaSafety.remainingAuthority.mockImplementationOnce(async () => {
    f.setClock(until);
  });
  await expect(f.execute(f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.committed).toBe(false);
});
function currentFixture() {
  const f = fixture(),
    { writeAuthority: _legacy, ...options } = f.options;
  void _legacy;
  const {
    registeredEditorContent: _registered,
    categoryPolicy: _category,
    editorContentAuthority: _content,
    ...baseOptions
  } = options;
  void _registered;
  void _category;
  void _content;
  const runtimeOptions = {
    ...baseOptions,
    currentRuntime: true as const,
    authoringSources: {
      configurationVersionReference: id(12),
      expectedBrandVersion: 1,
      policyReference: id(13),
      policyVersion: 1,
      allergenRegistryVersionReference: null,
    },
  };
  return { f, options: runtimeOptions, execute: create(runtimeOptions) };
}
function controlledReceipt(
  root: number,
  action: "Create" | "ReplaceDraft" = "ReplaceDraft",
  operation = id(7),
) {
  const baseline = parseProductAggregate(mock.baseline);
  return {
    action,
    operationReference: parseCatalogReference(operation),
    operationIntentHash: parseCatalogHash("a".repeat(64)),
    aggregate: parseProductAggregate({ ...baseline, aggregateVersion: root }),
  };
}
it("current Draft consumes only owning stored current successor and permits historical Create base reads", async () => {
  const c = currentFixture();
  mock.ownerRead = async (tx, store) => {
    const historical = controlledReceipt(1, "Create", id(20)),
      original = controlledReceipt(2);
    expect(
      await store.authorize(tx, {
        productReference: id(6),
        record: historical,
        recordOrigin: "StoredOperation",
      }),
    ).toBe(true);
    expect(mock.storedRead).not.toHaveBeenCalled();
    expect(await store.authorize(tx, { productReference: id(6), record: original })).toBe(true);
    expect(mock.storedRead).not.toHaveBeenCalled();
    expect(
      await store.authorize(tx, {
        productReference: id(6),
        record: original,
        recordOrigin: "StoredOperation",
      }),
    ).toBe(true);
    expect(mock.storedRead).toHaveBeenCalledExactlyOnceWith(tx, original);
  };
  await c.execute(c.f.request);
  expect(c.f.committed).toBe(true);
});
it.each(["action", "root"])(
  "known original %s mismatch retains IdempotencyConflict without Read admission",
  async (kind) => {
    const c = currentFixture();
    mock.ownerRead = async (tx, store) => {
      await store.authorize(tx, {
        productReference: id(6),
        record: controlledReceipt(
          kind === "root" ? 3 : 2,
          kind === "action" ? "Create" : "ReplaceDraft",
        ),
        recordOrigin: "StoredOperation",
      });
    };
    await expect(c.execute(c.f.request)).rejects.toMatchObject({
      code: "CATALOG_IDEMPOTENCY_CONFLICT",
    });
    expect(mock.storedRead).not.toHaveBeenCalled();
    expect(c.f.committed).toBe(false);
  },
);
it("does not admit foreign operation successors, Products, prospective Create or lost current permission", async () => {
  const c = currentFixture();
  mock.ownerRead = async (tx, store) => {
    const original = controlledReceipt(2),
      foreign = {
        ...original,
        aggregate: parseProductAggregate({ ...original.aggregate, productReference: id(22) }),
      };
    expect(
      await store.authorize(tx, {
        productReference: id(6),
        record: controlledReceipt(2, "ReplaceDraft", id(20)),
        recordOrigin: "StoredOperation",
      }),
    ).toBe(false);
    expect(
      await store.authorize(tx, {
        productReference: id(6),
        record: foreign,
        recordOrigin: "StoredOperation",
      }),
    ).toBe(false);
    expect(
      await store.authorize(tx, {
        productReference: id(6),
        record: controlledReceipt(2, "Create"),
      }),
    ).toBe(false);
    expect(mock.storedRead).not.toHaveBeenCalled();
    mock.actions.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
    await store.authorize(tx, {
      productReference: id(6),
      record: original,
      recordOrigin: "StoredOperation",
    });
  };
  await expect(c.execute(c.f.request)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(c.f.committed).toBe(false);
});
it("current Draft connects Edit capability and once-bound actual SKU delta to authoring admission", async () => {
  const c = currentFixture();
  await c.execute(c.f.request);
  expect(mock.actions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.update",
  ]);
  expect(mock.capability).toHaveBeenCalled();
  expect(mock.bridgeOptions).toMatchObject({
    sessionCookie: c.f.request.sessionCookie,
    sessionReference: id(5),
    capabilityKey: "catalog.cat_product_edit",
    originalValidUntil: until,
  });
  expect(mock.capabilityOptions).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    capabilityKey: "catalog.cat_product_edit",
  });
  expect(mock.runtimeMediaHost).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    action: "ReplaceDraft",
    productReference: c.f.request.command.productReference,
    operationReference: c.f.request.command.operationReference,
    expectedAggregateVersion: c.f.request.command.expectedAggregateVersion,
    originalValidUntil: until,
    currentAuthorization: { authorizeActions: mock.actions, assertCurrent: mock.current },
  });
  expect(mock.media).toBeNull(); // Static authority composition must not supply runtime proof.
  expect(mock.runtimeBrandHost).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    sessionReference: id(5),
    action: "ReplaceDraft",
    expectedAggregateVersion: 1,
    currentAuthorization: { authorizeActions: mock.actions, assertCurrent: mock.current },
    originalValidUntil: until,
  });
  const sourcePorts = mock.runtimeBrandSources as {
    brandAuthority: unknown;
    policyAuthority: unknown;
    registryAuthority: unknown;
    historyAuthority: unknown;
    optionAuthority: unknown;
  };
  expect(mock.policySourcePorts).toMatchObject({
    brandAuthority: sourcePorts.brandAuthority,
    policyAuthority: sourcePorts.policyAuthority,
    runtimeBrandSources: sourcePorts,
  });
  expect(mock.historySourcePort).toBeNull();
  expect(mock.optionSourcePort).toBeNull();
  expect(mock.registeredOptions).toMatchObject({
    registryAuthority: sourcePorts.registryAuthority,
  });
  expect(mock.variantOptions).toMatchObject({ variantAuthority: sourcePorts.historyAuthority });
  expect(mock.pinnedOptions).toMatchObject({ optionAuthority: sourcePorts.optionAuthority });
  expect(mock.runtimeRemaining).toHaveBeenCalled();
  expect(c.f.mediaSafety.remainingAuthority).not.toHaveBeenCalled();
  expect(c.f.committed).toBe(true);
});
it.each(["writeAuthority", "editorContentAuthority", "noSources", "falseMode"])(
  "current Draft rejects %s override before authentication",
  (kind) => {
    const c = currentFixture(),
      options = { ...c.options };
    if (kind === "writeAuthority")
      Object.assign(options, { writeAuthority: async () => "Allowed" });
    else if (kind === "editorContentAuthority")
      Object.assign(options, { editorContentAuthority: async () => undefined });
    else if (kind === "noSources") Object.assign(options, { authoringSources: undefined });
    else Object.assign(options, { currentRuntime: false });
    expect(() => create(options)).toThrow(CatalogError);
  },
);
it("current Draft request remains captured while authentication awaits", async () => {
  const c = currentFixture();
  const execute = create({
    ...c.options,
    authentication: {
      authorize: async () => {
        Object.assign(c.f.request.command, { expectedAggregateVersion: 99 });
        Object.assign(c.f.request.expectedScope, { brandReference: id(99) });
        Object.assign(c.f.request, { sessionCookie: "mutated session" });
        return { sessionReference: id(5) };
      },
    } as never,
  });
  await execute(c.f.request);
  expect(mock.bridgeOptions).toMatchObject({ sessionCookie: "controlled draft session" });
  expect(c.f.committed).toBe(true);
});
it("current Draft deadline includes authentication time", async () => {
  const c = currentFixture();
  const execute = create({
    ...c.options,
    authentication: {
      authorize: async () => {
        c.f.setClock(until);
        return { sessionReference: id(5) };
      },
    } as never,
  });
  await expect(execute(c.f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(mock.bridgeOptions).toBeNull();
  expect(c.f.committed).toBe(false);
});
it("fine update permission loss during source validation prevents Draft COMMIT", async () => {
  const c = currentFixture();
  mock.runtimeRemaining.mockImplementationOnce(async () => {
    mock.actions.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  });
  await expect(c.execute(c.f.request)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(c.f.committed).toBe(false);
});
it("a later Draft guard cannot overrun a shorter current permission boundary", async () => {
  const c = currentFixture();
  mock.current.mockImplementation(() => {
    if (c.f.options.merchant.now() >= "2026-10-04T21:00:01.000Z")
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    return at;
  });
  mock.runtimeRemaining.mockImplementationOnce(async (tx) => {
    const host = mock.runtimeMediaHost as Parameters<
      typeof import("./merchant-product-editor-runtime-media-safety.js").createMerchantProductEditorRuntimeMediaSafetyAuthority
    >[0];
    if (!host) throw new Error("Missing original Media/Safety context");
    await host.registerBeforeCommit(
      tx as never,
      async () => {
        c.f.setClock("2026-10-04T21:00:02.000Z");
      },
      () => undefined,
    );
  });
  await expect(c.execute(c.f.request)).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(c.f.committed).toBe(false);
});
