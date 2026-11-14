import { beforeEach, expect, it, vi } from "vitest";
import { applyRefundWithdrawalRecords } from "./order-refund-withdrawal-records.js";

const d = vi.hoisted(() => ({
  withdrawn: vi.fn(),
  link: vi.fn(),
  states: vi.fn(),
  kitchen: vi.fn(),
  fulfillment: vi.fn(),
  release: vi.fn(),
}));
vi.mock("./order-refund-withdrawal.js", () => ({ readRefundWithdrawnUnits: d.withdrawn }));
vi.mock("./submission-inventory-release.js", () => ({
  createSubmissionInventoryRelease: () => ({ releaseLines: d.release }),
}));
vi.mock("@rms/ordering", async (original) => ({
  ...(await original<object>()),
  createPostgresOrderItemInventoryLinkReader: () => ({ load: d.link }),
}));
vi.mock("@rms/kitchen", async (original) => ({
  ...(await original<object>()),
  listStoreKitchenOrderItemStates: d.states,
  createPostgresKitchenBatchCancellation: () => ({ cancelItems: d.kitchen }),
}));
vi.mock("@rms/fulfillment", async (original) => ({
  ...(await original<object>()),
  createPostgresFulfillmentItemCancellation: () => ({ cancelItems: d.fulfillment }),
}));
const id = (n: number) => "01909974-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const at = "2026-11-10T12:00:00.000Z";

beforeEach(() => {
  vi.clearAllMocks();
  // One dish of one unit, refunded in full and not started: its kitchen work, pickup line and
  // stock are cancelled.
  d.withdrawn.mockResolvedValue(new Map([[id(12), 1]]));
  d.link.mockResolvedValue({
    orderReference: id(8),
    orderBatchReference: id(11),
    quantity: 1,
    cartItemReference: id(20),
    submissionReference: id(21),
  });
  d.states.mockResolvedValue(new Map([[id(12), "NotStarted"]]));
});

const apply = () =>
  applyRefundWithdrawalRecords({} as never, {
    scope: { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
    orderReference: id(8),
    actorReference: id(4),
    recordedAt: at,
    operationReference: id(10),
    withdrawals: [
      {
        withdrawalReference: id(40),
        orderBatchReference: id(11),
        orderItemReference: id(12),
        withdrawnQuantity: 1,
      } as never,
    ],
    nextReference: () => id(41),
    now: () => at,
    allowed: async () => true,
  });

it("WP-2423 M10: stock that can't be returned dish by dish is its own refusal, never 'the kitchen just started'", async () => {
  for (const reason of [
    "DeferredInventory",
    "LegacyReservation",
    "NoInventoryRecord",
    "PartiallySettled",
  ])
    d.release.mockResolvedValueOnce({ status: "NotReleasable", reason });
  for (let index = 0; index < 4; index++)
    await expect(apply()).rejects.toThrow("ORDINARY_REFUND_WITHDRAW_STOCK_NOT_RELEASABLE");
  // Production started meanwhile is the kitchen's change: look again and choose.
  d.release.mockResolvedValueOnce({ status: "NotReleasable", reason: "ProductionStarted" });
  await expect(apply()).rejects.toThrow("ORDINARY_REFUND_WITHDRAW_KITCHEN_CHANGED");
});
