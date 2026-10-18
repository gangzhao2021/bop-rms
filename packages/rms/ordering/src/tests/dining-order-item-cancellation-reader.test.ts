import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresDiningOrderItemStateReader } from "../infrastructure/persistence/dining-order-item-state-reader.js";
const mocks = vi.hoisted(() => ({ current: vi.fn(), acceptance: vi.fn() }));
vi.mock("../infrastructure/persistence/order-termination-store.js", () => ({
  createPostgresDiningOrderPreparationSource: () => ({ resolveCurrent: mocks.current }),
}));
vi.mock("../infrastructure/persistence/order-acceptance-store.js", () => ({
  createPostgresOrderAcceptanceReader: () => ({ loadByBatch: mocks.acceptance }),
}));
const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture() {
  const identity = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    paymentOperationReference: id(7),
  };
  const expiry = {
    ...identity,
    commitmentReference: id(8),
    recordReference: id(9),
    previousRecordReference: null,
    version: 1,
    paymentRequestedAt: "2026-09-21T00:00:00.000Z",
    capacityExpiresAt: "2026-09-21T00:30:00.000Z",
    observedAt: "2026-09-21T00:31:00.000Z",
    evidenceDigest: "sha256:" + "a".repeat(64),
    status: "PaymentFailed",
    paymentEvidence: {
      paymentIntentReference: id(10),
      paymentAttemptReference: id(11),
      paymentEventReference: id(12),
      outcome: "Failed",
      occurredAt: "2026-09-21T00:10:00.000Z",
    },
  };
  const record = {
    ...identity,
    cancellationReference: id(13),
    operationReference: id(14),
    expiryRecordReference: id(9),
    expiryEvidenceDigest: expiry.evidenceDigest,
    expectedOrderVersion: 7,
    cancelledOrderVersion: 8,
    expectedSourceCheckpoint: id(15),
    workflowVersionReference: id(16),
    transitionReference: id(17),
    orderItemReferences: [id(18)],
    cancelledAt: expiry.observedAt,
    phase: "Cancelled",
    reasonCode: "CHECKOUT_DEADLINE_REACHED",
  };
  const items = [
    {
      orderBatchReference: id(19),
      orderItemReference: id(20),
      phase: "Ready" as const,
      everAccepted: true,
      everStarted: true,
    },
    {
      orderBatchReference: id(5),
      orderItemReference: id(18),
      phase: "Submitted" as const,
      everAccepted: false,
      everStarted: false,
    },
  ] as const;
  return { record, expiry, items };
}

function readerFixture() {
  const f = fixture();
  const scope = {
    brandReference: f.record.brandReference,
    storeReference: f.record.storeReference,
  };
  mocks.current
    .mockReset()
    .mockResolvedValue({ ...scope, orderReference: f.record.orderReference, orderVersion: 8 });
  mocks.acceptance.mockReset().mockResolvedValue(null);
  let cancellation: unknown = f.record;
  const rows = [
    {
      order_item_id: id(20),
      order_batch_id: id(19),
      quantity: 1,
      submission_kind: "Initial",
      batch_sequence: null,
    },
    {
      order_item_id: id(18),
      order_batch_id: id(5),
      quantity: 1,
      submission_kind: "Additional",
      batch_sequence: 2,
    },
  ];
  let staff: unknown[] = [];
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("FROM rms_ordering.order_batch_checkout_cancellation")
      ? cancellation === null
        ? []
        : [cancellation]
      : sql.includes("FROM rms_ordering.order_staff_cancellation")
        ? staff
        : sql.includes("FROM rms_ordering.order_item_staff_cancellation")
          ? []
          : rows,
    rowCount: 1,
  }));
  const input = {
    ...scope,
    orderReference: f.record.orderReference,
    diningSessionReference: id(90),
    guestSessionReference: id(91),
    observedAt: f.record.cancelledAt,
    transaction: { query: query as typeof query & ConsumerTransaction["query"] },
  };
  const reader = createPostgresDiningOrderItemStateReader({
    ...scope,
    authorize: async () => true,
  });
  return {
    f,
    input,
    reader,
    setCancellation: (value: unknown) => {
      cancellation = value;
    },
    setStaff: (value: unknown[]) => {
      staff = value;
    },
  };
}
it("retains cancellation on exactly its Batch and member items", async () => {
  const f = readerFixture(),
    result = await f.reader.load(f.input);
  expect(
    result?.items.find((item) => item.orderItemReference === id(18))?.cancellation
      ?.cancellationReference,
  ).toBe(f.f.record.cancellationReference);
  expect(result?.items.find((item) => item.orderItemReference === id(20))?.cancellation).toBe(null);
});
it.each(["membership", "version", "scope"])(
  "refuses inconsistent cancellation %s",
  async (kind) => {
    const f = readerFixture();
    f.setCancellation({
      ...f.f.record,
      ...(kind === "membership"
        ? { orderItemReferences: [id(99)] }
        : kind === "version"
          ? { expectedOrderVersion: 8, cancelledOrderVersion: 9 }
          : { storeReference: id(99) }),
    });
    await expect(f.reader.load(f.input)).rejects.toThrow();
  },
);
it("refuses contradictory acceptance and cancellation", async () => {
  const f = readerFixture();
  mocks.acceptance.mockImplementation(async (input) =>
    input.orderBatchReference === id(5)
      ? { acceptedOrderVersion: 7, acceptedAt: f.input.observedAt }
      : null,
  );
  await expect(f.reader.load(f.input)).rejects.toThrow("ORDER_ITEM_STATE_UNAVAILABLE");
});

function staffRecord(overrides: Record<string, unknown> = {}) {
  return {
    cancellationReference: id(40),
    operationReference: id(41),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    orderType: "DineIn",
    expectedOrderVersion: 7,
    cancelledOrderVersion: 8,
    expectedSourceCheckpoint: id(42),
    actorReference: id(43),
    reasonCode: "SOLD_OUT",
    paymentDispositionReference: id(44),
    paymentTransactionReference: id(45),
    paymentIntentReference: id(46),
    paymentAttemptReference: id(47),
    paymentEventReference: id(48),
    orderItemReferences: [id(18)],
    kitchenEvidenceDigest: "sha256:" + "b".repeat(64),
    sourceDigest: "sha256:" + "c".repeat(64),
    auditReference: id(49),
    cancelledAt: "2026-09-21T00:31:00.000Z",
    ...overrides,
  };
}
function staffFixture(overrides: Record<string, unknown> = {}) {
  const f = readerFixture();
  f.setCancellation(null);
  f.setStaff([staffRecord(overrides)]);
  mocks.acceptance.mockImplementation(async (input) =>
    input.orderBatchReference === id(5)
      ? { acceptedOrderVersion: 6, acceptedAt: "2026-09-21T00:20:00.000Z" }
      : null,
  );
  return f;
}
it("keeps acceptance and exposes the staff cancellation on exactly its Batch and items", async () => {
  const f = staffFixture(),
    result = await f.reader.load(f.input);
  const batch = result?.batches.find((value) => value.orderBatchReference === id(5));
  expect(batch?.acceptance).not.toBe(null);
  expect(batch?.cancellation).toBe(null);
  expect(batch?.staffCancellation?.cancellationReference).toBe(id(40));
  expect(
    result?.items.find((item) => item.orderItemReference === id(18))?.staffCancellation?.reasonCode,
  ).toBe("SOLD_OUT");
  expect(result?.items.find((item) => item.orderItemReference === id(20))?.staffCancellation).toBe(
    null,
  );
});
it.each([
  ["membership", { orderItemReferences: [id(99)] }],
  ["newer than the Order", { expectedOrderVersion: 8, cancelledOrderVersion: 9 }],
  ["pickup", { orderType: "Pickup" }],
  ["future", { cancelledAt: "2026-09-21T00:32:00.000Z" }],
])("refuses an inconsistent staff cancellation (%s)", async (_name, overrides) => {
  const f = staffFixture(overrides);
  await expect(f.reader.load(f.input)).rejects.toThrow("ORDER_ITEM_STATE_UNAVAILABLE");
});
it("refuses a staff cancellation without, or before, its Batch acceptance", async () => {
  const f = staffFixture();
  mocks.acceptance.mockResolvedValue(null);
  await expect(f.reader.load(f.input)).rejects.toThrow("ORDER_ITEM_STATE_UNAVAILABLE");
  mocks.acceptance.mockImplementation(async (input) =>
    input.orderBatchReference === id(5)
      ? { acceptedOrderVersion: 8, acceptedAt: "2026-09-21T00:20:00.000Z" }
      : null,
  );
  await expect(f.reader.load(f.input)).rejects.toThrow("ORDER_ITEM_STATE_UNAVAILABLE");
});
it("refuses a Batch with both a checkout and a staff cancellation", async () => {
  const f = staffFixture();
  f.setCancellation(f.f.record);
  await expect(f.reader.load(f.input)).rejects.toThrow("ORDER_ITEM_STATE_UNAVAILABLE");
});
