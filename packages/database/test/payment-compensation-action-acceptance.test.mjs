import { exerciseCompensationActions } from "../test-support/payment-compensation-actions.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPaymentCompensationLeaseStore,
  createPostgresPaymentCompensationCaseStore,
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationCase,
} from "../../rms/payment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "0190ed09-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const hash = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const scope = { brandReference: id(1), storeReference: id(2) };
it("persists refund action claims and outcomes under actual Case and lease fences", async () => {
  await withIsolatedDatabase({ caseId: "compensation_action" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_action_" + env.runId;
    assert.match(role, /^wp2402_action_[a-f0-9]+$/u);
    let sequence = 100,
      active = 0,
      loseAck = false,
      failAudit = false;
    const at = new Date(Date.now() - 1500).toISOString();
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
      const cases = owner(),
        token = await lease.lease.claim(request(original));
      assert.ok(token);
      await cases.ensure({
        record: original,
        audit: audit(original),
        fenceReference: token.fenceReference,
        fenceVersion: token.fenceVersion,
      });
      assert.equal(await count(), 1);
      assert.equal(await auditCount(), 1);
      await exerciseCompensationActions({
        admin,
        transactions,
        role,
        scope,
        lease,
        caseRecord: original,
        token,
        setAuditFailure: (value) => {
          failAudit = value;
        },
        setLostAck: (value) => {
          loseAck = value;
        },
      });
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
