import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresPaymentCompensationOperationsStore,
  createPostgresPaymentCompensationCaseStore,
  createPostgresPaymentCompensationEvidenceValidator,
  parsePaymentOperationsReconciliationReceipt,
  parsePaymentCompensationCase,
} from "../../rms/payment/src/index.ts";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
const digest = (value) => "sha256:" + createHash("sha256").update(json(value)).digest("hex");
export async function exerciseRefundOperations({
  admin,
  transactions,
  role,
  scope,
  lease,
  token,
  caseRecord,
  fact,
  event,
}) {
  const id = (n) => "0190ed50-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const receipt = parsePaymentOperationsReconciliationReceipt({
    receiptReference: id(1),
    compensationCaseReference: caseRecord.caseReference,
    refundReference: fact.refundReference,
    ...scope,
    actorReference: id(2),
    purpose: "ReconcilePaidWithoutFulfillableOrder",
    refundEvidenceDigest: fact.evidenceDigest,
    reconciledAt: fact.recordedAt,
    audit: {
      auditId: id(3),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: id(2) },
      actionCode: "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED",
      targetType: "PaymentCompensationCase",
      targetId: caseRecord.caseReference,
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
      correlationId: id(1),
      occurredAt: fact.recordedAt,
      sourceChannel: "OPERATIONS",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_compensation_operations TO " + role,
  );
  const operations = createPostgresPaymentCompensationOperationsStore({
    transactions,
    scope,
    authorize: async () => true,
    validateEvidence: async () => true,
  });
  for (const change of [
    { refundEvidenceDigest: "sha256:" + "f".repeat(64) },
    { refundReference: id(99) },
  ]) {
    await assert.rejects(
      operations.record({
        receipt: { ...receipt, ...change },
        expectedCaseVersion: caseRecord.version,
      }),
      { code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT" },
    );
  }
  assert.equal(
    (await operations.record({ receipt, expectedCaseVersion: caseRecord.version })).status,
    "Created",
  );
  const stored = await operations.resolve({ compensationCaseReference: caseRecord.caseReference });
  assert.deepEqual(stored, receipt);
  const next = parsePaymentCompensationCase({
    ...caseRecord,
    version: caseRecord.version + 1,
    state: "Closed",
    refundDisposition: "ProviderConfirmed",
    refundReference: fact.refundReference,
    refundCompositionDigest: digest({ fact, event }),
    refundEvidenceDigest: fact.evidenceDigest,
    refundConfirmedAt: fact.providerConfirmedAt,
    operationsDisposition: "Reconciled",
    operationsReceiptReference: stored.receiptReference,
    operationsReceiptDigest: digest(stored),
    operationsRefundEvidenceDigest: stored.refundEvidenceDigest,
    operationsReconciledAt: stored.reconciledAt,
    updatedAt: stored.reconciledAt,
    closedAt: stored.reconciledAt,
  });
  // Validate transition against committed owner records using the same transaction/fences.
  const cases = createPostgresPaymentCompensationCaseStore({
    transactions,
    scope,
    lease,
    authorize: async () => true,
    validateOpen: async () => false,
    validateTransition: createPostgresPaymentCompensationEvidenceValidator({
      scope,
      validateCurrentSource: async () => true,
    }),
  });
  const update = {
    current: caseRecord,
    next,
    refund: fact,
    operations: stored,
    fenceReference: token.fenceReference,
    fenceVersion: token.fenceVersion,
  };
  await assert.rejects(
    cases.reconcile({
      ...update,
      next: { ...next, refundCompositionDigest: "sha256:" + "f".repeat(64) },
    }),
    { code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE" },
  );
  assert.equal((await cases.reconcile(update)).status, "Updated");
  assert.equal((await cases.reconcile(update)).status, "Duplicate");
  assert.deepEqual(await cases.resolve({ caseReference: caseRecord.caseReference }), next);
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_operations")).rows[0]
      .count,
    "1",
  );
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_case_history"))
      .rows[0].count,
    "2",
  );
}
