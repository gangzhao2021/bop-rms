import { beforeEach, expect, it, vi } from "vitest";
import { createIdentityActor, parseSessionReference } from "@bop/identity";
import { createBrand, createStore, createTenantContext } from "@bop/tenant";
import {
  CatalogError,
  buildProductOptionPriceContextSnapshot,
  parseProductOptionPriceContextRequest,
  parseProductAggregate,
  parseCatalogOptionSetEditorContent,
  materializeFullOptionSetCreation,
  createCatalogFullOptionSetPublicationMaterialization,
  productOptionPriceContextSourceFields,
  frozenFullOptionSetContentFields,
  parseCatalogInstant,
  type createPostgresProductOptionPriceContextSourceStore,
  type createPostgresFrozenFullOptionSetContentStore,
} from "@rms/catalog";
import {
  createCurrencyMetadataSnapshot,
  parseCurrencyCode,
  parsePricingReference,
  parsePricingDigest,
} from "@rms/pricing";
import {
  createMerchantOptionPriceContextSource,
  type MerchantOptionPriceContextOptions,
} from "./merchant-option-price-context.js";
import type { createCurrentPublishedOptionSetGraphSource } from "./current-published-option-set-graph.js";
const owners = vi.hoisted(() => ({
  product: vi.fn(),
  frozen: vi.fn(),
  graph: vi.fn(),
  publishing: vi.fn(),
}));
vi.mock("@bop/publishing", async (original) => ({
  ...(await original<typeof import("@bop/publishing")>()),
  createPostgresPublishingMutationStore: (...args: unknown[]) => owners.publishing(...args),
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductOptionPriceContextSourceStore: (options: unknown) => owners.product(options),
  createPostgresFrozenFullOptionSetContentStore: (options: unknown) => owners.frozen(options),
}));
vi.mock("./current-published-option-set-graph.js", () => ({
  createCurrentPublishedOptionSetGraphSource: (options: unknown) => owners.graph(options),
}));
const id = (n: number) => "01902421-7950-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-10-05T12:00:00.000Z",
  until = "2026-10-05T12:00:05.000Z",
  digest = "sha256:" + "a".repeat(64);
const plus = (ms: number) => new Date(Date.parse(at) + ms).toISOString();
type ProductOptions = Parameters<typeof createPostgresProductOptionPriceContextSourceStore>[0];
type ProductTransaction = Parameters<
  ProductOptions["authority"]["holdUntilTransactionCompletes"]
>[0];
type FrozenOptions = Parameters<typeof createPostgresFrozenFullOptionSetContentStore>[0];
type GraphOptions = Parameters<typeof createCurrentPublishedOptionSetGraphSource>[0];
type GraphStore = ReturnType<typeof createCurrentPublishedOptionSetGraphSource>;
type GraphPacket = Parameters<Parameters<GraphStore["withCurrentGraph"]>[1]>[0];
beforeEach(() => vi.clearAllMocks());
function option() {
  return materializeFullOptionSetCreation(
    {
      internalCode: "SYNTH_PRICE",
      operationReference: id(10),
      occurredAt: at,
      reasonCode: "AUTHORIZED_OPERATION",
      draft: {
        defaultLocale: "en-CA",
        localizedNames: { "en-CA": "Actual owner choice" },
        localizedDescriptions: {},
        displayStyle: "MultiChoice",
        minimumSelection: 0,
        maximumSelection: 1,
        allowRepeatedOption: false,
        perOptionMaximumQuantity: 1,
        maximumTotalQuantity: 1,
        options: [
          {
            stableCode: "CHOICE",
            lifecycle: "Active",
            localizedNames: { "en-CA": "Synthetic choice" },
            localizedDescriptions: {},
            sortOrder: 0,
            defaultEligible: true,
            triggeredOptionSetReference: null,
            conflictOptionCodes: [],
          },
        ],
      },
      additionalContent: {
        profile: "CatalogOptionSetEditorContentV1",
        optionDetails: [
          {
            stableCode: "CHOICE",
            quantityRule: { minimumQuantity: 0, maximumQuantity: 1 },
            media: null,
            pricingRule: null,
            consumption: null,
            triggeredOptionSetVersionReference: null,
          },
        ],
        conditionalRules: [],
        conflictRules: [],
        scopeSet: [{ level: "Brand", reference: null, channelCodes: [], orderTypeCodes: [] }],
        effectivePeriod: {
          timeZone: "UTC",
          effectiveFrom: { instant: at, localDateTime: at.slice(0, 23), utcOffsetMinutes: 0 },
          effectiveUntil: null,
        },
      },
    },
    {
      brandReference: id(2),
      actorReference: id(4),
      allocations: {
        optionSetReference: id(6),
        versionReference: id(8),
        options: [{ stableCode: "CHOICE", optionReference: id(9) }],
      },
    },
  ).content;
}
function product(mode: "Pinned" | "CurrentPublished", changed = false) {
  return parseProductAggregate({
    productReference: id(20),
    brandReference: id(2),
    internalCode: "SYNTH",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
    createdAt: at,
    createdByActorReference: id(4),
    updatedAt: at,
    draft: {
      versionReference: id(21),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": changed ? "Changed" : "Synthetic Product" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [], primaryCategoryReference: null },
      skus: [
        {
          skuReference: id(22),
          productReference: id(20),
          brandReference: id(2),
          skuCode: "BASE",
          lifecycle: "Active",
          localizedNames: { "en-CA": "Base" },
          variantSelections: [],
          unitOfSale: "EA",
          unitQuantity: "1",
          createdAt: at,
          createdByActorReference: id(4),
        },
      ],
      optionBindings: [
        {
          bindingReference: id(23),
          optionSetReference: id(6),
          optionSetVersionReference: id(8),
          purpose: "EXTRAS",
          sortOrder: 0,
          enabledOptionReferences: [id(9)],
          defaultSelections: [],
          minimumSelectionOverride: null,
          maximumSelectionOverride: null,
          includedSkuReferences: [],
          excludedSkuReferences: [],
          channelCodes: ["WEB"],
          storeOverrideAllowed: false,
        },
      ],
      editorContent: {
        profile: "CatalogProductEditorContentV1",
        localizedShortDescriptions: {},
        localizedDescriptions: {},
        preparationNotes: {},
        tagReferences: [],
        attributeValues: [],
        media: [],
        variantDimensions: [],
        variantCombinations: [{ selections: [], disposition: "Valid", skuReference: id(22) }],
        optionRules: [
          {
            bindingReference: id(23),
            versionResolution: mode,
            pricingRule: null,
            conditionalRule: null,
            conflictRule: null,
            variantCondition: [],
          },
        ],
        allergenReferences: [],
        nutritionProfile: null,
      },
    },
  });
}
/** Controlled public acquisition seams, genuine narrow owning snapshot constructors.
 * This fixture does not claim native IAM, publication or persistence evidence. */
function fixture(mode: "Pinned" | "CurrentPublished" = "Pinned", reviewWriteFamily?: string) {
  const acquisitionOrder: string[] = [];
  const state = {
    now: at,
    denied: false,
    productReadDenied: false,
    rootChanged: false,
    sourceChanged: false,
    foreignScope: false,
    graphUntil: until,
    graphFinalized: false,
    callbackTwice: false,
  };
  const actor = createIdentityActor({
      actorType: "User",
      actorReference: id(4),
      accountKind: "Workforce",
      status: "Active",
      authenticationMethod: "Oidc",
      verificationLevel: "SingleFactor",
      authenticatedAt: at,
      recentMfaAt: null,
    }),
    brand = createBrand({
      brandReference: id(2),
      code: "BRAND",
      displayName: "Synthetic",
      defaultLocale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    store = createStore({
      storeReference: id(3),
      brandReference: id(2),
      code: "STORE",
      displayName: "Synthetic",
      timeZone: "UTC",
      locale: "en-CA",
      currencyCode: "CAD",
      lifecycle: "Active",
      version: 1,
      createdAt: at,
      updatedAt: at,
    }),
    context = createTenantContext(actor, brand, store, at),
    query = vi.fn(async (sql: string) => {
      if (sql === "SELECT current_setting('transaction_isolation') isolation")
        return [{ isolation: "read committed" }];
      if (sql === "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id','',true)")
        return [];
      throw new Error("Unexpected controlled Category Read query");
    }),
    tx: ProductTransaction = {
      async query<Row>(sql: string) {
        // Only these two controlled SQL packets exist in this fixture; the
        // genuine owning Category parser checks the returned isolation fact.
        const rows = await query(sql);
        return { rows: rows as unknown as readonly Row[] };
      },
    },
    guards: { async: () => Promise<void>; final: () => void }[] = [],
    content = option(),
    { sourceAggregate, ...details } = content,
    parsed = parseCatalogOptionSetEditorContent(sourceAggregate, details),
    frozen = createCatalogFullOptionSetPublicationMaterialization(sourceAggregate, details, {
      tenantReference: id(1),
      brandReference: id(2),
      optionSetReference: id(6),
      versionReference: id(8),
      sourceAggregateVersion: 1,
      publicationOperationReference: id(12),
      publicationIntentDigest: digest,
      successorDraftVersionReference: id(13),
      sealedAt: at,
      sourceDigest: parsed.sourceDigest,
      contentDigest: parsed.contentDigest,
      configurationDigest: parsed.configurationDigest,
    }).content;
  if (actor.actorReference === null) throw new Error("Fixture requires an actual User reference");
  const actorReference = actor.actorReference;
  const assert = () => {
    if (state.denied) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    return parseCatalogInstant(state.now);
  };
  const authorization: MerchantOptionPriceContextOptions["currentAuthorization"] = {
    assertCurrent: vi.fn(assert),
    leaseDeadline: () => until,
    authorizeActions: vi.fn(async (actions) => {
      assert();
      // A reviewer has actual Catalog reads and Pricing management, never
      // Product authoring permission. Full-editor reuse must fail this seam.
      if (
        actions.includes("catalog.product.manage") ||
        (state.productReadDenied && actions.includes("catalog.product.read"))
      )
        throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return undefined;
    }),
    async withCurrentStoreScope<T>(
      input: Parameters<
        MerchantOptionPriceContextOptions["currentAuthorization"]["withCurrentStoreScope"]
      >[0],
      work: (scope: typeof context) => Promise<T>,
    ): Promise<T> {
      expect(input.capabilityKey).toBe("pricing.price_book_editor");
      assert();
      return work(state.foreignScope ? createTenantContext(actor, brand, null, at) : context);
    },
  };
  const options: MerchantOptionPriceContextOptions = {
    transaction: tx,
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    clock: { now: () => state.now },
    originalValidUntil: until,
    currentAuthorization: authorization,
    capability: {
      holdUntilCommit: vi.fn(async () => {
        assert();
        return undefined;
      }),
      leaseDeadline: () => until,
    },
    async registerBeforeCommit(actual, async, final) {
      expect(actual).toBe(tx);
      if (!final) throw new Error("Missing final");
      guards.push({ async, final });
    },
    events: {
      generateReference() {
        throw new Error("Read cannot emit");
      },
    },
    brandScope: {
      tenantReference: id(1),
      actorReference,
      selectedStoreReference: store.storeReference,
      context: createTenantContext(actor, brand, null, at),
    },
    storeScope: {
      selected: { tenantReference: id(1) },
      context,
      store,
      actorReference,
      sessionReference: parseSessionReference(id(5)),
    },
    currencyMetadata: createCurrencyMetadataSnapshot({
      currencyCode: parseCurrencyCode("CAD"),
      minorUnitExponent: 2,
      metadataVersion: 1,
      metadataVersionReference: parsePricingReference(id(30)),
      metadataDigest: parsePricingDigest(digest),
    }),
  };
  owners.product.mockImplementation((o: ProductOptions) => {
    let registered = false,
      guarded = false,
      finalized = false;
    const acquire = async (request: unknown) => {
      const aggregate = product(mode, state.rootChanged),
        packet = buildProductOptionPriceContextSnapshot(
          aggregate,
          { tenantReference: id(1), brandReference: id(2), actorReference: id(4) },
          request,
          state.now,
          until,
        );
      await o.authority.holdUntilTransactionCompletes(tx, {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User",
        productReference: id(20),
        request: parseProductOptionPriceContextRequest(request),
        purposeCode: "CATALOG_PRODUCT_OPTION_PRICE_CONTEXT_READ",
        permission: "catalog.manage",
        owningAction: "catalog.product.read",
        requiredFields: productOptionPriceContextSourceFields,
        observedAt: state.now,
        validUntil: until,
      });
      acquisitionOrder.push("Catalog");
      return packet;
    };
    return {
      async withCurrentSnapshot<T>(
        request: unknown,
        work: (
          packet: ReturnType<typeof buildProductOptionPriceContextSnapshot>,
          actual: ProductTransaction,
        ) => Promise<T>,
      ): Promise<T> {
        if (guarded || finalized) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        if (!registered) {
          registered = true;
          await o.registerBeforeCommit(
            tx,
            async () => {
              if (guarded) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
              guarded = true;
              await acquire(request);
            },
            () => {
              if (!guarded || finalized) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
              finalized = true;
            },
          );
        }
        return work(await acquire(request), tx);
      },
      assertFinalized(actual: ProductTransaction) {
        if (actual !== tx || !guarded || !finalized)
          throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
        return until;
      },
    };
  });
  owners.frozen.mockImplementation((o: FrozenOptions) => ({
    async readPinned(request: unknown) {
      expect(request).toMatchObject({ optionSetReference: id(6), versionReference: id(8) });
      await o.authority.holdUntilTransactionCompletes(tx, {
        tenantReference: id(1),
        brandReference: id(2),
        actorReference: id(4),
        actorKind: "User",
        permission: "catalog.manage",
        action: "catalog.option_set.read",
        purposeCode: "CATALOG_OPTION_SET_FROZEN_CONTENT",
        requiredFields: frozenFullOptionSetContentFields,
        optionSetReference: id(6),
        versionReference: id(8),
        content: frozen,
        observedAt: state.now,
      });
      if (state.sourceChanged) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
      return {
        content: frozen,
        observedAt: state.now,
        validUntil: until,
        eligibility: "NotEvaluated",
      };
    },
  }));
  owners.graph.mockImplementation((o: GraphOptions) => {
    expect(o.capabilityPermissionAction).toBe("pricing.price-book.manage");
    return {
      assertFinalized() {
        if (!state.graphFinalized) throw new Error("Not finalized");
        return state.graphUntil;
      },
      async withCurrentGraph<T>(
        request: unknown,
        work: (packet: GraphPacket) => Promise<T>,
      ): Promise<T> {
        expect(request).toEqual({ optionSetReference: id(6), versionReference: id(8) });
        const packet: GraphPacket = {
          profile: "CurrentPublishedOptionSetGraphV1",
          graph: {
            brandReference: id(2),
            rootOptionSetReference: id(6),
            rootVersionReference: id(8),
            contents: [content],
          },
          sourceRecords: [
            {
              optionSetReference: id(6),
              versionReference: id(8),
              publicationReference: id(14),
              sealRecordDigest: frozen.digest,
              releaseRecordDigest: digest,
              approvalDisposition: "Approved",
            },
          ],
          graphDigest: digest,
          rules: { status: "Satisfiable", reason: null, searchNodes: 1 },
          originalObservedAt: at,
          observedAt: state.now,
          validUntil: until,
          sourceAuthority: "CurrentPublishingReleaseAndFrozenContent",
          referenceEligibility: "NotEvaluated",
          eligibility: "NotEvaluated",
          publishValidation: "Incomplete",
        };
        await o.registerBeforeCommit(
          tx,
          async () => {
            assert();
            if (state.sourceChanged) throw new CatalogError("CATALOG_VERSION_CONFLICT");
          },
          () => {
            state.graphFinalized = true;
          },
        );
        acquisitionOrder.push("GraphShare");
        const result = await work(packet);
        if (state.callbackTwice) await work(packet);
        return result;
      },
    };
  });
  const request = {
    productReference: id(20),
    expectedProductAggregateVersion: 1,
    bindingReference: id(23),
    optionReference: id(9),
  };
  if (reviewWriteFamily !== undefined)
    Object.assign(options, { publicationReviewWriteFamilyReference: reviewWriteFamily });
  owners.publishing.mockReturnValue({
    async withOptionPriceReview(input: unknown, work: (held: unknown) => Promise<unknown>) {
      expect(input).toEqual({ familyReference: reviewWriteFamily, mode: "Write" });
      acquisitionOrder.push("PublishingWrite");
      return work(Object.freeze({ readForDraft: vi.fn() }));
    },
  });
  const source = createMerchantOptionPriceContextSource(options);
  return {
    state,
    acquisitionOrder,
    options,
    source,
    request,
    tx,
    query,
    guards,
    authorization,
    run: () => source.withCurrentContext(tx, request, async (value) => value),
    async commit() {
      for (const guard of guards) await guard.async();
      for (const guard of guards) guard.final();
    },
  };
}
it.each(["Pinned", "CurrentPublished"] as const)(
  "reads actual %s context without interpreting an opaque pricing group",
  async (mode) => {
    const f = fixture(mode),
      result = await f.run();
    expect(result).toMatchObject({
      profile: "MerchantOptionPriceContextV1",
      productAggregateVersion: 1,
      optionSetVersionReference: id(8),
      versionResolution: mode,
      choices: [{ optionReference: id(9), stableCode: "CHOICE" }],
      skus: [{ skuReference: id(22), skuCode: "BASE" }],
      currencyMetadata: { currencyCode: "CAD" },
      referenceEligibility: "NotEvaluated",
      publishValidation: "Incomplete",
    });
    expect(owners.graph).toHaveBeenCalledTimes(mode === "CurrentPublished" ? 1 : 0);
    await f.commit();
    expect(
      vi
        .mocked(f.authorization.authorizeActions)
        .mock.calls.every(([actions]) => !actions.includes("catalog.product.manage")),
    ).toBe(true);
    expect(f.source.assertFinalized(f.tx)).toBe(until);
  },
);
it("requires genuine outer finalization and poisons a premature assertion", async () => {
  const f = fixture();
  await f.run();
  expect(() => f.source.assertFinalized(f.tx)).toThrowError(
    expect.objectContaining({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" }),
  );
  await expect(f.commit()).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
});
it("reads the complete Binding with null Choice without requiring Product management", async () => {
  const f = fixture();
  const value = await f.source.withCurrentContext(
    f.tx,
    { ...f.request, optionReference: null },
    async (context) => context,
  );
  expect(value.optionReference).toBeNull();
  expect(value.choices).toHaveLength(1);
  await f.commit();
  expect(f.source.assertFinalized(f.tx)).toBe(until);
  expect(
    vi
      .mocked(f.authorization.authorizeActions)
      .mock.calls.every(
        ([actions]) =>
          actions.includes("catalog.product.read") && !actions.includes("catalog.product.manage"),
      ),
  ).toBe(true);
});
it("rejects complete aggregate drift even when the selected Binding and SKU projection are unchanged", async () => {
  const f = fixture(),
    request = {
      productReference: f.request.productReference,
      expectedAggregateVersion: f.request.expectedProductAggregateVersion,
      bindingReference: f.request.bindingReference,
      optionReference: f.request.optionReference,
    },
    scope = { tenantReference: id(1), brandReference: id(2), actorReference: id(4) },
    before = buildProductOptionPriceContextSnapshot(
      product("Pinned", false),
      scope,
      request,
      at,
      until,
    ),
    after = buildProductOptionPriceContextSnapshot(
      product("Pinned", true),
      scope,
      request,
      at,
      until,
    );
  expect(after.binding).toEqual(before.binding);
  expect(after.skus).toEqual(before.skus);
  expect(after.aggregateDigest).not.toBe(before.aggregateDigest);
  await f.run();
  f.state.rootChanged = true;
  await expect(f.commit()).rejects.toHaveProperty("code", "OPTION_PRICE_VERSION_CONFLICT");
});
it("requires the owning narrow source final guard after the earlier Context final guard", async () => {
  const f = fixture();
  await f.run();
  for (const guard of f.guards) await guard.async();
  const contextGuard = f.guards[0];
  if (!contextGuard) throw new Error("Missing actual Context guard");
  contextGuard.final();
  expect(() => f.source.assertFinalized(f.tx)).toThrowError(
    expect.objectContaining({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" }),
  );
});
it.each(["denied", "productReadDenied", "rootChanged", "sourceChanged", "foreignScope"] as const)(
  "refuses late %s through the real registered context guard",
  async (reason) => {
    const f = fixture();
    await f.run();
    f.state[reason] = true;
    await expect(f.commit()).rejects.toHaveProperty(
      "code",
      reason === "denied" || reason === "productReadDenied"
        ? "OPTION_PRICE_PERMISSION_DENIED"
        : reason === "rootChanged"
          ? "OPTION_PRICE_VERSION_CONFLICT"
          : "OPTION_PRICE_DEPENDENCY_UNAVAILABLE",
    );
    expect(() => f.source.assertFinalized(f.tx)).toThrow();
  },
);
it("retains the actual graph's final shortened lease", async () => {
  const f = fixture("CurrentPublished");
  await f.run();
  f.state.graphUntil = plus(4000);
  await f.commit();
  expect(f.source.assertFinalized(f.tx)).toBe(plus(4000));
  f.state.now = plus(4000);
  expect(() => f.source.assertFinalized(f.tx)).toThrow();
});
it("does not reinterpret missing or foreign Choice membership as valid", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentContext(
      f.tx,
      { ...f.request, optionReference: id(99) },
      async (value) => value,
    ),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_VERSION_CONFLICT");
  await expect(f.commit()).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
});
it("refuses captured owner port replacement and expiry", async () => {
  const f = fixture();
  await f.run();
  f.options.clock.now = () => until;
  await expect(f.commit()).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
});
it("refuses a repeated graph callback without granting qualification", async () => {
  const f = fixture("CurrentPublished");
  f.state.callbackTwice = true;
  await expect(f.run()).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
  await expect(f.commit()).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
});
it("requires configured currency metadata to match actual Brand and selected Store", () => {
  const f = fixture(),
    currency = createCurrencyMetadataSnapshot({
      ...f.options.currencyMetadata,
      currencyCode: parseCurrencyCode("USD"),
    });
  expect(() =>
    createMerchantOptionPriceContextSource({ ...f.options, currencyMetadata: currency }),
  ).toThrowError(expect.objectContaining({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" }));
  expect(owners.product).not.toHaveBeenCalled();
  expect(owners.graph).not.toHaveBeenCalled();
});
it("refuses an invalid original window before source acquisition", () => {
  const f = fixture();
  expect(() =>
    createMerchantOptionPriceContextSource({ ...f.options, originalValidUntil: plus(5001) }),
  ).toThrow();
  expect(owners.product).not.toHaveBeenCalled();
});
it("poisons a caught same-host reentry rather than continuing to the Pricing consumer", async () => {
  const f = fixture();
  await expect(
    f.source.withCurrentContext(f.tx, f.request, async (value) => {
      await f.source
        .withCurrentContext(f.tx, f.request, async (next) => next)
        .catch(() => undefined);
      return value;
    }),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
  await expect(f.commit()).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
});
it("refuses a foreign transaction and never starts owning sources", async () => {
  const f = fixture(),
    foreign = { query: vi.fn(async () => ({ rows: [] })) };
  await expect(
    f.source.withCurrentContext(foreign, f.request, async (value) => value),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_DEPENDENCY_UNAVAILABLE");
  expect(owners.product).not.toHaveBeenCalled();
  expect(f.guards).toHaveLength(0);
});
it("rejects request accessors without invoking them or starting source reads", async () => {
  const f = fixture(),
    getter = vi.fn(() => id(23)),
    request = Object.defineProperty({ ...f.request }, "bindingReference", {
      enumerable: true,
      get: getter,
    });
  await expect(
    f.source.withCurrentContext(f.tx, request, async (value) => value),
  ).rejects.toHaveProperty("code", "OPTION_PRICE_INPUT_INVALID");
  expect(getter).not.toHaveBeenCalled();
  expect(owners.product).not.toHaveBeenCalled();
});

it("ordinary review takes the genuine Publishing writer admission after Catalog and before CurrentPublished graph SHARE", async () => {
  const f = fixture("CurrentPublished", id(71));
  await f.run();
  expect(f.acquisitionOrder.slice(0, 3)).toEqual(["Catalog", "PublishingWrite", "GraphShare"]);
  expect(owners.publishing).toHaveBeenCalledTimes(1);
  await f.commit();
});
it.each(["Pinned", "CurrentPublished"] as const)(
  "default %s context remains read-only without a Publishing write admission",
  async (mode) => {
    const f = fixture(mode);
    await f.run();
    expect(owners.publishing).not.toHaveBeenCalled();
    expect(f.acquisitionOrder).not.toContain("PublishingWrite");
    await f.commit();
  },
);
it("captures the server-only review family and rejects drift before owning acquisition", async () => {
  const f = fixture("CurrentPublished", id(71));
  Object.assign(f.options, { publicationReviewWriteFamilyReference: id(72) });
  await expect(f.run()).rejects.toMatchObject({ code: "OPTION_PRICE_DEPENDENCY_UNAVAILABLE" });
  expect(owners.publishing).not.toHaveBeenCalled();
});
