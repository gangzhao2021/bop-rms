import assert from "node:assert/strict";
import { orderQueryFixture } from "../../rms/ordering/src/tests/order-creation-query.fixture.ts";
import { seedAcceptanceOrderHistory } from "./acceptance-order-history.mjs";
import {
  createPostgresOrderInitialExecutionReader,
  createPostgresOrderTerminationStore,
  createPostgresOrderAcceptanceStore,
} from "../../rms/ordering/src/index.ts";

export async function exerciseOrderTermination({ admin, role, run, id, hash, setFailAudit }) {
  const original = orderQueryFixture().record;
  const scope = { brandReference: id(2), storeReference: id(3) };
  const remap = (value) => {
    if (value === original.order.brandReference) return scope.brandReference;
    if (value === original.order.storeReference) return scope.storeReference;
    if (Array.isArray(value)) return value.map(remap);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, remap(v)]));
    return value;
  };
  const seeded = remap(original);
  await seedAcceptanceOrderHistory(admin, seeded);
  await admin.query(
    "GRANT SELECT,UPDATE ON rms_ordering.order_header,rms_ordering.order_batch TO " + role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE,DELETE ON rms_ordering.order_termination_record TO " + role,
  );
  await admin.query("GRANT SELECT ON rms_ordering.order_fulfillment_completion_record TO " + role);
  let seq = 19000;
  let authorized = true,
    eligible = true,
    readable = true,
    eligibilityCalls = 0;
  const at = seeded.createdAt;
  const lookup = {
    orderReference: seeded.order.orderReference,
    orderBatchReference: seeded.order.batches[0].orderBatchReference,
  };
  const audit = (actionCode, phase, record, occurredAt) => ({
    auditId: id(++seq),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "User", reference: id(5) },
    actionCode,
    targetType: "Order",
    targetId: record.orderReference,
    correlationId: record.operationReference,
    reasonCode: record.reasonCode,
    occurredAt,
    sourceChannel: "MERCHANT_WEB",
    afterSummary: { phase },
    dataClassification: "Restricted",
    retentionPolicyCode: "FINANCIAL_COMPLIANCE",
    retentionPolicyVersion: 1,
  });
  const reader = createPostgresOrderInitialExecutionReader({
    ...scope,
    authorize: async (tx) => {
      const result = await tx.query("SELECT current_setting('bop.store_id') AS store", []);
      assert.equal(result.rows[0].store, scope.storeReference);
      return readable;
    },
  });
  const read = () => run((transaction) => reader.loadByBatch({ transaction, ...lookup }));
  const initial = await read();
  assert.equal(initial.phase, "Submitted");
  assert.equal(initial.version, 1);
  assert.equal(initial.checkpoint, seeded.submissionReference);
  readable = false;
  await assert.rejects(read(), { code: "ORDER_TERMINATION_UNAVAILABLE" });
  readable = true;
  await run(async (transaction) => {
    await reader.loadByBatch({ transaction, ...lookup });
    const lock = await admin.query(
      "SELECT pg_try_advisory_xact_lock(hashtextextended($1,0)) AS acquired",
      [
        "OrderingOrderDisposition:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          lookup.orderReference,
      ],
    );
    assert.equal(lock.rows[0].acquired, false);
  });
  const base = {
    terminationReference: id(19100),
    operationReference: id(19101),
    ...scope,
    ...lookup,
    expectedOrderVersion: 1,
    terminatedOrderVersion: 2,
    expectedSourceCheckpoint: initial.checkpoint,
    previousPhase: "Submitted",
    phase: "Cancelled",
    actorType: "User",
    actorReference: id(5),
    purposeCode: "OrderTermination",
    permissionCode: "order.cancel",
    reasonCode: "SYNTHETIC_TEST",
    workflowVersionReference: id(19102),
    transitionReference: id(19103),
    sourceDigest: hash("synthetic-current-initial-execution"),
    terminatedAt: at,
  };
  const writer = createPostgresOrderTerminationStore({
    ...scope,
    authorize: async () => authorized, // Explicit synthetic merchant capability.
    validateCurrentSource: async () => {
      eligibilityCalls++;
      return eligible;
    },
    audit: async (record) => audit("ORDER_TERMINATED", record.phase, record, record.terminatedAt),
  });
  const terminate = (record = base) =>
    run((transaction) => {
      const locks = [];
      return writer.commit({
        transaction: {
          query: async (sql, values) => {
            if (sql.startsWith("SELECT pg_advisory_xact_lock")) {
              locks.push(values[0]);
              if (values[0].startsWith("OrderingTerminationOperation:"))
                assert.ok(locks[0].startsWith("OrderingOrderDisposition:"));
            }
            return transaction.query(sql, values);
          },
        },
        record,
      });
    });
  authorized = false;
  await assert.rejects(terminate(), { code: "ORDER_TERMINATION_UNAVAILABLE" });
  assert.equal(eligibilityCalls, 0);
  authorized = true;
  await assert.rejects(terminate({ ...base, expectedSourceCheckpoint: id(19999) }), {
    code: "ORDER_TERMINATION_CONFLICT",
  });
  assert.equal(eligibilityCalls, 0);
  eligible = false;
  await assert.rejects(terminate(), { code: "ORDER_TERMINATION_UNAVAILABLE" });
  eligible = true;
  setFailAudit(true);
  await assert.rejects(terminate());
  setFailAudit(false);
  assert.equal((await read()).phase, "Submitted");
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM rms_ordering.order_termination_record WHERE order_id=$1",
        [lookup.orderReference],
      )
    ).rows[0].n,
    0,
  );

  // Catch the failure inside the outer transaction and commit it: all owner
  // effects must still roll back even after the revision INSERT completed.
  await run(async (transaction) => {
    await assert.rejects(
      writer.commit({
        transaction: {
          query: async (sql, values) => {
            const result = await transaction.query(sql, values);
            if (sql.startsWith("INSERT INTO rms_ordering.order_revision"))
              throw new Error("synthetic post-revision failure");
            return result;
          },
        },
        record: base,
      }),
      { code: "ORDER_TERMINATION_CONFLICT" },
    );
  });
  const rolledBack = await admin.query(
    "SELECT (SELECT count(*)::int FROM rms_ordering.order_revision WHERE order_id=$1) AS revisions, " +
      "(SELECT count(*)::int FROM rms_ordering.order_termination_record WHERE order_id=$1) AS terminations, " +
      "(SELECT count(*)::int FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='ORDER_TERMINATED') AS audits",
    [lookup.orderReference],
  );
  assert.deepEqual(rolledBack.rows[0], { revisions: 1, terminations: 0, audits: 0 });

  const acceptance = {
    acceptanceReference: id(19200),
    operationReference: id(19201),
    ...scope,
    ...lookup,
    expectedOrderVersion: 1,
    acceptedOrderVersion: 2,
    actorType: "User",
    actorReference: id(5),
    purposeCode: "OrderAcceptance",
    permissionCode: "order.accept",
    reasonCode: "SYNTHETIC_TEST",
    workflowVersionReference: id(19102),
    transitionReference: id(19202),
    sourceDigest: hash("synthetic-acceptance"),
    acceptedAt: at,
  };
  const acceptWriter = createPostgresOrderAcceptanceStore({
    ...scope,
    authorize: async () => true,
    validateCurrentSource: async () => true,
    audit: async (record) => audit("ORDER_ACCEPTED", "Accepted", record, record.acceptedAt),
  });
  const accept = () =>
    run((transaction) => acceptWriter.commit({ transaction, record: acceptance }));
  const competing = await Promise.allSettled([accept(), terminate()]);
  assert.equal(competing.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(competing.filter((r) => r.status === "rejected").length, 1);
  let committedInput = base;
  const raced = await read();
  if (raced.phase === "Accepted") {
    assert.equal(raced.checkpoint, acceptance.acceptanceReference);
    await assert.rejects(terminate(), { code: "ORDER_TERMINATION_CONFLICT" });
    committedInput = {
      ...base,
      expectedOrderVersion: 2,
      terminatedOrderVersion: 3,
      expectedSourceCheckpoint: raced.checkpoint,
      previousPhase: "Accepted",
    };
    await terminate(committedInput);
  } else {
    assert.equal(raced.phase, "Cancelled");
    await assert.rejects(accept(), { code: "ORDER_ACCEPTANCE_RECORD_CONFLICT" });
  }
  const final = await read();
  assert.equal(final.phase, "Cancelled");
  assert.equal(final.checkpoint, base.terminationReference);
  const beforeReplay = eligibilityCalls;
  const repeats = await Promise.all([
    terminate(committedInput),
    terminate({
      ...committedInput,
      terminationReference: id(19300),
      terminatedAt: new Date(Date.parse(at) + 1).toISOString(),
    }),
  ]);
  assert.ok(repeats.every((r) => r.status === "AlreadyCommitted"));
  assert.deepEqual(repeats[0].record, repeats[1].record);
  assert.equal(eligibilityCalls, beforeReplay);
  const revisions = await admin.query(
    "SELECT revision_id,kind,version,expected_version,previous_revision_id FROM rms_ordering.order_revision WHERE order_id=$1 ORDER BY version",
    [lookup.orderReference],
  );
  assert.equal(revisions.rows.length, committedInput.terminatedOrderVersion);
  assert.deepEqual(revisions.rows.at(-1), {
    revision_id: base.terminationReference,
    kind: "Termination",
    version: committedInput.terminatedOrderVersion,
    expected_version: committedInput.expectedOrderVersion,
    previous_revision_id: committedInput.expectedSourceCheckpoint,
  });

  await assert.rejects(terminate({ ...committedInput, reasonCode: "DIFFERENT" }), {
    code: "ORDER_TERMINATION_CONFLICT",
  });
  authorized = false;
  await assert.rejects(terminate(committedInput), { code: "ORDER_TERMINATION_UNAVAILABLE" });
  authorized = true;
  await assert.rejects(terminate({ ...committedInput, operationReference: id(19400) }), {
    code: "ORDER_TERMINATION_CONFLICT",
  });
  await run(async (tx) => {
    await reader.loadByBatch({ transaction: tx, ...lookup });
    assert.equal(
      (await tx.query("UPDATE rms_ordering.order_termination_record SET phase='Rejected'", []))
        .rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_ordering.order_termination_record", [])).rowCount,
      0,
    );
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(19900)]);
    assert.equal(
      (await tx.query("SELECT termination_id FROM rms_ordering.order_termination_record", [])).rows
        .length,
      0,
    );
  });
  assert.equal(
    (
      await admin.query(
        "SELECT count(*)::int AS n FROM platform_audit.audit_record WHERE target_id=$1 AND action_code='ORDER_TERMINATED'",
        [lookup.orderReference],
      )
    ).rows[0].n,
    1,
  );
  const header = (
    await admin.query(
      "SELECT canonical_phase,aggregate_version,closure_status FROM rms_ordering.order_header WHERE order_id=$1",
      [lookup.orderReference],
    )
  ).rows[0];
  assert.deepEqual(header, {
    canonical_phase: "Submitted",
    aggregate_version: 1,
    closure_status: "Open",
  });
}
