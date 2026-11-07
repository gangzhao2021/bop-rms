import { beforeEach, expect, it, vi } from "vitest";
import { CatalogProductListError } from "@rms/catalog";
import {
  createMerchantProductListQuery,
  merchantProductListRequiredFields,
  merchantProductListCategoryRequiredFields,
  type MerchantProductListCapability,
} from "./merchant-product-list-query.js";
const scopeMocks = vi.hoisted(() => ({ store: vi.fn(), brand: vi.fn() }));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => scopeMocks.store }));
vi.mock("./merchant-brand-scope.js", () => ({ createMerchantBrandScope: () => scopeMocks.brand }));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-28T12:00:00.000Z";
type Options = Parameters<typeof createMerchantProductListQuery>[0];
function setup() {
  let held = false;
  const events: string[] = [];
  const scope: MerchantProductListCapability = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    actorReference: id(4),
    sessionReference: id(5),
    locale: "en-CA",
  };
  const allowed = vi.fn(async () => true);
  const action = vi.fn(async (requested: string) => ({
    effect: "Allow",
    scopeKind: "Brand",
    action: requested,
  }));
  scopeMocks.store.mockResolvedValue({
    selected: { tenantReference: scope.tenantReference },
    context: { brand: { brandReference: scope.brandReference } },
    store: { storeReference: scope.storeReference },
    actorReference: scope.actorReference,
    allowed,
  });
  scopeMocks.brand.mockResolvedValue({
    tenantReference: scope.tenantReference,
    context: { brand: { brandReference: scope.brandReference } },
    actorReference: scope.actorReference,
    authorizeAction: action,
  });
  const query = vi.fn(async (sql: string) => {
    expect(held).toBe(true);
    if (sql.includes("LEFT JOIN rms_catalog.product_source_head"))
      return {
        rows: [
          {
            generation: {
              generationReference: id(600),
              brandReference: id(2),
              sourceRevision: "0",
              sourceDigest: "sha256:" + "1".repeat(64),
              projectedAt: at,
              productCount: 0,
              coverage: "CatalogProductDraftV1",
              partial: true,
            },
            revision: "0",
            count: "0",
          },
        ],
        rowCount: 1,
      };
    if (sql.includes("WITH source AS")) {
      events.push("owner-read");
      return { rows: [{ asOfUtc: at, items: [] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const tx = { query };
  const runner: Options["merchant"]["transactions"] = {
    async run(work) {
      expect(held).toBe(true);
      events.push("BEGIN");
      const result = await work(tx);
      expect(held).toBe(true);
      events.push("COMMIT");
      return result;
    },
  };
  const lease: Options["authority"] = {
    async withCurrentProductList(input, work) {
      expect(input).toMatchObject({
        action: "catalog.product.manage",
        screenId: "CAT-PRODUCT-LIST",
        capability: "catalog.cat_product_list",
        permission: "catalog.manage",
        purposeCode: "CATALOG_PRODUCT_LIST",
        requiredFields: (input.requiredFields as readonly string[]).includes("category")
          ? merchantProductListCategoryRequiredFields
          : merchantProductListRequiredFields,
      });
      held = true;
      events.push("lease");
      try {
        return await work(scope);
      } finally {
        events.push("release");
        held = false;
      }
    },
  };
  const options: Options = {
    merchant: { transactions: runner, now: () => at } as Options["merchant"],
    authority: lease,
    cursorKey: new Uint8Array(32).fill(17),
  };
  const request = {
    sessionCookie: "synthetic-isolated-cookie",
    filters: {
      search: null,
      lifecycle: null,
      productType: null,
      limit: 50,
      cursor: null,
      includeArchived: false,
      hasActiveSku: null,
      missingTranslationLocale: null,
      updatedFrom: null,
      updatedUntil: null,
      createdFrom: null,
      createdUntil: null,
      sort: "updatedAt",
      direction: "DESC",
    },
  };
  return {
    options,
    request,
    scope,
    events,
    query,
    allowed,
    action,
    load: createMerchantProductListQuery(options),
  };
}
beforeEach(() => vi.resetAllMocks());
it("holds current public authority through SQL COMMIT, derives exact scope and uses Brand permission", async () => {
  const f = setup();
  const result = await f.load(f.request);
  expect(f.events).toEqual(["lease", "BEGIN", "owner-read", "COMMIT", "release"]);
  expect(result.scope).toEqual({ brandReference: id(2), storeReference: id(3) });
  expect(result.locale).toBe("en-CA");
  expect(f.action.mock.calls.length).toBeGreaterThanOrEqual(3);
  expect(scopeMocks.store).toHaveBeenCalledWith(
    expect.anything(),
    f.request.sessionCookie,
    "merchant.access",
    id(5),
  );
  expect(scopeMocks.brand).toHaveBeenCalledWith(expect.anything(), f.request.sessionCookie, id(5));
});
it.each([
  "actorReference",
  "storeReference",
  "tenantReference",
  "brandReference",
  "observedAt",
  "locale",
])("rejects caller authority %s before lease/SQL", async (field) => {
  const f = setup();
  await expect(
    f.load({ ...f.request, filters: { ...f.request.filters, [field]: id(99) } }),
  ).rejects.toMatchObject({ code: "Invalid" });
  expect(f.query).not.toHaveBeenCalled();
  expect(f.events).toEqual([]);
});
it("rejects Store-only permission before owner SQL", async () => {
  const f = setup();
  f.action.mockResolvedValue({
    effect: "Allow",
    scopeKind: "Store",
    action: "catalog.product.manage",
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects mismatched current selected scope before owner SQL", async () => {
  const f = setup();
  scopeMocks.store.mockResolvedValueOnce({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(99) },
    actorReference: id(4),
    allowed: f.allowed,
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.query).not.toHaveBeenCalled();
});
it("discards data when permission is revoked during owner read", async () => {
  const f = setup(),
    original = f.query.getMockImplementation();
  if (!original) throw new Error("Missing SQL fixture");
  f.query.mockImplementation(async (sql) => {
    const result = await original(sql);
    if (sql.includes("WITH source AS"))
      f.action.mockImplementation(async (requested) => ({
        effect: requested === "catalog.product.read" ? "Deny" : "Allow",
        scopeKind: "Brand",
        action: requested,
      }));
    return result;
  });
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.events).toContain("owner-read");
  expect(f.events).not.toContain("COMMIT");
  expect(f.events.at(-1)).toBe("release");
});

it("does not read when Phase authority is unavailable", async () => {
  const f = setup();
  const load = createMerchantProductListQuery({
    ...f.options,
    authority: {
      async withCurrentProductList() {
        throw new CatalogProductListError("FeatureDisabled");
      },
    },
  });
  await expect(load(f.request)).rejects.toMatchObject({ code: "FeatureDisabled" });
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects skipped/repeated authority callback", async () => {
  const f = setup();
  const load = createMerchantProductListQuery({
    ...f.options,
    authority: {
      async withCurrentProductList() {
        return {} as never;
      },
    },
  });
  await expect(load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.query).not.toHaveBeenCalled();
});
it("rejects missing/short signing configuration at composition", () => {
  const f = setup();
  expect(() =>
    createMerchantProductListQuery({ ...f.options, cursorKey: new Uint8Array(2) }),
  ).toThrow(CatalogProductListError);
});

it("rejects a repeated held-authority callback after the first committed read", async () => {
  const f = setup();
  const load = createMerchantProductListQuery({
    ...f.options,
    authority: {
      withCurrentProductList: (input, work) =>
        f.options.authority.withCurrentProductList(input, async (scope) => {
          await work(scope);
          return work(scope);
        }),
    },
  });
  await expect(load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.events.filter((x) => x === "owner-read")).toHaveLength(1);
});

it("rejects authority replacing the scoped committed result", async () => {
  const f = setup();
  const load = createMerchantProductListQuery({
    ...f.options,
    authority: {
      withCurrentProductList: (input, work) =>
        f.options.authority.withCurrentProductList(input, async (scope) => {
          const result = await work(scope);
          return { ...(result as object) } as typeof result;
        }),
    },
  });
  await expect(load(f.request)).rejects.toMatchObject({ code: "Unavailable" });
});

it.each([
  "activeSkuCount",
  "updatedAt",
  "createdAt",
  "internalCode",
  "lifecycle",
  "productReference",
  "name",
  "nameLocale",
  "localeFallback",
  "productType",
  "aggregateVersion",
  "source",
  "skuCount",
  "productLocalizedNames",
  "skuLocalizedNames",
  "skuCode",
])("denies missing %s coverage before SQL", async (missingField) => {
  const f = setup();
  const load = createMerchantProductListQuery({
    ...f.options,
    authority: {
      async withCurrentProductList(input, work) {
        expect(input.requiredFields).toEqual([
          "activeSkuCount",
          "updatedAt",
          "createdAt",
          "internalCode",
          "lifecycle",
          "productReference",
          "name",
          "nameLocale",
          "localeFallback",
          "productType",
          "aggregateVersion",
          "source",
          "skuCount",
          "productLocalizedNames",
          "skuLocalizedNames",
          "skuCode",
        ]);
        expect(input.requiredFields).toContain(missingField);
        expect(Object.isFrozen(input.requiredFields)).toBe(true);
        const permitted = new Set(
          [
            "activeSkuCount",
            "updatedAt",
            "createdAt",
            "internalCode",
            "lifecycle",
            "productReference",
            "name",
            "nameLocale",
            "localeFallback",
            "productType",
            "aggregateVersion",
            "source",
            "skuCount",
            "productLocalizedNames",
            "skuLocalizedNames",
            "skuCode",
          ].filter((field) => field !== missingField),
        );
        if (input.requiredFields.some((field) => !permitted.has(field)))
          throw new CatalogProductListError("Denied");
        return f.options.authority.withCurrentProductList(input, work);
      },
    },
  });
  await expect(
    load({
      ...f.request,
      filters: { ...f.request.filters, hasActiveSku: true, missingTranslationLocale: "fr-CA" },
    }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(f.query).not.toHaveBeenCalled();
});

it.each(["fr_ca", "", 1, " fr-CA"])(
  "rejects invalid missing translation locale %j before owner SQL",
  async (missingTranslationLocale) => {
    const f = setup();
    await expect(
      createMerchantProductListQuery(f.options)({
        ...f.request,
        filters: { ...f.request.filters, missingTranslationLocale },
      }),
    ).rejects.toMatchObject({ code: "Invalid" });
    expect(f.query).not.toHaveBeenCalled();
  },
);

it("rejects Category filtering with unconfigured public source authority instead of an empty normal HTTP view", async () => {
  const f = setup();
  await expect(
    f.load({ ...f.request, filters: { ...f.request.filters, categoryReference: id(10) } }),
  ).rejects.toMatchObject({ code: "Unavailable" });
  expect(f.events).not.toContain("owner-read");
  expect(f.events).not.toContain("COMMIT");
});
it("accepts explicit-null Category filter without requiring classification grants", async () => {
  const f = setup();
  expect(
    (await f.load({ ...f.request, filters: { ...f.request.filters, categoryReference: null } }))
      .items,
  ).toEqual([]);
  expect(f.events).toContain("COMMIT");
});

it("requires Product Screen Category fields in the normal purpose before any SQL, independently of source grants", async () => {
  const f = setup();
  const withCurrentProductList = vi.fn(
    async (input: Parameters<Options["authority"]["withCurrentProductList"]>[0]) => {
      expect(input.screenId).toBe("CAT-PRODUCT-LIST");
      expect(input.purposeCode).toBe("CATALOG_PRODUCT_LIST");
      expect(input.requiredFields).toEqual(merchantProductListCategoryRequiredFields);
      throw new CatalogProductListError("Denied");
    },
  );
  const load = createMerchantProductListQuery({
    ...f.options,
    authority: { withCurrentProductList },
  });
  await expect(
    load({ ...f.request, filters: { ...f.request.filters, categoryReference: id(10) } }),
  ).rejects.toMatchObject({ code: "Denied" });
  expect(f.query).not.toHaveBeenCalled();
});

it.each(["catalog.manage", "catalog.product.manage", "catalog.product.read", "catalog.sku.read"])(
  "requires independent %s before list source",
  async (required) => {
    const f = setup();
    f.action.mockImplementation(async (requested) => ({
      effect: requested === required ? "Deny" : "Allow",
      scopeKind: "Brand",
      action: requested,
    }));
    await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
    expect(f.query).not.toHaveBeenCalled();
  },
);
it.each(["Store", "wrong-action"])("does not accept %s read evidence", async (kind) => {
  const f = setup();
  f.action.mockImplementation(async (requested) => ({
    effect: "Allow",
    scopeKind: requested === "catalog.sku.read" && kind === "Store" ? "Store" : "Brand",
    action:
      requested === "catalog.sku.read" && kind === "wrong-action"
        ? "catalog.sku.update"
        : requested,
  }));
  await expect(f.load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.query).not.toHaveBeenCalled();
});
it("captures related Category source and cannot drop its read permission through reconfiguration", async () => {
  const f = setup();
  Object.assign(f.options, {
    categorySource: {
      authority: { holdUntilTransactionCompletes: vi.fn() },
      maximumCategoryNodes: 100,
      maximumSourceCommits: 100,
    },
  });
  const load = createMerchantProductListQuery(f.options);
  Object.assign(f.options, { categorySource: undefined });
  f.action.mockImplementation(async (requested) => ({
    effect: requested === "catalog.category.read" ? "Deny" : "Allow",
    scopeKind: "Brand",
    action: requested,
  }));
  await expect(load(f.request)).rejects.toMatchObject({ code: "Denied" });
  expect(f.query).not.toHaveBeenCalled();
});
