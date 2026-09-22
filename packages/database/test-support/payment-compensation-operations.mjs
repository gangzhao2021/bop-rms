import assert from "node:assert/strict";
import {
  createPostgresPaymentCompensationOperationsStore,
  parsePaymentOperationsReconciliationReceipt,
} from "../../rms/payment/src/index.ts";
export async function exerciseCompensationOperations({
  admin,
  transactions,
  role,
  scope,
  caseRecord,
  setAuditFailure,
  setLostAck,
}) {
  const id = (n) => "0190ed40-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const receipt = parsePaymentOperationsReconciliationReceipt({
    receiptReference: id(1),
    compensationCaseReference: caseRecord.caseReference,
    refundReference: id(2),
    ...scope,
    actorReference: id(3),
    purpose: "ReconcilePaidWithoutFulfillableOrder",
    refundEvidenceDigest: "sha256:" + "d".repeat(64),
    reconciledAt: caseRecord.openedAt,
    audit: {
      auditId: id(4),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: id(3) },
      actionCode: "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED",
      targetType: "PaymentCompensationCase",
      targetId: caseRecord.caseReference,
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
      correlationId: id(1),
      occurredAt: caseRecord.openedAt,
      sourceChannel: "OPERATIONS",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  const accesses = [];
  const owner = (extra = {}) =>
    createPostgresPaymentCompensationOperationsStore({
      transactions,
      scope,
      authorize: async (_tx, access) => {
        accesses.push(access);
        return true;
      },
      validateEvidence: async () => true,
      ...extra,
    });
  const store = owner();
  const input = { receipt, expectedCaseVersion: caseRecord.version };
  const query = { compensationCaseReference: caseRecord.caseReference };
  const counts = async () => {
    const result = await admin.query(
      "SELECT (SELECT count(*) FROM rms_payment.payment_compensation_operations) AS operations," +
        "(SELECT count(*) FROM platform_audit.audit_record WHERE action_code='PAYMENT_COMPENSATION_OPERATIONS_RECONCILED') AS audits",
    );
    return Object.values(result.rows[0]).map(Number);
  };
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_compensation_operations TO " + role,
  );
  await admin.query("GRANT SELECT ON rms_payment.payment_compensation_refund TO " + role);
  await assert.rejects(store.record({ ...input, expectedCaseVersion: 2 }), {
    code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  });
  await assert.rejects(owner({ validateEvidence: async () => false }).record(input));
  setAuditFailure(true);
  await assert.rejects(store.record(input));
  setAuditFailure(false);
  let calls = 0;
  await assert.rejects(owner({ authorize: async () => ++calls < 2 }).record(input));
  assert.deepEqual(await counts(), [0, 0]);
  await admin.query("BEGIN");
  await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "PaymentReceiptOrder:" +
      scope.brandReference +
      ":" +
      scope.storeReference +
      ":" +
      caseRecord.orderReference,
  ]);
  try {
    const blocked = owner({
      transactions: {
        run: (work) =>
          transactions.run(async (tx) => {
            await tx.query("SET LOCAL lock_timeout='30ms'", []);
            return work(tx);
          }),
      },
    });
    await assert.rejects(blocked.record(input));
  } finally {
    await admin.query("ROLLBACK");
  }
  setLostAck(true);
  const first = await Promise.allSettled([store.record(input), store.record(input)]);
  assert.equal(first.filter((value) => value.status === "rejected").length, 1);
  assert.equal(first.find((value) => value.status === "fulfilled")?.value.status, "Duplicate");
  assert.deepEqual(await counts(), [1, 1]);
  assert.deepEqual(await store.resolve(query), receipt);
  assert.equal((await store.record({ ...input, expectedCaseVersion: 999 })).status, "Duplicate");
  const changed = { ...receipt, refundEvidenceDigest: "sha256:" + "e".repeat(64) };
  assert.equal((await store.record({ ...input, receipt: changed })).status, "Conflict");
  assert.ok(
    accesses.some(
      (access) =>
        access.action === "Record" &&
        access.actorReference === receipt.actorReference &&
        access.purpose === receipt.purpose &&
        access.brandReference === scope.brandReference &&
        access.storeReference === scope.storeReference,
    ),
  );
  await assert.rejects(owner({ authorize: async () => false }).resolve(query));
  await assert.rejects(owner({ authorize: async () => false }).record(input));
  assert.equal(await owner({ scope: { ...scope, storeReference: id(99) } }).resolve(query), null);
  await transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      id(99),
    ]);
    assert.equal(
      (await tx.query("SELECT * FROM rms_payment.payment_compensation_operations", [])).rows.length,
      0,
    );
  });
  await assert.rejects(
    transactions.run(async (tx) => {
      await tx.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, id(99)],
      );
      await tx.query(
        "INSERT INTO rms_payment.payment_compensation_operations " +
          "(brand_id,store_id,receipt_id,case_id,case_version,order_id,refund_id,actor_id,audit_id,recorded_at,record_json) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)",
        [
          scope.brandReference,
          scope.storeReference,
          receipt.receiptReference,
          caseRecord.caseReference,
          1,
          caseRecord.orderReference,
          receipt.refundReference,
          receipt.actorReference,
          receipt.audit.auditId,
          receipt.reconciledAt,
          JSON.stringify(receipt),
        ],
      );
    }),
    { code: "42501" },
  );
  await admin.query(
    "GRANT UPDATE,DELETE ON rms_payment.payment_compensation_operations TO " + role,
  );
  await transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    assert.equal(
      (
        await tx.query(
          "UPDATE rms_payment.payment_compensation_operations SET actor_id=receipt_id",
          [],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_payment.payment_compensation_operations", [])).rowCount,
      0,
    );
  });
  assert.deepEqual(await counts(), [1, 1]);
}
