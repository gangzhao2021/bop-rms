import { createPaymentOrderExceptionConsumer } from "../../../apps/api/src/payment-order-exception-consumer.ts";
import { createPostgresOrderExceptionSourceStore } from "../../bop/projection/src/index.ts";
import { createPaymentOrderExceptionSource } from "../../../apps/api/src/payment-order-exception-source.ts";
import { createPersistentConsumerWorker } from "../../../apps/worker/src/persistent-consumer-worker.ts";
import { setTimeout as waitForDispatch } from "node:timers/promises";
import { createPaymentCompensationWorkload } from "../../../apps/worker/src/payment-compensation-workload.ts";
import { createPostgresOrderCompensationCandidateReader } from "../../rms/ordering/src/index.ts";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  createPostgresPaymentCompensationRuntime,
  createPaymentProviderSnapshot,
  createPaymentCompensationFailureRecorder,
  createPostgresPaymentCompensationExceptionSource,
  createPostgresPaymentRefundStatusStore,
  createPaymentRefundStatusConsumer,
  parsePaymentRefundedEnvelope,
  parsePaymentOperationsReconciliationReceipt,
} from "../../rms/payment/src/index.ts";
const json = (value) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
export async function exerciseCompensationRuntime({
  admin,
  runner,
  role,
  scope,
  fact,
  disposition,
  services,
}) {
  const discover = createPostgresOrderCompensationCandidateReader({
    scope,
    authorize: async () => true,
  });
  const page = await runner.run((tx) =>
    discover(tx, { afterDispositionReference: null, limit: 1 }),
  );
  assert.deepEqual(page.candidates, [disposition]);
  assert.equal(page.nextAfterDispositionReference, disposition.dispositionReference);
  const end = await runner.run((tx) =>
    discover(tx, { afterDispositionReference: page.nextAfterDispositionReference, limit: 1 }),
  );
  assert.equal(end.candidates.length, 0);
  assert.equal(end.nextAfterDispositionReference, null);
  await assert.rejects(
    runner.run((tx) => discover(tx, { afterDispositionReference: null, limit: 101 })),
  );
  for (const limit of [0, 1]) {
    let calls = 0;
    const denied = createPostgresOrderCompensationCandidateReader({
      scope,
      authorize: async () => ++calls <= limit,
    });
    await assert.rejects(
      runner.run((tx) => denied(tx, { afterDispositionReference: null, limit: 1 })),
    );
  }
  const id = (n) => "0190ed60-0000-7000-8000-" + n.toString(16).padStart(12, "0");
  await admin.query("GRANT SELECT ON rms_payment.ordinary_refund_request TO " + role);
  let sequence = 100,
    refunded = 0n,
    refundCalls = 0,
    failNextRetrieve = false;
  const keys = [];
  const now = () => new Date().toISOString();
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_compensation_lease_history,rms_payment.payment_compensation_case_history,rms_payment.payment_compensation_action_history,rms_payment.payment_compensation_refund,rms_payment.payment_compensation_operations,rms_payment.payment_compensation_operation_history TO " +
      role,
  );
  const snapshot = (request) =>
    createPaymentProviderSnapshot({
      kind: "Snapshot",
      context: request.context,
      providerIntentReference: fact.providerIntentReference,
      providerTransactionReference: "ch_SYNTHETIC_COMPENSATION_RUNTIME",
      paymentMethod: "OnlineCard",
      captureMode: "Automatic",
      status: "Captured",
      requestedAmount: fact.amount,
      authorizedAmount: fact.amount,
      capturedAmount: fact.amount,
      refundedAmount: { amountMinor: refunded, currencyCode: "CAD" },
      observedAt: now(),
      evidenceDigest: hash("synthetic refund observation:" + refunded),
    });
  const systemAudit = (number, input, actionCode, targetType, targetId) => ({
    auditId: id(number),
    brandId: scope.brandReference,
    storeId: scope.storeReference,
    actor: { type: "System" },
    actionCode,
    targetType,
    targetId,
    reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
    correlationId: input.caseReference,
    occurredAt: input.occurredAt,
    sourceChannel: "PAYMENT_COMPENSATION",
    dataClassification: "Restricted",
    retentionPolicyCode: "AUDIT_DEFAULT",
    retentionPolicyVersion: 1,
  });
  const unexpected = async () => {
    throw Error("unexpected synthetic adapter operation");
  };
  const runtimeOptions = {
    tenantReference: scope.brandReference,
    transactions: runner,
    scope,
    runtime: {
      authorization: {
        authorize: async () => true,
        authorizeInterac: async () => false,
        authorizeOperations: async () => true,
      },
      clock: { now },
      interac: { resolveClaim: unexpected, resolve: unexpected, claim: unexpected },
      provider: {
        createIntent: unexpected,
        cancelIntent: unexpected,
        captureIntent: unexpected,
        retrieveIntent: async (request) => {
          if (failNextRetrieve) {
            failNextRetrieve = false;
            throw Error("synthetic post-refund retrieval unavailable");
          }
          return snapshot(request);
        },
        refundPayment: async (request) => {
          assert.equal(request.amount.amountMinor, fact.amount.amountMinor);
          refundCalls++;
          keys.push(request.idempotencyKey);
          refunded = request.amount.amountMinor;
          failNextRetrieve = true;
          throw Error("synthetic refund response lost after effect");
        },
      },
      audit: {
        createCase: async (input) =>
          systemAudit(
            20,
            input,
            "PAYMENT_COMPENSATION_CASE_OPENED",
            "PaymentCompensationCase",
            id(2),
          ),
        createAction: async (input) =>
          systemAudit(
            21,
            input,
            "PAYMENT_COMPENSATION_REFUND_CLAIMED",
            "PaymentCompensationAction",
            id(3),
          ),
        createRefund: async (input) =>
          systemAudit(22, input, "PAYMENT_COMPENSATION_REFUND_CONFIRMED", "PaymentRefund", id(4)),
      },
      references: {
        hash,
        equals: (a, b) => a === b,
        operationFor: () => id(1),
        caseFor: () => id(2),
        actionFor: () => id(3),
        refundFor: () => id(4),
        eventFor: () => id(5),
        causationFor: () => id(6),
        providerIdempotencyKey: (input) => "WP1310:" + hash(json(input)).slice(7),
      },
    },
    source: {
      authorize: async () => true,
      otherRefunds: async () => ({ confirmedMinor: 0n, pendingMinor: 0n, version: 1 }),
    },
    lease: {
      authorize: async () => true,
      leaseDurationMs: 30000,
      newFenceReference: () => id(++sequence),
    },
    cases: {
      authorize: async () => true,
      validateOpen: async () => true,
      validateCurrentSource: async () => true,
    },
    actions: {
      authorize: async () => true,
      validateClaim: async () => true,
      validateOutcome: async () => true,
    },
    repository: { authorize: async () => true, validateSources: async () => true },
    refunds: { authorize: async () => true, validateEvidence: async () => true },
    operations: { authorize: async () => true, validateEvidence: async () => true },
  };
  let runtime = createPostgresPaymentCompensationRuntime(runtimeOptions);
  const recordFailure = createPaymentCompensationFailureRecorder({
    transactions: runner,
    scope,
    now,
    newAuditReference: () => id(++sequence),
    authorize: async () => true,
  });
  const failureWorkload = createPaymentCompensationWorkload({
    discover: (input) => runner.run((tx) => discover(tx, input)),
    execute: async () => {
      throw Error("synthetic private Provider canary");
    },
    recordFailure,
    pageSize: 10,
    pollIntervalMs: 1000,
    drainDeadlineMs: 10000,
  });
  try {
    await failureWorkload.start();
  } finally {
    await failureWorkload.stop();
  }
  const failures = await admin.query(
    "SELECT action_code,reason_code,target_id,correlation_id FROM platform_audit.audit_record WHERE action_code='PAYMENT_COMPENSATION_EXECUTION_FAILED'",
  );
  assert.equal(failures.rows.length, 1);
  assert.equal(failures.rows[0].reason_code, "COMPENSATION_EXECUTION_FAILED");
  assert.equal(failures.rows[0].target_id, disposition.orderReference);
  assert.equal(failures.rows[0].correlation_id, disposition.dispositionReference);
  for (const limit of [0, 1]) {
    let calls = 0;
    const denied = createPaymentCompensationFailureRecorder({
      transactions: runner,
      scope,
      now,
      newAuditReference: () => id(++sequence),
      authorize: async () => ++calls <= limit,
    });
    await assert.rejects(denied(disposition, "COMPENSATION_EXECUTION_FAILED"), {
      code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
    });
  }
  assert.equal(
    (
      await admin.query(
        "SELECT count(*) FROM platform_audit.audit_record WHERE action_code='PAYMENT_COMPENSATION_EXECUTION_FAILED'",
      )
    ).rows[0].count,
    "1",
  );
  await admin.query(
    "GRANT UPDATE (published_at,attempt_count,last_error_code,lease_token,lease_owner,lease_expires_at,available_at,ordering_released_at) ON platform_eventing.outbox_event TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT ON platform_eventing.delivery_attempt,platform_eventing.dead_letter_item TO " +
      role,
  );
  await admin.query(
    "GRANT SELECT,INSERT,UPDATE ON platform_eventing.consumer_retry_schedule TO " + role,
  );
  const decisions = new Map();
  const identities = (key) => {
    if (!decisions.has(key))
      decisions.set(key, {
        attemptId: id(++sequence),
        deadLetterId: id(++sequence),
        idempotencyKey: id(++sequence),
        scheduleId: id(++sequence),
      });
    return decisions.get(key);
  };
  let observedJointPublication = false;
  let refreshOperations;
  let publicationTarget;
  const executeThroughWorker = async () => {
    let result;
    const workload = createPaymentCompensationWorkload({
      discover: (input) => runner.run((tx) => discover(tx, input)),
      execute: async (candidate) => {
        result = await runtime.execute(candidate);
      },
      recordFailure,
      afterExecute: async () => {
        if (refreshOperations) await refreshOperations();
      },
      pageSize: 10,
      pollIntervalMs: 1000,
      drainDeadlineMs: 10000,
    });
    const joint = publicationTarget
      ? createPersistentConsumerWorker({
          connections: runner,
          services,
          eventing: {
            authorizeScope: async (requested) =>
              requested.brandId === scope.brandReference &&
              requested.storeId === scope.storeReference,
            now,
            random: () => 0.5,
            outboxIdentities: (eventId, attempt) => identities("outbox:" + eventId + ":" + attempt),
            consumerIdentities: (input) =>
              identities(input.consumerName + ":" + input.eventId + ":" + input.attemptNumber),
          },
          scopes: [{ brandId: scope.brandReference, storeId: scope.storeReference }],
          leaseOwner: "wp2402_compensation_worker",
          newLeaseToken: () => id(++sequence),
          config: { batchMaximum: 10, perScopeMaximum: 10, adapterConcurrency: 1 },
          pollIntervalMs: 25,
          drainDeadlineMs: 25000,
          additionalWorkloads: [workload],
        })
      : { workload };
    try {
      await joint.workload.start();
      if (publicationTarget && !observedJointPublication) {
        for (let observation = 0; observation < 100; observation++) {
          const published = (
            await admin.query(
              "SELECT published_at FROM platform_eventing.outbox_event WHERE event_id=$1",
              [fact.event.eventId],
            )
          ).rows[0];
          if (published?.published_at) {
            observedJointPublication = true;
            break;
          }
          await waitForDispatch(50);
        }
        assert.equal(
          observedJointPublication,
          true,
          "joint worker must publish actual captured payment",
        );
      }
      if (publicationTarget) {
        let published = false;
        for (let observation = 0; observation < 200; observation++) {
          const row = (
            await admin.query(
              "SELECT published_at FROM platform_eventing.outbox_event WHERE event_id=$1",
              [publicationTarget],
            )
          ).rows[0];
          if (row?.published_at) {
            published = true;
            break;
          }
          await waitForDispatch(50);
        }
        assert.equal(
          published,
          true,
          "refund requires both configured consumers before publication",
        );
        const inbox = (
          await admin.query(
            "SELECT consumer_name FROM platform_eventing.consumer_inbox WHERE event_id=$1 AND status='completed' ORDER BY consumer_name",
            [publicationTarget],
          )
        ).rows;
        assert.deepEqual(
          inbox.map((row) => row.consumer_name),
          ["operations.order-exception:v1", "payment.status-projection:v1"],
        );
      }
    } finally {
      await joint.workload.stop();
    }
    assert.equal(await joint.workload.completion, "stopped");
    assert.ok(result);
    assert.equal(await workload.completion, "stopped");
    return result;
  };
  // Explicit synthetic Provider/authority; all service persistence and source reads are real.
  const first = await executeThroughWorker();
  assert.equal(first.status, "AwaitingProviderConfirmation");
  const savedAction = JSON.parse(
    (
      await admin.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_action_history WHERE action_id=$1 ORDER BY history_version DESC LIMIT 1",
        [id(3)],
      )
    ).rows[0].record,
  );
  assert.equal(savedAction.phase, "InvocationUnknown");
  assert.equal(savedAction.amount.amountMinor, fact.amount.amountMinor.toString());
  assert.equal(savedAction.providerIdempotencyKey, keys[0]);
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_refund")).rows[0]
      .count,
    "0",
  );
  // Reconstruct the runtime: recovery must use durable state, not service instance memory.
  runtime = createPostgresPaymentCompensationRuntime(runtimeOptions);
  assert.equal((await executeThroughWorker()).status, "AwaitingOperationsReconciliation");
  assert.equal(refundCalls, 1);
  await admin.query(
    "GRANT SELECT,INSERT ON rms_payment.payment_refund_status_projection TO " + role,
  );
  const refundStatus = createPaymentRefundStatusConsumer({
    scope,
    authorize: async () => true,
    projections: createPostgresPaymentRefundStatusStore({ scope, authorize: async () => true }),
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  const rawRefund = JSON.parse(
    (
      await admin.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_compensation_refund WHERE refund_id=$1",
        [id(4)],
      )
    ).rows[0].record,
  );
  const refundEvent = parsePaymentRefundedEnvelope({ ...rawRefund.event, aggregateVersion: 1n });
  let inboxFailureReached = false;
  await assert.rejects(
    runner.run((tx) =>
      refundStatus.consume(
        {
          query: (sql, values) => {
            if (sql.startsWith("UPDATE platform_eventing.consumer_inbox")) {
              inboxFailureReached = true;
              throw Error("synthetic refund Inbox failure");
            }
            return tx.query(sql, values);
          },
        },
        refundEvent,
      ),
    ),
  );
  assert.equal(inboxFailureReached, true);
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_refund_status_projection")).rows[0]
      .count,
    "0",
  );
  let writeChecks = 0;
  const revokedStore = createPostgresPaymentRefundStatusStore({
    scope,
    authorize: async (_tx, access) => access.access !== "Write" || ++writeChecks === 1,
  });
  const revokedConsumer = createPaymentRefundStatusConsumer({
    scope,
    authorize: async () => true,
    projections: revokedStore,
    sha256: (value) => createHash("sha256").update(value).digest("hex"),
  });
  await assert.rejects(
    runner.run((tx) => revokedConsumer.consume(tx, refundEvent)),
    { code: "PAYMENT_STATUS_PERMISSION_DENIED" },
  );
  assert.equal(writeChecks, 2);
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_refund_status_projection")).rows[0]
      .count,
    "0",
  );
  const concurrent = await Promise.all(
    [0, 1].map(() => runner.run((tx) => refundStatus.consume(tx, refundEvent))),
  );
  assert.deepEqual(concurrent.map((result) => result.status).sort(), [
    "duplicate_completed",
    "processed",
  ]);

  assert.equal(
    (await runner.run((tx) => refundStatus.consume(tx, refundEvent))).status,
    "duplicate_completed",
  );
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_refund_status_projection")).rows[0]
      .count,
    "1",
  );
  const projectionStore = createPostgresPaymentRefundStatusStore({
    scope,
    authorize: async () => true,
  });
  await assert.rejects(
    runner.run((tx) =>
      projectionStore.write(
        tx,
        parsePaymentRefundedEnvelope({
          ...refundEvent,
          payload: { ...refundEvent.payload, amountMinor: "1" },
        }),
      ),
    ),
    { code: "PAYMENT_STATUS_VERSION_CONFLICT" },
  );
  const foreignStore = createPostgresPaymentRefundStatusStore({
    scope: { brandReference: scope.brandReference, storeReference: id(999) },
    authorize: async () => true,
  });
  assert.equal(await runner.run((tx) => foreignStore.load(tx, id(4))), null);
  const beforeProjection = (
    await admin.query(
      "SELECT record_json::text AS record FROM rms_payment.payment_refund_status_projection",
    )
  ).rows[0].record;
  await admin.query(
    "GRANT UPDATE,DELETE ON rms_payment.payment_refund_status_projection TO " + role,
  );
  await runner.run(async (tx) => {
    await tx.query("SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)", [
      scope.brandReference,
      scope.storeReference,
    ]);
    assert.equal(
      (
        await tx.query(
          "UPDATE rms_payment.payment_refund_status_projection SET record_json='{}'::jsonb",
          [],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await tx.query("DELETE FROM rms_payment.payment_refund_status_projection", [])).rowCount,
      0,
    );
    await tx.query("SELECT set_config('bop.store_id',$1,true)", [id(999)]);
    assert.equal(
      (await tx.query("SELECT refund_id FROM rms_payment.payment_refund_status_projection", []))
        .rows.length,
      0,
    );
  });
  assert.equal(
    (
      await admin.query(
        "SELECT record_json::text AS record FROM rms_payment.payment_refund_status_projection",
      )
    ).rows[0].record,
    beforeProjection,
  );
  services.push(refundStatus);
  const loadCase = async () =>
    JSON.parse(
      (
        await admin.query(
          "SELECT record_json::text AS record FROM rms_payment.payment_compensation_case_history WHERE case_id=$1 ORDER BY version DESC LIMIT 1",
          [id(2)],
        )
      ).rows[0].record,
    );
  const exceptionSource = createPostgresPaymentCompensationExceptionSource({
    scope,
    authorize: async () => true,
  });
  const operationsSource = createPaymentOrderExceptionSource({
    tenantReference: id(998),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    load: exceptionSource,
    authorize: async () => true,
  });
  const openOperations = await runner.run((tx) => operationsSource(tx, refundEvent));
  assert.equal(openOperations.sourceStatus, "Open");
  assert.equal(openOperations.providerState, "Confirmed");
  assert.equal(openOperations.compensationStatus, "Pending");
  assert.equal(openOperations.resolutionEvidenceReference, null);
  await admin.query("GRANT USAGE ON SCHEMA platform_projection TO " + role);
  await admin.query("GRANT SELECT,INSERT ON platform_projection.order_exception_source TO " + role);
  const exceptionProjection = createPostgresOrderExceptionSourceStore({
    scope: {
      tenantReference: id(998),
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    authorize: async () => true,
    validateSource: async (tx, source) => {
      const actual = await operationsSource(tx, refundEvent);
      return (
        actual.sourceVersion === source.sourceVersion && actual.sourceDigest === source.sourceDigest
      );
    },
  });
  const operationsConsumer = createPaymentOrderExceptionConsumer({
    source: operationsSource,
    projections: exceptionProjection,
  });
  let operationsInboxFailure = false;
  await assert.rejects(
    runner.run((tx) =>
      operationsConsumer.consume(
        {
          query: (sql, values) => {
            if (sql.startsWith("UPDATE platform_eventing.consumer_inbox")) {
              operationsInboxFailure = true;
              throw Error("synthetic Operations Inbox failure");
            }
            return tx.query(sql, values);
          },
        },
        refundEvent,
      ),
    ),
  );
  assert.equal(operationsInboxFailure, true);
  assert.equal(
    (await admin.query("SELECT count(*) FROM platform_projection.order_exception_source")).rows[0]
      .count,
    "0",
  );
  assert.equal(
    (await runner.run((tx) => operationsConsumer.consume(tx, refundEvent))).status,
    "processed",
  );
  assert.deepEqual(await runner.run((tx) => exceptionProjection.load(tx, id(2))), openOperations);
  services.push(operationsConsumer);
  refreshOperations = () => runner.run((tx) => operationsConsumer.refresh(tx, refundEvent));
  publicationTarget = refundEvent.eventId;
  const openException = await runner.run((tx) => exceptionSource(tx, id(2)));
  assert.equal(openException.source.state, "Open");
  assert.equal(openException.source.refundDisposition, "ProviderConfirmed");
  assert.equal(openException.source.operationsDisposition, "Pending");
  assert.equal(openException.resolutionEvidenceReference, null);
  assert.deepEqual(Object.keys(openException).sort(), [
    "resolutionEvidenceReference",
    "source",
    "sourceVersion",
  ]);
  for (const limit of [0, 1]) {
    let calls = 0;
    const denied = createPostgresPaymentCompensationExceptionSource({
      scope,
      authorize: async () => ++calls <= limit,
    });
    await assert.rejects(
      runner.run((tx) => denied(tx, id(2))),
      { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
    );
  }
  const current = await loadCase();
  assert.equal(current.refundDisposition, "ProviderConfirmed");
  const at = now();
  const receipt = parsePaymentOperationsReconciliationReceipt({
    receiptReference: id(30),
    compensationCaseReference: id(2),
    refundReference: id(4),
    brandReference: scope.brandReference,
    storeReference: scope.storeReference,
    actorReference: id(31),
    purpose: "ReconcilePaidWithoutFulfillableOrder",
    refundEvidenceDigest: current.refundEvidenceDigest,
    reconciledAt: at,
    audit: {
      auditId: id(32),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "User", reference: id(31) },
      actionCode: "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED",
      targetType: "PaymentCompensationCase",
      targetId: id(2),
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
      correlationId: id(30),
      occurredAt: at,
      sourceChannel: "OPERATIONS",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    },
  });
  await runtime.recordOperations({ receipt, expectedCaseVersion: current.version });
  assert.equal((await executeThroughWorker()).status, "Closed");
  assert.equal((await executeThroughWorker()).status, "Closed");
  assert.equal(refundCalls, 1);
  assert.equal(new Set(keys).size, 1);
  assert.equal((await loadCase()).state, "Closed");
  const closedException = await runner.run((tx) => exceptionSource(tx, id(2)));
  assert.equal(closedException.source.state, "Closed");
  const closedOperations = await runner.run((tx) => operationsSource(tx, refundEvent));
  assert.equal(
    (await runner.run((tx) => exceptionProjection.load(tx, id(2)))).sourceStatus,
    "Final",
  );
  assert.equal(closedOperations.sourceStatus, "Final");
  assert.equal(closedOperations.compensationStatus, "Completed");
  assert.equal(closedOperations.resolutionEvidenceReference, id(30));
  assert.ok(closedOperations.sourceVersion > openOperations.sourceVersion);
  assert.notEqual(closedOperations.sourceDigest, openOperations.sourceDigest);
  assert.deepEqual(await runner.run((tx) => operationsSource(tx, refundEvent)), closedOperations);
  assert.equal(
    (await runner.run((tx) => operationsConsumer.consume(tx, refundEvent))).status,
    "duplicate_completed",
  );
  assert.deepEqual(await runner.run((tx) => exceptionProjection.load(tx, id(2))), closedOperations);
  assert.deepEqual(
    await runner.run((tx) => exceptionProjection.write(tx, closedOperations, refundEvent.eventId)),
    closedOperations,
  );
  assert.equal(
    (await admin.query("SELECT count(*) FROM platform_projection.order_exception_source")).rows[0]
      .count,
    "2",
  );
  const exceptionPage = await runner.run((tx) =>
    exceptionProjection.list(tx, { afterSourceReference: null, limit: 1 }),
  );
  assert.deepEqual(exceptionPage.items, [closedOperations]);
  assert.equal(exceptionPage.nextAfterSourceReference, null);
  assert.deepEqual(
    (
      await runner.run((tx) =>
        exceptionProjection.list(tx, { afterSourceReference: id(2), limit: 1 }),
      )
    ).items,
    [],
  );
  await assert.rejects(
    runner.run((tx) => exceptionProjection.list(tx, { afterSourceReference: null, limit: 101 })),
  );
  for (const changed of ["tenantReference", "storeReference"]) {
    const otherScope = {
      tenantReference: id(998),
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
      [changed]: id(997),
    };
    const other = createPostgresOrderExceptionSourceStore({
      scope: otherScope,
      authorize: async () => true,
      validateSource: async () => false,
    });
    assert.deepEqual(
      (await runner.run((tx) => other.list(tx, { afterSourceReference: null, limit: 10 }))).items,
      [],
    );
  }
  let listAuthorizations = 0;
  const deniedList = createPostgresOrderExceptionSourceStore({
    scope: {
      tenantReference: id(998),
      brandReference: scope.brandReference,
      storeReference: scope.storeReference,
    },
    authorize: async () => ++listAuthorizations === 1,
    validateSource: async () => false,
  });
  await assert.rejects(
    runner.run((tx) => deniedList.list(tx, { afterSourceReference: null, limit: 10 })),
  );
  assert.equal(listAuthorizations, 2);
  assert.equal(closedException.source.operationsDisposition, "Reconciled");
  assert.equal(closedException.resolutionEvidenceReference, id(30));
  assert.ok(closedException.sourceVersion > openException.sourceVersion);
  assert.equal(JSON.stringify(closedException).includes("evidenceDigest"), false);
  assert.equal(JSON.stringify(closedException).includes("amountMinor"), false);
  assert.equal(
    (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_refund")).rows[0]
      .count,
    "1",
  );
  assert.equal(
    (
      await admin.query(
        "SELECT count(*) FROM platform_eventing.outbox_event WHERE event_type='PaymentRefunded'",
      )
    ).rows[0].count,
    "1",
  );
}
