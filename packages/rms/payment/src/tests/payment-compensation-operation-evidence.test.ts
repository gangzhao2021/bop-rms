import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaidWithoutFulfillableOrderDisposition,
  parsePaymentCompensationCase,
  createPaidWithoutFulfillableExceptionSource,
  parsePaymentCompensationResult,
} from "../application/paid-without-fulfillable-order.js";
import { createPostgresPaymentCompensationOperationEvidence } from "../infrastructure/persistence/payment-compensation-evidence-source.js";
const id = (n: number) => "0190fa78-0000-7000-8000-" + String(n).padStart(12, "0"),
  hash = (x: unknown) => "sha256:" + createHash("sha256").update(JSON.stringify(x)).digest("hex"),
  digest = "sha256:" + "a".repeat(64),
  at = "2026-09-21T00:00:00.000Z";
function fixture() {
  const disposition = parsePaidWithoutFulfillableOrderDisposition({
    dispositionReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    orderBatchReference: id(5),
    submissionReference: id(6),
    paymentTransactionReference: id(7),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
    paymentEventReference: id(10),
    sourceVersion: 1,
    sourceCheckpoint: id(11),
    sourceDigest: digest,
    evaluatedAt: at,
    disposition: "PaidWithoutFulfillableOrder",
    reason: "SubmissionCancelled",
    kitchenReleaseDisposition: "Blocked",
  });
  const current = parsePaymentCompensationCase({
    caseReference: id(12),
    operationReference: id(13),
    dispositionReference: id(1),
    brandReference: id(2),
    storeReference: id(3),
    orderReference: id(4),
    paymentTransactionReference: id(7),
    paymentIntentReference: id(8),
    paymentAttemptReference: id(9),
    environment: "Test",
    originalPaymentMethod: "OnlineCard",
    reason: "PaidWithoutFulfillableOrder",
    dispositionDigest: digest,
    terminalEvidenceDigest: digest,
    sourceVersion: 1,
    sourceSnapshotDigest: digest,
    severity: "Critical",
    state: "Open",
    refundDisposition: "RefundPending",
    operationsDisposition: "Pending",
    refundReference: null,
    refundCompositionDigest: null,
    refundEvidenceDigest: null,
    refundConfirmedAt: null,
    operationsReceiptReference: null,
    operationsReceiptDigest: null,
    operationsRefundEvidenceDigest: null,
    operationsReconciledAt: null,
    openedAt: at,
    updatedAt: at,
    closedAt: null,
    version: 2,
  });
  const result = parsePaymentCompensationResult({
    status: "RefundPending",
    operationReference: id(13),
    caseReference: id(12),
    evaluatedAt: at,
    refundReference: null,
    eventReference: null,
    exceptionSource: createPaidWithoutFulfillableExceptionSource(current),
  });
  const record = { disposition, result, requestDigest: digest, resultDigest: hash(result) };
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("case_history") ? [{ record: JSON.stringify(current) }] : [],
    rowCount: 1,
  }));
  const tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true),
    verify = createPostgresPaymentCompensationOperationEvidence({
      scope: { brandReference: id(2), storeReference: id(3) },
      authorize,
    });
  return { current, result, record, query, tx, authorize, verify };
}
it("matches pending result to actual latest Case without inventing completion", async () => {
  const f = fixture();
  expect(await f.verify(f.tx, f.record)).toBe(true);
  expect(f.query.mock.calls.some(([sql]) => sql.includes("compensation_refund"))).toBe(false);
});
it("rejects missing or different persisted case", async () => {
  const f = fixture();
  f.query
    .mockResolvedValueOnce({ rows: [], rowCount: 1 })
    .mockResolvedValueOnce({ rows: [], rowCount: 0 });
  expect(await f.verify(f.tx, f.record)).toBe(false);
  const g = fixture();
  g.query.mockImplementation(async (sql) => ({
    rows: sql.includes("case_history")
      ? [{ record: JSON.stringify({ ...g.current, orderReference: id(99) }) }]
      : [],
    rowCount: 1,
  }));
  expect(await g.verify(g.tx, g.record)).toBe(false);
});
it("rejects altered result digest and result time", async () => {
  const f = fixture();
  expect(await f.verify(f.tx, { ...f.record, resultDigest: "sha256:" + "b".repeat(64) })).toBe(
    false,
  );
  const later = "2026-09-21T01:00:00.000Z";
  const changed = parsePaymentCompensationResult({
    ...f.result,
    evaluatedAt: later,
    exceptionSource: createPaidWithoutFulfillableExceptionSource(
      parsePaymentCompensationCase({ ...f.current, updatedAt: later }),
    ),
  });
  expect(await f.verify(f.tx, { ...f.record, result: changed, resultDigest: hash(changed) })).toBe(
    false,
  );
});
it("denies reads without authority and rejects authority revoked after reading", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  expect(await f.verify(f.tx, f.record)).toBe(false);
  expect(f.query).not.toHaveBeenCalled();
  const g = fixture();
  g.authorize.mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await g.verify(g.tx, g.record)).toBe(false);
});
