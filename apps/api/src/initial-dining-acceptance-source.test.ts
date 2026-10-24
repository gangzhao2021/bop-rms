import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ original: vi.fn(), current: vi.fn() }));
vi.mock("@rms/ordering", async (load) => ({
  ...(await load<object>()),
  createPostgresOrderCreationQueryStore: () => ({ withCurrentSubmission: mocks.original }),
  createPostgresDiningOrderItemStateReader: () => ({ load: mocks.current }),
}));
import { createInitialDiningAcceptanceSource } from "./initial-dining-acceptance-source.js";
const ref = (n: number) => `0190fa72-0000-7000-8000-${String(n).padStart(12, "0")}`;
const scope = { brandReference: ref(1), storeReference: ref(2) };
const identity = {
  orderReference: ref(3),
  orderBatchReference: ref(4),
  submissionReference: ref(5),
  observedAt: "2026-09-21T23:30:00.000Z",
};
const tx = { query: vi.fn() };
const original = () => ({
  submissionReference: ref(5),
  guestSessionReference: ref(6),
  createdAt: "2026-09-21T23:00:00.000Z",
  order: {
    ...scope,
    orderReference: ref(3),
    orderType: "DineIn",
    diningSessionReference: ref(7),
    aggregateVersion: 1,
    batches: [
      {
        orderBatchReference: ref(4),
        submissionReference: ref(5),
        submittedAt: "2026-09-21T23:00:00.000Z",
      },
    ],
  },
});
const current = () => ({
  ...scope,
  orderReference: ref(3),
  diningSessionReference: ref(7),
  orderVersion: 2,
  canonicalPhase: "Submitted",
  batches: [{ orderBatchReference: ref(4), sequence: 1, acceptance: null, cancellation: null }],
});
const setup = (authorize = vi.fn(async () => true)) =>
  createInitialDiningAcceptanceSource({ ...scope, quoteVersion: 1, authorize });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.original.mockImplementation(async (_submission, work) => work(tx, original()));
  mocks.current.mockResolvedValue(current());
});
describe("initial Dining acceptance source", () => {
  it("keeps original version separate from current revision after another batch", async () => {
    const result = await setup().resolve(tx, identity);
    expect(result.order.order.aggregateVersion).toBe(1);
    expect(result.current.orderVersion).toBe(2);
    expect(result.batch.acceptance).toBeNull();
    expect(mocks.current).toHaveBeenCalledWith(
      expect.objectContaining({
        transaction: tx,
        diningSessionReference: ref(7),
        guestSessionReference: ref(6),
      }),
    );
  });
  it("preserves actual batch cancellation rather than offering a fresh submitted state", async () => {
    const state = {
      ...current(),
      orderVersion: 3,
      batches: [{ ...current().batches[0], cancellation: { cancelledOrderVersion: 3 } }],
    };
    mocks.current.mockResolvedValue(state);
    expect((await setup().resolve(tx, identity)).batch.cancellation).toEqual({
      cancelledOrderVersion: 3,
    });
  });
  it.each([
    null,
    { ...current(), storeReference: ref(99) },
    { ...current(), diningSessionReference: ref(99) },
    { ...current(), batches: [] },
    { ...current(), batches: [{ ...current().batches[0], sequence: 2 }] },
  ])("rejects missing or mismatched current ownership", async (state) => {
    mocks.current.mockResolvedValue(state);
    await expect(setup().resolve(tx, identity)).rejects.toThrow(
      "INITIAL_DINING_ACCEPTANCE_SOURCE_UNAVAILABLE",
    );
  });
  it("rejects a different original submission before current-state access", async () => {
    mocks.original.mockImplementation(async (_s, work) =>
      work(tx, { ...original(), submissionReference: ref(99) }),
    );
    await expect(setup().resolve(tx, identity)).rejects.toThrow(
      "INITIAL_DINING_ACCEPTANCE_SOURCE_UNAVAILABLE",
    );
    expect(mocks.current).not.toHaveBeenCalled();
  });
  it("rechecks actor authority after owner reads", async () => {
    const authorize = vi.fn().mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    await expect(setup(authorize).resolve(tx, identity)).rejects.toThrow(
      "INITIAL_DINING_ACCEPTANCE_SOURCE_UNAVAILABLE",
    );
  });
});
