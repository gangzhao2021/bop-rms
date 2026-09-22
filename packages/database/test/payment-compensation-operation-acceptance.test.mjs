import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPaymentCompensationLeaseStore,
  createPostgresPaymentCompensationOperationStore,
  paidWithoutFulfillableOrderJobName,
  parsePaymentCompensationOperationRecord,
  parsePaymentCompensationResult,
} from "../../rms/payment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "0190ed08-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const digest = (value) => "sha256:" + createHash("sha256").update(value).digest("hex");
const scope = { brandReference: id(1), storeReference: id(2) };
it("persists compensation results under actual leases with immutable replay and source checks", async () => {
  await withIsolatedDatabase({ caseId: "compensation_result" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_result_" + env.runId;
    assert.match(role, /^wp2402_result_[a-f0-9]+$/u);
    let sequence = 100,
      active = 0,
      loseAck = false;
    const at = new Date(Date.now() - 1000).toISOString();
    const disposition = {
      dispositionReference: id(3),
      ...scope,
      orderReference: id(4),
      orderBatchReference: id(5),
      submissionReference: id(6),
      paymentTransactionReference: id(7),
      paymentIntentReference: id(8),
      paymentAttemptReference: id(9),
      paymentEventReference: id(10),
      sourceVersion: 3,
      sourceCheckpoint: id(11),
      sourceDigest: digest("synthetic-ordering-disposition"),
      evaluatedAt: at,
      disposition: "PaidWithoutFulfillableOrder",
      reason: "CapacityExpired",
      kitchenReleaseDisposition: "Blocked",
    };
    const record = (status = "RefundPending", offset = 200) => {
      const evaluatedAt = new Date(Date.parse(at) + offset).toISOString();
      const confirmed = status === "Closed" || status === "AwaitingOperationsReconciliation";
      const result = parsePaymentCompensationResult({
        status,
        operationReference: id(20),
        caseReference: id(21),
        evaluatedAt,
        refundReference: confirmed ? id(22) : null,
        eventReference: confirmed ? id(23) : null,
        exceptionSource: {
          exceptionReference: id(21),
          ...scope,
          paymentIntentReference: id(8),
          paymentAttemptReference: id(9),
          orderReference: id(4),
          kind: "PaidWithoutFulfillableOrder",
          severity: "Critical",
          state: status === "Closed" ? "Closed" : "Open",
          refundDisposition: confirmed ? "ProviderConfirmed" : status,
          operationsDisposition: status === "Closed" ? "Reconciled" : "Pending",
          openedAt: at,
          updatedAt: evaluatedAt,
          closedAt: status === "Closed" ? evaluatedAt : null,
        },
      });
      return parsePaymentCompensationOperationRecord({
        disposition,
        requestDigest: digest("synthetic-request"),
        result,
        resultDigest: digest(JSON.stringify(result)),
      });
    };
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
          const result = await work({ query: (sql, values) => client.query(sql, [...values]) });
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
    const request = {
      paymentAttemptReference: id(9),
      operationReference: id(20),
      jobName: paidWithoutFulfillableOrderJobName,
    };
    const owner = (extra = {}) =>
      createPostgresPaymentCompensationOperationStore({
        transactions,
        scope,
        lease,
        authorize: async () => true,
        validateSources: async () => true,
        ...extra,
      });
    const count = async () =>
      Number(
        (
          await admin.query(
            "SELECT count(*) FROM rms_payment.payment_compensation_operation_history",
          )
        ).rows[0].count,
      );
    try {
      await admin.query("CREATE ROLE " + role + " NOLOGIN NOBYPASSRLS");
      await admin.query("GRANT USAGE ON SCHEMA rms_payment,platform_helpers TO " + role);
      await admin.query("GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO " + role);
      await admin.query(
        "GRANT EXECUTE ON FUNCTION platform_helpers.is_uuid_v7(uuid),platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO " +
          role,
      );
      await admin.query(
        "GRANT SELECT,INSERT ON rms_payment.payment_compensation_lease_history,rms_payment.payment_compensation_operation_history TO " +
          role,
      );
      const store = owner(),
        first = await lease.lease.claim(request);
      assert.ok(first);
      const commit = (value, token = first, target = store) =>
        target.commitOperation({
          record: value,
          fenceReference: token.fenceReference,
          fenceVersion: token.fenceVersion,
        });
      assert.equal(await store.resolveOperation({ operationReference: id(20) }), null);
      const initial = record("RefundPending", 0);
      const outcomes = await Promise.all([commit(initial), commit(initial)]);
      assert.deepEqual(outcomes.map((result) => result.status).sort(), ["Created", "Duplicate"]);
      assert.equal(await count(), 1);
      assert.deepEqual(await store.resolveOperation({ operationReference: id(20) }), initial);
      const next = record("AwaitingProviderConfirmation");
      assert.equal((await commit(next)).status, "Updated");
      assert.equal(await count(), 2);
      assert.equal(
        (await commit(initial)).status,
        "Conflict",
        "older evaluated result cannot replace current history",
      );
      await assert.rejects(commit({ ...next, resultDigest: digest("wrong") }), {
        code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT",
      });
      const rebound = {
        ...next,
        result: {
          ...next.result,
          exceptionSource: { ...next.result.exceptionSource, orderReference: id(99) },
        },
      };
      rebound.resultDigest = digest(JSON.stringify(rebound.result));
      await assert.rejects(commit(rebound), { code: "PAYMENT_COMPENSATION_OPERATION_CONFLICT" });
      assert.equal(
        (await commit({ ...next, requestDigest: digest("changed-request") })).status,
        "Conflict",
      );
      await assert.rejects(
        commit(
          record("ReconciliationRequired"),
          first,
          owner({ validateSources: async () => false }),
        ),
        { code: "PAYMENT_COMPENSATION_SOURCE_UNAVAILABLE" },
      );
      let calls = 0;
      await assert.rejects(
        commit(
          record("ReconciliationRequired"),
          first,
          owner({ authorize: async () => ++calls < 4 }),
        ),
        { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
      );
      assert.equal(
        await count(),
        2,
        "source and post-insert authorization failures preserve history",
      );

      await lease.lease.release({
        ...request,
        fenceReference: first.fenceReference,
        fenceVersion: first.fenceVersion,
      });
      const second = await lease.lease.claim(request);
      assert.ok(second);
      await assert.rejects(commit(next, first), { code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE" });
      loseAck = true;
      const confirmed = record("AwaitingOperationsReconciliation");
      await assert.rejects(commit(confirmed, second), {
        code: "PAYMENT_COMPENSATION_DEPENDENCY_UNAVAILABLE",
      });
      assert.equal(await count(), 3);
      assert.deepEqual(await store.resolveOperation({ operationReference: id(20) }), confirmed);
      assert.equal((await commit(confirmed, second)).status, "Duplicate");
      assert.equal(
        (await commit(next, second)).status,
        "Conflict",
        "Provider confirmation cannot disappear",
      );
      const closed = record("Closed");
      assert.equal((await commit(closed, second)).status, "Updated");
      assert.equal((await commit(next, second)).status, "Conflict", "Closed is not reopened");
      assert.equal(await count(), 4);
      await assert.rejects(
        owner({ authorize: async () => false }).resolveOperation({ operationReference: id(20) }),
        { code: "PAYMENT_COMPENSATION_PERMISSION_DENIED" },
      );
      assert.equal(
        await owner({ scope: { ...scope, storeReference: id(99) } }).resolveOperation({
          operationReference: id(20),
        }),
        null,
      );
      const storedRow = (
        await admin.query(
          "SELECT * FROM rms_payment.payment_compensation_operation_history LIMIT 1",
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
          (
            await admin.query(
              "SELECT count(*) FROM rms_payment.payment_compensation_operation_history",
            )
          ).rows[0].count,
        ),
        0,
      );
      const columns = [
        "brand_id",
        "store_id",
        "operation_id",
        "history_version",
        "payment_attempt_id",
        "order_id",
        "case_id",
        "fence_id",
        "fence_version",
        "request_digest",
        "result_digest",
        "evaluated_at",
        "recorded_at",
        "record_json",
      ];
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.payment_compensation_operation_history (" +
            columns.join(",") +
            ") VALUES (" +
            columns.map((_column, index) => "$" + (index + 1)).join(",") +
            ")",
          columns.map((column) => (column === "history_version" ? 99 : storedRow[column])),
        ),
        { code: "42501" },
      );
      await admin.query("ROLLBACK");
      const before = await admin.query(
        "SELECT record_json FROM rms_payment.payment_compensation_operation_history ORDER BY history_version",
      );
      await admin.query(
        "UPDATE rms_payment.payment_compensation_operation_history SET request_digest='sha256:" +
          "0".repeat(64) +
          "'",
      );
      await admin.query("DELETE FROM rms_payment.payment_compensation_operation_history");
      assert.deepEqual(
        (
          await admin.query(
            "SELECT record_json FROM rms_payment.payment_compensation_operation_history ORDER BY history_version",
          )
        ).rows,
        before.rows,
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
