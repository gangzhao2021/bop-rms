import assert from "node:assert/strict";
import {
  createPostgresPaymentCompensationActionStore,
  createPostgresPaymentCompensationRefundPositionSource,
  createPostgresPaymentCompensationRefundStore,
  parsePaymentProviderConfirmedRefundFact,
  createPaymentRefundedEnvelope,
  parsePaymentCompensationActionReceipt,
} from "../../rms/payment/src/index.ts";
export async function exerciseCompensationActions({
  admin,
  transactions,
  role,
  scope,
  lease,
  caseRecord,
  token,
  setAuditFailure,
  setLostAck,
}) {
  const id = (n) => "0190ed10-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  const time = (offset) => new Date(Date.parse(caseRecord.openedAt) + offset).toISOString();
  const receipt = parsePaymentCompensationActionReceipt({
    actionReference: id(1),
    compensationCaseReference: caseRecord.caseReference,
    ...scope,
    paymentTransactionReference: caseRecord.paymentTransactionReference,
    paymentAttemptReference: caseRecord.paymentAttemptReference,
    originalPaymentMethod: "OnlineCard",
    amount: { amountMinor: 2260n, currencyCode: "CAD" },
    interacEvidenceReference: null,
    interacEvidenceDigest: null,
    dispositionDigest: caseRecord.dispositionDigest,
    terminalEvidenceDigest: caseRecord.terminalEvidenceDigest,
    sourceVersion: caseRecord.sourceVersion,
    sourceSnapshotDigest: caseRecord.sourceSnapshotDigest,
    providerObservationDigest: "sha256:" + "a".repeat(64),
    actionDigest: "sha256:" + "b".repeat(64),
    providerIdempotencyKey: "WP1310:" + "c".repeat(64),
    claimedAt: caseRecord.openedAt,
    claimDisposition: "Claimed",
    phase: "Claimed",
  });
  const audit = {
    auditId: id(2),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode: "PAYMENT_COMPENSATION_REFUND_CLAIMED",
    targetType: "PaymentCompensationAction",
    targetId: receipt.actionReference,
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    correlationId: caseRecord.caseReference,
    occurredAt: receipt.claimedAt,
    sourceChannel: "SYSTEM",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  };
  const owner = (extra = {}) =>
    createPostgresPaymentCompensationActionStore({
      transactions,
      scope,
      lease,
      authorize: async () => true,
      validateClaim: async () => true,
      validateOutcome: async () => true,
      ...extra,
    });
  const store = owner();
  await admin.query("GRANT SELECT ON rms_payment.payment_compensation_refund TO " + role);
  const positionReader = createPostgresPaymentCompensationRefundPositionSource({
    scope,
    authorize: async () => true,
  });
  const readPosition = () =>
    transactions.run((tx) =>
      positionReader(tx, {
        orderReference: caseRecord.orderReference,
        paymentTransactionReference: caseRecord.paymentTransactionReference,
        paymentAttemptReference: caseRecord.paymentAttemptReference,
      }),
    );

  const claim = (value = receipt, target = store) =>
    target.claim({
      receipt: value,
      audit,
      interacEvidence: null,
      fenceReference: token.fenceReference,
      fenceVersion: token.fenceVersion,
    });
  const count = async () =>
    Number(
      (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_action_history"))
        .rows[0].count,
    );
  const audits = async () =>
    Number(
      (
        await admin.query(
          "SELECT count(*) FROM platform_audit.audit_record WHERE action_code='PAYMENT_COMPENSATION_REFUND_CLAIMED'",
        )
      ).rows[0].count,
    );
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_compensation_action_history TO " + role,
  );
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
    await assert.rejects(claim(receipt, blocked), {
      code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
    });
    assert.equal(await count(), 0);
  } finally {
    await admin.query("ROLLBACK");
  }
  setAuditFailure(true);
  await assert.rejects(claim(), { code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE" });
  setAuditFailure(false);
  assert.equal(await count(), 0);
  assert.equal(await audits(), 0);
  await assert.rejects(claim(receipt, owner({ validateClaim: async () => false })), {
    code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
  });
  const claimed = await Promise.all([claim(), claim()]);
  assert.deepEqual(claimed.map((value) => value.claimDisposition).sort(), ["Claimed", "Existing"]);
  assert.equal(await count(), 1);
  assert.equal(await audits(), 1);
  assert.deepEqual(await store.resolve({ actionReference: receipt.actionReference }), receipt);
  await assert.rejects(claim({ ...receipt, amount: { amountMinor: 2261n, currencyCode: "CAD" } }), {
    code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  });
  await assert.rejects(claim({ ...receipt, providerIdempotencyKey: "WP1310:" + "d".repeat(64) }), {
    code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  });
  const outcome = (expectedPhase, nextPhase, offset, active = token, target = store) =>
    target.recordOutcome({
      actionReference: receipt.actionReference,
      expectedPhase,
      nextPhase,
      observedAt: time(offset),
      fenceReference: active.fenceReference,
      fenceVersion: active.fenceVersion,
    });
  await Promise.all([
    outcome("Claimed", "InvocationUnknown", 100),
    outcome("Claimed", "InvocationUnknown", 100),
  ]);
  assert.equal(await count(), 2);
  await assert.rejects(outcome("Claimed", "ProviderPending", 150), {
    code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  });
  await assert.rejects(
    outcome(
      "InvocationUnknown",
      "ProviderPending",
      150,
      token,
      owner({ validateOutcome: async () => false }),
    ),
    { code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE" },
  );
  let calls = 0;
  await assert.rejects(
    outcome(
      "InvocationUnknown",
      "ProviderPending",
      150,
      token,
      owner({ authorize: async () => ++calls < 3 }),
    ),
    { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
  );
  assert.equal(await count(), 2);
  const request = {
    paymentAttemptReference: caseRecord.paymentAttemptReference,
    operationReference: caseRecord.operationReference,
    jobName: token.jobName,
  };
  await lease.lease.release({
    ...request,
    fenceReference: token.fenceReference,
    fenceVersion: token.fenceVersion,
  });
  const fresh = await lease.lease.claim(request);
  assert.ok(fresh);
  await assert.rejects(outcome("InvocationUnknown", "ProviderPending", 150), {
    code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
  });
  await outcome("InvocationUnknown", "ProviderPending", 150, fresh);
  await assert.rejects(outcome("ProviderPending", "InvocationUnknown", 200, fresh), {
    code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  });
  setLostAck(true);
  await assert.rejects(outcome("ProviderPending", "ProviderConfirmed", 200, fresh), {
    code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
  });
  const confirmed = await store.resolve({ actionReference: receipt.actionReference });
  assert.deepEqual(confirmed, { ...receipt, phase: "ProviderConfirmed" });
  assert.equal(
    (await outcome("ProviderPending", "ProviderConfirmed", 200, fresh)).phase,
    "ProviderConfirmed",
  );
  await assert.rejects(outcome("ProviderConfirmed", "InvocationUnknown", 300, fresh), {
    code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
  });
  assert.equal(await count(), 4);
  assert.equal(await audits(), 1);
  await assert.rejects(
    owner({ authorize: async () => false }).resolve({ actionReference: receipt.actionReference }),
    { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
  );
  assert.equal(
    await owner({ scope: { ...scope, storeReference: id(99) } }).resolve({
      actionReference: receipt.actionReference,
    }),
    null,
  );
  const row = (
    await admin.query(
      "SELECT * FROM rms_payment.payment_compensation_action_history WHERE history_version=2",
    )
  ).rows[0];
  await admin.query("BEGIN");
  await admin.query("SET LOCAL ROLE " + role);
  await admin.query(
    "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
    [scope.brandReference, id(99)],
  );
  assert.equal(
    Number(
      (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_action_history"))
        .rows[0].count,
    ),
    0,
  );
  const columns = [
    "brand_id",
    "store_id",
    "action_id",
    "history_version",
    "case_id",
    "case_version",
    "order_id",
    "payment_attempt_id",
    "fence_id",
    "fence_version",
    "phase",
    "amount_minor",
    "provider_idempotency_key",
    "audit_id",
    "observed_at",
    "recorded_at",
    "record_json",
  ];
  await assert.rejects(
    admin.query(
      "INSERT INTO rms_payment.payment_compensation_action_history (" +
        columns.join(",") +
        ") VALUES (" +
        columns.map((_column, index) => "$" + (index + 1)).join(",") +
        ")",
      columns.map((column) => (column === "history_version" ? 99 : row[column])),
    ),
    { code: "42501" },
  );
  await admin.query("ROLLBACK");
  const before = (
    await admin.query(
      "SELECT record_json FROM rms_payment.payment_compensation_action_history ORDER BY history_version",
    )
  ).rows;
  await admin.query("UPDATE rms_payment.payment_compensation_action_history SET phase='Claimed'");
  await admin.query("DELETE FROM rms_payment.payment_compensation_action_history");
  assert.deepEqual(
    (
      await admin.query(
        "SELECT record_json FROM rms_payment.payment_compensation_action_history ORDER BY history_version",
      )
    ).rows,
    before,
  );
  const position = await readPosition();
  assert.equal(position.confirmedMinor, 0n);
  assert.equal(position.pendingMinor, receipt.amount.amountMinor);
  assert.equal(position.version, 5);
  const positionInput = {
    orderReference: caseRecord.orderReference,
    paymentTransactionReference: caseRecord.paymentTransactionReference,
    paymentAttemptReference: caseRecord.paymentAttemptReference,
  };
  for (const field of ["orderReference", "paymentTransactionReference"]) {
    await assert.rejects(
      transactions.run((tx) =>
        positionReader(tx, {
          ...positionInput,
          [field]: id(99),
        }),
      ),
      { code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE" },
    );
  }
  for (const limit of [0, 1]) {
    let calls = 0;
    const denied = createPostgresPaymentCompensationRefundPositionSource({
      scope,
      authorize: async () => ++calls <= limit,
    });
    await assert.rejects(
      transactions.run((tx) => denied(tx, positionInput)),
      { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
    );
  }
  await admin.query("GRANT INSERT ON rms_payment.payment_compensation_refund TO " + role);
  await admin.query("GRANT USAGE ON SCHEMA platform_eventing TO " + role);
  await admin.query("GRANT INSERT ON platform_eventing.outbox_event TO " + role);
  const refundFact = parsePaymentProviderConfirmedRefundFact({
    refundReference: id(80),
    eventReference: id(81),
    compensationCaseReference: caseRecord.caseReference,
    paymentTransactionReference: caseRecord.paymentTransactionReference,
    paymentIntentReference: caseRecord.paymentIntentReference,
    paymentAttemptReference: caseRecord.paymentAttemptReference,
    orderReference: caseRecord.orderReference,
    ...scope,
    originalPaymentMethod: receipt.originalPaymentMethod,
    amount: receipt.amount,
    source: "ProviderRetrieval",
    providerConfirmedAt: time(200),
    recordedAt: time(200),
    evidenceDigest: "sha256:" + "c".repeat(64),
    causationReference: id(82),
  });
  const refunds = createPostgresPaymentCompensationRefundStore({
    transactions,
    scope,
    lease,
    authorize: async () => true,
    validateEvidence: async () => true,
  });
  await refunds.record({
    fact: refundFact,
    event: createPaymentRefundedEnvelope({ fact: refundFact }),
    audit: {
      ...audit,
      auditId: id(83),
      actionCode: "PAYMENT_COMPENSATION_REFUND_CONFIRMED",
      targetType: "PaymentRefund",
      targetId: refundFact.refundReference,
      occurredAt: refundFact.providerConfirmedAt,
    },
    fenceReference: fresh.fenceReference,
    fenceVersion: fresh.fenceVersion,
  });
  const settled = await readPosition();
  assert.equal(settled.confirmedMinor, receipt.amount.amountMinor);
  assert.equal(settled.pendingMinor, 0n);
  assert.equal(settled.version, 6);
  assert.notEqual(settled.snapshotDigest, position.snapshotDigest);
  assert.deepEqual(await readPosition(), settled);
}
