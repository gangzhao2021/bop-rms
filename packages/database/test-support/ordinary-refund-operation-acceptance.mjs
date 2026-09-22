import { exerciseOrdinaryRefundDispatchIsolation } from "./ordinary-refund-dispatch-acceptance.mjs";
import assert from "node:assert/strict";
import { createPostgresOrdinaryRefundApprovalSubjectSource } from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-request-store.ts";
import {
  createPostgresOrdinaryRefundOperationPreparationSource,
  createPostgresOrdinaryRefundOperationStore,
  createPostgresOrdinaryRefundWorkSource,
} from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-operation-store.ts";

export async function exerciseOrdinaryRefundOperationIsolation({
  admin,
  run,
  role,
  scope,
  request,
  audit,
}) {
  const id = (n) => "01909976-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_payment.ordinary_refund_operation TO " + role,
  );
  const at = new Date().toISOString();
  const current = await run((tx) =>
    createPostgresOrdinaryRefundApprovalSubjectSource({
      scope,
      authorize: async () => true,
    })(tx, {
      orderReference: request.orderReference,
      requestReference: request.requestReference,
      observedAt: at,
    }),
  );
  const leg = request.payments[0];
  const expectedOperation = {
    ...current.subject,
    operationReference: id(1),
    providerOperationReference: id(2),
    paymentTransactionReference: leg.paymentTransactionReference,
    paymentIntentReference: leg.paymentIntentReference,
    paymentAttemptReference: leg.paymentAttemptReference,
    firstCaptureReference: leg.firstCaptureReference,
    providerAccountReference: id(3),
    executorReference: request.actorReference,
    auditReference: id(4),
    approvalReference: null,
    claimVersion: current.claimVersion,
    preparedAt: at,
    environment: "Test",
    currencyCode: "CAD",
    amountMinor: request.amountMinor,
    status: "Prepared",
  };
  const prepareInput = Object.fromEntries(
    [
      "orderReference",
      "requestReference",
      "paymentAttemptReference",
      "operationReference",
      "providerOperationReference",
      "executorReference",
      "auditReference",
      "approvalReference",
    ].map((key) => [key, expectedOperation[key]]),
  );
  const preparation = (extra = {}) =>
    createPostgresOrdinaryRefundOperationPreparationSource({
      scope,
      providerAccountReference: id(3),
      environment: "Test",
      authorize: async () => true,
      ...extra,
    });
  const prepare = (input = prepareInput, target = preparation()) => run((tx) => target(tx, input));
  const operation = await prepare();
  assert.deepEqual(operation, { ...expectedOperation, preparedAt: operation.preparedAt });
  assert.ok(operation.preparedAt >= at);
  await assert.rejects(prepare({ ...prepareInput, amountMinor: 1n }));
  await assert.rejects(prepare({ ...prepareInput, paymentAttemptReference: id(99) }));
  await assert.rejects(prepare(prepareInput, preparation({ authorize: async () => false })));
  const makeAudit = (op) => ({
    ...audit,
    auditId: op.auditReference,
    actor: { type: "User", reference: op.executorReference },
    actionCode: "PAYMENT_ORDINARY_REFUND_PREPARED",
    targetType: "PaymentRefundOperation",
    targetId: op.operationReference,
    correlationId: op.operationReference,
    occurredAt: op.preparedAt,
  });
  // The request source and storage are real. Current executor/escalation/
  // Provider/balance composition is a synthetic port, not dispatch acceptance.
  const store = (extra = {}) =>
    createPostgresOrdinaryRefundOperationStore({
      scope,
      authorize: async () => true,
      validateCurrent: async (_tx, op, observedAt) => {
        assert.equal(op.providerAccountReference, id(3));
        assert.ok(observedAt >= op.preparedAt);
        return true;
      },
      ...extra,
    });
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_operation) AS operations," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_PREPARED') AS audits",
      )
    ).rows[0];
  const commit = (op = operation, target = store()) =>
    run((tx) => target.record(tx, op, makeAudit(op)));
  for (const patch of [
    { amountMinor: request.amountMinor - 1n },
    { firstCaptureReference: id(30) },
    { paymentTransactionReference: id(30) },
    { paymentIntentReference: id(30) },
    { paymentAttemptReference: id(30) },
    { claimVersion: current.claimVersion + 1 },
    { claimsDigest: "sha256:" + "0".repeat(64) },
    { allocationDigest: "sha256:" + "0".repeat(64) },
    { tenantReference: id(30) },
    { preparedAt: "2099-01-01T00:00:00.000Z" },
  ])
    await assert.rejects(commit({ ...operation, ...patch }));
  await assert.rejects(commit(operation, store({ authorize: async () => false })));
  await assert.rejects(commit(operation, store({ validateCurrent: async () => false })));
  let checks = 0;
  await run(async (tx) => {
    await assert.rejects(
      store({ validateCurrent: async () => ++checks === 1 }).record(
        tx,
        operation,
        makeAudit(operation),
      ),
    );
    // Deliberately commit the caller transaction: savepoint must remove both rows.
  });
  assert.equal(checks, 2);
  assert.deepEqual(await counts(), { operations: 0, audits: 0 });
  await run(async (tx) => {
    const fault = {
      query: async (sql, values) => {
        if (sql.includes("INSERT INTO platform_audit.audit_record"))
          throw new Error("synthetic Audit fault");
        return tx.query(sql, values);
      },
    };
    await assert.rejects(
      store().record(fault, operation, makeAudit(operation)),
      /synthetic Audit fault/,
    );
  });
  assert.deepEqual(await counts(), { operations: 0, audits: 0 });
  const pair = await Promise.all([commit(), commit()]);
  assert.deepEqual(pair.map((x) => x.status).sort(), ["AlreadyCommitted", "Created"]);
  assert.deepEqual(await counts(), { operations: 1, audits: 1 });
  assert.deepEqual(await prepare(), operation);
  for (const patch of [
    { operationReference: id(88) },
    { providerOperationReference: id(88) },
    { executorReference: id(88) },
    { auditReference: id(88) },
    { approvalReference: id(88) },
  ])
    await assert.rejects(prepare({ ...prepareInput, ...patch }));
  await assert.rejects(prepare(prepareInput, preparation({ providerAccountReference: id(99) })));
  await assert.rejects(prepare(prepareInput, preparation({ authorize: async () => false })));
  await admin.query("GRANT SELECT ON rms_payment.ordinary_refund_dispatch TO " + role);
  let scanAllowed = true;
  const scanScope = {
    ...scope,
    providerAccountReference: operation.providerAccountReference,
    environment: operation.environment,
  };
  const scan = createPostgresOrdinaryRefundWorkSource({
    scope: scanScope,
    authorize: async () => scanAllowed,
  });
  const page = await run((tx) => scan(tx, { afterOperationReference: null, limit: 1 }));
  assert.deepEqual(page, {
    candidates: [
      {
        operationReference: operation.operationReference,
        orderReference: operation.orderReference,
        requestReference: operation.requestReference,
        workKind: "Dispatch",
      },
    ],
    nextAfterOperationReference: null,
  });
  assert.equal(
    (
      await run((tx) =>
        scan(tx, { afterOperationReference: operation.operationReference, limit: 1 }),
      )
    ).candidates.length,
    0,
  );
  scanAllowed = false;
  await assert.rejects(run((tx) => scan(tx, { afterOperationReference: null, limit: 1 })));
  scanAllowed = true;
  await assert.rejects(run((tx) => scan(tx, { afterOperationReference: null, limit: 101 })));
  for (const key of ["tenantReference", "brandReference", "storeReference"]) {
    const foreign = createPostgresOrdinaryRefundWorkSource({
      scope: { ...scanScope, [key]: id(999) },
      authorize: async () => true,
    });
    assert.equal(
      (await run((tx) => foreign(tx, { afterOperationReference: null, limit: 1 }))).candidates
        .length,
      0,
    );
  }
  for (const patch of [{ providerAccountReference: id(998) }, { environment: "Live" }]) {
    const foreign = createPostgresOrdinaryRefundWorkSource({
      scope: { ...scanScope, ...patch },
      authorize: async () => true,
    });
    assert.equal(
      (await run((tx) => foreign(tx, { afterOperationReference: null, limit: 1 }))).candidates
        .length,
      0,
    );
  }
  await exerciseOrdinaryRefundDispatchIsolation({ admin, run, scope, role, operation });
  assert.equal(
    (await run((tx) => scan(tx, { afterOperationReference: null, limit: 1 }))).candidates[0]
      .workKind,
    "Reconcile",
  );

  // Immutable recovery does not repeat the current first-dispatch gate.
  assert.equal(
    (
      await commit(
        operation,
        store({
          validateCurrent: async () => {
            throw new Error("not dispatch");
          },
        }),
      )
    ).status,
    "AlreadyCommitted",
  );
  await assert.rejects(
    commit({
      ...operation,
      operationReference: id(40),
      providerOperationReference: id(41),
      auditReference: id(42),
    }),
  );
  await assert.rejects(commit({ ...operation, providerOperationReference: id(41) }));
  await assert.rejects(commit(operation, store({ authorize: async () => false })));
  const context = (tx, storeId) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      storeId,
    ]);
  await run(async (tx) => {
    await context(tx, scope.storeReference);
    assert.equal(
      (await tx.query("UPDATE rms_payment.ordinary_refund_operation SET claim_version=2")).rowCount,
      0,
    );
    assert.equal((await tx.query("DELETE FROM rms_payment.ordinary_refund_operation")).rowCount, 0);
  });
  await run(async (tx) => {
    await context(tx, id(99));
    assert.equal(
      (await tx.query("SELECT operation_id FROM rms_payment.ordinary_refund_operation")).rows
        .length,
      0,
    );
  });
  const row = (await admin.query("SELECT * FROM rms_payment.ordinary_refund_operation")).rows[0];
  const insert = (tx, value) =>
    tx.query(
      "INSERT INTO rms_payment.ordinary_refund_operation SELECT * FROM jsonb_populate_record(NULL::rms_payment.ordinary_refund_operation,$1::jsonb)",
      [JSON.stringify(value)],
    );
  await assert.rejects(
    run(async (tx) => {
      await context(tx, id(99));
      await insert(tx, row);
    }),
    (error) => error.code === "42501",
  );
  // Check constraints without relying on the repository parser.
  for (const patch of [
    { amount_minor: "0" },
    { record_json: { ...row.record_json, currencyCode: "USD" } },
  ])
    await assert.rejects(
      run(async (tx) => {
        await context(tx, scope.storeReference);
        await insert(tx, { ...row, ...patch });
      }),
      (error) => error.code === "23514",
    );
  assert.deepEqual(await counts(), { operations: 1, audits: 1 });
}
