import { beforeEach, expect, it, vi } from "vitest";
import { createMerchantOrderQueueRead } from "./merchant-order-queue-read.js";
const mocks = vi.hoisted(() => ({ cancelled: vi.fn(), progress: vi.fn() }));
const id = (n: number) => `0190ee39-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
vi.mock("./dining-order-delivery-progress.js", () => ({
  createDiningOrderDeliveryProgress: () => ({ load: mocks.progress }),
}));
vi.mock("@rms/ordering", () => ({
  parseOrderingInstant: (value: string) => value,
  createPostgresMerchantOrderIndex: () => ({
    list: async () => ({
      items: [
        {
          orderReference: id(4),
          orderType: "DineIn",
          initialBatchReference: id(5),
          initialSubmissionReference: id(6),
        },
      ],
      nextAfterOrderReference: null,
    }),
  }),
  createPostgresOrderAcceptanceReader: () => ({ loadByBatch: async () => null }),
  createPostgresOrderExecutionReader: vi.fn(),
  createPostgresDiningOrderItemStateReader: () => ({ load: async () => null }),
  createPostgresDiningOrderPreparationSource: () => ({ resolveCancelled: mocks.cancelled }),
  createPostgresOrderCreationQueryStore: () => ({
    withCurrentSubmission: async (_ref: unknown, work: (...args: unknown[]) => unknown) =>
      work(
        {},
        {
          order: {
            orderReference: id(4),
            orderType: "DineIn",
            diningSessionReference: id(7),
            batches: [{ orderBatchReference: id(5) }],
          },
          guestSessionReference: id(8),
        },
      ),
  }),
}));
beforeEach(() => {
  mocks.cancelled.mockReset();
  mocks.progress.mockReset();
});
const scope = {
  tenantReference: id(1),
  brandReference: id(2),
  storeReference: id(3),
  sessionReference: id(9),
};
function read() {
  return createMerchantOrderQueueRead({
    transactions: { run: async (work) => work({ query: async () => ({ rows: [], rowCount: 0 }) }) },
    authorize: async () => scope,
    quoteVersion: 1,
    now: () => "2026-09-22T00:00:00.000Z",
  })({ sessionCookie: "synthetic", afterOrderReference: null, limit: 50 });
}
it("shows owning cancelled phase/version without creating an actionable batch or querying serving", async () => {
  mocks.cancelled.mockResolvedValue({ phase: "Cancelled", orderVersion: 2 });
  const result = await read();
  expect(result.items[0]).toMatchObject({
    currentPhase: "Cancelled",
    currentVersion: 2,
    batches: [],
  });
  expect(mocks.progress).not.toHaveBeenCalled();
  expect(mocks.cancelled).toHaveBeenCalledWith(
    expect.objectContaining({
      brandReference: id(2),
      storeReference: id(3),
      orderReference: id(4),
      diningSessionReference: id(7),
    }),
  );
});
it("keeps unsupported missing state unresolved", async () => {
  mocks.cancelled.mockResolvedValue(null);
  expect((await read()).items[0]).toMatchObject({
    currentPhase: null,
    currentVersion: null,
    batches: [],
  });
});
it("does not conceal conflicting cancellation history", async () => {
  mocks.cancelled.mockRejectedValue(new Error("ORDER_TERMINATION_CONFLICT"));
  await expect(read()).rejects.toThrow("ORDER_TERMINATION_CONFLICT");
});
