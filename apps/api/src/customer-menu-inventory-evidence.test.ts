import { beforeEach, expect, it, vi } from "vitest";
import {
  createCustomerCatalogInventoryPort,
  createCustomerInventoryEvidence,
} from "./customer-menu-inventory-evidence.js";

const f = vi.hoisted(() => ({
  observe: vi.fn(),
  created: [] as { transactions: { run(work: (tx: unknown) => Promise<unknown>): unknown } }[],
  facts: vi.fn(),
}));
vi.mock("./customer-recipe-inventory-observation.js", () => ({
  createCustomerRecipeInventoryObservation: (options: (typeof f.created)[number]) => {
    f.created.push(options);
    return {
      observe: async (input: unknown) =>
        options.transactions.run(async (tx) => f.observe(tx, input) as unknown),
    };
  },
}));
vi.mock("@rms/catalog", async (original) => ({
  ...(await original<typeof import("@rms/catalog")>()),
  createPostgresCurrentSelectionFactsStore: () => ({ load: f.facts }),
}));

const id = (n: number) => "01902408-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-10-11T09:00:00.000Z";
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  stockSiteReference: id(4),
};
const item = (
  n: number,
  defaults: { binding: number; option: number; quantity: number }[] = [],
) => ({
  sellableReference: id(n),
  productVersionReference: id(n + 100),
  defaultOptionSelections: defaults.map((d) => ({
    bindingReference: id(d.binding) as never,
    optionReference: id(d.option) as never,
    quantity: d.quantity,
  })),
});
const tx = { query: vi.fn() };
beforeEach(() => {
  vi.resetAllMocks();
  f.created.length = 0;
});
const source = (extra: { maximumItems?: number } = {}) =>
  createCustomerInventoryEvidence({
    scope,
    resolveExpiryCutoff: async () => {
      throw new Error("No expiry fixture");
    },
    ...extra,
  });

it("maps the stock observation of one item as normally ordered to Inventory evidence", async () => {
  f.observe.mockImplementation(async (_tx, input: { sellableReference: string }) => {
    if (input.sellableReference === id(10)) return { status: "Available" };
    if (input.sellableReference === id(11)) return { status: "Unavailable" };
    throw new Error("no recipe");
  });
  const result = await source().observe(tx, {
    brandReference: id(2),
    storeReference: id(3),
    observedAt: at,
    items: [item(10, [{ binding: 50, option: 51, quantity: 2 }]), item(11), item(12)],
  });
  expect(result.get(id(10))).toEqual({
    kind: "Inventory",
    brandReference: id(2),
    storeReference: id(3),
    sellableReference: id(10),
    status: "Available",
    observedAt: at,
    expiresAt: "2026-10-11T09:01:00.000Z",
    reasonCode: "STOCK_AVAILABLE",
  });
  expect(result.get(id(11))).toMatchObject({ status: "Unavailable", reasonCode: "STOCK_DEPLETED" });
  // A failed observation (no Recipe, unknown SKU, read failure) is unknown, never sold out.
  expect(result.get(id(12))).toMatchObject({
    status: "Indeterminate",
    reasonCode: "STOCK_UNOBSERVED",
  });
  // Quantity one with the default choices, all in the caller's one transaction.
  expect(f.observe.mock.calls[0]?.[1]).toEqual({
    sellableReference: id(10),
    productVersionReference: id(110),
    quantity: 1,
    selections: [{ bindingReference: id(50), optionReference: id(51), quantity: 2 }],
    observedAt: at,
  });
  expect(f.observe.mock.calls.every(([used]) => used === tx)).toBe(true);
  expect(f.created).toHaveLength(1);
});

it("observes nothing for another Store, and bounds and de-duplicates the items it observes", async () => {
  f.observe.mockResolvedValue({ status: "Unavailable" });
  expect(
    (
      await source().observe(tx, {
        brandReference: id(2),
        storeReference: id(9),
        observedAt: at,
        items: [item(10)],
      })
    ).size,
  ).toBe(0);
  expect(f.observe).not.toHaveBeenCalled();
  const bounded = await source({ maximumItems: 2 }).observe(tx, {
    brandReference: id(2),
    storeReference: id(3),
    observedAt: at,
    items: [item(10), item(10), item(11), item(12)],
  });
  expect(f.observe).toHaveBeenCalledTimes(2);
  expect([...bounded.values()].map((e) => e.status)).toEqual([
    "Unavailable",
    "Unavailable",
    "Indeterminate",
  ]);
});

it("gives Catalog's cart and checkout port the same observation for the published default choices", async () => {
  f.observe.mockResolvedValue({ status: "Unavailable" });
  const runs: unknown[] = [];
  const port = createCustomerCatalogInventoryPort({
    evidence: source(),
    transactions: {
      run: async (work) => {
        runs.push(tx);
        return work(tx as never);
      },
    },
    menuReference: id(70),
    sourceChannel: "Qr",
  });
  const request = {
    brandReference: id(2) as never,
    storeReference: id(3) as never,
    sellableReference: id(10) as never,
    channelCode: "CUSTOMER_PWA" as never,
    orderTypeCode: "DINE_IN" as never,
    observedAt: at as never,
  };
  f.facts.mockResolvedValue({
    published: {
      productVersionReference: id(110),
      optionRules: [
        {
          semanticsVersion: 2,
          channelCodes: ["CUSTOMER_PWA"],
          activationOptionReferences: [],
          bindingReference: id(50),
          optionSetVersionReference: id(52),
          minimumSelections: 1,
          maximumSelections: 1,
          enabledOptionReferences: [id(51), id(53)],
          defaultOptionReferences: [id(51)],
          options: [
            { ...option(51), selectedByDefault: true, defaultQuantity: 1 },
            { ...option(53), selectedByDefault: false, defaultQuantity: 0 },
          ],
        },
      ],
    },
  });
  expect(await port.loadEvidence(request)).toMatchObject({
    kind: "Inventory",
    sellableReference: id(10),
    status: "Unavailable",
  });
  expect(f.facts.mock.calls[0]?.[0]).toMatchObject({
    menuReference: id(70),
    orderType: "DineIn",
    sourceChannel: "Qr",
    channelCode: "CUSTOMER_PWA",
  });
  expect(f.observe.mock.calls[0]?.[1]).toMatchObject({
    productVersionReference: id(110),
    selections: [{ bindingReference: id(50), optionReference: id(51), quantity: 1 }],
  });
  expect(runs).toHaveLength(1);
  // Not on the current published menu: unknown, without a stock read.
  f.facts.mockResolvedValue(null);
  expect(await port.loadEvidence(request)).toMatchObject({
    status: "Indeterminate",
    reasonCode: "STOCK_UNOBSERVED",
  });
  expect(f.observe).toHaveBeenCalledTimes(1);
});

function option(n: number) {
  return {
    optionReference: id(n),
    localizedNames: { en: "Option" },
    maximumQuantity: 1,
    conflictOptionReferences: [],
  };
}
