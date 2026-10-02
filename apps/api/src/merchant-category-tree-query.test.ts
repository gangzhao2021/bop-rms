import { beforeEach, expect, it, vi } from "vitest";
import {
  categoryTreeViewFields,
  categoryTreeMenuViewFields,
  productClassificationSourceFields,
  CatalogError,
  parseCatalogCategoryTreeQueryView,
  type CatalogCategoryTreeQueryView,
} from "@rms/catalog";
import {
  createMerchantCategoryTreeQuery,
  MerchantCategoryTreeError,
  type MerchantCategoryTreeSelection,
} from "./merchant-category-tree-query.js";
const state = vi.hoisted(() => ({
  store: vi.fn(),
  brand: vi.fn(),
  load: vi.fn(),
  factory: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => state.store }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => state.brand }));
vi.mock("@rms/catalog", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/catalog")>()),
  createPostgresProductSearchGenerationStore: (...args: unknown[]) => state.factory(...args),
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T12:00:00.000Z";
const filters = {
  search: null,
  lifecycle: null,
  productUsage: null,
  includeArchivedProducts: false,
} as const;
type Options = Parameters<typeof createMerchantCategoryTreeQuery>[0];
function query(menu = false): CatalogCategoryTreeQueryView {
  return parseCatalogCategoryTreeQueryView({
    filters,
    matchedCategoryReferences: [],
    tree: {
      projection: {
        name: "catalog_category_tree_v1",
        version: 1,
        asOfUtc: at,
        stale: false,
        partial: true,
      },
      brandReference: id(2),
      locale: "en-CA",
      configuration: "Draft",
      classificationCoverage: "Known",
      source: {
        ...(menu
          ? {
              menu: {
                digest: "sha256:" + "3".repeat(64),
                asOfUtc: at,
                consistency: "StatementSnapshot",
                reviewCategoryCoverage: "Known",
              },
            }
          : {}),
        category: { revision: "0", digest: "sha256:" + "1".repeat(64), asOfUtc: at },
        products: {
          generationReference: id(600),
          revision: "0",
          digest: "sha256:" + "2".repeat(64),
          asOfUtc: at,
        },
      },
      items: [],
    },
  });
}
// Scope/owner result are unit doubles; actual owner SQL and current authority are separate acceptances.
function setup(includeMenuUse = false) {
  let held = false;
  const events: string[] = [];
  const scope: MerchantCategoryTreeSelection = {
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
  state.load.mockImplementation(async () => {
    expect(held).toBe(true);
    events.push("owner-read");
    return query(includeMenuUse);
  });
  state.factory.mockReturnValue({ loadCategoryTreeQuery: state.load });
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const options: Options = {
    includeMenuUse,
    merchant: {
      now: () => at,
      transactions: {
        async run(work) {
          expect(held).toBe(true);
          events.push("BEGIN");
          try {
            const result = await work(tx);
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
      async withCurrentCategoryTree(input, work) {
        expect(input).toMatchObject({
          screenId: "CAT-CATEGORY-TREE",
          permission: "catalog.manage",
          action: "catalog.manage",
          purposeCode: "CATALOG_CATEGORY_TREE",
          capability: "catalog.cat_category_tree",
          referencedCapability: "catalog.cat_product_list",
          requiredFields: includeMenuUse ? categoryTreeMenuViewFields : categoryTreeViewFields,
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
    createProductSourceAuthority: vi.fn(() => ({
      holdUntilTransactionCompletes: vi.fn(async () => undefined),
    })),
    holdCategoryFieldsAndPhaseUntilCommit: vi.fn(async () => undefined),
    maximumProducts: 100,
    maximumCategoryNodes: 100,
    maximumSourceCommits: 100,
  };
  return {
    options,
    load: createMerchantCategoryTreeQuery(options),
    scope,
    events,
    allowed,
    action,
    tx,
  };
}
beforeEach(() => {
  for (const mock of Object.values(state)) mock.mockReset();
});
it("holds normal current scope/purpose through actual host COMMIT and returns Brand-owned tree with selected Store context", async () => {
  const f = setup(),
    result = await f.load({ sessionCookie: "Synthetic opaque credential", filters });
  expect(result.scope).toEqual({
    brandReference: f.scope.brandReference,
    storeReference: f.scope.storeReference,
  });
  expect(result.query).toEqual(query());
  expect(f.events).toEqual(["lease", "BEGIN", "owner-read", "COMMIT", "release"]);
  expect(state.load).toHaveBeenCalledWith("en-CA", filters);
  expect(f.options.createProductSourceAuthority).toHaveBeenCalledWith({
    ...f.scope,
    sessionCookie: "Synthetic opaque credential",
  });
  const built = state.factory.mock.calls[0]?.[0];
  expect(built).toMatchObject({
    tenantReference: f.scope.tenantReference,
    brandReference: f.scope.brandReference,
    actorReference: f.scope.actorReference,
    maximumProducts: 100,
  });
  expect(built.categorySource.authority).toBe(built.categorySource.treeAuthority);
  expect(Object.isFrozen(result.scope)).toBe(true);
});
it.each([
  { actorReference: id(99) },
  { usage: "Empty" },
  { search: "" },
  { productUsage: "Unknown" },
])(
  "rejects malformed/caller authority filters before current purpose or SQL %j",
  async (change) => {
    const f = setup();
    await expect(
      f.load({ sessionCookie: "Synthetic opaque credential", filters: { ...filters, ...change } }),
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(f.events).toEqual([]);
    expect(state.factory).not.toHaveBeenCalled();
  },
);
it("denies equivalent Store permission before owner reads", async () => {
  const f = setup();
  f.action.mockResolvedValue({ effect: "Allow", scopeKind: "Store", action: "catalog.manage" });
  await expect(f.load({ sessionCookie: "Synthetic", filters })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(f.events).toContain("ROLLBACK");
  expect(state.load).not.toHaveBeenCalled();
});
it("rechecks permission before COMMIT and discards already-read data", async () => {
  const f = setup();
  f.allowed.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.load({ sessionCookie: "Synthetic", filters })).rejects.toMatchObject({
    code: "Denied",
  });
  expect(state.load).toHaveBeenCalledTimes(1);
  expect(f.events).toContain("ROLLBACK");
  expect(f.events).not.toContain("COMMIT");
});
it("rejects rebound owning Brand and changed filter echo", async () => {
  const f = setup();
  state.load.mockResolvedValue({ ...query(), tree: { ...query().tree, brandReference: id(99) } });
  await expect(f.load({ sessionCookie: "Synthetic", filters })).rejects.toMatchObject({
    code: "Denied",
  });
  const g = setup();
  state.load.mockResolvedValue({ ...query(), filters: { ...filters, lifecycle: "Active" } });
  await expect(g.load({ sessionCookie: "Synthetic", filters })).rejects.toMatchObject({
    code: "Unavailable",
  });
});
it.each(["Denied", "FeatureDisabled", "Stale"] as const)(
  "preserves normal current %s rejection before source query",
  async (code) => {
    const f = setup();
    f.options.authority.withCurrentCategoryTree = async () => {
      throw new MerchantCategoryTreeError(code);
    };
    await expect(
      createMerchantCategoryTreeQuery(f.options)({ sessionCookie: "Synthetic", filters }),
    ).rejects.toMatchObject({ code });
    expect(state.load).not.toHaveBeenCalled();
  },
);
it("requires independently configured source and field/Phase holders", () => {
  const f = setup();
  for (const key of [
    "createProductSourceAuthority",
    "holdCategoryFieldsAndPhaseUntilCommit",
  ] as const)
    expect(() =>
      createMerchantCategoryTreeQuery({ ...f.options, [key]: undefined } as unknown as Options),
    ).toThrow(MerchantCategoryTreeError);
});
it("rejects filter getters without executing them", async () => {
  const f = setup(),
    getter = vi.fn(() => null),
    value = { ...filters };
  Object.defineProperty(value, "search", { enumerable: true, get: getter });
  await expect(f.load({ sessionCookie: "Synthetic", filters: value })).rejects.toMatchObject({
    code: "Invalid",
  });
  expect(getter).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});

it("rechecks the independently configured Product source fields before COMMIT", async () => {
  const f = setup();
  const sourceHold = vi.fn(async () => undefined);
  sourceHold
    .mockImplementationOnce(async () => undefined)
    .mockImplementationOnce(async () => {
      throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
  f.options.createProductSourceAuthority = () => ({ holdUntilTransactionCompletes: sourceHold });
  state.load.mockImplementation(async () => {
    const built = state.factory.mock.calls.at(-1)?.[0];
    if (!built) throw new Error("missing synthetic owner adapter");
    await built.transactions.run(async (tx: unknown) => {
      await built.authorization.holdUntilTransactionCompletes(tx, {
        tenantReference: f.scope.tenantReference,
        brandReference: f.scope.brandReference,
        actorReference: f.scope.actorReference,
        purposeCode: "CATALOG_PRODUCT_CATEGORY_SOURCE_READ",
        permission: "catalog.manage",
        capability: "catalog.cat_product_list",
        sourceProtocolVersion: 1,
        requiredFields: productClassificationSourceFields,
        observedAt: at,
      });
    });
    return query();
  });
  await expect(
    createMerchantCategoryTreeQuery(f.options)({ sessionCookie: "Synthetic", filters }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(sourceHold).toHaveBeenCalledTimes(2);
  expect(f.events).toContain("ROLLBACK");
  expect(f.events).not.toContain("COMMIT");
});

it("requires extended tree fields and supplies owning Menu authority only when configured", async () => {
  const f = setup(true);
  const result = await f.load({ sessionCookie: "Synthetic opaque credential", filters });
  expect(result.query.tree.source.menu?.consistency).toBe("StatementSnapshot");
  expect(
    state.factory.mock.calls[0]?.[0].categorySource.menuAuthority.holdUntilTransactionCompletes,
  ).toEqual(expect.any(Function));
});
it("rejects missing configured Menu evidence", async () => {
  const f = setup(true);
  state.load.mockResolvedValue(query());
  await expect(
    f.load({ sessionCookie: "Synthetic opaque credential", filters }),
  ).rejects.toMatchObject({ code: "Unavailable" });
});
it.each([false, true])(
  "rejects aging through outer authority completion with Menu configured %s",
  async (configured) => {
    const f = setup(configured);
    let clock = at;
    const original = f.options.authority;
    const load = createMerchantCategoryTreeQuery({
      ...f.options,
      merchant: { ...f.options.merchant, now: () => clock },
      authority: {
        async withCurrentCategoryTree(input, work) {
          const result = await original.withCurrentCategoryTree(input, work);
          clock = "2026-09-28T12:00:05.001Z";
          return result;
        },
      },
    });
    await expect(
      load({ sessionCookie: "Synthetic opaque credential", filters }),
    ).rejects.toMatchObject({ code: "Stale" });
    expect(f.events).toContain("COMMIT");
  },
);

it.each(["catalog.category.read", "catalog.product.read"])(
  "requires independent %s for tree with Product counts",
  async (required) => {
    for (const kind of ["Deny", "Store", "wrong-action"]) {
      const f = setup();
      f.action.mockImplementation(async (requested) => ({
        effect: requested === required && kind === "Deny" ? "Deny" : "Allow",
        scopeKind: requested === required && kind === "Store" ? "Store" : "Brand",
        action: requested === required && kind === "wrong-action" ? "catalog.manage" : requested,
      }));
      await expect(
        f.load({ sessionCookie: "Synthetic opaque credential", filters }),
      ).rejects.toMatchObject({ code: "Denied" });
      expect(state.factory).not.toHaveBeenCalled();
    }
  },
);
it.each(["catalog.category.read", "catalog.product.read"])(
  "drops completed tree after %s revocation",
  async (required) => {
    const f = setup();
    state.load.mockImplementation(async () => {
      f.action.mockImplementation(async (requested) => ({
        effect: requested === required ? "Deny" : "Allow",
        scopeKind: "Brand",
        action: requested,
      }));
      return query();
    });
    await expect(
      f.load({ sessionCookie: "Synthetic opaque credential", filters }),
    ).rejects.toMatchObject({ code: "Denied" });
    expect(state.load).toHaveBeenCalledTimes(1);
    expect(f.events).not.toContain("COMMIT");
  },
);
