import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPaymentCompensationLeaseStore,
  createPostgresPaymentCompensationCaseStore,
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationCase,
  parsePaymentProviderConfirmedRefundFact,
  parsePaymentOperationsReconciliationReceipt,
} from "../../rms/payment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "0190ed09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const scope = { brandReference: id(1), storeReference: id(2) };
it("persists compensation cases and original Audit with leased append-only reconciliation", async () => {
  await withIsolatedDatabase({ caseId: "compensation_case" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_case_" + env.runId;
    assert.match(role, /^wp2402_case_[a-f0-9]+$/u);
    let sequence = 100,
      active = 0,
      loseAck = false,
      failAudit = false;
    const at = new Date(Date.now() - 1500).toISOString();
    const time = (offset) => new Date(Date.parse(at) + offset).toISOString();
    const original = parsePaymentCompensationCase({
      caseReference: id(21),
      operationReference: id(20),
      dispositionReference: id(3),
      ...scope,
      orderReference: id(4),
      paymentTransactionReference: id(7),
      paymentIntentReference: id(8),
      paymentAttemptReference: id(9),
      environment: "Test",
      originalPaymentMethod: "OnlineCard",
      reason: "PaidWithoutFulfillableOrder",
      dispositionDigest: hash("synthetic-disposition"),
      terminalEvidenceDigest: hash("synthetic-terminal"),
      sourceVersion: 1,
      sourceSnapshotDigest: hash("synthetic-source"),
      severity: "Critical",
      state: "Open",
      refundDisposition: "NotStarted",
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
      version: 1,
    });
    const audit = (record) => ({
      auditId: record.caseReference === id(21) ? id(51) : id(52),
      brandId: scope.brandReference,
      storeId: scope.storeReference,
      actor: { type: "System" },
      actionCode: "PAYMENT_COMPENSATION_CASE_OPENED",
      targetType: "PaymentCompensationCase",
      targetId: record.caseReference,
      reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
      correlationId: record.caseReference,
      occurredAt: record.openedAt,
      sourceChannel: "SYSTEM",
      dataClassification: "Restricted",
      retentionPolicyCode: "AUDIT_DEFAULT",
      retentionPolicyVersion: 1,
    });
    const transactions = {
      async run(work) {
        const client = new Client({
          ...env.clientConfig,
          connectionTimeoutMillis: 2000,
          query_timeout: 5000,
        });
        await client.connect();
        active++;
        try {
          await client.query("BEGIN");
          await client.query("SET LOCAL ROLE " + role);
          await client.query("SET LOCAL lock_timeout='3s'");
          const result = await work({
            query: (sql, values) => {
              if (failAudit && sql.startsWith("UPDATE platform_audit.audit_chain_head"))
                throw new Error("synthetic audit failure");
              return client.query(sql, [...values]);
            },
          });
          await client.query("COMMIT");
          if (loseAck) {
            loseAck = false;
            throw new Error("synthetic lost acknowledgement");
          }
          return result;
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          active--;
          await client.end();
        }
      },
    };
    const lease = createPostgresPaymentCompensationLeaseStore({
      transactions,
      scope,
      leaseDurationMs: 30000,
      newFenceReference: () => id(++sequence),
      authorize: async () => true,
    });
    const request = (record) => ({
      paymentAttemptReference: record.paymentAttemptReference,
      operationReference: record.operationReference,
      jobName: paidWithoutFulfillableOrderJobName,
    });
    const owner = (extra = {}) =>
      createPostgresPaymentCompensationCaseStore({
        transactions,
        scope,
        lease,
        authorize: async () => true,
        validateOpen: async () => true,
        validateTransition: async () => true,
        ...extra,
      });
    const count = async () =>
      Number(
        (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_case_history"))
          .rows[0].count,
      );
    const auditCount = async () =>
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM platform_audit.audit_record WHERE action_code='PAYMENT_COMPENSATION_CASE_OPENED'",
          )
        ).rows[0].count,
      );
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOBYPASSRLS");
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_helpers,platform_audit TO " + role,
      );
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.payment_compensation_lease_history,rms_payment.payment_compensation_case_history,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      const store = owner(),
        first = await lease.lease.claim(request(original));
      assert.ok(first);
      const ensure = (record, token = first, target = store) =>
        target.ensure({
          record,
          audit: audit(record),
          fenceReference: token.fenceReference,
          fenceVersion: token.fenceVersion,
        });
      const reconcile = (
        current,
        next,
        token = first,
        target = store,
        refund = null,
        operations = null,
      ) =>
        target.reconcile({
          current,
          next,
          refund,
          operations,
          fenceReference: token.fenceReference,
          fenceVersion: token.fenceVersion,
        });
      assert.equal(await store.resolve({ caseReference: original.caseReference }), null);
      // A receipt coverage transaction holding the shared Order fence blocks case creation.
      await admin.query("BEGIN");
      await admin.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        "PaymentReceiptOrder:" +
          scope.brandReference +
          ":" +
          scope.storeReference +
          ":" +
          original.orderReference,
      ]);
      try {
        const bounded = owner({
          transactions: {
            run: (work) =>
              transactions.run(async (tx) => {
                await tx.query("SET LOCAL lock_timeout='30ms'", []);
                return work(tx);
              }),
          },
        });
        await assert.rejects(ensure(original, first, bounded), {
          code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
        });
        assert.equal(await count(), 0);
        assert.equal(await auditCount(), 0);
      } finally {
        await admin.query("ROLLBACK");
      }

      const created = await Promise.all([ensure(original), ensure(original)]);
      assert.deepEqual(created.map((r) => r.status).sort(), ["Created", "Existing"]);
      assert.equal(await count(), 1);
      assert.equal(await auditCount(), 1);
      assert.deepEqual(await store.resolve({ caseReference: original.caseReference }), original);
      const pending = parsePaymentCompensationCase({
        ...original,
        version: 2,
        updatedAt: time(100),
        refundDisposition: "RefundPending",
      });
      const advanced = await Promise.all([
        reconcile(original, pending),
        reconcile(original, pending),
      ]);
      assert.deepEqual(advanced.map((r) => r.status).sort(), ["Duplicate", "Updated"]);
      await assert.rejects(
        reconcile(pending, { ...pending, version: 3, refundDisposition: "NotStarted" }),
        { code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT" },
      );
      const stale = { ...pending, refundDisposition: "ReconciliationRequired" };
      assert.equal((await reconcile(original, stale)).status, "Conflict");
      await assert.rejects(reconcile(pending, { ...pending, version: 3, orderReference: id(99) }), {
        code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
      });
      await lease.lease.release({
        ...request(original),
        fenceReference: first.fenceReference,
        fenceVersion: first.fenceVersion,
      });
      const second = await lease.lease.claim(request(original));
      assert.ok(second);
      const waiting = {
        ...pending,
        version: 3,
        updatedAt: time(200),
        refundDisposition: "AwaitingProviderConfirmation",
      };
      await assert.rejects(reconcile(pending, waiting, first), {
        code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
      });
      await assert.rejects(
        reconcile(pending, waiting, second, owner({ validateTransition: async () => false })),
        { code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE" },
      );
      let calls = 0;
      await assert.rejects(
        reconcile(pending, waiting, second, owner({ authorize: async () => ++calls < 3 })),
        { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
      );
      assert.equal(await count(), 2);
      const refund = parsePaymentProviderConfirmedRefundFact({
        refundReference: id(22),
        eventReference: id(23),
        compensationCaseReference: id(21),
        paymentTransactionReference: id(7),
        paymentIntentReference: id(8),
        paymentAttemptReference: id(9),
        orderReference: id(4),
        ...scope,
        originalPaymentMethod: "OnlineCard",
        amount: { amountMinor: 2260n, currencyCode: "CAD" },
        source: "ProviderRetrieval",
        providerConfirmedAt: time(200),
        recordedAt: time(200),
        evidenceDigest: hash("synthetic-refund"),
        causationReference: id(24),
      });
      const confirmed = parsePaymentCompensationCase({
        ...pending,
        version: 3,
        updatedAt: time(200),
        refundDisposition: "ProviderConfirmed",
        refundReference: refund.refundReference,
        refundCompositionDigest: hash("synthetic-composition"),
        refundEvidenceDigest: refund.evidenceDigest,
        refundConfirmedAt: refund.providerConfirmedAt,
      });
      await assert.rejects(reconcile(pending, confirmed, second), {
        code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
      });
      await assert.rejects(
        reconcile(pending, confirmed, second, store, {
          ...refund,
          compensationCaseReference: id(99),
        }),
        { code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT" },
      );
      loseAck = true;
      await assert.rejects(reconcile(pending, confirmed, second, store, refund), {
        code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
      });
      assert.deepEqual(await store.resolve({ caseReference: id(21) }), confirmed);
      assert.equal(
        (await reconcile(pending, confirmed, second, store, refund)).status,
        "Duplicate",
      );
      await assert.rejects(
        reconcile(confirmed, { ...pending, version: 4, updatedAt: time(300) }, second),
        { code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT" },
      );
      const operations = parsePaymentOperationsReconciliationReceipt({
        receiptReference: id(61),
        compensationCaseReference: id(21),
        refundReference: id(22),
        ...scope,
        actorReference: id(62),
        purpose: "ReconcilePaidWithoutFulfillableOrder",
        refundEvidenceDigest: refund.evidenceDigest,
        reconciledAt: time(300),
        audit: {
          auditId: id(63),
          brandId: scope.brandReference,
          storeId: scope.storeReference,
          actor: { type: "User", reference: id(62) },
          actionCode: "PAYMENT_COMPENSATION_OPERATIONS_RECONCILED",
          targetType: "PaymentCompensationCase",
          targetId: id(21),
          reasonCode: "PAID_WITHOUT_FULFILLABLE_ORDER",
          correlationId: id(61),
          occurredAt: time(300),
          sourceChannel: "OPERATIONS",
          dataClassification: "Restricted",
          retentionPolicyCode: "AUDIT_DEFAULT",
          retentionPolicyVersion: 1,
        },
      });
      const closed = parsePaymentCompensationCase({
        ...confirmed,
        version: 4,
        updatedAt: time(300),
        state: "Closed",
        closedAt: time(300),
        operationsDisposition: "Reconciled",
        operationsReceiptReference: operations.receiptReference,
        operationsReceiptDigest: hash(JSON.stringify(operations)),
        operationsRefundEvidenceDigest: operations.refundEvidenceDigest,
        operationsReconciledAt: operations.reconciledAt,
      });
      await assert.rejects(reconcile(confirmed, closed, second), {
        code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
      });
      assert.equal(
        (await reconcile(confirmed, closed, second, store, null, operations)).status,
        "Updated",
      );
      assert.equal((await ensure(original, second)).status, "Existing");
      assert.deepEqual(await store.resolve({ caseReference: id(21) }), closed);
      await assert.rejects(
        reconcile(closed, { ...pending, version: 5, updatedAt: time(400) }, second),
        { code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT" },
      );

      const other = parsePaymentCompensationCase({
        ...original,
        caseReference: id(41),
        operationReference: id(30),
        paymentAttemptReference: id(10),
      });
      const otherLease = await lease.lease.claim(request(other));
      assert.ok(otherLease);
      failAudit = true;
      await assert.rejects(ensure(other, otherLease), {
        code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
      });
      failAudit = false;
      assert.equal(await store.resolve({ caseReference: id(41) }), null);
      assert.equal(await count(), 4);
      assert.equal(await auditCount(), 1);
      await assert.rejects(ensure(other, otherLease, owner({ validateOpen: async () => false })), {
        code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE",
      });
      assert.equal((await ensure(other, otherLease)).status, "Created");
      assert.equal(await auditCount(), 2);
      await assert.rejects(
        owner({ authorize: async () => false }).resolve({ caseReference: id(21) }),
        { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
      );
      assert.equal(
        await owner({ scope: { ...scope, storeReference: id(99) } }).resolve({
          caseReference: id(21),
        }),
        null,
      );

      const storedRow = (
        await admin.query("SELECT * FROM rms_payment.payment_compensation_case_history LIMIT 1")
      ).rows[0];
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, id(99)],
      );
      assert.equal(
        Number(
          (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_case_history"))
            .rows[0].count,
        ),
        0,
      );
      const columns = [
        "brand_id",
        "store_id",
        "case_id",
        "version",
        "operation_id",
        "payment_attempt_id",
        "order_id",
        "fence_id",
        "fence_version",
        "audit_id",
        "updated_at",
        "recorded_at",
        "record_json",
      ];
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.payment_compensation_case_history (" +
            columns.join(",") +
            ") VALUES (" +
            columns.map((_column, index) => "$" + (index + 1)).join(",") +
            ")",
          columns.map((column) =>
            column === "version"
              ? 99
              : column === "audit_id"
                ? null
                : column === "record_json"
                  ? { ...storedRow.record_json, version: 99 }
                  : storedRow[column],
          ),
        ),
        { code: "42501" },
      );
      await admin.query("ROLLBACK");
      const before = (
        await admin.query(
          "SELECT record_json FROM rms_payment.payment_compensation_case_history ORDER BY case_id,version",
        )
      ).rows;
      await admin.query("UPDATE rms_payment.payment_compensation_case_history SET version=99");
      await admin.query("DELETE FROM rms_payment.payment_compensation_case_history");
      assert.deepEqual(
        (
          await admin.query(
            "SELECT record_json FROM rms_payment.payment_compensation_case_history ORDER BY case_id,version",
          )
        ).rows,
        before,
      );
      assert.equal(active, 0);
    } finally {
      await admin.query("ROLLBACK");
      assert.equal(active, 0);
      await admin.query("DROP OWNED BY " + role);
      await admin.query("DROP ROLE " + role);
      await admin.end();
    }
  });
});
