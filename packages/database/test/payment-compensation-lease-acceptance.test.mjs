import assert from "node:assert/strict";
import { setTimeout } from "node:timers/promises";
import pg from "pg";
import { it } from "vitest";
import {
  createPostgresPaymentCompensationLeaseStore,
  paidWithoutFulfillableOrderJobName,
} from "../../rms/payment/src/index.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const id = (n) => "0190ed07-0000-7000-8000-" + n.toString(16).padStart(12, "0");
const scope = { brandReference: id(1), storeReference: id(2) };
it("persists compensation leases with one winner, stale-worker fencing, expiry and RLS", async () => {
  await withIsolatedDatabase({ caseId: "compensation_lease" }, async (env) => {
    const admin = new Client(env.clientConfig);
    await admin.connect();
    const role = "wp2402_lease_" + env.runId;
    assert.match(role, /^wp2402_lease_[a-f0-9]+$/u);
    let sequence = 100,
      active = 0,
      loseAck = false;
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
    const owner = (extra = {}) =>
      createPostgresPaymentCompensationLeaseStore({
        transactions,
        scope,
        leaseDurationMs: 30000,
        newFenceReference: () => id(++sequence),
        authorize: async (_tx, access) => {
          assert.deepEqual(
            Object.keys(access).sort(),
            [
              "action",
              "brandReference",
              "storeReference",
              "paymentAttemptReference",
              "operationReference",
            ].sort(),
          );
          return true;
        },
        ...extra,
      });
    const request = (attempt = 10, operation = 20) => ({
      paymentAttemptReference: id(attempt),
      operationReference: id(operation),
      jobName: paidWithoutFulfillableOrderJobName,
    });
    const fence = (lease) => ({
      ...request(),
      paymentAttemptReference: lease.paymentAttemptReference,
      operationReference: lease.operationReference,
      fenceReference: lease.fenceReference,
      fenceVersion: lease.fenceVersion,
    });
    const count = async () =>
      Number(
        (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_lease_history"))
          .rows[0].count,
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
        "GRANT SELECT,INSERT ON rms_payment.payment_compensation_lease_history TO " + role,
      );
      const store = owner();
      await assert.rejects(store.lease.claim({ ...request(), paymentAttemptReference: "bad" }), {
        code: "PAYMENT_COMPENSATION_INPUT_INVALID",
      });
      await assert.rejects(store.lease.claim({ ...request(), extra: true }), {
        code: "PAYMENT_COMPENSATION_INPUT_INVALID",
      });

      const winners = (
        await Promise.all([store.lease.claim(request()), store.lease.claim(request())])
      ).filter(Boolean);
      assert.equal(winners.length, 1);
      const first = winners[0];
      assert.equal(first.fenceVersion, 1);
      assert.equal(await count(), 1);
      await transactions.run((tx) => store.assertCurrent(tx, fence(first)));
      await store.lease.release(fence(first));
      await store.lease.release(fence(first));
      assert.equal(await count(), 2);
      const replacement = await store.lease.claim(request());
      assert.ok(replacement);
      assert.equal(replacement.fenceVersion, 3);
      await assert.rejects(store.lease.release(fence(first)), {
        code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
      });
      await assert.rejects(
        transactions.run((tx) => store.assertCurrent(tx, fence(first))),
        { code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE" },
      );
      await transactions.run((tx) => store.assertCurrent(tx, fence(replacement)));
      assert.equal(await count(), 3);
      let entered, finish;
      const ready = new Promise((resolve) => {
        entered = resolve;
      });
      const hold = new Promise((resolve) => {
        finish = resolve;
      });
      const held = transactions.run(async (tx) => {
        await store.assertCurrent(tx, fence(replacement));
        entered();
        await hold;
      });
      await ready;
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
        await assert.rejects(bounded.lease.release(fence(replacement)), {
          code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
        });
      } finally {
        finish();
        await held;
      }
      await transactions.run((tx) => store.assertCurrent(tx, fence(replacement)));
      const denied = owner({ authorize: async () => false });
      await assert.rejects(denied.lease.claim(request(11)), {
        code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
      });
      let calls = 0;
      const drift = owner({ authorize: async () => ++calls < 3 });
      await assert.rejects(drift.lease.claim(request(12)), {
        code: "PAYMENT_COMPENSATION_PERMISSION_DENIED",
      });
      assert.equal(
        await count(),
        3,
        "post-insert authorization failure rolls back its owned transaction",
      );
      loseAck = true;
      await assert.rejects(store.lease.claim(request(13)), {
        code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
      });
      assert.equal(await count(), 4);
      assert.equal(
        await store.lease.claim(request(13)),
        null,
        "lost claim response cannot create another active worker",
      );
      const short = owner({ leaseDurationMs: 100 });
      const expiring = await short.lease.claim(request(14));
      assert.ok(expiring);
      await setTimeout(150);
      await assert.rejects(
        transactions.run((tx) => short.assertCurrent(tx, fence(expiring))),
        { code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE" },
      );
      const afterExpiry = await short.lease.claim(request(14));
      assert.ok(afterExpiry);
      assert.equal(afterExpiry.fenceVersion, 2);
      await assert.rejects(short.lease.release(fence(expiring)), {
        code: "PAYMENT_COMPENSATION_LEASE_UNAVAILABLE",
      });
      await admin.query("BEGIN");
      await admin.query("SET LOCAL ROLE " + role);
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [scope.brandReference, id(99)],
      );
      assert.equal(
        Number(
          (await admin.query("SELECT count(*) FROM rms_payment.payment_compensation_lease_history"))
            .rows[0].count,
        ),
        0,
      );
      await assert.rejects(
        admin.query(
          "INSERT INTO rms_payment.payment_compensation_lease_history " +
            "(brand_id,store_id,payment_attempt_id,operation_id,history_sequence,action,fence_id,fence_version,claimed_at,expires_at,recorded_at) " +
            "VALUES ($1,$2,$3,$4,1,'Claimed',$5,1,$6,$7,$6)",
          [
            scope.brandReference,
            scope.storeReference,
            id(99),
            id(20),
            id(999),
            first.claimedAt,
            first.expiresAt,
          ],
        ),
        { code: "42501" },
      );
      await admin.query("ROLLBACK");
      const before = await count();
      await admin.query(
        "UPDATE rms_payment.payment_compensation_lease_history SET action='Released'",
      );
      await admin.query("DELETE FROM rms_payment.payment_compensation_lease_history");
      assert.equal(await count(), before);
      assert.equal(
        (
          await admin.query(
            "SELECT action FROM rms_payment.payment_compensation_lease_history WHERE history_sequence=1 LIMIT 1",
          )
        ).rows[0].action,
        "Claimed",
      );
      // PostgreSQL ORDER BY must use the numeric column, not its text output alias.
      for (let cycle = 0; cycle < 7; cycle++) {
        const current = await store.lease.claim(request(30, 31));
        assert(current);
        assert.equal(current.fenceVersion, cycle * 2 + 1);
        await transactions.run((tx) => store.assertCurrent(tx, fence(current)));
        await store.lease.release(fence(current));
        await store.lease.release(fence(current));
      }
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
