import assert from "node:assert/strict";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
import {
  createPostgresReconciliationFollowUpStore,
  createPostgresReconciliationFollowUpQuery,
  createReconciliationFollowUpService,
} from "../../rms/payment/src/index.ts";
import { appendAuditRecordInTransaction } from "../../bop/audit/src/index.ts";
const { Client } = pg,
  id = (n) => "01902402-0000-7000-8000-" + n.toString(16).padStart(12, "0");
it("commits follow-up with Audit exactly once under concurrent retries and rolls back failures", async () => {
  await withIsolatedDatabase({ caseId: "recon_follow_store" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "recon_follow_" + env.runId;
    let created = false,
      failAudit = false,
      revoke = false,
      authorized = true,
      sequence = 1000;
    const scope = { tenantReference: id(1), brandReference: id(2), storeReference: id(3) },
      now = "2026-09-20T10:01:00.000Z";
    const command = {
      ...scope,
      exceptionReference: id(4),
      expectedVersion: 1,
      operationReference: id(5),
      actorReference: id(6),
      action: "Acknowledge",
      assigneeReference: null,
      occurredAt: now,
    };
    async function run(work) {
      const client = new Client(env.clientConfig);
      await client.connect();
      try {
        await client.query("BEGIN");
        await client.query("SET LOCAL ROLE " + role);
        await client.query("SET LOCAL lock_timeout='5s'");
        const result = await work({
          query: async (sql, values = []) => {
            if (failAudit && sql.startsWith("INSERT INTO platform_audit.audit_record"))
              await client.query("SELECT 1/0");
            const result = await client.query(sql, [...values]);
            if (revoke && sql.startsWith("INSERT INTO platform_audit.audit_record"))
              authorized = false;
            return result;
          },
        });
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        await client.end();
      }
    }
    const authorize = async () => authorized;
    const service = createReconciliationFollowUpService({
      transactions: { run },
      now: () => now,
      authorize,
      records: createPostgresReconciliationFollowUpStore({ scope, authorize }),
      audit: {
        append: async (tx, { command: c }) =>
          appendAuditRecordInTransaction(tx, {
            auditId: id(++sequence),
            brandId: c.brandReference,
            storeId: c.storeReference,
            actor: { type: "User", reference: c.actorReference },
            actionCode: "PAYMENT_RECONCILIATION_FOLLOW_UP",
            targetType: "PaymentReconciliationException",
            targetId: c.exceptionReference,
            correlationId: c.operationReference,
            occurredAt: c.occurredAt,
            reasonCode: c.action === "Assign" ? "EXCEPTION_ASSIGNED" : "EXCEPTION_ACKNOWLEDGED",
            sourceChannel: "INTERNAL_TEST",
            dataClassification: "Restricted",
            retentionPolicyCode: "PAYMENT_AUDIT",
            retentionPolicyVersion: 1,
          }),
      },
    });
    const counts = async () =>
      (
        await admin.query(
          "SELECT (SELECT count(*)::int FROM rms_payment.reconciliation_follow_up_history) AS history,(SELECT count(*)::int FROM platform_audit.audit_record WHERE action_code='PAYMENT_RECONCILIATION_FOLLOW_UP') AS audit",
        )
      ).rows[0];
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOSUPERUSER NOBYPASSRLS");
      created = true;
      await admin.query(
        "GRANT USAGE ON SCHEMA rms_payment,platform_helpers,platform_audit TO " + role,
      );
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query("GRANT SELECT ON rms_payment.payment_reconciliation_exception TO " + role);
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.reconciliation_follow_up_history,platform_audit.audit_record TO " +
          role,
      );
      await admin.query("GRANT SELECT,INSERT,UPDATE ON platform_audit.audit_chain_head TO " + role);
      await admin.query(
        "INSERT INTO rms_payment.payment_reconciliation_exception VALUES($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)",
        [id(4), id(2), id(3), id(7), now],
      );
      failAudit = true;
      await assert.rejects(service.execute(command));
      assert.deepEqual(await counts(), { history: 0, audit: 0 });
      failAudit = false;
      const results = await Promise.all([service.execute(command), service.execute(command)]);
      assert.deepEqual(results.map((r) => r.status).sort(), ["Created", "Duplicate"]);
      assert.deepEqual(await counts(), { history: 1, audit: 1 });
      await assert.rejects(service.execute({ ...command, actorReference: id(99) }));
      const assignment = {
        ...command,
        expectedVersion: 2,
        operationReference: id(8),
        action: "Assign",
        assigneeReference: id(9),
      };
      revoke = true;
      await assert.rejects(service.execute(assignment));
      assert.deepEqual(await counts(), { history: 1, audit: 1 });
      revoke = false;
      authorized = true;
      const assigned = await service.execute(assignment);
      assert.equal(assigned.state.status, "Assigned");
      assert.equal(assigned.state.ownerReference, id(9));
      assert.equal(assigned.state.acknowledgedByReference, id(6));
      const readFollowUp = createPostgresReconciliationFollowUpQuery({ scope, authorize });
      assert.deepEqual(await run((tx) => readFollowUp(tx, id(4))), {
        version: 3,
        followUpStatus: "Assigned",
        acknowledged: true,
        assigned: true,
        updatedAt: now,
      });

      assert.deepEqual(await counts(), { history: 2, audit: 2 });
      await assert.rejects(service.execute({ ...command, operationReference: id(10) }));
      assert.deepEqual(await counts(), { history: 2, audit: 2 });
      for (const [tenant, brand, store, count] of [
        [id(1), id(2), id(3), 2],
        [id(99), id(2), id(3), 0],
        [id(1), id(99), id(3), 0],
        [id(1), id(2), id(99), 0],
      ])
        await run(async (tx) => {
          await tx.query(
            "SELECT set_config('bop.tenant_id',$1,true),set_config('bop.brand_id',$2,true),set_config('bop.store_id',$3,true)",
            [tenant, brand, store],
          );
          assert.equal(
            (
              await tx.query(
                "SELECT count(*)::int AS n FROM rms_payment.reconciliation_follow_up_history",
              )
            ).rows[0].n,
            count,
          );
        });
      await assert.rejects(
        run((tx) => tx.query("UPDATE rms_payment.reconciliation_follow_up_history SET version=99")),
        (e) => e.code === "42501",
      );
      assert.equal(
        (await admin.query("SELECT status FROM rms_payment.payment_reconciliation_exception"))
          .rows[0].status,
        "Open",
      );
    } finally {
      if (created) {
        await admin.query("DROP OWNED BY " + role);
        await admin.query("DROP ROLE " + role);
      }
      await admin.end();
    }
  });
}, 180000);
