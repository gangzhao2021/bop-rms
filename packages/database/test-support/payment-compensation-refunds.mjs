import { exerciseRefundOperations } from "./payment-compensation-refund-operations.mjs";
import assert from "node:assert/strict";
import {
  createPostgresPaymentCompensationRefundStore,
  parsePaymentProviderConfirmedRefundFact,
  createPaymentRefundedEnvelope,
} from "../../rms/payment/src/index.ts";
export async function exerciseCompensationRefunds({
  admin,
  transactions,
  role,
  scope,
  lease,
  caseRecord,
  token,
  setAuditFailure,
  setOutboxFailure,
  setLostAck,
}) {
  const id = (n) => "0190ed30-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const fact = parsePaymentProviderConfirmedRefundFact({
    refundReference: id(1),
    eventReference: id(2),
    compensationCaseReference: caseRecord.caseReference,
    paymentTransactionReference: caseRecord.paymentTransactionReference,
    paymentIntentReference: caseRecord.paymentIntentReference,
    paymentAttemptReference: caseRecord.paymentAttemptReference,
    orderReference: caseRecord.orderReference,
    ...scope,
    originalPaymentMethod: caseRecord.originalPaymentMethod,
    amount: { amountMinor: 2260n, currencyCode: "CAD" },
    source: "ProviderRetrieval",
    providerConfirmedAt: caseRecord.openedAt,
    recordedAt: caseRecord.openedAt,
    evidenceDigest: "sha256:" + "c".repeat(64),
    causationReference: id(3),
  });
  const event = createPaymentRefundedEnvelope({ fact });
  const audit = {
    auditId: id(4),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: "PAYMENT_COMPENSATION_REFUND_CONFIRMED",
    targetType: "PaymentRefund",
    targetId: fact.refundReference,
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    correlationId: caseRecord.caseReference,
    occurredAt: fact.providerConfirmedAt,
    sourceChannel: "SYSTEM",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
  const owner = (extra = {}) =>
    createPostgresPaymentCompensationRefundStore({
      transactions,
      scope,
      lease,
      authorize: async () => true,
      validateEvidence: async () => true,
      ...extra,
    });
  const store = owner();
  const input = {
    fact,
    event,
    audit,
    fenceReference: token.fenceReference,
    fenceVersion: token.fenceVersion,
  };
  const read = () => store.resolve({ compensationCaseReference: caseRecord.caseReference });
  const counts = async () => {
    const result = await admin.query(
      "SELECT (SELECT count(*) FROM rms_payment.payment_compensation_refund) AS refunds," +
        "(SELECT count(*) FROM platform_audit.audit_record WHERE action_code='PAYMENT_COMPENSATION_REFUND_CONFIRMED') AS audits," +
        "(SELECT count(*) FROM platform_eventing.outbox_event WHERE event_type='PaymentRefunded') AS events",
    );
    return Object.values(result.rows[0]).map(Number);
  };
  await admin.query("GRANT USAGE ON SCHEMA platform_eventing TO " + role);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_compensation_refund,platform_eventing.outbox_event TO " +
      role,
  );
  for (const setter of [setAuditFailure, setOutboxFailure]) {
    setter(true);
    await assert.rejects(store.record(input));
    setter(false);
    assert.deepEqual(await counts(), [0, 0, 0]);
  }
  await assert.rejects(owner({ validateEvidence: async () => false }).record(input));
  let writes = 0;
  await assert.rejects(
    owner({ authorize: async (_tx, access) => access.action !== "Record" || ++writes < 2 }).record(
      input,
    ),
  );
  assert.deepEqual(await counts(), [0, 0, 0]);
  await admin.query("BEGIN");
  await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
    "PaymentReceiptOrder:" +
      scope.brandReference +
      ":" +
      scope.storeReference +
      ":" +
      fact.orderReference,
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
    assert.deepEqual(await counts(), [0, 0, 0]);
  } finally {
    await admin.query("ROLLBACK");
  }

  setLostAck(true);
  const firstRace = await Promise.allSettled([store.record(input), store.record(input)]);
  assert.equal(firstRace.filter((result) => result.status === "rejected").length, 1);
  const recovered = firstRace.find((result) => result.status === "fulfilled");
  assert.equal(recovered?.value.status, "Duplicate");
  assert.deepEqual(await counts(), [1, 1, 1]);
  assert.deepEqual(await read(), { fact, event });
  const replay = await Promise.all([store.record(input), store.record(input)]);
  assert.deepEqual(
    replay.map((r) => r.status),
    ["Duplicate", "Duplicate"],
  );
  const changedFact = { ...fact, amount: { amountMinor: 2200n, currencyCode: "CAD" } };
  assert.equal(
    (
      await store.record({
        ...input,
        fact: changedFact,
        event: createPaymentRefundedEnvelope({ fact: changedFact }),
      })
    ).status,
    "Conflict",
  );
  assert.deepEqual(await counts(), [1, 1, 1]);
  await assert.rejects(
    owner({ authorize: async () => false }).resolve({
      compensationCaseReference: caseRecord.caseReference,
    }),
  );
  await exerciseRefundOperations({
    admin,
    transactions,
    role,
    scope,
    lease,
    token,
    caseRecord,
    fact,
    event,
  });
  await lease.lease.release({
    paymentAttemptReference: caseRecord.paymentAttemptReference,
    operationReference: caseRecord.operationReference,
    jobName: token.jobName,
    fenceReference: token.fenceReference,
    fenceVersion: token.fenceVersion,
  });
  await assert.rejects(store.record(input));
  assert.deepEqual(await counts(), [1, 1, 1]);
  const foreign = owner({ scope: { ...scope, storeReference: id(99) } });
  assert.equal(
    await foreign.resolve({ compensationCaseReference: caseRecord.caseReference }),
    null,
  );
  await transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      id(99),
    ]);
    assert.equal(
      (await tx.query("SELECT * FROM rms_payment.payment_compensation_refund", [])).rows.length,
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
        "INSERT INTO rms_payment.payment_compensation_refund " +
          "(brand_id,store_id,refund_id,case_id,order_id,payment_attempt_id,event_id,audit_id,fence_id,fence_version,amount_minor,recorded_at,record_json) " +
          "VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb)",
        [
          scope.brandReference,
          scope.storeReference,
          fact.refundReference,
          fact.compensationCaseReference,
          fact.orderReference,
          fact.paymentAttemptReference,
          event.eventId,
          audit.auditId,
          token.fenceReference,
          token.fenceVersion,
          "2260",
          fact.recordedAt,
          JSON.stringify({ fact, event }, (_key, item) =>
            typeof item === "bigint" ? item.toString() : item,
          ),
        ],
      );
    }),
    { code: "42501" },
  );
  await admin.query("GRANT UPDATE,DELETE ON rms_payment.payment_compensation_refund TO " + role);
  await transactions.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    assert.equal(
      (await tx.query("UPDATE rms_payment.payment_compensation_refund SET amount_minor=1", []))
        .rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_payment.payment_compensation_refund", [])).rowCount,
      0,
    );
  });
  assert.deepEqual(await counts(), [1, 1, 1]);
}
