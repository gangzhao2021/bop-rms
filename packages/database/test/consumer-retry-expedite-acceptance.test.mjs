// WP-2423 (2026-10-18) acceptance on a real isolated PostgreSQL: platform support's "retry now"
// (tooling/environment/consumer-retry-operations.mjs retry-now) brings consumer retries still
// waiting out their backoff forward to now, through a NOBYPASSRLS role holding only the grants the
// command needs, under Store row security. It moves only scheduled retries due later, of the named
// consumer (or every consumer), changes nothing else on them, records one append-only audit row per
// retry moved, writes nothing in a dry run and recognises a replayed request.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { claimConsumerRetryBatch, expediteConsumerRetries } from "../../bop/eventing/src/index.ts";
import { pendingSql, scopesSql } from "../../../tooling/environment/consumer-retry-operations.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => "0190fb10-0000-7000-8000-" + String(n).padStart(12, "0");
const brand = id(1),
  store = id(2),
  otherStore = id(3),
  operator = id(4);
const kitchen = "fulfillment.kitchen-item-ready:v1";
const inventory = "inventory.order-line-kitchenworkstarted:v1";
const MIN = 60_000;
let n = 100;
const next = () => id(++n);

async function inScope(client, storeId, work) {
  await client.query("BEGIN");
  try {
    await client.query(
      "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
      [brand, storeId ?? ""],
    );
    const result = await work(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

// Setup reads run as the database owner, which may bypass row security: filter the Store explicitly.
const scheduleSnapshotSql = `SELECT schedule_id::text, event_id::text, consumer_name, source_attempt_id::text,
   attempt_count, available_at::text, deadline_at::text, state, lease_token::text, lease_owner,
   lease_expires_at::text, version::text
 FROM platform_eventing.consumer_retry_schedule AS schedule
 WHERE store_id IS NOT DISTINCT FROM $1 ORDER BY schedule.schedule_id`;
const snapshot = (client, storeId) =>
  inScope(client, storeId, async (tx) => (await tx.query(scheduleSnapshotSql, [storeId])).rows);
const auditRows = (client, storeId) =>
  inScope(
    client,
    storeId,
    async (tx) =>
      (
        await tx.query(
          `SELECT action_id::text, schedule_id::text, event_id::text, consumer_name,
           requested_consumer_name, attempt_count, previous_available_at::text,
           expedited_available_at::text, deadline_at::text, actor_id::text, permission_code,
           purpose_code, reason_code, idempotency_key::text
         FROM platform_eventing.consumer_retry_expedite_action AS action
         WHERE store_id IS NOT DISTINCT FROM $1
         ORDER BY action.recorded_at, action.previous_available_at`,
          [storeId],
        )
      ).rows,
  );

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const operatorClient = new Client(context.clientConfig);
  const role = `bop_retry_expedite_${context.runId}`;
  await Promise.all([admin.connect(), operatorClient.connect()]);
  try {
    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA platform_eventing, platform_helpers TO ${role}`);
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION
      platform_helpers.is_uuid_v7(uuid),
      platform_helpers.current_brand_id(),
      platform_helpers.current_store_id()
      TO ${role}`);
    await admin.query(
      `GRANT SELECT, UPDATE ON TABLE platform_eventing.consumer_retry_schedule TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT, INSERT ON TABLE platform_eventing.consumer_retry_expedite_action TO ${role}`,
    );
    await operatorClient.query(`SET ROLE ${role}`);
    assert.deepEqual(
      (
        await admin.query(
          `SELECT rol.rolsuper, rol.rolbypassrls,
             has_table_privilege($1,'platform_eventing.consumer_retry_expedite_action','UPDATE,DELETE,TRUNCATE') AS mutation,
             has_table_privilege('public','platform_eventing.consumer_retry_expedite_action','SELECT,INSERT,UPDATE,DELETE') AS public_access,
             c.relrowsecurity, c.relforcerowsecurity
           FROM pg_roles rol, pg_class c
           WHERE rol.rolname = $1 AND c.oid = 'platform_eventing.consumer_retry_expedite_action'::regclass`,
          [role],
        )
      ).rows,
      [
        {
          rolsuper: false,
          rolbypassrls: false,
          mutation: false,
          public_access: false,
          relrowsecurity: true,
          relforcerowsecurity: true,
        },
      ],
    );

    const now = Date.now();
    const at = (offsetMs) => new Date(now + offsetMs).toISOString();
    const retry = (storeId, consumer, state, availableInMs, attempts = 3) =>
      inScope(admin, storeId, async (tx) => {
        const attempt = next(),
          event = next(),
          schedule = next();
        await tx.query(
          `INSERT INTO platform_eventing.delivery_attempt (attempt_id,brand_id,store_id,delivery_path,
             event_id,consumer_name,attempt_number,failure_class,safe_code,policy_name,policy_version,
             decision,next_available_at,deadline_at,idempotency_key,recorded_at)
           VALUES ($1,$2,$3,'consumer',$4,$5,$6,'retryable','CONSUMER_TEMPORARY_FAILURE',
             'eventing_default',2,'retry_scheduled',$7,$8,$9,$10)`,
          [
            attempt,
            brand,
            storeId,
            event,
            consumer,
            attempts,
            at(availableInMs),
            at(23 * 60 * MIN),
            next(),
            at(-MIN),
          ],
        );
        await tx.query(
          `INSERT INTO platform_eventing.consumer_retry_schedule (schedule_id,brand_id,store_id,event_id,
             consumer_name,source_attempt_id,attempt_count,available_at,deadline_at,state,lease_token,
             lease_owner,lease_expires_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
          [
            schedule,
            brand,
            storeId,
            event,
            consumer,
            attempt,
            attempts,
            at(availableInMs),
            at(23 * 60 * MIN),
            state,
            state === "claimed" ? next() : null,
            state === "claimed" ? "business-worker" : null,
            state === "claimed" ? at(MIN) : null,
          ],
        );
        return schedule;
      });
    const late = await retry(store, kitchen, "scheduled", 20 * MIN, 6); // backoff 20 min
    const soon = await retry(store, kitchen, "scheduled", 5 * MIN, 5); // backoff 5 min
    const due = await retry(store, kitchen, "scheduled", -MIN); // already due
    const claimed = await retry(store, kitchen, "claimed", 10 * MIN); // being delivered
    await retry(store, kitchen, "completed", 10 * MIN, 4); // history
    await retry(store, kitchen, "dead_lettered", 10 * MIN, 8); // history
    const otherConsumer = await retry(store, inventory, "scheduled", 20 * MIN);
    const otherStoreRetry = await retry(otherStore, kitchen, "scheduled", 20 * MIN);

    // The tool's reads (run as the migration role): the scopes holding retries in backoff of the
    // consumer, and the pending list (no outbox events are seeded here, so it joins nothing).
    assert.deepEqual((await admin.query(scopesSql, [kitchen])).rows, [
      { brand, store },
      { brand, store: otherStore },
    ]);
    assert.deepEqual((await admin.query(pendingSql)).rows, []);

    const before = await snapshot(admin, store);
    const otherStoreBefore = await snapshot(admin, otherStore);
    const command = {
      brandId: brand,
      storeId: store,
      consumerName: kitchen,
      actorId: operator,
      permission: "EVENTING_DEAD_LETTER_RETRY",
      purpose: "RELIABILITY_RECOVERY",
      reason: "DEPENDENCY_RECOVERED",
      idempotencyKey: next(),
      dryRun: true,
      actionId: next,
    };

    // Dry run: lists the two retries in backoff, soonest first, and writes nothing.
    const dry = await inScope(operatorClient, store, (tx) => expediteConsumerRetries(tx, command));
    assert.equal(dry.status, "dry_run");
    assert.deepEqual(
      dry.retries.map((item) => [item.scheduleId, item.expeditedAvailableAt]),
      [
        [soon, null],
        [late, null],
      ],
    );
    assert.deepEqual(await snapshot(admin, store), before);
    assert.deepEqual(await auditRows(admin, store), []);

    // Retry now: only the scheduled retries of this consumer due later move, to the same instant.
    const live = { ...command, dryRun: false };
    const applied = await inScope(operatorClient, store, (tx) => expediteConsumerRetries(tx, live));
    assert.equal(applied.status, "applied");
    assert.deepEqual(
      applied.retries.map((item) => [item.scheduleId, item.consumerName, item.attemptCount]),
      [
        [soon, kitchen, 5],
        [late, kitchen, 6],
      ],
    );
    const after = await snapshot(admin, store);
    const audit = await auditRows(admin, store);
    assert.equal(audit.length, 2);
    const byId = (rows) => new Map(rows.map((row) => [row.schedule_id, row]));
    const beforeById = byId(before),
      afterById = byId(after),
      auditById = byId(audit);
    for (const [scheduleId, row] of beforeById) {
      const moved = afterById.get(scheduleId);
      if (scheduleId === late || scheduleId === soon) {
        const record = auditById.get(scheduleId);
        assert.deepEqual(
          { ...moved, available_at: row.available_at, version: row.version },
          row,
          "only the due time and version change",
        );
        assert.equal(BigInt(moved.version), BigInt(row.version) + 1n);
        assert.equal(moved.available_at, record.expedited_available_at);
        assert(Date.parse(moved.available_at) <= Date.now());
        assert.deepEqual(
          {
            event_id: record.event_id,
            consumer_name: record.consumer_name,
            requested_consumer_name: record.requested_consumer_name,
            attempt_count: record.attempt_count,
            previous_available_at: record.previous_available_at,
            deadline_at: record.deadline_at,
            actor_id: record.actor_id,
            permission_code: record.permission_code,
            purpose_code: record.purpose_code,
            reason_code: record.reason_code,
            idempotency_key: record.idempotency_key,
          },
          {
            event_id: row.event_id,
            consumer_name: kitchen,
            requested_consumer_name: kitchen,
            attempt_count: row.attempt_count,
            previous_available_at: row.available_at,
            deadline_at: row.deadline_at,
            actor_id: operator,
            permission_code: "EVENTING_DEAD_LETTER_RETRY",
            purpose_code: "RELIABILITY_RECOVERY",
            reason_code: "DEPENDENCY_RECOVERED",
            idempotency_key: command.idempotencyKey,
          },
        );
      } else assert.deepEqual(moved, row, "due, claimed, history and other consumers stay");
    }
    assert.deepEqual(await snapshot(admin, otherStore), otherStoreBefore);

    // Replay of the same request: the recorded result, nothing changes; another scope is a conflict.
    const replay = await inScope(operatorClient, store, (tx) => expediteConsumerRetries(tx, live));
    assert.equal(replay.status, "already_applied");
    assert.deepEqual(replay.retries, applied.retries);
    assert.deepEqual(
      await inScope(operatorClient, store, (tx) =>
        expediteConsumerRetries(tx, { ...live, consumerName: null }),
      ),
      { status: "conflict", retries: [] },
    );
    assert.deepEqual(await snapshot(admin, store), after);
    assert.deepEqual(await auditRows(admin, store), audit);

    // The audit history is append-only: UPDATE and DELETE change nothing, even for the owner.
    await inScope(admin, store, async (tx) => {
      const updated = await tx.query(
        "UPDATE platform_eventing.consumer_retry_expedite_action SET reason_code = 'DEPENDENCY_RECOVERED', actor_id = $1",
        [brand],
      );
      const deleted = await tx.query(
        "DELETE FROM platform_eventing.consumer_retry_expedite_action",
      );
      assert.equal(updated.rowCount, 0);
      assert.equal(deleted.rowCount, 0);
    });
    assert.deepEqual(await auditRows(admin, store), audit);
    // The operator role holds no UPDATE/DELETE grant (checked above); its DELETE is rewritten to
    // nothing as well.
    assert.equal(
      (
        await inScope(operatorClient, store, (tx) =>
          tx.query("DELETE FROM platform_eventing.consumer_retry_expedite_action"),
        )
      ).rowCount,
      0,
    );
    assert.deepEqual(await auditRows(admin, store), audit);

    // Row security: under this Store's scope another Store's retries are invisible and untouched.
    assert.deepEqual(
      await inScope(operatorClient, store, (tx) =>
        expediteConsumerRetries(tx, {
          ...live,
          storeId: otherStore,
          idempotencyKey: next(),
        }),
      ),
      { status: "applied", retries: [] },
    );
    assert.deepEqual(await snapshot(admin, otherStore), otherStoreBefore);

    // Every consumer of the scope: the other consumer's retry in backoff moves now.
    const everyConsumer = await inScope(operatorClient, store, (tx) =>
      expediteConsumerRetries(tx, { ...live, consumerName: null, idempotencyKey: next() }),
    );
    assert.deepEqual(
      everyConsumer.retries.map((item) => item.scheduleId),
      [otherConsumer],
    );
    assert.equal((await auditRows(admin, store)).at(-1).requested_consumer_name, null);

    // The retry worker now takes the moved retries on its next pass; the claimed one stays claimed.
    const claims = await inScope(operatorClient, store, (tx) =>
      claimConsumerRetryBatch(tx, {
        batchSize: 25,
        leaseDurationSeconds: 30,
        leaseOwner: "retry_worker",
        leaseToken: next(),
        now: new Date().toISOString(),
      }),
    );
    assert.deepEqual(
      claims.map((item) => item.scheduleId).sort(),
      [due, soon, late, otherConsumer].sort(),
    );
    assert(!claims.some((item) => item.scheduleId === claimed));
    assert(!claims.some((item) => item.scheduleId === otherStoreRetry));
  } finally {
    await operatorClient.query("ROLLBACK").catch(() => undefined);
    await operatorClient.query("RESET ROLE").catch(() => undefined);
    await operatorClient.end();
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("proves the WP-2423 consumer retry expedite acceptance", async () => {
  await withIsolatedDatabase({ caseId: "retry_expedite", root }, prove);
}, 300_000);
