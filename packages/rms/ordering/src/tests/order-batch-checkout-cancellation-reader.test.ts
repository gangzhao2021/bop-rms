import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderBatchCheckoutCancellationReader } from "../infrastructure/persistence/order-batch-checkout-expiry-store.js";
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
  let rows: unknown[] = [f.record];
  const authorize = vi.fn(async () => true),
    query = vi.fn(async (sql: string) => ({
      rows: sql.includes("FROM rms_ordering.order_batch_checkout_cancellation") ? rows : [],
      rowCount: rows.length,
    }));
  const tx = { query: query as typeof query & ConsumerTransaction["query"] };
  const reader = createPostgresOrderBatchCheckoutCancellationReader({
    ...f.record,
    now: () => f.record.cancelledAt,
    authorize,
  });
  const input = {
    orderReference: f.record.orderReference,
    orderBatchReference: f.record.orderBatchReference,
    operationReference: f.record.operationReference,
  };
  return {
    f,
    reader,
    tx,
    query,
    authorize,
    input,
    setRows: (value: unknown[]) => {
      rows = value;
    },
  };
}
it("returns original version, timestamp and references without writing", async () => {
  const f = readerFixture();
  expect(await f.reader.loadOperation(f.tx, f.input)).toEqual(f.f.record);
  expect(f.query.mock.calls.every(([sql]) => sql.startsWith("SELECT"))).toBe(true);
});
it("distinguishes missing from success", async () => {
  const f = readerFixture();
  f.setRows([]);
  expect(await f.reader.loadOperation(f.tx, f.input)).toBe(null);
});
it.each([
  "tenantReference",
  "orderReference",
  "orderBatchReference",
  "operationReference",
] as const)("refuses rebound %s", async (key) => {
  const f = readerFixture();
  f.setRows([{ ...f.f.record, [key]: id(99) }]);
  await expect(f.reader.loadOperation(f.tx, f.input)).rejects.toThrow();
});
it("does not query before authority and rechecks after read", async () => {
  const f = readerFixture();
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.reader.loadOperation(f.tx, f.input)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.reader.loadOperation(f.tx, f.input)).rejects.toThrow();
});
