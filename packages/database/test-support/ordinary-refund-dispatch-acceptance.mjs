import { createHash } from "node:crypto";
import {
  createOrdinaryRefundObservation,
  encodeOrdinaryRefundObservation,
  decodeOrdinaryRefundObservation,
} from "../../rms/payment/src/application/ordinary-refund-observation.ts";
import { createOrdinaryRefundProviderRequest } from "../../rms/payment/src/application/ordinary-refund-provider-request.ts";
import assert from "node:assert/strict";
import {
  createPostgresOrdinaryRefundDispatchStore,
  createPostgresOrdinaryRefundDispatchReader,
} from "../../rms/payment/src/infrastructure/persistence/ordinary-refund-operation-store.ts";

export async function exerciseOrdinaryRefundDispatchIsolation({
  admin,
  run,
  scope,
  role,
  operation,
}) {
  const id = (n) => "01909970-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_payment.ordinary_refund_dispatch TO " + role,
  );
  const input = {
    orderReference: operation.orderReference,
    requestReference: operation.requestReference,
    operationReference: operation.operationReference,
    dispatchReference: id(1),
    auditReference: id(2),
    approvalReference: null,
  };
  const policy = {
    reasonCode: "CUSTOMER_REQUEST",
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  };
  const facts = async (_tx, query) => {
    assert.deepEqual(query.operation, operation);
    assert.ok(query.observedAt >= operation.preparedAt);
    const providerBinding = Object.fromEntries(
      [
        "tenantReference",
        "brandReference",
        "storeReference",
        "orderReference",
        "paymentTransactionReference",
        "paymentIntentReference",
        "paymentAttemptReference",
        "firstCaptureReference",
        "providerAccountReference",
        "environment",
      ].map((key) => [key, operation[key]]),
    );
    return {
      providerBinding: {
        ...providerBinding,
        originalPaymentMethod: "OnlineCard",
        providerIntentReference: "pi_synthetic_dispatch",
      },
      claimVersion: operation.claimVersion,
      claimsDigest: operation.claimsDigest,
    };
  };
  // Actual operation/journal/Audit persistence; dispatch gate is a synthetic port.
  const store = (extra = {}) =>
    createPostgresOrdinaryRefundDispatchStore({
      scope,
      authorize: async () => true,
      prepareCurrent: facts,
      ...extra,
    });
  const commit = (value = input, target = store()) => run((tx) => target.record(tx, value, policy));
  const counts = async () =>
    (
      await admin.query(
        "SELECT (SELECT count(*)::int FROM rms_payment.ordinary_refund_dispatch) AS dispatches," +
          "(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_ORDINARY_REFUND_DISPATCH_STARTED') AS audits",
      )
    ).rows[0];
  await assert.rejects(commit({ ...input, operationReference: id(80) }));
  await assert.rejects(commit(input, store({ authorize: async () => false })));
  let calls = 0;
  await run(async (tx) => {
    await assert.rejects(
      store({
        prepareCurrent: async (...args) => {
          if (++calls === 2) throw new Error("synthetic gate revoked");
          return facts(...args);
        },
      }).record(tx, input, policy),
    );
  });
  assert.equal(calls, 2);
  assert.deepEqual(await counts(), { dispatches: 0, audits: 0 });
  await run(async (tx) => {
    await assert.rejects(
      store().record(
        {
          query: async (sql, values) => {
            if (sql.includes("INSERT INTO platform_audit.audit_record"))
              throw new Error("synthetic Audit failure");
            return tx.query(sql, values);
          },
        },
        input,
        policy,
      ),
      /synthetic Audit failure/,
    );
  });
  assert.deepEqual(await counts(), { dispatches: 0, audits: 0 });
  const pair = await Promise.all([commit(), commit()]);
  assert.deepEqual(pair.map((x) => x.status).sort(), ["AlreadyCommitted", "Created"]);
  assert.deepEqual(pair[0].dispatch, pair[1].dispatch);
  assert.equal(pair[0].dispatch.status, "DispatchStarted");
  assert.deepEqual(await counts(), { dispatches: 1, audits: 1 });

  const recoveryQuery = {
    orderReference: operation.orderReference,
    operationReference: operation.operationReference,
  };
  const reader = (extra = {}) =>
    createPostgresOrdinaryRefundDispatchReader({
      scope,
      authorize: async (_tx, query) => {
        assert.deepEqual(query, { ...scope, ...recoveryQuery });
        return true;
      },
      ...extra,
    });
  const recovered = await run((tx) => reader()(tx, recoveryQuery));
  assert.deepEqual(recovered, { dispatch: pair[0].dispatch, operation });
  assert.ok(Object.isFrozen(recovered));
  for (const patch of [{ operationReference: id(80) }, { orderReference: id(81) }])
    assert.equal(
      await run((tx) =>
        reader({ authorize: async () => true })(tx, { ...recoveryQuery, ...patch }),
      ),
      null,
    );
  assert.equal(
    await run((tx) =>
      reader({ scope: { ...scope, storeReference: id(99) }, authorize: async () => true })(
        tx,
        recoveryQuery,
      ),
    ),
    null,
  );
  await assert.rejects(
    run((tx) =>
      reader({ scope: { ...scope, tenantReference: id(98) }, authorize: async () => true })(
        tx,
        recoveryQuery,
      ),
    ),
  );
  await assert.rejects(run((tx) => reader({ authorize: async () => false })(tx, recoveryQuery)));
  for (const query of [recoveryQuery, { ...recoveryQuery, operationReference: id(80) }]) {
    let reads = 0;
    await assert.rejects(run((tx) => reader({ authorize: async () => ++reads === 1 })(tx, query)));
    assert.equal(reads, 2);
  }
  // Corrupt a returned row only, preserving append-only database evidence.
  for (const patch of [
    { operationDigest: "sha256:" + "0".repeat(64) },
    { providerOperationReference: id(85) },
    { allocationDigest: "sha256:" + "1".repeat(64) },
    { claimsDigest: "sha256:" + "2".repeat(64) },
    { startedAt: "2000-01-01T00:00:00.000Z" },
  ]) {
    await assert.rejects(
      run((tx) =>
        reader()(
          {
            query: async (sql, values) => {
              const result = await tx.query(sql, values);
              if (!sql.includes("AS dispatch")) return result;
              return {
                ...result,
                rows: result.rows.map((row) => ({
                  ...row,
                  dispatch: JSON.stringify({ ...JSON.parse(row.dispatch), ...patch }),
                })),
              };
            },
          },
          recoveryQuery,
        ),
      ),
    );
  }
  const replay = await commit(
    input,
    store({
      prepareCurrent: async () => {
        throw new Error("not a new send");
      },
    }),
  );
  assert.deepEqual(replay.dispatch, pair[0].dispatch);
  for (const patch of [
    { dispatchReference: id(3) },
    { auditReference: id(4) },
    { approvalReference: id(5) },
  ])
    await assert.rejects(commit({ ...input, ...patch }));
  await assert.rejects(commit(input, store({ authorize: async () => false })));
  const context = (tx, storeId) =>
    tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      storeId,
    ]);
  await run(async (tx) => {
    await context(tx, scope.storeReference);
    assert.equal(
      (await tx.query("UPDATE rms_payment.ordinary_refund_dispatch SET claim_version=2")).rowCount,
      0,
    );
    assert.equal((await tx.query("DELETE FROM rms_payment.ordinary_refund_dispatch")).rowCount, 0);
  });
  await run(async (tx) => {
    await context(tx, id(99));
    assert.equal(
      (await tx.query("SELECT dispatch_id FROM rms_payment.ordinary_refund_dispatch")).rows.length,
      0,
    );
  });
  const row = (await admin.query("SELECT * FROM rms_payment.ordinary_refund_dispatch")).rows[0];
  const insert = (tx, value) =>
    tx.query(
      "INSERT INTO rms_payment.ordinary_refund_dispatch SELECT * FROM jsonb_populate_record(NULL::rms_payment.ordinary_refund_dispatch,$1::jsonb)",
      [JSON.stringify(value)],
    );
  await assert.rejects(
    run(async (tx) => {
      await context(tx, id(99));
      await insert(tx, row);
    }),
    (error) => error.code === "42501",
  );
  await assert.rejects(
    run(async (tx) => {
      await context(tx, scope.storeReference);
      await insert(tx, { ...row, operation_digest: "bad" });
    }),
    (error) => error.code === "23514",
  );
  assert.deepEqual(await counts(), { dispatches: 1, audits: 1 });
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_payment.ordinary_refund_observation TO " + role,
  );
  const providerRequest = createOrdinaryRefundProviderRequest(
    operation,
    (
      await facts(null, {
        operation,
        observedAt: pair[0].dispatch.startedAt,
      })
    ).providerBinding,
  );
  const observation = createOrdinaryRefundObservation({
    dispatch: pair[0].dispatch,
    request: providerRequest,
    observationReference: id(201),
    auditReference: id(202),
    recordedAt: new Date().toISOString(),
    outcome: {
      kind: "Failure",
      context: providerRequest.context,
      code: "Unknown",
      retryDisposition: "Unknown",
      safeReasonCode: "PROVIDER_OUTCOME_UNKNOWN",
    },
  });
  const observationRow = {
    tenant_id: observation.tenantReference,
    brand_id: observation.brandReference,
    store_id: observation.storeReference,
    order_id: observation.orderReference,
    request_id: observation.requestReference,
    operation_id: observation.operationReference,
    provider_operation_id: observation.providerOperationReference,
    payment_attempt_id: observation.paymentAttemptReference,
    dispatch_id: observation.dispatchReference,
    observation_id: observation.observationReference,
    audit_id: observation.auditReference,
    provider_request_digest: observation.providerRequestDigest,
    provider_environment: observation.outcome.context.environment,
    outcome_kind: observation.outcome.kind,
    recorded_at: observation.recordedAt,
    record_json: JSON.parse(encodeOrdinaryRefundObservation(observation)),
  };
  const appendObservation = (tx, value) =>
    tx.query(
      "INSERT INTO rms_payment.ordinary_refund_observation SELECT * FROM jsonb_populate_record(NULL::rms_payment.ordinary_refund_observation,$1::jsonb)",
      [JSON.stringify(value)],
    );
  await run(async (tx) => {
    await context(tx, scope.storeReference);
    await appendObservation(tx, observationRow);
    const read = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_observation",
    );
    assert.deepEqual(decodeOrdinaryRefundObservation(read.rows[0].record), observation);
    assert.equal(
      (await tx.query("UPDATE rms_payment.ordinary_refund_observation SET outcome_kind='Snapshot'"))
        .rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_payment.ordinary_refund_observation")).rowCount,
      0,
    );
  });
  await run(async (tx) => {
    await context(tx, id(99));
    assert.equal(
      (await tx.query("SELECT observation_id FROM rms_payment.ordinary_refund_observation")).rows
        .length,
      0,
    );
  });
  await assert.rejects(
    run(async (tx) => {
      await context(tx, id(99));
      await appendObservation(tx, observationRow);
    }),
    (error) => error.code === "42501",
  );
  for (const patch of [
    { provider_request_digest: "bad" },
    { outcome_kind: "Confirmed" },
    { record_json: { ...observationRow.record_json, state: "Confirmed" } },
    { record_json: { ...observationRow.record_json, outcome: null } },
    {
      record_json: {
        ...observationRow.record_json,
        outcome: {
          ...observationRow.record_json.outcome,
          context: { ...observationRow.record_json.outcome.context, operationReference: id(250) },
        },
      },
    },
  ])
    await assert.rejects(
      run(async (tx) => {
        await context(tx, scope.storeReference);
        await appendObservation(tx, { ...observationRow, ...patch });
      }),
      (error) => error.code === "23514",
    );
  const individualFacts = {
    kind: "RefundObservation",
    context: providerRequest.context,
    providerRefundReference: "re_syntheticObserved",
    providerIntentReference: providerRequest.providerIntentReference,
    amount: providerRequest.amount,
    status: "succeeded",
    createdAt: new Date(
      Math.floor(Date.parse(pair[0].dispatch.startedAt) / 1000) * 1000,
    ).toISOString(),
    observedAt: new Date().toISOString(),
    providerRequestDigest: pair[0].dispatch.providerRequestDigest,
  };
  const individual = createOrdinaryRefundObservation({
    dispatch: pair[0].dispatch,
    request: providerRequest,
    observationReference: id(203),
    auditReference: id(204),
    recordedAt: new Date().toISOString(),
    outcome: {
      ...individualFacts,
      evidenceDigest:
        "sha256:" +
        createHash("sha256")
          .update(
            JSON.stringify(individualFacts, (_key, value) =>
              typeof value === "bigint" ? value.toString() : value,
            ),
          )
          .digest("hex"),
    },
  });
  await run(async (tx) => {
    await context(tx, scope.storeReference);
    await appendObservation(tx, {
      ...observationRow,
      observation_id: individual.observationReference,
      audit_id: individual.auditReference,
      recorded_at: individual.recordedAt,
      outcome_kind: "RefundObservation",
      record_json: JSON.parse(encodeOrdinaryRefundObservation(individual)),
    });
    const rows = await tx.query(
      "SELECT record_json::text AS record FROM rms_payment.ordinary_refund_observation WHERE observation_id=$1",
      [individual.observationReference],
    );
    assert.deepEqual(decodeOrdinaryRefundObservation(rows.rows[0].record), individual);
  });
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS count FROM rms_payment.ordinary_refund_observation",
      )
    ).rows[0].count,
    2,
  );
}
