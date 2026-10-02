import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  deriveCatalogProductDraftBaseline,
  parseProductAggregate,
  parseCatalogReference,
  productDraftBaselineFields,
  productDraftBaselineReferencedFields,
  type ProductAggregate,
} from "@rms/catalog";
import {
  createMerchantProductDraftBaselineQuery,
  parseProductDraftBaselineRequest,
} from "./merchant-product-draft-baseline-query.js";
const state = vi.hoisted(() => ({
  store: vi.fn(),
  brand: vi.fn(),
  factory: vi.fn(),
  load: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => state.store }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => state.brand }));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresProductDraftBaselineStore: (...args: unknown[]) => state.factory(...args),
}));
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
function source(): ProductAggregate {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "DRAFT_1",
    productType: "PreparedFood",
    lifecycle: "Active",
    aggregateVersion: 4,
    createdAt: at,
    createdByActorReference: id(3),
    updatedAt: at,
    draft: {
      versionReference: id(4),
      baseVersionReference: null,
      status: "Draft",
      defaultLocale: "en-CA",
      localizedNames: { "en-CA": "Synthetic draft" },
      taxClassificationReference: null,
      createdAt: at,
      updatedAt: at,
      categoryClassification: { categoryReferences: [id(5)], primaryCategoryReference: id(5) },
      skus: [0, 1].map((n) => ({
        skuReference: id(10 + n),
        productReference: id(1),
        brandReference: id(2),
        skuCode: "SKU_" + n,
        lifecycle: "Draft",
        localizedNames: { "en-CA": "Synthetic SKU " + n },
        variantSelections: [{ dimensionReference: id(20), valueReference: id(21 + n) }],
        unitOfSale: "EA",
        unitQuantity: "1",
        createdAt: at,
        createdByActorReference: id(30),
      })),
      optionBindings: [
        {
          bindingReference: id(40),
          optionSetReference: id(41),
          optionSetVersionReference: id(42),
          purpose: "SELECT",
          sortOrder: 0,
          enabledOptionReferences: [id(43)],
          defaultSelections: [{ optionReference: id(43), quantity: 2 }],
          minimumSelectionOverride: 0,
          maximumSelectionOverride: 2,
          includedSkuReferences: [id(10)],
          excludedSkuReferences: [],
          channelCodes: ["DINE_IN"],
          storeOverrideAllowed: false,
        },
      ],
    },
  });
}

type Options = Parameters<typeof createMerchantProductDraftBaselineQuery>[0];
function setup() {
  let held = false,
    now = at;
  const scope = {
      tenantReference: id(6),
      brandReference: id(2),
      storeReference: id(7),
      actorReference: id(8),
      sessionReference: id(9),
    },
    events: string[] = [];
  const allowed = vi.fn(async () => true),
    action = vi.fn(async (requested: string) => ({
      effect: "Allow",
      scopeKind: "Brand",
      action: requested,
    }));
  const store = {
    selected: { tenantReference: scope.tenantReference },
    context: { brand: { brandReference: scope.brandReference } },
    store: { storeReference: scope.storeReference },
    actorReference: scope.actorReference,
    allowed,
  };
  const brand = {
    tenantReference: scope.tenantReference,
    context: { brand: { brandReference: scope.brandReference } },
    actorReference: scope.actorReference,
    selectedStoreReference: scope.storeReference,
    authorizeAction: action,
  };
  state.store.mockResolvedValue(store);
  state.brand.mockResolvedValue(brand);
  state.load.mockImplementation(async () => deriveCatalogProductDraftBaseline(source(), now, now));
  state.factory.mockImplementation((input) => ({
    loadBaseline: async (productReference: string) =>
      input.transactions.run(async (tx: unknown) => {
        for (let n = 0; n < 3; n++)
          await input.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            actorReference: scope.actorReference,
            productReference,
            purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ",
            permission: "catalog.manage",
            action: "catalog.product.manage",
            capability: "catalog.cat_product_edit",
            requiredFields: productDraftBaselineFields,
            referencedFields: productDraftBaselineReferencedFields,
            observedAt: now,
          });
        return state.load();
      }),
  }));
  const fields = vi.fn(async () => {
    expect(held).toBe(true);
    events.push("fields");
  });
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
    authority: {
      async withCurrentProductDraftBaseline(input, work) {
        expect(input).toMatchObject({
          productReference: id(1),
          screenId: "CAT-PRODUCT-EDIT",
          capability: "catalog.cat_product_edit",
          permission: "catalog.manage",
          action: "catalog.product.manage",
          purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ",
          requiredFields: productDraftBaselineFields,
        });
        held = true;
        try {
          return await work(scope);
        } finally {
          held = false;
          events.push("release");
        }
      },
    },
    holdFieldsAndPhaseUntilCommit: fields,
    maximumSkus: 100,
    maximumOptionBindings: 100,
  };
  const request = {
    sessionCookie: "Synthetic opaque credential",
    query: { productReference: id(1) },
  };
  return {
    options,
    load: createMerchantProductDraftBaselineQuery(options),
    request,
    scope,
    store,
    brand,
    fields,
    action,
    allowed,
    events,
    setNow: (value: string) => {
      now = value;
    },
  };
}
beforeEach(() => Object.values(state).forEach((mock) => mock.mockReset()));
it("holds exact target, all independent reads and fields through outer COMMIT", async () => {
  const f = setup(),
    value = await f.load(f.request);
  expect(value.baseline?.draft).toEqual(source().draft);
  expect(value.scope).toEqual({ brandReference: id(2), storeReference: id(7) });
  expect(f.fields).toHaveBeenCalledTimes(5);
  expect(f.action).toHaveBeenCalledTimes(20);
  expect(f.events.slice(-3)).toEqual(["fields", "commit", "release"]);
  expect(state.factory.mock.calls[0]?.[0].categoryAssignments).toBeUndefined();
});
it.each(["tenant", "brand", "store", "actor", "brandStore"])(
  "rejects resolved scope drift %s",
  async (kind) => {
    const f = setup();
    if (kind === "tenant") f.store.selected.tenantReference = id(99);
    if (kind === "brand") f.brand.context.brand.brandReference = id(99);
    if (kind === "store") f.store.store.storeReference = id(99);
    if (kind === "actor") f.brand.actorReference = id(99);
    if (kind === "brandStore") f.brand.selectedStoreReference = id(99);
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it.each(["catalog.manage", "catalog.product.manage", "catalog.product.read", "catalog.sku.read"])(
  "requires %s independently",
  async (required) => {
    const f = setup();
    f.action.mockImplementation(async (requested) => ({
      effect: requested === required ? "Deny" : "Allow",
      scopeKind: "Brand",
      action: requested,
    }));
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
    expect(f.fields).not.toHaveBeenCalled();
  },
);
it("discards completed read when outer COMMIT field lease denies", async () => {
  const f = setup();
  f.fields.mockImplementation(async () => {
    if (f.fields.mock.calls.length === 5) throw new CatalogError("CATALOG_PERMISSION_DENIED");
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.events).not.toContain("commit");
  expect(state.load).toHaveBeenCalledTimes(1);
});
it("rechecks current permission at COMMIT", async () => {
  const f = setup();
  state.load.mockImplementation(async () => {
    f.allowed.mockResolvedValue(false);
    return deriveCatalogProductDraftBaseline(source(), at, at);
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.events).not.toContain("commit");
});
it("returns authorized missing target as null", async () => {
  const f = setup();
  state.load.mockResolvedValue(null);
  expect((await f.load(f.request)).baseline).toBeNull();
  expect(f.fields).toHaveBeenCalledTimes(5);
});
it("discards wrong owner target", async () => {
  const f = setup();
  const changed = source();
  state.load.mockResolvedValue(
    deriveCatalogProductDraftBaseline(
      {
        ...changed,
        productReference: parseCatalogReference(id(99)),
        draft: {
          ...changed.draft,
          skus: changed.draft.skus.map((s) => ({
            ...s,
            productReference: parseCatalogReference(id(99)),
          })),
        },
      },
      at,
      at,
    ),
  );
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
});
it("discards baseline aged after outer authority completion", async () => {
  const f = setup(),
    delegate = f.options.authority.withCurrentProductDraftBaseline;
  f.options.authority.withCurrentProductDraftBaseline = async (input, work) => {
    const result = await delegate(input, work);
    f.setNow("2026-09-28T12:00:05.001Z");
    return result;
  };
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Stale" });
});
it.each(["none", "twice", "rebound"])(
  "requires single exact authority callback %s",
  async (mode) => {
    const f = setup();
    f.options.authority.withCurrentProductDraftBaseline = async (_input, work) => {
      if (mode === "none") return {} as Awaited<ReturnType<typeof work>>;
      const result = await work(f.scope);
      if (mode === "twice") await work(f.scope);
      return mode === "rebound" ? { ...result } : result;
    };
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  },
);
it.each([
  { productReference: id(1), actorReference: id(8) },
  { productReference: "invalid" },
  null,
])("rejects closed malformed request before authority %#", async (query) => {
  const f = setup();
  await expect(f.load({ ...f.request, query })).rejects.toMatchObject({ code: "Invalid" });
  expect(f.fields).not.toHaveBeenCalled();
});
it("rejects getter without evaluation", () => {
  const getter = vi.fn(() => id(1)),
    value = {};
  Object.defineProperty(value, "productReference", { get: getter, enumerable: true });
  expect(() => parseProductDraftBaselineRequest(value)).toThrow();
  expect(getter).not.toHaveBeenCalled();
});

it.each(["catalog.product.read", "catalog.sku.read"])(
  "drops completed baseline after %s revocation",
  async (required) => {
    const f = setup();
    state.load.mockImplementation(async () => {
      f.action.mockImplementation(async (requested) => ({
        effect: requested === required ? "Deny" : "Allow",
        scopeKind: "Brand",
        action: requested,
      }));
      return deriveCatalogProductDraftBaseline(source(), at, at);
    });
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(f.events).not.toContain("commit");
  },
);
it.each(["catalog.product.read", "catalog.sku.read"])(
  "rejects substituted %s read evidence",
  async (required) => {
    for (const kind of ["Store", "wrong-action"]) {
      const f = setup();
      f.action.mockImplementation(async (requested) => ({
        effect: "Allow",
        scopeKind: requested === required && kind === "Store" ? "Store" : "Brand",
        action:
          requested === required && kind === "wrong-action" ? "catalog.product.update" : requested,
      }));
      await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
      expect(f.fields).not.toHaveBeenCalled();
    }
  },
);
it("read baseline requires no create or update grant", async () => {
  const f = setup();
  f.action.mockImplementation(async (requested) => ({
    effect: requested.endsWith(".create") || requested.endsWith(".update") ? "Deny" : "Allow",
    scopeKind: "Brand",
    action: requested,
  }));
  expect((await f.load(f.request)).baseline?.draft).toEqual(source().draft);
  expect(
    f.action.mock.calls.some(
      ([action]) => action.endsWith(".create") || action.endsWith(".update"),
    ),
  ).toBe(false);
});
