import { beforeEach, expect, it, vi } from "vitest";
import {
  CatalogError,
  categorySourceDigest,
  categoryPersistenceFields,
  productCategoryLookupFields,
} from "@rms/catalog";
import { createMerchantProductCategoryLookupQuery } from "./merchant-product-category-lookup-query.js";
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
  createPostgresCategorySourceStore: (...args: unknown[]) => state.factory(...args),
}));
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T12:00:00.000Z";
type Options = Parameters<typeof createMerchantProductCategoryLookupQuery>[0];
// Current scope and owner source are unit doubles. Real SQL composition has separate acceptance.
function setup() {
  let held = false,
    now = at;
  const events: string[] = [],
    scope = {
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      actorReference: id(4),
      sessionReference: id(5),
      locale: "en-CA",
    };
  const allowed = vi.fn(async () => true),
    action = vi.fn(async (requested: string) => ({
      effect: "Allow",
      scopeKind: "Brand",
      action: requested,
    }));
  state.store.mockResolvedValue({
    selected: { tenantReference: scope.tenantReference },
    context: { brand: { brandReference: scope.brandReference } },
    store: { storeReference: scope.storeReference },
    actorReference: scope.actorReference,
    allowed,
  });
  state.brand.mockResolvedValue({
    tenantReference: scope.tenantReference,
    context: { brand: { brandReference: scope.brandReference } },
    actorReference: scope.actorReference,
    authorizeAction: action,
  });
  const core = { brandReference: scope.brandReference, sourceRevision: "0", categories: [] };
  state.factory.mockImplementation((input) => ({
    loadSnapshot: async () =>
      input.transactions.run(
        async (tx: Parameters<Options["holdFieldsPolicyAndPhaseUntilCommit"]>[0]) => {
          await input.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            actorReference: scope.actorReference,
            purposeCode: "CATALOG_CATEGORY_SOURCE_READ",
            permission: "catalog.manage",
            capability: input.readCapability,
            requiredFields: categoryPersistenceFields,
            observedAt: now,
          });
          const data = await state.load();
          await input.authority.holdUntilTransactionCompletes(tx, {
            tenantReference: scope.tenantReference,
            brandReference: scope.brandReference,
            actorReference: scope.actorReference,
            purposeCode: "CATALOG_CATEGORY_SOURCE_READ",
            permission: "catalog.manage",
            capability: input.readCapability,
            requiredFields: categoryPersistenceFields,
            observedAt: now,
          });
          return data;
        },
      ),
  }));
  state.load.mockImplementation(async () => {
    expect(held).toBe(true);
    events.push("read");
    return { ...core, observedAt: at, sourceDigest: categorySourceDigest(core) };
  });
  const policy = vi.fn(
    async (...args: Parameters<Options["holdFieldsPolicyAndPhaseUntilCommit"]>) => {
      void args;
      return { allowedLifecycles: ["Draft", "Active"] };
    },
  );
  const options: Options = {
    merchant: {
      now: () => now,
      transactions: {
        async run(work) {
          expect(held).toBe(true);
          events.push("BEGIN");
          try {
            const result = await work({ query: vi.fn(async () => ({ rows: [], rowCount: 0 })) });
            expect(held).toBe(true);
            events.push("COMMIT");
            return result;
          } catch (error) {
            events.push("ROLLBACK");
            throw error;
          }
        },
      },
    } as Options["merchant"],
    authority: {
      async withCurrentProductCategoryLookup(input, work) {
        expect(input).toMatchObject({
          permission: "catalog.manage",
          purposeCode: "CATALOG_PRODUCT_CATEGORY_LOOKUP",
          requiredFields: productCategoryLookupFields,
        });
        held = true;
        events.push("lease");
        try {
          return await work(scope);
        } finally {
          held = false;
          events.push("release");
        }
      },
    },
    holdFieldsPolicyAndPhaseUntilCommit: policy,
    maximumCategoryNodes: 100,
    maximumSourceCommits: 100,
  };
  const request = {
    sessionCookie: "Synthetic opaque credential",
    query: { parentScreenId: "CAT-PRODUCT-CREATE" },
  };
  return {
    options,
    load: createMerchantProductCategoryLookupQuery(options),
    events,
    scope,
    request,
    policy,
    allowed,
    action,
    setNow: (value: string) => {
      now = value;
    },
  };
}
beforeEach(() => {
  Object.values(state).forEach((mock) => mock.mockReset());
});
it.each(["CAT-PRODUCT-CREATE", "CAT-PRODUCT-EDIT"])(
  "holds exact %s parent and field/policy lease through COMMIT",
  async (parent) => {
    const f = setup(),
      result = await f.load({ ...f.request, query: { parentScreenId: parent } });
    expect(result.scope).toEqual({
      brandReference: f.scope.brandReference,
      storeReference: f.scope.storeReference,
    });
    expect(result.lookup).toMatchObject({
      parentScreenId: parent,
      items: [],
      configuration: "Draft",
    });
    expect(f.events).toEqual(["lease", "BEGIN", "read", "COMMIT", "release"]);
    expect(f.policy).toHaveBeenCalledTimes(4);
    expect(f.policy.mock.calls[0]?.[1]).toMatchObject({
      ...f.scope,
      screenId: parent,
      capability:
        parent === "CAT-PRODUCT-CREATE" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
      referencedFields: categoryPersistenceFields,
      requiredFields: productCategoryLookupFields,
    });
    expect(state.factory.mock.calls[0]?.[0].readCapability).toBe(
      parent === "CAT-PRODUCT-CREATE" ? "catalog.cat_product_create" : "catalog.cat_product_edit",
    );
    expect(JSON.stringify(result)).not.toContain(f.scope.actorReference);
  },
);
it.each([
  {},
  { parentScreenId: "CAT-CATEGORY-TREE" },
  { parentScreenId: "CAT-PRODUCT-EDIT", actorReference: id(4) },
])("rejects caller scope/unknown parent before authority %#", async (query) => {
  const f = setup();
  await expect(f.load({ ...f.request, query })).rejects.toMatchObject({ code: "Invalid" });
  expect(f.events).toEqual([]);
  expect(state.factory).not.toHaveBeenCalled();
});
it.each(["brand", "store", "actor"])("denies rebound %s before owner read", async (kind) => {
  const f = setup();
  const data = await state.store();
  if (kind === "brand") data.context.brand.brandReference = id(99);
  if (kind === "store") data.store.storeReference = id(99);
  if (kind === "actor") data.actorReference = id(99);
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(state.load).not.toHaveBeenCalled();
});
it("denies Store permission substituted for Brand catalog.manage", async () => {
  const f = setup();
  f.action.mockResolvedValue({ effect: "Allow", scopeKind: "Store", action: "catalog.manage" });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(state.load).not.toHaveBeenCalled();
});
it.each(["deny", "policy"])("discards read on COMMIT %s", async (kind) => {
  const f = setup();
  let calls = 0;
  f.policy.mockImplementation(async () => {
    if (++calls === 4) {
      if (kind === "deny") throw new CatalogError("CATALOG_PERMISSION_DENIED");
      return { allowedLifecycles: [] };
    }
    return { allowedLifecycles: ["Draft", "Active"] };
  });
  await expect(f.load(f.request)).rejects.toMatchObject({
    code: kind === "deny" ? "Denied" : "Unavailable",
  });
  expect(state.load).toHaveBeenCalledTimes(1);
  expect(f.events).toContain("ROLLBACK");
  expect(f.events).not.toContain("COMMIT");
});
it("rejects missing policy and late scope permission withdrawal", async () => {
  const f = setup();
  f.policy.mockResolvedValue({ allowedLifecycles: ["Archived"] });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  expect(state.load).not.toHaveBeenCalled();
  const g = setup();
  g.allowed
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValueOnce(true)
    .mockResolvedValue(false);
  await expect(g.load(g.request)).rejects.toMatchObject({ code: "Denied" });
  expect(g.events).not.toContain("COMMIT");
});
it("rejects source rebound and result replacement", async () => {
  const f = setup();
  state.load.mockResolvedValue({
    brandReference: id(99),
    categories: [],
    sourceRevision: "0",
    sourceDigest: categorySourceDigest({
      brandReference: id(99),
      categories: [],
      sourceRevision: "0",
    }),
    observedAt: at,
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  const g = setup();
  g.options.authority.withCurrentProductCategoryLookup = async (_input, work) => ({
    ...(await work(g.scope)),
  });
  await expect(g.load(g.request)).rejects.toMatchObject({ code: "Unavailable" });
});
it("rejects duplicate and missing current authority callbacks", async () => {
  const f = setup();
  f.options.authority.withCurrentProductCategoryLookup = async (_input, work) => {
    await work(f.scope);
    return work(f.scope);
  };
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  const g = setup();
  g.options.authority.withCurrentProductCategoryLookup = async () => undefined as never;
  await expect(g.load(g.request)).rejects.toMatchObject({ code: "Unavailable" });
  expect(g.events).toEqual([]);
});
it("rejects freshness exhausted after outer COMMIT", async () => {
  const f = setup();
  const original = f.options.authority.withCurrentProductCategoryLookup;
  f.options.authority.withCurrentProductCategoryLookup = async (input, work) => {
    const result = await original(input, work);
    f.setNow("2026-09-28T12:00:05.001Z");
    return result;
  };
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Stale" });
  expect(f.events).toContain("COMMIT");
});
it("requires trusted provider and bounded source budget at composition", () => {
  const f = setup();
  expect(() =>
    createMerchantProductCategoryLookupQuery({
      ...f.options,
      holdFieldsPolicyAndPhaseUntilCommit: undefined as never,
    }),
  ).toThrow();
  expect(() =>
    createMerchantProductCategoryLookupQuery({ ...f.options, maximumCategoryNodes: 10001 }),
  ).toThrow();
});

it.each(["Deny", "Store", "wrong-action"])(
  "rejects independent Category read %s before lookup fields/source",
  async (kind) => {
    const f = setup();
    f.action.mockImplementation(async (requested) => ({
      effect: requested === "catalog.category.read" && kind === "Deny" ? "Deny" : "Allow",
      scopeKind: requested === "catalog.category.read" && kind === "Store" ? "Store" : "Brand",
      action:
        requested === "catalog.category.read" && kind === "wrong-action"
          ? "catalog.category.manage"
          : requested,
    }));
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
    expect(f.policy).not.toHaveBeenCalled();
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it("drops completed lookup after Category read revocation", async () => {
  const f = setup(),
    original = state.load.getMockImplementation();
  if (!original) throw new Error("Missing source fixture");
  state.load.mockImplementation(async () => {
    const value = await original();
    f.action.mockImplementation(async (requested) => ({
      effect: requested === "catalog.category.read" ? "Deny" : "Allow",
      scopeKind: "Brand",
      action: requested,
    }));
    return value;
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(state.load).toHaveBeenCalledTimes(1);
  expect(f.events).not.toContain("COMMIT");
});
