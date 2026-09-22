import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({
  inventory: vi.fn(),
  binding: vi.fn(),
  closure: vi.fn(),
  current: vi.fn(),
  finality: vi.fn(),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresDiningSessionOrderInventory: () => ({ load: mock.inventory }),
  createPostgresMerchantOrderIndex: () => ({ find: mock.binding }),
  createPostgresOrderClosurePosition: () => mock.closure,
}));
vi.mock("@rms/payment", () => ({
  createPostgresOrderSettledFinalityStore: () => ({ readFinality: mock.finality }),
}));
vi.mock("./dining-order-closure-inputs.js", () => ({
  createDiningOrderClosureInputs: () => ({ load: mock.current }),
}));
import { createDiningSessionClosureInputs } from "./dining-session-closure-inputs.js";
const id = (n: number) => "0190fad4-0000-7000-8000-" + String(n).padStart(12, "0"),
  at = "2026-09-20T00:00:00.000Z";
beforeEach(() => vi.resetAllMocks());
function setup() {
  const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    query = { diningSessionReference: id(4), observedAt: at };
  const authorize = vi.fn(async () => true),
    tx = { query: vi.fn() };
  const entry = { orderReference: id(5), batches: [{ orderBatchReference: id(6) }] };
  mock.inventory.mockResolvedValue({ ...scope, ...query, orders: [entry] });
  mock.binding.mockResolvedValue({
    orderReference: id(5),
    orderType: "DineIn",
    diningSessionReference: id(4),
    guestSessionReference: id(7),
  });
  mock.closure.mockResolvedValue({
    status: "Closed",
    orderVersion: 3,
    orderCheckpoint: id(8),
    financialFinalityReference: id(9),
  });
  mock.current.mockResolvedValue({
    execution: {
      orderVersion: 3,
      revisionCheckpoint: id(8),
      items: [{ orderBatchReference: id(6) }],
    },
    settlement: { classification: "Unpaid" },
  });
  mock.finality.mockResolvedValue({ orderCheckpoint: id(8), classification: "Settled" });
  const source = createDiningSessionClosureInputs({
    ...scope,
    diningScope: scope,
    paymentScope: { ...scope, providerAccountReference: id(10), environment: "Test" },
    authorize,
    authorizeKitchen: authorize,
    authorizeDining: authorize,
    authorizeAndFence: authorize,
  });
  return { run: () => source.load(tx, query), authorize, entry };
}
it("preserves historical settlement separately from changed current balance", async () => {
  const f = setup();
  const result = await f.run();
  expect(result.orders).toHaveLength(1);
  expect(result.orders[0]?.historicalFinality?.classification).toBe("Settled");
  expect(result.orders[0]?.current.settlement.classification).toBe("Unpaid");
});
it("does not discard a missing order from session inventory", async () => {
  const f = setup();
  mock.binding.mockResolvedValue(null);
  await expect(f.run()).rejects.toThrow();
});
it("rejects incomplete batch execution", async () => {
  const f = setup();
  f.entry.batches.push({ orderBatchReference: id(11) });
  await expect(f.run()).rejects.toThrow();
});
it("rejects closed order without linked finality", async () => {
  const f = setup();
  mock.finality.mockResolvedValue(null);
  await expect(f.run()).rejects.toThrow();
});
it("rejects current revision mismatch", async () => {
  const f = setup();
  mock.current.mockResolvedValue({ execution: { orderVersion: 4, revisionCheckpoint: id(8) } });
  await expect(f.run()).rejects.toThrow();
});
it("requires session authority before inventory", async () => {
  const f = setup();
  f.authorize.mockResolvedValue(false);
  await expect(f.run()).rejects.toThrow();
  expect(mock.inventory).not.toHaveBeenCalled();
});
