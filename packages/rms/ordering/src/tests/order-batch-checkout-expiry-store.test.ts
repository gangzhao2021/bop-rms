import type { ConsumerTransaction } from "@bop/eventing";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { canonicalizeRfc8785 } from "@bop/audit";
import { createPostgresOrderBatchCheckoutExpiryStore } from "../infrastructure/persistence/order-batch-checkout-expiry-store.js";
const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@bop/audit", async (original) => ({
  ...(await original<typeof import("@bop/audit")>()),
  appendAuditRecordInTransaction: mocks.audit,
}));
const id = (n: number) => `0190ee28-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
function fixture() {
  const evidence = {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    commitmentReference: id(7),
    paymentOperationReference: id(8),
    paymentRequestedAt: "2026-09-21T00:00:00.000Z",
    capacityExpiresAt: "2026-09-21T00:30:00.000Z",
    observedAt: "2026-09-21T00:31:00.000Z",
    paymentEvidence: null,
  };
  const record = {
    ...evidence,
    recordReference: id(9),
    previousRecordReference: null,
    version: 1,
    status: "AwaitingPaymentResolution",
    evidenceDigest:
      "sha256:" + createHash("sha256").update(canonicalizeRfc8785(evidence)).digest("hex"),
  };
  const authorize = vi.fn(async () => true),
    fence = vi.fn(async () => true),
    readEvidence = vi.fn(async () => evidence);
  const audit = vi.fn(async () => ({
    auditId: id(10),
    brandId: id(2),
    storeId: id(3),
    actor: { type: "System" },
    actionCode: "ORDERING_BATCH_CHECKOUT_EXPIRY_RECORDED",
    targetType: "OrderBatch",
    targetId: id(5),
    correlationId: id(9),
    reasonCode: "CHECKOUT_DEADLINE_REACHED",
    occurredAt: evidence.observedAt,
    sourceChannel: "SYSTEM",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  }));
  let history: unknown[] = [];
  const query = vi.fn(async (sql: string) => {
    if (sql.startsWith("SELECT order_id")) return { rows: [{ order_id: id(4) }], rowCount: 1 };
    if (sql.includes("FROM rms_ordering.order_batch_checkout_expiry"))
      return { rows: history, rowCount: history.length };
    if (sql.startsWith("INSERT")) return { rows: [{ record_id: id(9) }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  });
  const store = createPostgresOrderBatchCheckoutExpiryStore({
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    now: () => evidence.observedAt,
    authorize,
    fence,
    evidence: readEvidence,
    audit,
  });
  mocks.audit.mockReset().mockResolvedValue(undefined);
  const row = () => {
    const { paymentEvidence: _unused, ...rest } = record;
    void _unused;
    return {
      ...rest,
      paymentIntentReference: null,
      paymentAttemptReference: null,
      paymentEventReference: null,
      outcome: null,
      terminalOccurredAt: null,
    };
  };
  return {
    store,
    record,
    evidence,
    authorize,
    fence,
    readEvidence,
    audit,
    tx: { query: query as typeof query & ConsumerTransaction["query"] },
    row,
    setHistory: (rows: unknown[]) => {
      history = rows;
    },
  };
}
it("writes only after Payment fence/evidence and appends Audit in the same transaction", async () => {
  const f = fixture();
  f.fence.mockImplementation(async () => {
    expect(f.tx.query).not.toHaveBeenCalled();
    return true;
  });
  expect((await f.store.append(f.tx, f.record)).status).toBe("Created");
  expect(f.readEvidence).toHaveBeenCalledWith(
    f.tx,
    expect.objectContaining({ orderBatchReference: id(5) }),
  );
  expect(mocks.audit).toHaveBeenCalledTimes(1);
  expect(mocks.audit.mock.calls[0]?.[0]).toBe(f.tx);
  expect(f.tx.query.mock.calls.filter(([sql]) => sql.startsWith("INSERT"))).toHaveLength(1);
});
it("returns exact existing history without adding Audit or re-observing evidence", async () => {
  const f = fixture();
  f.setHistory([f.row()]);
  expect((await f.store.append(f.tx, f.record)).status).toBe("Existing");
  expect(f.readEvidence).not.toHaveBeenCalled();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it("rejects changed content under the same record reference", async () => {
  const f = fixture();
  f.setHistory([{ ...f.row(), evidenceDigest: "sha256:" + "b".repeat(64) }]);
  await expect(f.store.append(f.tx, f.record)).rejects.toThrow();
  expect(mocks.audit).not.toHaveBeenCalled();
});
it("rejects foreign scope before any fence or SQL", async () => {
  const f = fixture();
  await expect(f.store.append(f.tx, { ...f.record, storeReference: id(11) })).rejects.toThrow();
  expect(f.fence).not.toHaveBeenCalled();
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("does not start owner locks when payment fence is refused", async () => {
  const f = fixture();
  f.fence.mockResolvedValue(false);
  await expect(f.store.append(f.tx, f.record)).rejects.toThrow();
  expect(f.tx.query).not.toHaveBeenCalled();
});
it("rejects unrelated or forged evidence before writing", async () => {
  const f = fixture();
  f.readEvidence.mockResolvedValue({ ...f.evidence, orderBatchReference: id(11) });
  await expect(f.store.append(f.tx, f.record)).rejects.toThrow();
  expect(f.audit).not.toHaveBeenCalled();
  expect(f.tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it("rechecks authorization after evidence", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(f.store.append(f.tx, f.record)).rejects.toThrow();
  expect(mocks.audit).not.toHaveBeenCalled();
  expect(f.tx.query.mock.calls.some(([sql]) => sql.startsWith("INSERT"))).toBe(false);
});
it("requires authorization for absence and rechecks before returning reads", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  await expect(
    f.store.load(f.tx, { orderReference: id(4), orderBatchReference: id(5) }),
  ).rejects.toThrow();
  expect(f.fence).not.toHaveBeenCalled();
});
