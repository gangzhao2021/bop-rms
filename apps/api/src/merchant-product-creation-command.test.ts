import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "@rms/catalog";
import { createMerchantProductCreationCommand as create } from "./merchant-product-creation-command.js";
import type {
  RegisteredProductCreationContent,
  createMerchantProductCreationContentFactory,
} from "./merchant-product-creation-content.js";

type StoreOptions = Parameters<typeof import("@rms/catalog").createPostgresProductCreationStore>[0];
type ServiceOptions = Parameters<typeof import("@rms/catalog").createCatalogProductService>[0];
type Context = Parameters<ReturnType<typeof createMerchantProductCreationContentFactory>>[0];
const mock = vi.hoisted(() => ({
  scope: null as unknown,
  store: null as StoreOptions | null,
  service: null as ServiceOptions | null,
  context: null as Context | null,
  content: vi.fn(),
  factory: vi.fn(),
  actions: vi.fn(),
  current: vi.fn(),
  capability: vi.fn(),
  bridgeOptions: null as unknown,
  capabilityOptions: null as unknown,
  runtimeBrandHost: null as unknown,
  runtimeBrandSources: null as unknown,
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
      remainingAuthority: vi.fn(async (tx: unknown, input: unknown) => {
        void tx;
        void input;
      }),
      categoryPolicy: vi.fn(async () => ({ allowedLifecycles: ["Draft", "Active"] })),
      withCurrentBrandContent: vi.fn(),
    };
    mock.runtimeBrandSources = sources;
    return sources;
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
vi.mock("./merchant-product-creation-content.js", () => ({
  createMerchantProductCreationContentFactory: (config: RegisteredProductCreationContent) => {
    mock.factory(config);
    return (context: Context) => {
      mock.context = context;
      return mock.content;
    };
  },
}));
vi.mock("@rms/catalog", async (original) => {
  const catalog = await original<typeof import("@rms/catalog")>();
  return {
    ...catalog,
    createPostgresProductCreationStore: (options: StoreOptions) => {
      mock.store = options;
      return {
        resolveOperation: async () => null,
        create: vi.fn(),
        codeAvailable: async () => true,
      };
    },
    createCatalogProductService: (options: ServiceOptions) => {
      mock.service = options;
      return {
        async create(command: {
          internalCode: string;
          productType: "PreparedFood";
          defaultLocale: string;
          localizedNames: Record<string, string>;
          requestedAt: string;
          editorContent?: unknown;
        }) {
          const store = mock.store;
          if (!store) throw new Error("Missing controlled Store");
          const aggregate = catalog.parseProductAggregate({
            productReference: options.references.generate("Product"),
            brandReference: id(2),
            internalCode: command.internalCode,
            productType: command.productType,
            lifecycle: "Draft",
            aggregateVersion: 1,
            createdAt: command.requestedAt,
            updatedAt: command.requestedAt,
            createdByActorReference: id(4),
            draft: {
              versionReference: options.references.generate("ProductVersion"),
              baseVersionReference: null,
              status: "Draft",
              defaultLocale: command.defaultLocale,
              localizedNames: command.localizedNames,
              taxClassificationReference: null,
              skus: [],
              optionBindings: [],
              createdAt: command.requestedAt,
              updatedAt: command.requestedAt,
              ...(command.editorContent === undefined
                ? {}
                : { editorContent: command.editorContent }),
            },
          });
          await store.transactions.run(async (tx) => {
            if (command.editorContent !== undefined) {
              await store.editorContentAuthority?.holdUntilTransactionCompletes(tx, {
                mode: "DraftWrite",
                aggregate,
                requiredFields: productEditorContentFields,
                requiredReferenceChecks: productEditorContentReferenceChecks,
              });
            }
          });
          return { status: "Applied", aggregate };
        },
      };
    },
  };
});
const id = (n: number) => "019a2421-2000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T20:30:00.000Z",
  unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
const content = {
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
function fixture(configured = true) {
  let committed = false,
    commitLost = false,
    allowed = true,
    now = at;
  const scope = {
    tenantReference: id(1),
    selectedStoreReference: id(3),
    actorReference: id(4),
    context: { brand: { brandReference: id(2) } },
    authorizeAction: vi.fn(async (action: string) => ({
      action,
      scopeKind: "Brand",
      effect: allowed ? "Allow" : "Deny",
    })),
  };
  mock.scope = scope;
  const query = vi.fn(async () => ({ rows: [] })),
    transactions = {
      async run<T>(work: (tx: { query: typeof query }) => Promise<T>): Promise<T> {
        const result = await work({ query });
        committed = true;
        if (commitLost) throw new Error("Controlled lost COMMIT response");
        return result;
      },
    },
    configuration: RegisteredProductCreationContent = {
      registryAuthority: { holdUntilTransactionCompletes: async () => undefined },
      creationAuthority: { holdUntilTransactionCompletes: async () => undefined },
      contentPolicy: {
        configurationVersionReference: id(10),
        expectedBrandVersion: 1,
        policyReference: id(11),
        policyVersion: 1,
        brandAuthority: {
          withCurrentContentRead: async (_tx, _r, work) => work(),
          isCurrent: async () => true,
        },
        policyAuthority: { holdUntilTransactionCompletes: async () => undefined },
      },
      optionAuthority: {
        holdUntilTransactionCompletes: async () => ({
          observedAt: at,
          validUntil: "2026-10-04T20:30:05.000Z",
        }),
      },
      remainingAuthority: async () => undefined,
    },
    options: Parameters<typeof create>[0] = {
      merchant: { transactions, now: () => now } as never,
      authentication: { authorize: async () => ({ sessionReference: id(5) }) } as never,
      auditReference: () => id(8),
      writeAuthority: async () => "Allowed",
      ...(configured ? { registeredEditorContent: configuration } : {}),
    },
    command = {
      internalCode: "CREATION_WIRING",
      productType: "PreparedFood",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic" },
      taxClassificationReference: null,
      skus: [],
      operationReference: id(7),
      editorContent: content,
    },
    request = {
      sessionCookie: "controlled session",
      csrf: "controlled csrf",
      command,
      expectedScope: { brandReference: id(2), storeReference: id(3) },
    };
  const execute = create(options);
  return {
    execute,
    options,
    configuration,
    request,
    scope,
    query,
    get committed() {
      return committed;
    },
    loseCommit: () => {
      commitLost = true;
    },
    deny: () => {
      allowed = false;
    },
    setNow: (at: string) => {
      now = at;
    },
  };
}
beforeEach(() => {
  mock.content.mockReset().mockResolvedValue(undefined);
  mock.factory.mockReset();
  mock.context = null;
  mock.store = null;
  mock.service = null;
  mock.actions.mockReset().mockResolvedValue(undefined);
  mock.current.mockReset().mockReturnValue(at);
  mock.capability.mockReset().mockResolvedValue(undefined);
  mock.bridgeOptions = null;
  mock.capabilityOptions = null;
});
function runtimeFixture() {
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
  return { ...f, execute: create(runtimeOptions), runtimeOptions, base: f };
}
it("current Create composes fixed admission with original actual context and Store Create capability", async () => {
  const f = runtimeFixture(),
    result = await f.execute(f.request);
  expect(result.status).toBe("Applied");
  expect(mock.bridgeOptions).toMatchObject({
    sessionCookie: f.request.sessionCookie,
    sessionReference: id(5),
    capabilityKey: "catalog.cat_product_create",
    originalValidUntil: "2026-10-04T20:30:05.000Z",
  });
  expect(mock.capabilityOptions).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    capabilityKey: "catalog.cat_product_create",
  });
  expect(mock.actions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.create",
  ]);
  expect(mock.capability).toHaveBeenCalled();
  expect(mock.context).toMatchObject({
    currentAuthorization: { authorizeActions: mock.actions, assertCurrent: mock.current },
    originalValidUntil: "2026-10-04T20:30:05.000Z",
  });
  expect(mock.context?.runtimeBrandSources).toBe(mock.runtimeBrandSources);
  expect(mock.runtimeBrandHost).toMatchObject({
    currentAuthorization: { authorizeActions: mock.actions, assertCurrent: mock.current },
    originalValidUntil: "2026-10-04T20:30:05.000Z",
    action: "Create",
    expectedAggregateVersion: null,
  });
  expect(f.base.committed).toBe(true);
});
it.each([
  "writeAuthority",
  "editorContentAuthority",
  "missingSources",
  "legacySources",
  "falseMode",
])("current Create rejects %s configuration before authentication", (kind) => {
  const f = runtimeFixture(),
    options = { ...f.runtimeOptions };
  if (kind === "writeAuthority") Object.assign(options, { writeAuthority: async () => "Allowed" });
  else if (kind === "editorContentAuthority")
    Object.assign(options, { editorContentAuthority: async () => undefined });
  else if (kind === "missingSources") Object.assign(options, { authoringSources: undefined });
  else if (kind === "legacySources")
    Object.assign(options, { registeredEditorContent: f.configuration });
  else Object.assign(options, { currentRuntime: false });
  expect(() => create(options)).toThrow(CatalogError);
});
it("current Create refuses missing complete browser content", async () => {
  const f = runtimeFixture(),
    { editorContent: _content, ...command } = f.request.command;
  void _content;
  await expect(f.execute({ ...f.request, command })).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(f.base.committed).toBe(false);
});
it.each(["finePermission", "feature", "currentBoundary"])(
  "current Create %s refusal prevents commit",
  async (kind) => {
    const f = runtimeFixture();
    const error = new CatalogError(
      kind === "finePermission" ? "CATALOG_PERMISSION_DENIED" : "CATALOG_DEPENDENCY_UNAVAILABLE",
    );
    if (kind === "finePermission") mock.actions.mockRejectedValue(error);
    else if (kind === "feature") mock.capability.mockRejectedValue(error);
    else
      mock.current.mockImplementation(() => {
        throw error;
      });
    await expect(f.execute(f.request)).rejects.toMatchObject({ code: error.code });
    expect(f.base.committed).toBe(false);
  },
);
it("authentication awaits cannot mutate the captured complete command or scope", async () => {
  const f = runtimeFixture();
  const execute = create({
    ...f.runtimeOptions,
    authentication: {
      authorize: async () => {
        Object.assign(f.request.command, { internalCode: "MUTATED" });
        Object.assign(f.request.expectedScope, { brandReference: id(99) });
        Object.assign(f.request, { sessionCookie: "replaced session" });
        return { sessionReference: id(5) };
      },
    } as never,
  });
  await execute(f.request);
  expect(mock.bridgeOptions).toMatchObject({ sessionCookie: "controlled session" });
  expect(mock.content.mock.calls[0]?.[1].aggregate.internalCode).toBe("CREATION_WIRING");
  expect(f.base.committed).toBe(true);
});
it("original request deadline includes authentication time and cannot renew", async () => {
  const f = runtimeFixture();
  const execute = create({
    ...f.runtimeOptions,
    authentication: {
      authorize: async () => {
        f.setNow("2026-10-04T20:30:05.000Z");
        return { sessionReference: id(5) };
      },
    } as never,
  });
  await expect(execute(f.request)).rejects.toMatchObject(unavailable);
  expect(mock.bridgeOptions).toBeNull();
  expect(f.base.committed).toBe(false);
});
it("a later asynchronous guard cannot outrun shortened current authorization before COMMIT", async () => {
  const f = runtimeFixture();
  mock.current.mockImplementation(() => {
    if (f.options.merchant.now() >= "2026-10-04T20:30:01.000Z")
      throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
    return at;
  });
  mock.content.mockImplementationOnce(async (tx) => {
    if (!mock.context) throw new Error("Missing original creation context");
    await mock.context.registerBeforeCommit(
      tx,
      async () => {
        f.setNow("2026-10-04T20:30:02.000Z");
      },
      () => undefined,
    );
  });
  await expect(f.execute(f.request)).rejects.toMatchObject(unavailable);
  expect(f.base.committed).toBe(false);
});
it("fine Create permission revoked after content admission prevents COMMIT", async () => {
  const f = runtimeFixture();
  mock.content.mockImplementationOnce(async () => {
    mock.actions.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  });
  await expect(f.execute(f.request)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.base.committed).toBe(false);
});
it("actual Create command composes complete content with original scope/session/operation in its borrowed transaction", async () => {
  const f = fixture(),
    result = await f.execute(f.request);
  expect(result).toMatchObject({
    status: "Applied",
    aggregateVersion: 1,
    lifecycle: "Draft",
    operationReference: id(7),
    scope: f.request.expectedScope,
  });
  expect(mock.factory).toHaveBeenCalledWith(f.configuration);
  expect(mock.context).toMatchObject({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    operationReference: id(7),
    productReference: result.productReference,
  });
  expect(mock.content).toHaveBeenCalledTimes(2);
  for (const [tx, input] of mock.content.mock.calls) {
    expect(tx).toBe(mock.context?.transaction);
    expect(input).toMatchObject({
      purposeCode: "CATALOG_PRODUCT_CREATE",
      mode: "DraftWrite",
      operationReference: id(7),
      aggregate: {
        aggregateVersion: 1,
        productReference: result.productReference,
        draft: { editorContent: content },
      },
    });
  }
  expect(f.committed).toBe(true);
});
it("unconfigured legacy entry still refuses complete content before starting a transaction", async () => {
  const f = fixture(false);
  await expect(f.execute(f.request)).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(f.committed).toBe(false);
  expect(mock.store).toBeNull();
});
it("mixed direct and registered complete authority is refused before authentication", () => {
  const f = fixture();
  expect(() => create({ ...f.options, editorContentAuthority: async () => undefined })).toThrow(
    CatalogError,
  );
});
it("unknown browser source fields cannot become creation configuration", async () => {
  const f = fixture();
  await expect(
    f.execute({
      ...f.request,
      command: { ...f.request.command, registeredEditorContent: f.configuration },
    }),
  ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
  expect(mock.content).not.toHaveBeenCalled();
  expect(f.committed).toBe(false);
});
it("scope mismatch refuses before source construction and persistence", async () => {
  const f = fixture();
  await expect(
    f.execute({ ...f.request, expectedScope: { brandReference: id(99), storeReference: id(3) } }),
  ).rejects.toThrow();
  expect(mock.context).toBeNull();
  expect(f.committed).toBe(false);
});
it("remaining complete-content denial rolls back rather than returning a Draft receipt", async () => {
  const f = fixture();
  mock.content.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.execute(f.request)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.committed).toBe(false);
});
it("current permission loss after content admission prevents outer COMMIT", async () => {
  const f = fixture();
  mock.content.mockImplementationOnce(async () => {
    f.deny();
  });
  await expect(f.execute(f.request)).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(f.committed).toBe(false);
});
it("expired original editor lease is not renewed by COMMIT checks", async () => {
  const f = fixture();
  mock.content.mockImplementationOnce(async () => {
    f.setNow("2026-10-04T20:30:05.000Z");
  });
  await expect(f.execute(f.request)).rejects.toMatchObject(unavailable);
  expect(f.committed).toBe(false);
});
it("lost COMMIT response remains unconfirmed even after the authorized command result", async () => {
  const f = fixture();
  f.loseCommit();
  await expect(f.execute(f.request)).rejects.toMatchObject(unavailable);
  expect(f.committed).toBe(true);
});
it("legacy direct configured complete holder still follows its original path", async () => {
  const f = fixture(false),
    held = vi.fn(async () => undefined);
  const execute = create({ ...f.options, editorContentAuthority: held });
  const result = await execute(f.request);
  expect(result.lifecycle).toBe("Draft");
  expect(held).toHaveBeenCalledTimes(2);
  expect(mock.context).toBeNull();
  expect(f.committed).toBe(true);
});

const explicitBaseProposal = () => ({
  skuCode: "BASE",
  localizedNames: { "en-CA": "Synthetic base" },
  variantSelections: [],
  unitOfSale: "SYNTHETIC",
  unitQuantity: "1",
});
it("admits the complete base SKU wire proposal without client allocated references", async () => {
  // Controlled service composition only; actual owning persistence/unit source is native coverage.
  const f = fixture(),
    request = { ...f.request, command: { ...f.request.command, skus: [explicitBaseProposal()] } };
  await expect(f.execute(request)).resolves.toMatchObject({ status: "Applied" });
  expect(mock.content).toHaveBeenCalled();
});
it.each(["multiple", "variant"])(
  "refuses %s complete initial SKU before authority",
  async (kind) => {
    const f = runtimeFixture(),
      sku = explicitBaseProposal(),
      skus =
        kind === "multiple"
          ? [sku, { ...sku, skuCode: "SECOND" }]
          : [
              {
                ...sku,
                variantSelections: [{ dimensionReference: id(70), valueReference: id(71) }],
              },
            ];
    await expect(
      f.execute({ ...f.request, command: { ...f.request.command, skus } }),
    ).rejects.toMatchObject({ code: "CATALOG_INPUT_INVALID" });
    expect(mock.actions).not.toHaveBeenCalled();
  },
);
it("requires current fine SKU create permission for complete base SKU", async () => {
  const f = runtimeFixture();
  mock.actions.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(
    f.execute({ ...f.request, command: { ...f.request.command, skus: [explicitBaseProposal()] } }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  expect(mock.actions).toHaveBeenCalledWith([
    "catalog.manage",
    "catalog.product.manage",
    "catalog.product.create",
    "catalog.sku.create",
  ]);
  expect(f.base.committed).toBe(false);
});
