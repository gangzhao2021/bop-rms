import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import { createPostgresDiningBatchCancellationCandidates } from "../infrastructure/persistence/order-batch-checkout-expiry-store.js";
const id = (n: number) => `0190ee34-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-09-21T01:00:00.000Z";
function row(n = 20) {
  return {
    tenantReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(n + 1),
    submissionReference: id(n + 2),
    commitmentReference: id(n + 3),
    paymentOperationReference: id(n + 4),
    recordReference: id(n),
    previousRecordReference: null,
    version: 1,
    paymentRequestedAt: new Date("2026-09-21T00:00:00.000Z"),
    capacityExpiresAt: new Date("2026-09-21T00:30:00.000Z"),
    observedAt: new Date("2026-09-21T00:31:00.000Z"),
    evidenceDigest: "sha256:" + "a".repeat(64),
    status: "PaymentFailed",
    paymentIntentReference: id(n + 5),
    paymentAttemptReference: id(n + 6),
    paymentEventReference: id(n + 7),
    outcome: "Failed",
    terminalOccurredAt: new Date("2026-09-21T00:10:00.000Z"),
  };
}
function fixture() {
  const authorize = vi.fn().mockResolvedValue(true),
    query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  query.mockImplementation(async (sql: string) => ({
    rows: sql.includes("FROM rms_ordering") ? [row()] : [],
    rowCount: 0,
  }));
  const tx = { query: query as typeof query & ConsumerTransaction["query"] };
  return {
    authorize,
    query,
    tx,
    source: createPostgresDiningBatchCancellationCandidates({
      tenantReference: id(1),
      brandReference: id(2),
      storeReference: id(3),
      authorize,
    }),
  };
}
const request = { observedAt: at, after: null, limit: 2 };
it("decodes Failed records and binds exact scope/cursor/bound", async () => {
  const f = fixture(),
    result = await f.source.discover(f.tx, request);
  expect(result).toHaveLength(1);
  expect(result[0]?.paymentEvidence?.outcome).toBe("Failed");
  expect(f.query.mock.calls[1]?.[1]).toEqual([id(1), id(2), id(3), at, null, 2]);
  expect(f.authorize).toHaveBeenCalledTimes(2);
  expect(Object.isFrozen(result)).toBe(true);
});
it("denies before SQL and rechecks after SQL", async () => {
  const f = fixture();
  f.authorize.mockResolvedValueOnce(false);
  await expect(f.source.discover(f.tx, request)).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
  f.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
  await expect(f.source.discover(f.tx, request)).rejects.toThrow();
});
it.each(["foreign", "paid", "future", "reversed", "duplicate", "overflow"])(
  "rejects malformed query output %s",
  async (kind) => {
    const f = fixture(),
      a = row(),
      b = row(40);
    let rows = [a, b];
    if (kind === "foreign") b.tenantReference = id(999);
    if (kind === "paid") {
      b.status = "PaidBeforeDeadline";
      b.outcome = "Succeeded";
    }
    if (kind === "future") b.observedAt = new Date("2026-09-21T02:00:00.000Z");
    if (kind === "reversed") rows = [b, a];
    if (kind === "duplicate") b.orderBatchReference = a.orderBatchReference;
    if (kind === "overflow") rows = [a, b, row(60)];
    f.query.mockImplementation(async () => ({ rows, rowCount: rows.length }));
    await expect(f.source.discover(f.tx, request)).rejects.toThrow();
  },
);
it.each([0, 101, 1.1])("rejects invalid limit %s without SQL", async (limit) => {
  const f = fixture();
  await expect(f.source.discover(f.tx, { ...request, limit })).rejects.toThrow();
  expect(f.query).not.toHaveBeenCalled();
});
