import { beforeEach, expect, it, vi } from "vitest";
import { StockReservationStoreError } from "@rms/inventory";
import { createCustomerRecipeInventoryObservation } from "./customer-recipe-inventory-observation.js";
const f = vi.hoisted(() => ({
  sku: vi.fn(),
  recipe: vi.fn(),
  stock: vi.fn(),
  runners: [] as unknown[],
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresCurrentSkuStore: (runner: unknown) => {
    f.runners.push(runner);
    return { load: f.sku };
  },
}));
vi.mock("@rms/recipe", async (original) => ({
  ...(await original<typeof import("@rms/recipe")>()),
  createPostgresSaleRecipeDemandSource: (runner: unknown) => {
    f.runners.push(runner);
    return { resolve: f.recipe };
  },
}));
vi.mock("@rms/inventory", async (original) => ({
  ...(await original<typeof import("@rms/inventory")>()),
  createPostgresRecipeStockPlanSource: (runner: unknown) => {
    f.runners.push(runner);
    return { resolve: f.stock };
  },
}));
const id = (n: number) => "01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-19T09:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  stockSiteReference: id(4),
};
const requirement = {
  itemReference: id(8),
  itemVersionReference: id(9),
  unitDimension: "Mass",
  quantityNumerator: "1250000",
  quantityDenominator: "1",
};
beforeEach(() => {
  vi.resetAllMocks();
  f.runners.length = 0;
  f.sku.mockResolvedValue({ catalogEligible: true, unitOfSale: "PORTION", unitQuantity: "2.5" });
  f.recipe.mockResolvedValue({ requirements: [requirement] });
  f.stock.mockResolvedValue({ allocations: [] });
});
function setup() {
  const tx = { query: vi.fn(async () => ({ rows: [] })) };
  const run = vi.fn();
  const authorize = vi.fn(async () => true);
  const source = createCustomerRecipeInventoryObservation({
    scope,
    transactions: {
      run: async (work) => {
        run();
        return work(tx);
      },
    },
    authorize,
    resolveExpiryCutoff: async () => {
      throw new Error("No expiry fixture");
    },
  });
  const input = {
    sellableReference: id(5),
    productVersionReference: id(6),
    quantity: 2,
    selections: [
      { bindingReference: id(10) as never, optionReference: id(11) as never, quantity: 1 },
    ],
    observedAt: at,
  };
  return { source, input, tx, run, authorize };
}
it("passes actual SKU sale units, selected quantity and options through one retained transaction", async () => {
  const x = setup();
  expect(await x.source.observe(x.input)).toMatchObject({
    status: "Available",
    ...scope,
    quantity: 2,
  });
  expect(f.recipe).toHaveBeenCalledWith({
    storeReference: scope.storeReference,
    skuReference: id(5),
    occurredAt: at,
    saleUnitCode: "PORTION",
    unitQuantity: "2.5",
    saleQuantity: 2,
    selections: x.input.selections,
  });
  expect(f.stock).toHaveBeenCalledWith(
    {
      ...scope,
      contributions: [
        {
          itemReference: id(8),
          configurationOperationReference: id(9),
          unitDimension: "Mass",
          quantityNumerator: "1250000",
          quantityDenominator: "1",
        },
      ],
    },
    at,
  );
  expect(x.run).toHaveBeenCalledOnce();
  expect(x.authorize).toHaveBeenCalledTimes(2);
  for (const runner of f.runners) {
    await (runner as { run: (work: (tx: unknown) => Promise<void>) => Promise<void> }).run(
      async (tx) => {
        expect(tx).toBe(x.tx);
      },
    );
  }
});
it("reports only authoritative stock insufficiency as unavailable", async () => {
  const x = setup();
  f.stock.mockRejectedValue(new StockReservationStoreError("STOCK_RESERVATION_INSUFFICIENT"));
  expect(await x.source.observe(x.input)).toMatchObject({ status: "Unavailable" });
  f.stock.mockRejectedValue(new Error("private SQL detail"));
  await expect(x.source.observe(x.input)).rejects.toThrow("Inventory observation unavailable");
});
it("rejects withdrawn authority before exposing an observation", async () => {
  const x = setup();
  x.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(x.source.observe(x.input)).rejects.toMatchObject({
    code: "CUSTOMER_INVENTORY_OBSERVATION_UNAVAILABLE",
  });
  const denied = setup();
  denied.authorize.mockResolvedValue(false);
  f.sku.mockClear();
  await expect(denied.source.observe(denied.input)).rejects.toThrow(
    "Inventory observation unavailable",
  );
  expect(f.sku).not.toHaveBeenCalled();
});
it("does not interpret invalid or missing selection/SKU facts as zero inventory demand", async () => {
  const x = setup();
  await expect(x.source.observe({ ...x.input, quantity: 0 })).rejects.toThrow();
  expect(x.run).not.toHaveBeenCalled();
  f.sku.mockResolvedValue(null);
  await expect(x.source.observe(x.input)).rejects.toThrow();
  expect(f.recipe).not.toHaveBeenCalled();
  expect(f.stock).not.toHaveBeenCalled();
});
