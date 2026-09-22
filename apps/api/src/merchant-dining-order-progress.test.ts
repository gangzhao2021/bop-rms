import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantDiningOrderProgress } from "./merchant-dining-order-progress.js";
const doubles = vi.hoisted(() => ({
  resolve: vi.fn(),
  compose: vi.fn(),
  load: vi.fn(),
  find: vi.fn(),
  labels: vi.fn(),
  table: vi.fn(),
  tableContext: vi.fn(),
  closure: vi.fn(),
}));
vi.mock("./merchant-store-scope.js", () => ({ createMerchantStoreScope: () => doubles.resolve }));
vi.mock("./dining-order-delivery-progress.js", () => ({
  createDiningOrderDeliveryProgress: doubles.compose,
}));
vi.mock("@rms/ordering", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rms/ordering")>()),
  createPostgresMerchantOrderItemLabels: () => ({ load: doubles.labels }),
  createPostgresMerchantOrderIndex: () => ({ find: doubles.find }),
  createPostgresOrderClosurePosition: () => doubles.closure,
}));
vi.mock("./merchant-dining-table-context.js", () => ({
  createMerchantDiningTableContext: doubles.tableContext,
}));
const id = (n: number) => "01909985-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-09-20T11:00:00.000Z";
type Options = Parameters<typeof createMerchantDiningOrderProgress>[0];
function setup() {
  const tx = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) };
  const allowed = vi.fn(async () => true);
  const authenticate = vi.fn(async () => ({ sessionReference: id(20) }));
  doubles.resolve.mockResolvedValue({
    selected: { tenantReference: id(1) },
    context: { brand: { brandReference: id(2) } },
    store: { storeReference: id(3) },
    allowed,
  });
  const run = vi.fn(async (work: (transaction: object) => Promise<unknown>) => work(tx));
  const operation = createMerchantDiningOrderProgress({
    locale: "en-CA",
    persistence: { transactions: { run }, now: () => at } as unknown as Options["persistence"],
    authentication: { authorize: authenticate } as unknown as Options["authentication"],
  });
  const input = {
    sessionCookie: "synthetic-cookie",
    csrf: "synthetic-csrf",
    query: { orderReference: id(5) },
  };
  return { tx, allowed, authenticate, run, operation, input };
}
beforeEach(() => {
  vi.clearAllMocks();
  doubles.tableContext.mockImplementation(() => ({ load: doubles.table }));
  doubles.closure.mockResolvedValue({ status: "Open", closureVersion: 0, orderVersion: 3 });
  doubles.table.mockResolvedValue({
    tableLabel: "T1",
    diningSessionReference: id(6),
    sessionPhase: "Active",
    sessionVersion: 2,
    tableAssignmentVersion: 3,
  });
  doubles.labels.mockResolvedValue([]);
  doubles.find.mockResolvedValue({
    orderReference: id(5),
    orderType: "DineIn",
    diningSessionReference: id(4),
    guestSessionReference: id(6),
    initialSubmissionReference: id(7),
    initialBatchReference: id(8),
  });
  doubles.compose.mockImplementation(() => ({ load: doubles.load }));
  doubles.load.mockResolvedValue({ phase: "Fulfilled", items: [] });
});
it("uses authenticated selected scope, server time and the owner delivery reader", async () => {
  const f = setup();
  expect(await f.operation(f.input)).toEqual({
    phase: "Fulfilled",
    closureStatus: "Open",
    closureVersion: 0,
    currentOrderVersion: 3,
    tableLabel: "T1",
    diningSessionReference: id(6),
    sessionPhase: "Active",
    sessionVersion: 2,
    tableAssignmentVersion: 3,
    items: [],
  });
  expect(doubles.resolve).toHaveBeenCalledWith(
    f.tx,
    f.input.sessionCookie,
    "dining.item.serve",
    id(20),
  );
  expect(doubles.load).toHaveBeenCalledWith({
    ...f.input.query,
    diningSessionReference: id(4),
    guestSessionReference: id(6),
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    observedAt: at,
    transaction: expect.objectContaining({ query: expect.any(Function) }),
  });
  const ports = doubles.compose.mock.calls[0]?.[0];
  expect(ports.diningScope).toEqual({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
  });
  f.allowed.mockResolvedValue(false);
  expect(await ports.authorize()).toBe(false);
  expect(await ports.authorizeKitchen()).toBe(false);
  expect(await ports.authorizeDining()).toBe(false);
});
it("rejects invalid session or CSRF before database access", async () => {
  const f = setup();
  f.authenticate.mockRejectedValue(new Error("denied"));
  await expect(f.operation(f.input)).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it.each([
  "tenantReference",
  "brandReference",
  "storeReference",
  "observedAt",
  "permission",
  "guestSessionReference",
  "diningSessionReference",
])("rejects caller-supplied %s", async (key) => {
  const f = setup();
  await expect(
    f.operation({ ...f.input, query: { ...f.input.query, [key]: id(9) } }),
  ).rejects.toThrow();
  expect(f.run).not.toHaveBeenCalled();
});
it("denies before owner reads when current permission is absent", async () => {
  const f = setup();
  f.allowed.mockResolvedValue(false);
  await expect(f.operation(f.input)).rejects.toThrow("PERMISSION_DENIED");
  expect(doubles.load).not.toHaveBeenCalled();
});
it("does not return data if permission changes during the read", async () => {
  const f = setup();
  doubles.load.mockImplementationOnce(async () => {
    f.allowed.mockResolvedValue(false);
    return { phase: "Fulfilled" };
  });
  await expect(f.operation(f.input)).rejects.toThrow("PERMISSION_DENIED");
});
it("preserves unavailable owner facts instead of reporting no work remaining", async () => {
  const f = setup();
  doubles.load.mockResolvedValueOnce(null);
  expect(await f.operation(f.input)).toBeNull();
});

it("does not read progress for missing or non-Dining Orders", async () => {
  const f = setup();
  doubles.find.mockResolvedValueOnce(null);
  expect(await f.operation(f.input)).toBeNull();
  doubles.find.mockResolvedValueOnce({ orderType: "Pickup" });
  expect(await f.operation(f.input)).toBeNull();
  expect(doubles.load).not.toHaveBeenCalled();
});
it("rejects missing Dining context", async () => {
  const f = setup();
  doubles.find.mockResolvedValueOnce({ orderType: "DineIn", diningSessionReference: null });
  await expect(f.operation(f.input)).rejects.toThrow("UNAVAILABLE");
  expect(doubles.load).not.toHaveBeenCalled();
});

it("binds immutable labels to exact current item and batch membership", async () => {
  const f = setup();
  doubles.load.mockResolvedValueOnce({
    items: [{ orderItemReference: id(9), orderBatchReference: id(8), remainingQuantity: 1 }],
  });
  doubles.labels.mockResolvedValueOnce([
    {
      orderItemReference: id(9),
      orderBatchReference: id(8),
      displayName: "Meal",
      batchSequence: 2,
      itemOrdinal: 1,
    },
  ]);
  expect(await f.operation(f.input)).toMatchObject({
    items: [{ displayName: "Meal", batchSequence: 2, remainingQuantity: 1 }],
  });
});
it("rejects missing labels instead of hiding a current item", async () => {
  const f = setup();
  doubles.load.mockResolvedValueOnce({
    items: [{ orderItemReference: id(9), orderBatchReference: id(8) }],
  });
  await expect(f.operation(f.input)).rejects.toThrow("UNAVAILABLE");
});

it("does not return stale item context when current table cannot be resolved", async () => {
  const f = setup();
  doubles.table.mockRejectedValueOnce(new Error("DINING_TABLE_CONTEXT_UNAVAILABLE"));
  await expect(f.operation(f.input)).rejects.toThrow("UNAVAILABLE");
});

it("returns persisted Closed independently of serving phase and fences before delivery", async () => {
  const f = setup();
  doubles.closure.mockResolvedValueOnce({
    status: "Closed",
    closureVersion: 1,
    orderVersion: 7,
    financialFinalityReference: id(99),
  });
  const result = await f.operation(f.input);
  expect(result).toMatchObject({
    phase: "Fulfilled",
    closureStatus: "Closed",
    closureVersion: 1,
    currentOrderVersion: 7,
  });
  expect(result).not.toHaveProperty("financialFinalityReference");
  expect(doubles.closure).toHaveBeenCalledWith(expect.anything(), {
    orderReference: id(5),
    observedAt: at,
  });
  expect(doubles.closure.mock.invocationCallOrder[0]).toBeLessThan(
    doubles.load.mock.invocationCallOrder[0] ?? 0,
  );
});
it("does not invent Open when closure history is unavailable", async () => {
  const f = setup();
  doubles.closure.mockRejectedValueOnce(new Error("ORDER_CLOSURE_POSITION_UNAVAILABLE"));
  await expect(f.operation(f.input)).rejects.toThrow("ORDER_CLOSURE_POSITION_UNAVAILABLE");
  expect(doubles.load).not.toHaveBeenCalled();
});

it("reads a released Closed session while its order remains Open for financial follow-up", async () => {
  const f = setup();
  doubles.tableContext.mockImplementation((options) => ({
    load: async () => {
      if (options.allowClosedSession !== true) throw new Error("DINING_TABLE_CONTEXT_UNAVAILABLE");
      return {
        diningSessionReference: id(4),
        tableLabel: "T1",
        sessionPhase: "Closed",
        sessionVersion: 4,
        tableAssignmentVersion: 3,
      };
    },
  }));
  const result = await f.operation(f.input);
  expect(result).toMatchObject({
    closureStatus: "Open",
    closureVersion: 0,
    sessionPhase: "Closed",
    sessionVersion: 4,
  });
  expect(result).not.toHaveProperty("financialFinalityReference");
});
