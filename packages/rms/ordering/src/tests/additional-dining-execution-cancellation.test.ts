import { expect, it, vi } from "vitest";
import { createPostgresAdditionalDiningExecutionReader } from "../infrastructure/persistence/additional-dining-execution-reader.js";
const mocks = vi.hoisted(() => ({ history: vi.fn(), current: vi.fn() }));
vi.mock("../infrastructure/persistence/additional-dining-batch-store.js", () => ({
  createPostgresAdditionalDiningBatchHistoryReader: () => ({
    withCurrentSubmission: mocks.history,
  }),
  AdditionalDiningBatchStoreError: class extends Error {},
}));
vi.mock("../infrastructure/persistence/dining-order-item-state-reader.js", () => ({
  createPostgresDiningOrderItemStateReader: () => ({ load: mocks.current }),
}));
const id = (n: number) => `0190ee39-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture() {
  const at = "2026-09-21T00:00:00.000Z",
    later = "2026-09-21T00:31:00.000Z",
    scope = { brandReference: id(1), storeReference: id(2) },
    tx = { query: vi.fn() };
  const snapshot = {
    ...scope,
    orderReference: id(3),
    diningSessionReference: id(4),
    guestSessionReference: id(5),
    expectedOrderVersion: 4,
    batch: { orderBatchReference: id(6), submissionReference: id(7), submittedAt: at },
  };
  const cancellation = {
    submissionReference: id(7),
    expectedOrderVersion: 7,
    cancelledOrderVersion: 8,
    cancellationReference: id(8),
    cancelledAt: later,
  };
  const batch = {
    orderBatchReference: id(6),
    acceptance: null as unknown,
    cancellation: null as unknown,
  };
  mocks.history.mockReset().mockImplementation(async (_ref, _at, work) => work(tx, snapshot, {}));
  mocks.current.mockReset().mockImplementation(async () => ({
    ...scope,
    orderReference: id(3),
    orderVersion: 8,
    canonicalPhase: "Submitted",
    batches: [batch],
  }));
  const reader = createPostgresAdditionalDiningExecutionReader({
    ...scope,
    authorize: async () => true,
  });
  return {
    reader,
    input: { transaction: tx, submissionReference: id(7), observedAt: later },
    batch,
    cancellation,
  };
}
it("returns cancellation checkpoint rather than Submitted for an unaccepted cancelled target", async () => {
  const f = fixture();
  f.batch.cancellation = f.cancellation;
  expect(await f.reader.loadBySubmission(f.input)).toMatchObject({
    batchPhase: "Cancelled",
    batchVersion: 8,
    batchCheckpoint: id(8),
    batchOccurredAt: f.cancellation.cancelledAt,
  });
});
it("keeps a different uncancelled target Submitted", async () => {
  const f = fixture();
  expect(await f.reader.loadBySubmission(f.input)).toMatchObject({
    batchPhase: "Submitted",
    batchVersion: 5,
    batchCheckpoint: id(7),
  });
});
it.each(["submission", "version", "time", "accepted"])(
  "rejects contradictory cancellation %s",
  async (kind) => {
    const f = fixture();
    f.batch.cancellation = {
      ...f.cancellation,
      ...(kind === "submission"
        ? { submissionReference: id(99) }
        : kind === "version"
          ? { cancelledOrderVersion: 9 }
          : kind === "time"
            ? { cancelledAt: "2026-09-21T00:32:00.000Z" }
            : {}),
    };
    if (kind === "accepted")
      f.batch.acceptance = {
        expectedOrderVersion: 5,
        acceptedOrderVersion: 6,
        acceptedAt: f.input.observedAt,
      };
    await expect(f.reader.loadBySubmission(f.input)).rejects.toThrow();
  },
);
