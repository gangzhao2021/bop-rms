import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresOrderBatchCheckoutCancellationStore } from "../infrastructure/persistence/order-batch-checkout-expiry-store.js";
const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
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

function storeFixture() {
  const f = fixture();
  let previous: unknown[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT order_id"))
      return { rows: [{ order_id: f.record.orderReference }], rowCount: 1 };
    if (sql.includes("FROM rms_ordering.order_batch_checkout_cancellation"))
      return { rows: previous, rowCount: previous.length };
    if (sql.startsWith("INSERT INTO rms_ordering.order_batch_checkout_cancellation"))
      return { rows: [{ cancellation_id: f.record.cancellationReference }], rowCount: 1 };
    if (sql.startsWith("INSERT INTO rms_ordering.order_revision"))
      return { rows: [{ revision_id: f.record.cancellationReference }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const tx = { query: query as typeof query & ConsumerTransaction["query"] };
  const authorize = vi.fn(async () => true),
    fence = vi.fn(async () => true),
    workflow = vi.fn(async () => true);
  const source = vi.fn(async () => ({
    expiry: f.expiry,
    items: f.items,
    orderVersion: 7,
    checkpoint: f.record.expectedSourceCheckpoint,
  }));
  const audit = vi.fn(async () => ({
    auditId: id(99),
    brandId: f.record.brandReference,
    storeId: f.record.storeReference,
    actor: { type: "System" },
    actionCode: "ORDERING_BATCH_CHECKOUT_CANCELLED",
    targetType: "OrderBatch",
    targetId: f.record.orderBatchReference,
    correlationId: f.record.operationReference,
    reasonCode: f.record.reasonCode,
    occurredAt: f.record.cancelledAt,
    sourceChannel: "SYSTEM",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  }));
  mocks.audit.mockReset().mockResolvedValue(undefined);
  const store = createPostgresOrderBatchCheckoutCancellationStore({
    ...f.record,
    now: () => f.record.cancelledAt,
    authorize,
    fence,
    source,
    workflow,
    audit,
  });
  return {
    f,
    store,
    tx,
    query,
    authorize,
    fence,
    source,
    workflow,
    setPrevious: (rows: unknown[]) => {
      previous = rows;
    },
  };
}
it("retains Payment fence before owner locks and writes cancellation/revision/Audit in same transaction", async () => {
  const f = storeFixture();
  f.fence.mockImplementation(async () => {
    expect(f.query).not.toHaveBeenCalled();
    return true;
  });
  expect((await f.store.append(f.tx, f.f.record)).status).toBe("Created");
  expect(f.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(2);
  expect(mocks.audit.mock.calls[0]?.[0]).toBe(f.tx);
});
it("replays exact record without new source, workflow or Audit", async () => {
  const f = storeFixture();
  f.setPrevious([f.f.record]);
  expect((await f.store.append(f.tx, f.f.record)).status).toBe("Existing");
  expect(f.source).not.toHaveBeenCalled();
  expect(f.workflow).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("refuses changed content under an existing operation", async () => {
  const f = storeFixture();
  f.setPrevious([{ ...f.f.record, workflowVersionReference: id(100) }]);
  await expect(f.store.append(f.tx, f.f.record)).rejects.toThrow();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it.each(["scope", "authority", "fence", "source", "workflow"])(
  "refuses invalid %s without writes",
  async (kind) => {
    const f = storeFixture();
    if (kind === "authority") f.authorize.mockResolvedValue(false);
    if (kind === "fence") f.fence.mockResolvedValue(false);
    if (kind === "source") f.source.mockResolvedValue({ ...(await f.source()), orderVersion: 8 });
    if (kind === "workflow") f.workflow.mockResolvedValue(false);
    await expect(
      f.store.append(f.tx, {
        ...f.f.record,
        ...(kind === "scope" ? { storeReference: id(100) } : {}),
      }),
    ).rejects.toThrow();
    expect(f.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
  },
);
it("propagates Audit failure so caller cannot commit incomplete operation", async () => {
  const f = storeFixture();
  mocks.audit.mockRejectedValue(new Error("AUDIT_FAILED"));
  await expect(f.store.append(f.tx, f.f.record)).rejects.toThrow();
});
