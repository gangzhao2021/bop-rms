import { beforeEach, expect, it, vi } from "vitest";
import {
  createPostgresProductDraftBaselineStore,
  productDraftBaselineFields,
  productDraftBaselineReferencedFields,
  CatalogError,
  parseProductAggregate,
} from "../index.js";
const state = vi.hoisted(() => ({ factory: vi.fn(), load: vi.fn() }));
vi.mock("../infrastructure/persistence/product-lifecycle-store.js", async (original) => ({
  ...(await original<typeof import("../infrastructure/persistence/product-lifecycle-store.js")>()),
  createPostgresProductLifecycleStore: (...args: unknown[]) => state.factory(...args),
}));
const id = (n: number) => "01902409-0000-7000-8000-" + n.toString(16).padStart(12, "0"),
  at = "2026-09-28T12:00:00.000Z";
function aggregate(classified = true) {
  return parseProductAggregate({
    productReference: id(1),
    brandReference: id(2),
    internalCode: "DRAFT_1",
    productType: "PreparedFood",
    lifecycle: "Draft",
    aggregateVersion: 1,
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
      ...(classified
        ? { categoryClassification: { categoryReferences: [], primaryCategoryReference: null } }
        : {}),
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
        createdByActorReference: id(3),
      })),
      optionBindings: [],
    },
  });
}
type Options = Parameters<typeof createPostgresProductDraftBaselineStore>[0];
// Unit owner reader double; current persisted SQL is separate database acceptance.
function setup() {
  let now = at;
  const events: string[] = [],
    sql = vi.fn(async () => ({ rows: [], rowCount: 0 })),
    tx = { query: sql },
    hold = vi.fn<Options["authority"]["holdUntilTransactionCompletes"]>(async () => {
      events.push("hold");
    }),
    classification = vi.fn(async () => {
      events.push("classification");
    });
  const options: Options = {
    tenantReference: id(90),
    brandReference: id(2),
    actorReference: id(3),
    transactions: {
      async run(work) {
        events.push("BEGIN");
        try {
          const result = await work(tx);
          events.push("COMMIT");
          return result;
        } catch (error) {
          events.push("ROLLBACK");
          throw error;
        }
      },
    },
    authority: { holdUntilTransactionCompletes: hold },
    categoryAssignments: { holdUntilTransactionCompletes: classification },
    clock: { now: () => now },
    maximumSkus: 100,
    maximumOptionBindings: 100,
  };
  state.load.mockResolvedValue(aggregate());
  state.factory.mockImplementation((input) => ({
    load: async (product: string) =>
      input.transactions.run(async (actual: typeof tx) => {
        expect(await input.authorize(actual, { productReference: product })).toBe(true);
        events.push("read");
        const result = await state.load();
        if (result?.draft.categoryClassification !== undefined) {
          if (!input.categoryAssignments) throw new CatalogError("CATALOG_DEPENDENCY_UNAVAILABLE");
          await input.categoryAssignments.holdUntilTransactionCompletes(actual, {
            mode: "Read",
            aggregate: result,
          });
        }
        expect(await input.authorize(actual, { productReference: product })).toBe(true);
        return result;
      }),
  }));
  return {
    options,
    source: createPostgresProductDraftBaselineStore(options),
    events,
    sql,
    tx,
    hold,
    classification,
    setNow: (value: string) => {
      now = value;
    },
  };
}
beforeEach(() => {
  state.factory.mockReset();
  state.load.mockReset();
});
it("holds exact parent/full source fields around current owner read and preserves Draft", async () => {
  const f = setup(),
    value = await f.source.loadBaseline(id(1));
  expect(value?.draft).toEqual(aggregate().draft);
  expect(f.events).toEqual(["BEGIN", "hold", "hold", "read", "classification", "hold", "COMMIT"]);
  expect(f.hold).toHaveBeenCalledTimes(3);
  expect(f.hold.mock.calls[0]?.[1]).toMatchObject({
    tenantReference: id(90),
    brandReference: id(2),
    actorReference: id(3),
    productReference: id(1),
    purposeCode: "CATALOG_PRODUCT_DRAFT_BASELINE_READ",
    permission: "catalog.manage",
    action: "catalog.product.manage",
    capability: "catalog.cat_product_edit",
    requiredFields: productDraftBaselineFields,
    referencedFields: productDraftBaselineReferencedFields,
  });
  expect(f.sql).toHaveBeenCalledWith(
    "SELECT set_config('lock_timeout','5000',true),set_config('statement_timeout','5000',true)",
    [],
  );
  expect(f.classification).toHaveBeenCalledWith(f.tx, { mode: "Read", aggregate: aggregate() });
});
it("authorized missing target returns null after final holder, never synthetic empty baseline", async () => {
  const f = setup();
  state.load.mockResolvedValue(null);
  expect(await f.source.loadBaseline(id(1))).toBeNull();
  expect(f.hold).toHaveBeenCalledTimes(3);
  expect(f.classification).not.toHaveBeenCalled();
});
it.each([1, 3])(
  "denies initial/final field lease %i with no successful COMMIT",
  async (attempt) => {
    const f = setup();
    let calls = 0;
    f.hold.mockImplementation(async () => {
      if (++calls === attempt) throw new CatalogError("CATALOG_PERMISSION_DENIED");
    });
    await expect(f.source.loadBaseline(id(1))).rejects.toMatchObject({
      code: "CATALOG_PERMISSION_DENIED",
    });
    expect(f.events).toContain("ROLLBACK");
    expect(f.events).not.toContain("COMMIT");
    if (attempt === 1) {
      expect(f.sql).not.toHaveBeenCalled();
      expect(state.load).not.toHaveBeenCalled();
    }
  },
);
it("missing classified access fails while legacy absence stays absent", async () => {
  const f = setup(),
    legacyOptions = { ...f.options };
  delete legacyOptions.categoryAssignments;
  const source = createPostgresProductDraftBaselineStore(legacyOptions);
  await expect(source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  state.load.mockResolvedValue(aggregate(false));
  const view = await source.loadBaseline(id(1));
  expect(view?.classificationCoverage).toBe("Unavailable");
  expect(Object.hasOwn(view?.draft ?? {}, "categoryClassification")).toBe(false);
});
it("rejects read classification policy denial and rebound exact target", async () => {
  const f = setup();
  f.classification.mockRejectedValue(new CatalogError("CATALOG_PERMISSION_DENIED"));
  await expect(f.source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_PERMISSION_DENIED",
  });
  const g = setup();
  state.load.mockResolvedValue({
    ...aggregate(),
    productReference: id(99),
    draft: {
      ...aggregate().draft,
      skus: aggregate().draft.skus.map((sku) => ({ ...sku, productReference: id(99) })),
    },
  });
  await expect(g.source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
});
it("fails finite SKU budget instead of truncating complete draft", async () => {
  const f = setup(),
    source = createPostgresProductDraftBaselineStore({ ...f.options, maximumSkus: 1 });
  await expect(source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toContain("ROLLBACK");
});
it("rejects age exhausted at actual outer completion", async () => {
  const f = setup(),
    original = f.options.transactions.run;
  const source = createPostgresProductDraftBaselineStore({
    ...f.options,
    transactions: {
      async run(work) {
        const result = await original(work);
        f.setNow("2026-09-28T12:00:05.001Z");
        return result;
      },
    },
  });
  await expect(source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.events).toContain("COMMIT");
});
it("bounds driver detail and validates malformed target before SQL", async () => {
  const f = setup();
  state.load.mockRejectedValue(new Error("SYNTHETIC_PRIVATE_SQL"));
  await expect(f.source.loadBaseline(id(1))).rejects.toMatchObject({
    message: "catalog is unavailable",
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  const g = setup();
  await expect(g.source.loadBaseline("caller-unrestricted-id")).rejects.toMatchObject({
    code: "CATALOG_INPUT_INVALID",
  });
  expect(g.events).toEqual([]);
});
it("requires current holder and valid finite budgets at composition", () => {
  const f = setup();
  expect(() =>
    createPostgresProductDraftBaselineStore({ ...f.options, authority: undefined as never }),
  ).toThrow();
  expect(() =>
    createPostgresProductDraftBaselineStore({ ...f.options, maximumSkus: 10001 }),
  ).toThrow();
  expect(() =>
    createPostgresProductDraftBaselineStore({ ...f.options, categoryAssignments: null as never }),
  ).toThrow();
});

it("keeps exact Brand/target binding even for legacy unknown classification", async () => {
  const f = setup(),
    legacy = aggregate(false);
  state.load.mockResolvedValue({
    ...legacy,
    productReference: id(99),
    draft: {
      ...legacy.draft,
      skus: legacy.draft.skus.map((sku) => ({ ...sku, productReference: id(99) })),
    },
  });
  await expect(f.source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.classification).not.toHaveBeenCalled();
});
it("captures configured classification holder rather than silently skipping a removed option", async () => {
  const f = setup();
  Object.assign(f.options, { categoryAssignments: undefined });
  expect((await f.source.loadBaseline(id(1)))?.classificationCoverage).toBe("Known");
  expect(f.classification).toHaveBeenCalledTimes(1);
});
it("treats malformed trusted clock as unavailable instead of caller input error", async () => {
  const f = setup();
  f.setNow("malformed-synthetic-clock");
  await expect(f.source.loadBaseline(id(1))).rejects.toMatchObject({
    code: "CATALOG_DEPENDENCY_UNAVAILABLE",
  });
  expect(f.sql).not.toHaveBeenCalled();
});
