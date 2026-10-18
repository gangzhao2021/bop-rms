import { beforeEach, expect, it, vi } from "vitest";
import type { CurrentCatalogSelectionSnapshot } from "@rms/catalog";
import {
  createCustomerCartSelectionInventory,
  createCustomerCartStockCoverage,
  withCartItemStockShortage,
} from "./customer-cart-selection-inventory.js";
import type { CustomerCartPort } from "./customer-cart.js";
const f = vi.hoisted(() => ({
  resolve: vi.fn(),
  observe: vi.fn(),
  covers: vi.fn(),
  authorizers: [] as unknown[],
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresCurrentSelectionFactsStore: () => ({ load: vi.fn() }),
  createPostgresAvailabilityQueryStore: () => ({}),
  createCurrentAvailabilityQueryService: () => ({}),
  createCurrentCatalogSelectionSource: () => ({ resolveCurrent: f.resolve }),
}));
vi.mock("./customer-recipe-inventory-observation.js", () => ({
  createCustomerRecipeInventoryObservation: (options: { authorize: unknown }) => {
    f.authorizers.push(options.authorize);
    return { observe: f.observe };
  },
  createCustomerRecipeInventoryCoverage: (options: { authorize: unknown }) => {
    f.authorizers.push(options.authorize);
    return { covers: f.covers };
  },
}));
const id = (n: number) => ("01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0")) as never;
const at = "2026-09-19T09:00:00.000Z" as never;
const scope = {
  brandReference: id(1),
  storeReference: id(2),
  menuReference: id(3),
  sourceChannel: "Web",
  orderType: "Pickup",
  channelCode: "WEB",
  orderTypeCode: "PICKUP",
} as const;
const input = {
  brandReference: id(1),
  storeReference: id(2),
  sourceChannel: "Web",
  orderType: "Pickup",
  sellableReference: id(4),
  optionSelections: [{ optionReference: id(5), quantity: 2 }],
  observedAt: at,
} as const;
const context = {
  diningSessionReference: null,
  cartReference: id(9),
  cartVersion: 3,
  guestSessionReference: id(10),
  quantity: 7,
};
function snapshot(): CurrentCatalogSelectionSnapshot {
  return {
    brandReference: input.brandReference,
    storeReference: input.storeReference,
    sourceChannel: input.sourceChannel,
    orderType: input.orderType,
    sellableReference: input.sellableReference,
    availability: "Available",
    freshnessStatus: "Fresh",
    menuVersionReference: id(6),
    productVersionReference: id(7),
    catalogChannelCode: "WEB",
    catalogOrderTypeCode: "PICKUP",
    effectiveFrom: at,
    effectiveUntil: null,
    resolvedAt: at,
    rules: [
      {
        bindingReference: id(8),
        optionSetVersionReference: id(11),
        activationOptionReferences: [],
        minimumQuantity: 0,
        maximumQuantity: 3,
        options: [{ optionReference: id(5), maximumQuantity: 3, conflictOptionReferences: [] }],
      },
    ],
  };
}
function setup() {
  const authorize = vi.fn(async () => true);
  const runner = { run: vi.fn() };
  const service = createCustomerCartSelectionInventory(
    runner,
    scope,
    {
      clock: { now: () => at },
      killSwitch: {} as never,
      inventory: {} as never,
    },
    {
      scope: {
        tenantReference: id(12),
        brandReference: id(1),
        storeReference: id(2),
        stockSiteReference: id(13),
      },
      transactions: runner,
      authorize,
      resolveExpiryCutoff: vi.fn(),
    },
  );
  return { service, authorize };
}
beforeEach(() => {
  vi.resetAllMocks();
  f.authorizers.length = 0;
  f.resolve.mockImplementation(async () => snapshot());
  f.observe.mockResolvedValue({ status: "Available" });
});
it("uses the accepted product, exact binding/options and target quantity with current authority", async () => {
  const { service, authorize } = setup();
  expect((await service.validateSelection(input, context)).status).toBe("Accepted");
  const expected = {
    sellableReference: id(4),
    productVersionReference: id(7),
    quantity: 7,
    selections: [{ bindingReference: id(8), optionReference: id(5), quantity: 2 }],
    observedAt: at,
  };
  expect(f.observe).toHaveBeenCalledWith(expected);
  const tx = {};
  await (f.authorizers[0] as (tx: unknown, input: unknown) => Promise<boolean>)(tx, expected);
  expect(authorize).toHaveBeenCalledWith(tx, expected, context);
});
it("rejects invalid Catalog options before Inventory", async () => {
  const { service } = setup();
  expect(
    await service.validateSelection(
      { ...input, optionSelections: [{ optionReference: id(99), quantity: 1 }] },
      context,
    ),
  ).toEqual({ status: "Rejected", reason: "OPTION_NOT_ENABLED" });
  expect(f.observe).not.toHaveBeenCalled();
});
it("rejects stock shortage and propagates unavailable observations", async () => {
  const { service } = setup();
  f.observe.mockResolvedValueOnce({ status: "Unavailable" });
  expect(await service.validateSelection(input, context)).toEqual({
    status: "Rejected",
    reason: "SELLABLE_UNAVAILABLE",
  });
  f.observe.mockRejectedValueOnce(new Error("unavailable"));
  await expect(service.validateSelection(input, context)).rejects.toThrow("unavailable");
});
it("WP-2423: a Cart change the stock can't make says how many it can (instead of a bare refusal)", async () => {
  const { service } = setup();
  f.observe.mockImplementation(async (value: { quantity: number }) => ({
    status: value.quantity <= 3 ? "Available" : "Unavailable",
  }));
  const refused = { status: "SelectionInvalid", issueCodes: ["CATALOG_SELECTION_REJECTED"] };
  const selectionInput = input;
  const port = withCartItemStockShortage({
    updateItem: async () => {
      const result = await service.validateSelection(selectionInput, context);
      return result.status === "Accepted" ? ({ status: "Unavailable" } as const) : refused;
    },
    addItem: async () => {
      await service.validateSelection(
        { ...selectionInput, optionSelections: [{ optionReference: id(99), quantity: 1 }] },
        context,
      );
      return refused;
    },
  } as unknown as CustomerCartPort);
  expect(await port.updateItem({} as never)).toEqual({
    status: "SelectionInvalid",
    issueCodes: ["ITEM_SHORT"],
    available: 3,
  });
  // Quantities asked: 7, then halving below it.
  expect(f.observe.mock.calls.map(([value]) => value.quantity)).toEqual([7, 3, 5, 4]);
  // A refusal that isn't about stock stays as it was.
  expect(await port.addItem({} as never)).toBe(refused);
  // None at all: 0 can be made.
  f.observe.mockResolvedValue({ status: "Unavailable" });
  expect(await port.updateItem({} as never)).toMatchObject({ available: 0 });
});
it("keeps overlapping requests attached to their own snapshot and Cart context", async () => {
  const { service, authorize } = setup();
  let release!: (value: CurrentCatalogSelectionSnapshot) => void;
  f.resolve.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const first = service.validateSelection(input, context);
  const other = { ...context, cartReference: id(20), quantity: 4 };
  await service.validateSelection(input, other);
  release({ ...snapshot(), productVersionReference: id(21) });
  await first;
  expect(
    f.observe.mock.calls.map(([value]) => [value.quantity, value.productVersionReference]),
  ).toEqual([
    [4, id(7)],
    [7, id(21)],
  ]);
  for (const fn of f.authorizers as ((tx: unknown, input: unknown) => Promise<boolean>)[])
    await fn({}, {});
  expect(authorize.mock.calls.map((call) => (call as unknown[])[2])).toEqual([other, context]);
});

it("WP-2423: asks Inventory about the Cart's lines together, with each item's current product and bindings", async () => {
  const authorize = vi.fn(async () => true);
  const runner = { run: vi.fn() };
  const coverage = createCustomerCartStockCoverage(
    runner,
    scope,
    { clock: { now: () => at }, killSwitch: {} as never, inventory: {} as never },
    {
      scope: {
        tenantReference: id(12),
        brandReference: id(1),
        storeReference: id(2),
        stockSiteReference: id(13),
      },
      transactions: runner,
      authorize,
      resolveExpiryCutoff: vi.fn(),
    },
  );
  f.covers.mockResolvedValue(false);
  const lines = [
    {
      cartItemReference: id(20),
      sellableReference: id(4),
      quantity: 2,
      optionSelections: [{ optionReference: id(5), quantity: 1 }],
    },
    { cartItemReference: id(21), sellableReference: id(4), quantity: 1, optionSelections: [] },
  ];
  expect(await coverage.covers({ lines, observedAt: at })).toBe(false);
  expect(f.covers).toHaveBeenCalledWith({
    observedAt: at,
    lines: [
      {
        cartItemReference: id(20),
        sellableReference: id(4),
        productVersionReference: id(7),
        quantity: 2,
        selections: [{ bindingReference: id(8), optionReference: id(5), quantity: 1 }],
      },
      {
        cartItemReference: id(21),
        sellableReference: id(4),
        productVersionReference: id(7),
        quantity: 1,
        selections: [],
      },
    ],
  });
  // One Catalog snapshot per item for the whole checkout's questions.
  expect(await coverage.covers({ lines, observedAt: at })).toBe(false);
  expect(f.resolve).toHaveBeenCalledTimes(1);
  // An item the Catalog no longer offers (sold out for even one) is not covered.
  f.resolve.mockResolvedValueOnce(null);
  const other = { ...lines[1], sellableReference: id(30) };
  expect(await coverage.covers({ lines: [other] as never, observedAt: at })).toBe(false);
  expect(f.covers).toHaveBeenCalledTimes(2);
});
