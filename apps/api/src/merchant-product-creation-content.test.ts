import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  parseCatalogInstant,
  parseProductAggregate,
  productEditorContentFields,
  productEditorContentReferenceChecks,
} from "@rms/catalog";
import {
  createMerchantProductCreationContentFactory as create,
  type RegisteredProductCreationContent,
} from "./merchant-product-creation-content.js";
// Composition-only ports. Owning SQL, current policy and absence are covered by their owner suites.
const mock = vi.hoisted(() => ({
  order: [] as string[],
  configs: new Map<string, unknown>(),
  compose(
    stage: string,
    options: { remainingAuthority(tx: unknown, input: unknown): Promise<void> },
  ) {
    this.configs.set(stage, options);
    return async (tx: unknown, input: unknown) => {
      this.order.push(stage);
      await options.remainingAuthority(tx, input);
    };
  },
}));
vi.mock("./merchant-product-editor-registered-content-authority.js", () => ({
  createMerchantProductEditorRegisteredContentAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => mock.compose("registry", options),
}));
vi.mock("./merchant-product-editor-variant-content-authority.js", () => ({
  createMerchantProductEditorVariantContentAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => mock.compose("absence", options),
}));
vi.mock("./merchant-product-editor-policy-content-authority.js", () => ({
  createMerchantProductEditorPolicyContentAuthority: (
    options: Parameters<typeof mock.compose>[1],
  ) => mock.compose("policy", options),
}));
vi.mock("./merchant-product-editor-pinned-option-authority.js", () => ({
  createMerchantProductEditorPinnedOptionAuthority: (options: Parameters<typeof mock.compose>[1]) =>
    mock.compose("pinned", options),
}));
vi.mock("./merchant-product-editor-media-safety-authority.js", () => ({
  createMerchantProductEditorMediaSafetyAuthority: (options: Parameters<typeof mock.compose>[1]) =>
    mock.compose("media-safety", options),
}));
vi.mock("./merchant-product-editor-runtime-media-safety.js", () => ({
  createMerchantProductEditorRuntimeMediaSafetyAuthority: (
    host: unknown,
    options: Parameters<typeof mock.compose>[1],
  ) => {
    mock.configs.set("runtime-host", host);
    return mock.compose("runtime-media-safety", options);
  },
}));
vi.mock("./merchant-product-editor-runtime-brand-sources.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./merchant-product-editor-runtime-brand-sources.js")>()),
  createMerchantProductEditorRuntimeBrandSources: (host: unknown, selectors: unknown) => {
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
      categoryPolicy: vi.fn(),
      withCurrentBrandContent: vi.fn(),
    };
    mock.configs.set("runtime-brand-host", host);
    mock.configs.set("runtime-brand-selectors", selectors);
    mock.configs.set("runtime-brand-sources", sources);
    return sources;
  },
}));
const id = (n: number) => "019a2421-1000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-04T20:00:00.000Z",
  until = "2026-10-04T20:00:05.000Z",
  unavailable = { code: "CATALOG_DEPENDENCY_UNAVAILABLE" };
function configuration(): Extract<
  RegisteredProductCreationContent,
  { readonly mediaSafety?: never }
> {
  return {
    registryAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    creationAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    contentPolicy: {
      configurationVersionReference: id(9),
      expectedBrandVersion: 1,
      policyReference: id(10),
      policyVersion: 1,
      brandAuthority: {
        withCurrentContentRead: async (_tx, _r, work) => work(),
        isCurrent: async () => true,
      },
      policyAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
    },
    optionAuthority: {
      holdUntilTransactionCompletes: vi.fn(async () => ({ observedAt: at, validUntil: until })),
    },
    remainingAuthority: vi.fn(async () => undefined),
  };
}
function mediaSafetyConfiguration() {
  const { remainingAuthority: _legacy, ...base } = configuration();
  void _legacy;
  return {
    ...base,
    mediaSafety: {
      allergenRegistryVersionReference: id(11),
      mediaAuthority: {
        holdUntilTransactionCompletes: vi.fn(async () => ({ observedAt: at, validUntil: until })),
      },
      safetyAuthority: { holdUntilTransactionCompletes: vi.fn(async () => undefined) },
      remainingAuthority: vi.fn(async () => undefined),
    },
  } satisfies RegisteredProductCreationContent;
}
function fixture() {
  let clock = at;
  const guards: { work: () => Promise<void>; final: () => void }[] = [],
    tx = { query: vi.fn(async () => ({ rows: [] })) },
    config = configuration(),
    register = vi.fn<Parameters<ReturnType<typeof create>>[0]["registerBeforeCommit"]>(
      async (actual, work, final) => {
        expect(actual).toBe(tx);
        guards.push({ work, final });
      },
    ),
    context = {
      transaction: tx,
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      sessionReference: id(5),
      productReference: id(6),
      operationReference: id(7),
      clock: { now: () => clock },
      registerBeforeCommit: register,
    },
    authority = create(config)(context),
    aggregate = parseProductAggregate({
      productReference: id(6),
      brandReference: id(2),
      internalCode: "CREATE_CONTENT",
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
        editorContent: {
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
        },
      },
    }),
    input = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      sessionReference: id(5),
      productReference: id(6),
      operationReference: id(7),
      permission: "catalog.manage" as const,
      owningAction: "catalog.product.manage" as const,
      purposeCode: "CATALOG_PRODUCT_CREATE" as const,
      observedAt: at,
      validUntil: until,
      mode: "DraftWrite" as const,
      aggregate,
      requiredFields: productEditorContentFields,
      requiredReferenceChecks: productEditorContentReferenceChecks,
    };
  return {
    config,
    context,
    authority,
    tx,
    input,
    register,
    guards,
    setClock: (value: string) => {
      clock = value;
    },
    async commit() {
      for (const g of guards) await g.work();
      for (const g of guards) g.final();
    },
  };
}
beforeEach(() => {
  mock.order.length = 0;
  mock.configs.clear();
});
it("current Create selects actual runtime Media/Safety using the original authorization host", async () => {
  const f = fixture(),
    config = mediaSafetyConfiguration(),
    currentAuthorization = {
      authorizeActions: vi.fn(async () => undefined),
      assertCurrent: () => parseCatalogInstant(at),
      withCurrentStoreScope: async () => {
        throw new Error("unused Store source");
      },
    },
    context = { ...f.context, currentAuthorization, originalValidUntil: until },
    authority = create({
      authoringSources: {
        configurationVersionReference: id(12),
        expectedBrandVersion: 1,
        policyReference: id(13),
        policyVersion: 1,
        allergenRegistryVersionReference: null,
      },
    })(context);
  await authority(f.tx, f.input);
  expect(mock.order).toEqual(["registry", "absence", "policy", "pinned", "runtime-media-safety"]);
  expect(mock.configs.get("runtime-host")).toMatchObject({
    transaction: f.tx,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    productReference: id(6),
    operationReference: id(7),
    action: "Create",
    expectedAggregateVersion: null,
    originalValidUntil: until,
    currentAuthorization,
  });
  expect(config.mediaSafety.mediaAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  expect(config.mediaSafety.safetyAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  expect(config.mediaSafety.remainingAuthority).not.toHaveBeenCalled();
  const sources = mock.configs.get("runtime-brand-sources") as {
    registryAuthority: Record<string, ReturnType<typeof vi.fn>>;
    brandAuthority: Record<string, ReturnType<typeof vi.fn>>;
    policyAuthority: Record<string, ReturnType<typeof vi.fn>>;
    creationAuthority: Record<string, ReturnType<typeof vi.fn>>;
    optionAuthority: Record<string, ReturnType<typeof vi.fn>>;
    remainingAuthority: ReturnType<typeof vi.fn>;
  };
  expect(sources.remainingAuthority).toHaveBeenCalledWith(f.tx, f.input);
  expect(mock.configs.get("runtime-media-safety")).toMatchObject({
    remainingAuthority: sources.remainingAuthority,
  });
  interface Port {
    holdUntilTransactionCompletes(...args: unknown[]): unknown;
  }
  const absence = mock.configs.get("absence") as { creation: { authority: Port } },
    pinned = mock.configs.get("pinned") as { optionAuthority: Port },
    registry = mock.configs.get("registry") as { registryAuthority: Port },
    policy = mock.configs.get("policy") as {
      brandAuthority: { withCurrentContentRead(...args: unknown[]): unknown };
      policyAuthority: Port;
      runtimeBrandSources: unknown;
    };
  expect(policy.runtimeBrandSources).toBe(sources);
  // Composition captures bound methods. Assert that each captured port invokes
  // its actual producer rather than comparing bound-function identity.
  await absence.creation.authority.holdUntilTransactionCompletes(f.tx, f.input);
  await pinned.optionAuthority.holdUntilTransactionCompletes(f.tx, f.input);
  await registry.registryAuthority.holdUntilTransactionCompletes(f.tx, f.input);
  await policy.policyAuthority.holdUntilTransactionCompletes(f.tx, f.input);
  await policy.brandAuthority.withCurrentContentRead(f.input, [], async () => undefined);
  expect(sources.creationAuthority.holdUntilTransactionCompletes).toHaveBeenCalledWith(
    f.tx,
    f.input,
  );
  expect(sources.optionAuthority.holdUntilTransactionCompletes).toHaveBeenCalledWith(f.tx, f.input);
  expect(sources.registryAuthority.holdUntilTransactionCompletes).toHaveBeenCalledWith(
    f.tx,
    f.input,
  );
  expect(sources.policyAuthority.holdUntilTransactionCompletes).toHaveBeenCalledWith(f.tx, f.input);
  expect(sources.brandAuthority.withCurrentContentRead).toHaveBeenCalled();
  expect(mock.configs.get("runtime-brand-host")).toMatchObject({
    currentAuthorization,
    originalValidUntil: until,
    transaction: f.tx,
  });
  await f.commit();
});
it("refuses runtime authorization without its original deadline or actual media source branch", () => {
  const f = fixture(),
    currentAuthorization = {
      authorizeActions: async () => undefined,
      assertCurrent: () => parseCatalogInstant(at),
      withCurrentStoreScope: async () => {
        throw new Error("unused Store source");
      },
    };
  expect(() => create(mediaSafetyConfiguration())({ ...f.context, currentAuthorization })).toThrow(
    CatalogError,
  );
  expect(() =>
    create(f.config)({ ...f.context, currentAuthorization, originalValidUntil: until }),
  ).toThrow(CatalogError);
});
it("connects configured Media/Safety to Create with original context and mandatory remaining checks", async () => {
  const f = fixture(),
    config = mediaSafetyConfiguration(),
    authority = create(config)(f.context);
  await authority(f.tx, f.input);
  expect(mock.order).toEqual(["registry", "absence", "policy", "pinned", "media-safety"]);
  expect(mock.configs.get("media-safety")).toMatchObject({
    tenantReference: f.context.tenantReference,
    brandReference: f.context.brandReference,
    actorReference: f.context.actorReference,
    allergenRegistryVersionReference: id(11),
    registerBeforeCommit: f.register,
    clock: f.context.clock,
  });
  expect(config.mediaSafety.remainingAuthority).toHaveBeenCalledWith(f.tx, f.input);
  await f.commit();
});
it("captures configured Media/Safety selector and all ports before later mutation", async () => {
  const f = fixture(),
    config = mediaSafetyConfiguration(),
    build = create(config),
    replacement = vi.fn(async () => undefined);
  Object.assign(config.mediaSafety, {
    allergenRegistryVersionReference: id(99),
    remainingAuthority: replacement,
  });
  Object.assign(config.mediaSafety.mediaAuthority, { holdUntilTransactionCompletes: replacement });
  Object.assign(config.mediaSafety.safetyAuthority, { holdUntilTransactionCompletes: replacement });
  await build(f.context)(f.tx, f.input);
  const captured = mock.configs.get("media-safety") as NonNullable<
    RegisteredProductCreationContent["mediaSafety"]
  >;
  expect(captured.allergenRegistryVersionReference).toBe(id(11));
  await captured.mediaAuthority.holdUntilTransactionCompletes(f.tx, {} as never);
  await captured.safetyAuthority.holdUntilTransactionCompletes(f.tx, {} as never);
  expect(replacement).not.toHaveBeenCalled();
});
it("preserves an explicit empty registry selector without inventing a dictionary", async () => {
  const f = fixture(),
    config = mediaSafetyConfiguration();
  await create({
    ...config,
    mediaSafety: { ...config.mediaSafety, allergenRegistryVersionReference: null },
  })(f.context)(f.tx, f.input);
  expect(mock.configs.get("media-safety")).toMatchObject({
    allergenRegistryVersionReference: null,
  });
});
it("refuses mixed legacy and Media/Safety holders before any source use", () => {
  expect(() =>
    create({
      ...mediaSafetyConfiguration(),
      remainingAuthority: configuration().remainingAuthority,
    } as never),
  ).toThrow(CatalogError);
  expect(mock.configs.size).toBe(0);
});
it.each(["mediaAuthority", "safetyAuthority", "remainingAuthority"])(
  "refuses missing Media/Safety %s",
  (field) => {
    const config = mediaSafetyConfiguration();
    expect(() =>
      create({ ...config, mediaSafety: { ...config.mediaSafety, [field]: undefined } } as never),
    ).toThrow(CatalogError);
    expect(mock.configs.size).toBe(0);
  },
);
it("refuses malformed Media/Safety configuration with the bounded dependency error", () => {
  expect(() => create({ ...mediaSafetyConfiguration(), mediaSafety: null } as never)).toThrow(
    CatalogError,
  );
});
it("retains remaining field denial through the configured Media/Safety branch", async () => {
  const f = fixture(),
    config = mediaSafetyConfiguration();
  config.mediaSafety.remainingAuthority.mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(create(config)(f.context)(f.tx, f.input)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("connects actual owner-stage ports in order on the original transaction, never skipping remaining checks", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  expect(mock.order).toEqual(["registry", "absence", "policy", "pinned"]);
  expect(f.config.remainingAuthority).toHaveBeenCalledWith(f.tx, f.input);
  expect(f.guards).toHaveLength(1);
  await f.commit();
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "actorReference",
  "sessionReference",
  "productReference",
  "operationReference",
])("refuses different %s and poisons commit", async (field) => {
  const f = fixture();
  await expect(f.authority(f.tx, { ...f.input, [field]: id(99) })).rejects.toMatchObject(
    unavailable,
  );
  expect(mock.order).toEqual([]);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it.each(["Read", "ReplaceDraft", "foreignTx"])("refuses %s before source use", async (kind) => {
  const f = fixture();
  const input =
    kind === "Read"
      ? { ...f.input, mode: "Read" as const, requiredReferenceChecks: [] }
      : kind === "ReplaceDraft"
        ? { ...f.input, purposeCode: "CATALOG_PRODUCT_DRAFT_REPLACE" as const }
        : f.input;
  await expect(
    f.authority(kind === "foreignTx" ? { query: f.tx.query } : f.tx, input),
  ).rejects.toMatchObject(unavailable);
  expect(mock.order).toEqual([]);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("captures selector and authority ports before subsequent caller mutation", async () => {
  const config = configuration(),
    build = create(config),
    replacement = vi.fn(async () => undefined);
  Object.assign(config, { remainingAuthority: replacement });
  Object.assign(config.contentPolicy, { policyVersion: 2, policyReference: id(99) });
  Object.assign(config.registryAuthority, { holdUntilTransactionCompletes: replacement });
  const f = fixture(),
    authority = build(f.context);
  await authority(f.tx, f.input);
  expect(replacement).not.toHaveBeenCalled();
  expect(mock.configs.get("policy")).toMatchObject({ policyVersion: 1, policyReference: id(10) });
});
it("remaining field denial stays denial and prevents commit", async () => {
  const f = fixture();
  vi.mocked(f.config.remainingAuthority).mockRejectedValue(
    new CatalogError("CATALOG_PERMISSION_DENIED"),
  );
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("swallowed outer reentry poisons source completion and final guard", async () => {
  const f = fixture();
  vi.mocked(f.config.remainingAuthority).mockImplementationOnce(async () => {
    await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it.each(["expiry", "query", "renewal", "badInput"])(
  "previous successful admission cannot commit after %s",
  async (kind) => {
    const f = fixture();
    await f.authority(f.tx, f.input);
    if (kind === "expiry") f.setClock(until);
    else if (kind === "query") Object.assign(f.tx, { query: vi.fn(async () => ({ rows: [] })) });
    else if (kind === "renewal")
      await expect(
        f.authority(f.tx, {
          ...f.input,
          observedAt: "2026-10-04T20:00:01.000Z",
          validUntil: "2026-10-04T20:00:06.000Z",
        }),
      ).rejects.toMatchObject(unavailable);
    else
      await expect(
        f.authority(f.tx, { ...f.input, sourcePass: true } as never),
      ).rejects.toMatchObject(unavailable);
    await expect(f.commit()).rejects.toMatchObject(unavailable);
  },
);
it.each([
  "registryAuthority",
  "creationAuthority",
  "contentPolicy",
  "optionAuthority",
  "remainingAuthority",
])("missing %s cannot become an empty default", async (field) => {
  expect(() => create({ ...configuration(), [field]: undefined } as never)).toThrow(CatalogError);
});
it.each([0, -1, 2147483648, 1.5])("refuses invalid selected policy version %s", (version) => {
  const config = configuration();
  expect(() =>
    create({ ...config, contentPolicy: { ...config.contentPolicy, policyVersion: version } }),
  ).toThrow(CatalogError);
});
it("cannot reuse a proof after successful COMMIT finalization", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  await f.commit();
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  expect(mock.order).toHaveLength(4);
});
it("final COMMIT assertion requires exactly one completed asynchronous guard", async () => {
  const f = fixture();
  await f.authority(f.tx, f.input);
  const guard = f.guards[0];
  if (!guard) throw new Error("Missing controlled guard");
  expect(() => guard.final()).toThrow(CatalogError);
  await expect(guard.work()).rejects.toMatchObject(unavailable);
});

it("rejects mixed legacy callbacks with runtime selectors", () => {
  const f = fixture();
  expect(() =>
    create({
      ...f.config,
      authoringSources: {
        configurationVersionReference: id(12),
        expectedBrandVersion: 1,
        policyReference: id(13),
        policyVersion: 1,
        allergenRegistryVersionReference: null,
      },
    }),
  ).toThrow();
});
it("selector-only Create requires the original runtime authorization and deadline", () => {
  const f = fixture(),
    factory = create({
      authoringSources: {
        configurationVersionReference: id(12),
        expectedBrandVersion: 1,
        policyReference: id(13),
        policyVersion: 1,
        allergenRegistryVersionReference: null,
      },
    });
  expect(() => factory(f.context)).toThrow(CatalogError);
});

function runtimeContentFixture() {
  const f = fixture(),
    selected = {
      configurationVersionReference: id(12),
      expectedBrandVersion: 1,
      policyReference: id(13),
      policyVersion: 1,
      allergenRegistryVersionReference: null,
    },
    context = {
      ...f.context,
      currentAuthorization: {
        authorizeActions: vi.fn(async () => undefined),
        assertCurrent: () => parseCatalogInstant(at),
        withCurrentStoreScope: async () => {
          throw new Error("unused Store source");
        },
      },
      originalValidUntil: until,
    },
    authority = create({ authoringSources: selected })(context);
  const sources = mock.configs.get("runtime-brand-sources") as {
    remainingAuthority: ReturnType<typeof vi.fn>;
    creationAuthority: { holdUntilTransactionCompletes: ReturnType<typeof vi.fn> };
  };
  return { ...f, authority, sources };
}
it("current Create authorizes stored complete Read without invoking absence or current reference sources", async () => {
  const f = runtimeContentFixture(),
    input = { ...f.input, mode: "Read" as const, requiredReferenceChecks: [] };
  await f.authority(f.tx, input);
  expect(mock.order).toEqual([]);
  expect(f.sources.creationAuthority.holdUntilTransactionCompletes).not.toHaveBeenCalled();
  expect(f.sources.remainingAuthority).toHaveBeenCalledWith(f.tx, input);
  await f.commit();
});
it("current Create stored Read cannot substitute for the original strict DraftWrite chain", async () => {
  const f = runtimeContentFixture();
  await f.authority(f.tx, { ...f.input, mode: "Read", requiredReferenceChecks: [] });
  await f.authority(f.tx, f.input);
  expect(mock.order).toEqual(["registry", "absence", "policy", "pinned", "runtime-media-safety"]);
  expect(f.sources.remainingAuthority).toHaveBeenCalledTimes(2);
  await f.commit();
});
it("refuses unknown recorded Read authority and poisons later Create reuse", async () => {
  const f = runtimeContentFixture();
  f.sources.remainingAuthority.mockRejectedValueOnce(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(
    f.authority(f.tx, { ...f.input, mode: "Read", requiredReferenceChecks: [] }),
  ).rejects.toMatchObject({ code: "CATALOG_PERMISSION_DENIED" });
  await expect(f.authority(f.tx, f.input)).rejects.toMatchObject(unavailable);
  await expect(f.commit()).rejects.toMatchObject(unavailable);
});
it("current Create Read refuses qualification-check fields rather than silently clearing them", async () => {
  const f = runtimeContentFixture();
  await expect(f.authority(f.tx, { ...f.input, mode: "Read" })).rejects.toMatchObject(unavailable);
  expect(f.sources.remainingAuthority).not.toHaveBeenCalled();
  expect(mock.order).toEqual([]);
});
