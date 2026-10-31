import { beforeEach, expect, it, vi } from "vitest";
const mock = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("../infrastructure/persistence/receipt-order-source.js", () => ({
  createPostgresReceiptOrderSource: () => mock.read,
}));
import { createPostgresSubmittedOrderAmountSource } from "../infrastructure/persistence/submitted-order-amount-source.js";
import { orderWriteFixture } from "./order-creation-store.fixture.js";
const id = (n: number) => "0190ed09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
function fixture() {
  const f = orderWriteFixture({ at: "2026-09-12T12:00:00.000Z" });
  const record = f.request.record;
  const secondBatch = id(1);
  const firstItem = record.items[0];
  if (!firstItem) throw new Error("missing fixture item");
  return {
    orderReference: record.order.orderReference,
    brandReference: record.order.brandReference,
    storeReference: record.order.storeReference,
    guestSessionReference: record.guestSessionReference,
    orderNumber: "SYNTHETIC-1",
    createdAt: record.createdAt,
    batches: [
      {
        orderBatchReference: record.order.batches[0].orderBatchReference,
        submittedAt: record.createdAt,
      },
      { orderBatchReference: secondBatch, submittedAt: "2026-09-12T12:01:00.000Z" },
    ],
    items: [
      ...record.items.map((snapshot) => ({ snapshotVersion: 1, snapshot })),
      {
        snapshotVersion: 1,
        snapshot: {
          ...firstItem,
          orderItemReference: id(2),
          orderBatchReference: secondBatch,
          cartItemReference: id(3),
          pricing: { ...firstItem.pricing, lineReference: id(3) },
        },
      },
    ],
  };
}

beforeEach(() => vi.resetAllMocks());
function setup() {
  const order = fixture(),
    tx = { query: vi.fn() };
  mock.read.mockResolvedValue(order);
  const read = createPostgresSubmittedOrderAmountSource({
    brandReference: String(order.brandReference),
    storeReference: String(order.storeReference),
    authorize: async () => true,
  });
  return {
    order,
    tx,
    load: () =>
      read(tx, {
        orderReference: String(order.orderReference),
        observedAt: "2026-09-12T12:02:00.000Z",
      }),
  };
}
it("sums frozen price facts from all batches once, without counting quantity twice", async () => {
  const f = setup(),
    view = await f.load();
  const expected = f.order.items.reduce(
    (sum, item) => sum + item.snapshot.pricing.total.amountMinor,
    0n,
  );
  expect(view.totalMinor).toBe(expected);
  expect(view.batches).toHaveLength(2);
  expect(view.batches.reduce((sum, b) => sum + b.totalMinor, 0n)).toBe(expected);
  expect(view.tipIncluded).toBe(false);
  expect(view.amendmentAdjustmentsIncluded).toBe(false);
  expect(view).not.toHaveProperty("guestSessionReference");
  expect(view).not.toHaveProperty("orderNumber");
  expect(Object.isFrozen(view.batches[0])).toBe(true);
  expect(mock.read.mock.calls[0]?.[0]).toBe(f.tx);
});
it("retains tax, discounts and fees as distinct submitted components", async () => {
  const f = setup(),
    view = await f.load();
  expect(view.taxMinor).toBe(
    f.order.items.reduce((n, item) => n + item.snapshot.pricing.tax.amountMinor, 0n),
  );
  expect(view.totalMinor).toBe(
    view.subtotalMinor - view.discountMinor + view.feeMinor + view.taxMinor,
  );
});
it("fails closed on missing owner data or unavailable authorization", async () => {
  const f = setup();
  mock.read.mockResolvedValue(null);
  await expect(f.load()).rejects.toThrow("SUBMITTED_ORDER_AMOUNT_UNAVAILABLE");
  mock.read.mockRejectedValue(new Error("private"));
  await expect(f.load()).rejects.toThrow("SUBMITTED_ORDER_AMOUNT_UNAVAILABLE");
});
it("rejects wrong Order or future submitted batches", async () => {
  const f = setup();
  mock.read.mockResolvedValue({ ...f.order, orderReference: id(99) });
  await expect(f.load()).rejects.toThrow();
  mock.read.mockResolvedValue({
    ...f.order,
    batches: f.order.batches.map((b) => ({ ...b, submittedAt: "2026-09-13T00:00:00.000Z" })),
  });
  await expect(f.load()).rejects.toThrow();
});
