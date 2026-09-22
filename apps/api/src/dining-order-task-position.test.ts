import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ execution: vi.fn(), tasks: vi.fn(), payment: vi.fn() }));
vi.mock("./dining-order-execution-position.js", () => ({
  createDiningOrderExecutionPosition: () => ({ load: mock.execution }),
}));
vi.mock("@bop/task", async (original) => ({
  ...(await original<typeof import("@bop/task")>()),
  createPostgresTaskSourceReader: () => ({ load: mock.tasks }),
}));
vi.mock("@rms/payment", () => ({
  createPostgresOrderPaymentAttemptPosition: () => ({ load: mock.payment }),
}));
import { createDiningOrderTaskPosition } from "./dining-order-task-position.js";
const id = (n: number) => "0190fad0-0000-7000-8000-" + String(n).padStart(12, "0");
beforeEach(() => vi.resetAllMocks());
function fixture() {
  const scope = { brandReference: id(1), storeReference: id(2) },
    at = "2026-09-20T00:00:00.000Z";
  const input = {
    ...scope,
    transaction: { query: vi.fn() },
    orderReference: id(3),
    diningSessionReference: id(4),
    guestSessionReference: id(5),
    observedAt: at,
  };
  const current = {
    ...scope,
    orderReference: id(3),
    observedAt: at,
    snapshotDigest: "sha256:" + "a".repeat(64),
  };
  mock.execution.mockResolvedValue(current);
  const payment = {
    ...scope,
    orderReference: id(3),
    observedAt: at,
    providerAccountReference: id(7),
    environment: "Test",
    attempts: [],
    snapshotDigest: "sha256:" + "c".repeat(64),
  };
  mock.payment.mockResolvedValue(payment);
  mock.tasks.mockImplementation(async (_tx, q) => ({
    scope: { kind: "Store", ...scope },
    ...q,
    tasks: [],
    snapshotDigest: "sha256:" + "b".repeat(64),
  }));
  const authorize = vi.fn(async () => true);
  const source = createDiningOrderTaskPosition({
    ...scope,
    diningScope: { tenantReference: id(6), ...scope },
    paymentScope: { ...scope, providerAccountReference: id(7), environment: "Test" },
    authorize,
    authorizeKitchen: async () => true,
    authorizeDining: async () => true,
  });
  return { input, current, payment, authorize, load: () => source.load(input) };
}
it("includes session and order tasks only after verified execution binding", async () => {
  const f = fixture(),
    result = await f.load();
  expect(result?.taskSources.map((s) => s.sourceType)).toEqual(["DINING_SESSION", "ORDER"]);
  expect(mock.tasks.mock.calls.map((c) => c[1].sourceReference)).toEqual([id(4), id(3)]);
  expect(mock.execution.mock.invocationCallOrder[0]).toBeLessThan(
    mock.tasks.mock.invocationCallOrder[0] ?? -1,
  );
  expect(Object.isFrozen(result?.taskSources)).toBe(true);
  expect(result).not.toHaveProperty("criticalBlockingTaskCount");
});
it("unavailable execution never becomes an empty task inventory", async () => {
  const f = fixture();
  mock.execution.mockResolvedValue(null);
  expect(await f.load()).toBeNull();
  expect(mock.tasks).not.toHaveBeenCalled();
});
it("keeps terminal and open tasks instead of filtering financial clearance", async () => {
  const f = fixture();
  const tasks = [{ status: "Completed" }, { status: "Open" }];
  mock.tasks.mockImplementation(async (_tx, q) => ({
    scope: { kind: "Store", brandReference: id(1), storeReference: id(2) },
    ...q,
    tasks,
    snapshotDigest: "sha256:" + "b".repeat(64),
  }));
  expect((await f.load())?.taskSources[0]?.tasks).toEqual(tasks);
});
it.each(["scope", "source", "time", "digest", "failure"])(
  "rejects incomplete/mixed task evidence %s",
  async (kind) => {
    const f = fixture();
    mock.tasks.mockImplementation(async (_tx, q) => {
      if (kind === "failure") throw new Error("unavailable");
      return {
        scope: {
          kind: "Store",
          brandReference: id(1),
          storeReference: kind === "scope" ? id(90) : id(2),
        },
        ...q,
        sourceReference: kind === "source" ? id(90) : q.sourceReference,
        observedAt: kind === "time" ? "2026-09-21T00:00:00.000Z" : q.observedAt,
        tasks: [],
        snapshotDigest: kind === "digest" ? "invalid" : "sha256:" + "b".repeat(64),
      };
    });
    await expect(f.load()).rejects.toThrow("DINING_ORDER_TASK_POSITION_UNAVAILABLE");
  },
);
it("requires authority before work and after all evidence", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow();
  expect(mock.execution).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.load()).rejects.toThrow();
});

it("covers succeeded, failed and unresolved attempt tasks under Payment fences before Task reads", async () => {
  const f = fixture();
  mock.payment.mockResolvedValue({
    ...f.payment,
    attempts: [
      { paymentAttemptReference: id(12), outcome: "Failed" },
      { paymentAttemptReference: id(10), outcome: "Succeeded" },
      { paymentAttemptReference: id(11), outcome: "Unresolved" },
    ],
  });
  const result = await f.load();
  expect(result?.taskSources.map((s) => s.sourceReference)).toEqual([
    id(4),
    id(3),
    id(10),
    id(11),
    id(12),
  ]);
  expect(mock.payment.mock.invocationCallOrder[0]).toBeLessThan(
    mock.tasks.mock.invocationCallOrder[0] ?? -1,
  );
});
it.each([
  "storeReference",
  "orderReference",
  "observedAt",
  "providerAccountReference",
  "environment",
  "snapshotDigest",
])("denies mixed Payment %s before Task reads", async (field) => {
  const f = fixture();
  mock.payment.mockResolvedValue({ ...f.payment, [field]: "invalid" });
  await expect(f.load()).rejects.toThrow();
  expect(mock.tasks).not.toHaveBeenCalled();
});
it("does not suppress Payment source failure", async () => {
  const f = fixture();
  mock.payment.mockRejectedValue(new Error("unavailable"));
  await expect(f.load()).rejects.toThrow();
  expect(mock.tasks).not.toHaveBeenCalled();
});
