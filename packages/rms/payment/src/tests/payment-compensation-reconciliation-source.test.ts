import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ConsumerTransaction } from "@bop/eventing";
import {
  parsePaymentCompensationCase,
  parsePaymentProviderConfirmedRefundFact,
} from "../application/paid-without-fulfillable-order.js";
import { createPaymentRefundedEnvelope } from "../application/payment-refunded-event.js";
import { encodePaymentCompensationRefund } from "../application/payment-compensation-refund-codec.js";
import { createPostgresPaymentCompensationReconciliationSource } from "../infrastructure/persistence/payment-compensation-evidence-source.js";
const id = (n: number) => "0190fa81-0000-7000-8000-" + String(n).padStart(12, "0"),
  digest = "sha256:" + "a".repeat(64),
  at = "2026-09-21T00:00:00.000Z";
function fixture() {
  const base = parsePaymentCompensationCase({
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
  const fact = parsePaymentProviderConfirmedRefundFact({
    refundReference: id(30),
    eventReference: id(31),
    compensationCaseReference: base.caseReference,
    paymentTransactionReference: base.paymentTransactionReference,
    paymentIntentReference: base.paymentIntentReference,
    paymentAttemptReference: base.paymentAttemptReference,
    orderReference: base.orderReference,
    brandReference: base.brandReference,
    storeReference: base.storeReference,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: 1130n, currencyCode: "CAD" },
    source: "ProviderRetrieval",
    providerConfirmedAt: at,
    recordedAt: at,
    evidenceDigest: digest,
    causationReference: id(32),
  });
  const receipt = { fact, event: createPaymentRefundedEnvelope({ fact }) };
  const hash =
    "sha256:" +
    createHash("sha256")
      .update(JSON.stringify(receipt, (_k, v) => (typeof v === "bigint" ? v.toString() : v)))
      .digest("hex");
  const current = parsePaymentCompensationCase({
    ...base,
    refundDisposition: "ProviderConfirmed",
    refundReference: fact.refundReference,
    refundCompositionDigest: hash,
    refundEvidenceDigest: digest,
    refundConfirmedAt: at,
  });
  const query = vi.fn(async (sql: string) => ({
    rows: sql.includes("case_history")
      ? [{ record: JSON.stringify(current) }]
      : sql.includes("compensation_refund")
        ? [{ record: encodePaymentCompensationRefund(receipt) }]
        : [],
    rowCount: 1,
  }));
  const tx = { query } as unknown as ConsumerTransaction,
    authorize = vi.fn(async () => true),
    read = createPostgresPaymentCompensationReconciliationSource({
      scope: { brandReference: id(2), storeReference: id(3) },
      authorize,
    });
  return { current, fact, receipt, tx, query, authorize, read };
}
it("prepares only matching committed confirmed Case/refund evidence", async () => {
  const f = fixture();
  expect(await f.read(f.tx, id(12))).toEqual({ caseRecord: f.current, refund: f.fact });
});
it("denies reads before authority and rejects revocation after source read", async () => {
  const f = fixture();
  f.authorize.mockResolvedValue(false);
  expect(await f.read(f.tx, id(12))).toBeNull();
  expect(f.query).not.toHaveBeenCalled();
  const g = fixture();
  g.authorize.mockResolvedValueOnce(true).mockResolvedValueOnce(true).mockResolvedValue(false);
  expect(await g.read(g.tx, id(12))).toBeNull();
});
it("rejects absent refund and mismatched Case digest", async () => {
  const f = fixture();
  f.query.mockImplementation(async (sql) => ({
    rows: sql.includes("case_history") ? [{ record: JSON.stringify(f.current) }] : [],
    rowCount: 1,
  }));
  expect(await f.read(f.tx, id(12))).toBeNull();
  const g = fixture();
  g.query.mockImplementation(async (sql) => ({
    rows: sql.includes("case_history")
      ? [
          {
            record: JSON.stringify({
              ...g.current,
              refundCompositionDigest: "sha256:" + "b".repeat(64),
            }),
          },
        ]
      : sql.includes("compensation_refund")
        ? [{ record: encodePaymentCompensationRefund(g.receipt) }]
        : [],
    rowCount: 1,
  }));
  expect(await g.read(g.tx, id(12))).toBeNull();
});
