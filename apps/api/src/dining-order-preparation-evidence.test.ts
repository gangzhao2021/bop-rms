import { expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ order: vi.fn(), kitchen: vi.fn() }));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<typeof import("@rms/ordering")>()),
  createPostgresDiningOrderItemStateReader: () => ({ load: mock.order }),
}));
vi.mock("@rms/kitchen", () => ({
  createPostgresKitchenCustomerStatusReader: () => ({ loadByOrder: mock.kitchen }),
}));
import { createDiningOrderPreparationProgress } from "./dining-order-preparation-progress.js";
const id = (n: number) => "0190fad1-0000-7000-8000-" + String(n).padStart(12, "0");
it.each([false, true])("accepted item's Kitchen evidence present=%s", async (present) => {
  const scope = { brandReference: id(1), storeReference: id(2) },
    at = "2026-09-20T00:00:00.000Z",
    orderReference = id(3),
    item = id(4),
    batch = id(5);
  mock.order.mockResolvedValue({
    ...scope,
    orderReference,
    orderVersion: 2,
    items: [
      { orderItemReference: item, orderBatchReference: batch, orderedQuantity: 1, acceptance: {} },
    ],
  });
  mock.kitchen.mockResolvedValue(
    present
      ? {
          batches: [
            {
              orderBatchReference: batch,
              updatedAt: at,
              items: [{ orderItemReference: item, status: "Queued" }],
            },
          ],
        }
      : null,
  );
  const result = await createDiningOrderPreparationProgress({
    ...scope,
    authorize: async () => true,
    authorizeKitchen: async () => true,
  }).load({
    ...scope,
    orderReference,
    diningSessionReference: id(6),
    guestSessionReference: id(7),
    observedAt: at,
    transaction: { query: vi.fn() },
  });
  expect(result?.preparationPhase).toBe("Accepted");
  expect(result?.kitchenEvidenceComplete).toBe(present);
});

it.each([false, true])(
  "cancelled Batch preserves older Ready work; contradictory Kitchen=%s",
  async (contradictory) => {
    const scope = { brandReference: id(1), storeReference: id(2) },
      at = "2026-09-20T00:00:00.000Z";
    mock.order.mockResolvedValue({
      ...scope,
      orderReference: id(3),
      orderVersion: 8,
      orderCheckpoint: id(12),
      items: [
        {
          orderItemReference: id(4),
          orderBatchReference: id(5),
          orderedQuantity: 1,
          acceptance: {},
          cancellation: null,
        },
        {
          orderItemReference: id(8),
          orderBatchReference: id(9),
          orderedQuantity: 1,
          acceptance: null,
          cancellation: { cancellationReference: id(10) },
        },
      ],
    });
    mock.kitchen.mockResolvedValue({
      batches: [
        {
          orderBatchReference: id(5),
          updatedAt: at,
          items: [{ orderItemReference: id(4), status: "Ready" }],
        },
        ...(contradictory
          ? [
              {
                orderBatchReference: id(9),
                updatedAt: at,
                items: [{ orderItemReference: id(8), status: "Queued" }],
              },
            ]
          : []),
      ],
    });
    const result = createDiningOrderPreparationProgress({
      ...scope,
      authorize: async () => true,
      authorizeKitchen: async () => true,
    }).load({
      ...scope,
      orderReference: id(3),
      diningSessionReference: id(6),
      guestSessionReference: id(7),
      observedAt: at,
      transaction: { query: vi.fn() },
    });
    if (contradictory) await expect(result).rejects.toThrow("ORDER_PROGRESS_UNAVAILABLE");
    else {
      const value = await result;
      expect(value?.preparationPhase).toBe("Ready");
      expect(value?.orderCheckpoint).toBe(id(12));
      expect(value?.items[1]?.phase).toBe("Cancelled");
    }
  },
);
