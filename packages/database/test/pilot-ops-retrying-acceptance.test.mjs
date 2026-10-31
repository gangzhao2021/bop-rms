// WP-2423 (2026-10-16) acceptance on a real isolated PostgreSQL: the operations monitor's early
// warning for order updates that are still being retried (tooling/environment/pilot-ops-observe.mjs)
// reads consumer retries and outbox events through a NOBYPASSRLS role holding only the pilot api
// role's SELECT grants on the eventing tables, under Store and Brand row security, and stays
// bounded with many completed retries and published events.
import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import {
  CONSUMER_RETRYING_SUMMARY,
  OUTBOX_RETRYING_SUMMARY,
  RETRY_HORIZON_MS,
  RETRYING_UPDATE_AGE_MS,
  RETRYING_UPDATE_ATTEMPTS,
  readBusinessSignals,
} from "../../../tooling/environment/pilot-ops-observe.mjs";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => "0190fa97-0000-7000-8000-" + String(n).padStart(12, "0");
const brand = id(1),
  store = id(2),
  otherStore = id(3);
const COMPLETED = 20_000;
const PUBLISHED = 50_000;
const MIN = 60_000;

function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_ops_retrying_${context.runId}`;
  await admin.connect();
  const pool = new Pool({
    ...context.clientConfig,
    max: 2,
    connectionTimeoutMillis: 2000,
    query_timeout: 10_000,
  });
  try {
    const now = Date.now();
    const at = (offsetMs) => new Date(now + offsetMs).toISOString();
    // Setup writes as the owner; tables force row security, so each row is written in its scope.
    const scoped = async (storeId, work) => {
      await admin.query("BEGIN");
      await admin.query(
        "SELECT set_config('bop.brand_id',$1,true),set_config('bop.store_id',$2,true)",
        [brand, storeId ?? ""],
      );
      await work();
      await admin.query("COMMIT");
    };
    let n = 100;
    // One consumer retry: its source attempt, then the schedule row (first failure = deadline - 24 h).
    const retry = async (storeId, { attempts, failingForMs, state }) => {
      const attempt = id(++n),
        event = id(++n),
        deadline = at(-failingForMs + RETRY_HORIZON_MS);
      await scoped(storeId, async () => {
        await admin.query(
          `INSERT INTO platform_eventing.delivery_attempt (attempt_id,brand_id,store_id,delivery_path,
             event_id,consumer_name,attempt_number,failure_class,safe_code,policy_name,policy_version,
             decision,next_available_at,deadline_at,idempotency_key,recorded_at)
           VALUES ($1,$2,$3,'consumer',$4,'fulfillment.kitchen-item-ready:v1',$5,'retryable',
             'CONSUMER_TEMPORARY_FAILURE','eventing_default',2,'retry_scheduled',$6,$7,$8,$6)`,
          [attempt, brand, storeId, event, attempts, at(-MIN), deadline, id(++n)],
        );
        await admin.query(
          `INSERT INTO platform_eventing.consumer_retry_schedule (schedule_id,brand_id,store_id,event_id,
             consumer_name,source_attempt_id,attempt_count,available_at,deadline_at,state,lease_token,
             lease_owner,lease_expires_at)
           VALUES ($1,$2,$3,$4,'fulfillment.kitchen-item-ready:v1',$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            id(++n),
            brand,
            storeId,
            event,
            attempt,
            attempts,
            at(MIN),
            deadline,
            state,
            state === "claimed" ? id(++n) : null,
            state === "claimed" ? "business-worker" : null,
            state === "claimed" ? at(MIN) : null,
          ],
        );
      });
    };
    await retry(store, { attempts: 2, failingForMs: 5 * MIN, state: "scheduled" }); // too early
    await retry(store, { attempts: 4, failingForMs: 1 * MIN, state: "scheduled" }); // 4 tries
    await retry(store, { attempts: 2, failingForMs: 20 * MIN, state: "claimed" }); // 20 minutes
    await retry(store, { attempts: 6, failingForMs: 40 * MIN, state: "completed" }); // processed
    await retry(store, { attempts: 8, failingForMs: 60 * MIN, state: "dead_lettered" }); // dead letter
    await retry(null, { attempts: 5, failingForMs: 2 * MIN, state: "scheduled" }); // Brand-wide
    await retry(otherStore, { attempts: 7, failingForMs: 90 * MIN, state: "scheduled" }); // hidden

    const outbox = async (storeId, values) =>
      scoped(storeId, () =>
        admin.query(
          `INSERT INTO platform_eventing.outbox_event (event_id,event_type,schema_version,producer_module,
             brand_id,store_id,aggregate_type,aggregate_id,aggregate_version,correlation_id,actor_type,
             payload_json,redaction_classification,replay_metadata_json,occurred_at,recorded_at,
             available_at,published_at,attempt_count,last_error_code)
           VALUES ($1,'KitchenItemCompleted',1,'@rms/kitchen',$2,$3,'KitchenTicket',$4,1,$5,'System',
             '{}','none','{}',$6,$6,$7,NULL,$8,$9)`,
          [id(++n), brand, storeId, id(++n), id(++n), ...values],
        ),
      );
    await outbox(store, [at(-3 * MIN), at(MIN), 4, null]); // 4 tries, next retry scheduled
    await outbox(store, [at(-16 * MIN), at(-15 * MIN), 0, null]); // due 15 minutes, held back
    await outbox(store, [at(-2 * MIN), at(-2 * MIN), 1, null]); // too early
    await outbox(store, [at(-60 * MIN), at(-60 * MIN), 8, "TRANSPORT_REJECTED"]); // dead letter
    await outbox(null, [at(-5 * MIN), at(MIN), 5, null]); // Brand-wide, seen by the Store
    await outbox(otherStore, [at(-90 * MIN), at(-90 * MIN), 5, null]); // hidden

    // Volume: completed retries and published events of this Store.
    await scoped(store, async () => {
      await admin.query(
        `INSERT INTO platform_eventing.delivery_attempt (attempt_id,brand_id,store_id,delivery_path,
           event_id,consumer_name,attempt_number,failure_class,safe_code,policy_name,policy_version,
           decision,next_available_at,deadline_at,idempotency_key,recorded_at)
         SELECT ('0190fa96-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,$1,$2,'consumer',
           ('0190fa95-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,'inventory.consumption:v1',3,
           'retryable','CONSUMER_TEMPORARY_FAILURE','eventing_default',2,'retry_scheduled',
           $3::timestamptz,$3::timestamptz + interval '24 hours',
           ('0190fa94-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,$3::timestamptz
         FROM generate_series(1,$4::int) AS i`,
        [brand, store, at(-10 * 24 * 60 * MIN), COMPLETED],
      );
      await admin.query(
        `INSERT INTO platform_eventing.consumer_retry_schedule (schedule_id,brand_id,store_id,event_id,
           consumer_name,source_attempt_id,attempt_count,available_at,deadline_at,state)
         SELECT ('0190fa93-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,$1,$2,
           ('0190fa95-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,'inventory.consumption:v1',
           ('0190fa96-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,3,$3::timestamptz,
           $3::timestamptz + interval '24 hours','completed'
         FROM generate_series(1,$4::int) AS i`,
        [brand, store, at(-10 * 24 * 60 * MIN), COMPLETED],
      );
      await admin.query(
        `INSERT INTO platform_eventing.outbox_event (event_id,event_type,schema_version,producer_module,
           brand_id,store_id,aggregate_type,aggregate_id,aggregate_version,correlation_id,actor_type,
           payload_json,redaction_classification,replay_metadata_json,occurred_at,recorded_at,
           available_at,published_at,attempt_count)
         SELECT ('0190fa92-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,'OrderSubmitted',1,
           '@rms/ordering',$1,$2,'Order',('0190fa91-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,
           1,('0190fa90-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,'System','{}','none','{}',
           $3::timestamptz,$3::timestamptz,$3::timestamptz,$3::timestamptz + interval '1 second',1
         FROM generate_series(1,$4::int) AS i`,
        [brand, store, at(-10 * 24 * 60 * MIN), PUBLISHED],
      );
    });
    await admin.query(
      "VACUUM ANALYZE platform_eventing.consumer_retry_schedule, platform_eventing.outbox_event",
    );

    // The pilot api role's grants on these tables (docs/spec/pilot-acl-matrix.json), nothing more.
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA platform_eventing, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON platform_eventing.dead_letter_item, platform_eventing.consumer_retry_schedule, platform_eventing.outbox_event TO ${role}`,
    );
    const asRole = (runner) => ({
      run: (work) =>
        runner.run(async (tx) => {
          await tx.query(`SET LOCAL ROLE ${role}`, []);
          return work(tx);
        }),
    });
    const resources = {
      scope: { brandReference: brand, storeReference: store },
      transactions: asRole(createTenantTransactionRunner(pool, { brandId: brand, storeId: store })),
      database: {
        transactions: (scope) =>
          asRole(createTenantTransactionRunner(pool, { brandId: scope.brandId })),
      },
    };
    const signals = await readBusinessSignals({
      resources,
      installation: {},
      now,
      settlementExceptions: { count: 0, oldestAgeMs: 0 },
      dependencies: {
        createReconciliationExceptions: () => async () => ({
          items: [],
          nextAfterExceptionReference: null,
        }),
      },
    });
    // Store: the 4-try retry and the 20-minute retry; Brand: one; outbox: 4 tries, due 15
    // minutes, and the Brand-wide one. Oldest: the retry failing for 20 minutes.
    assert.deepEqual(signals.retryingUpdates, { count: 6, oldestAgeMs: 20 * MIN });
    assert.deepEqual(signals.stuckUpdates, { count: 0, oldestAgeMs: 0 });

    // Bounded cost: both reads touch only the work still pending, not the history.
    const plan = async (sql, parameters) =>
      (
        await resources.transactions.run((tx) =>
          tx.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, parameters),
        )
      ).rows[0]["QUERY PLAN"][0];
    const measure = async (name, sql, parameters) => {
      const result = await plan(sql, parameters);
      const all = nodes(result.Plan);
      const scanned = all
        .filter((node) => /Scan/u.test(node["Node Type"]))
        .reduce((sum, node) => sum + node["Actual Rows"] * (node["Actual Loops"] ?? 1), 0);
      const removed = all.reduce(
        (sum, node) => sum + (node["Rows Removed by Filter"] ?? 0) * (node["Actual Loops"] ?? 1),
        0,
      );
      const indexes = all.map((node) => node["Index Name"]).filter(Boolean);
      // Recorded cost (WP-2423 evidence): execution time, rows visited, indexes, buffers.
      process.stdout.write(
        JSON.stringify({
          name,
          executionMs: result["Execution Time"],
          scanned,
          removed,
          indexes,
          sharedHit: result.Plan["Shared Hit Blocks"],
        }) + "\n",
      );
      return { scanned, removed, indexes };
    };
    const consumer = await measure("consumer", CONSUMER_RETRYING_SUMMARY, [
      RETRYING_UPDATE_ATTEMPTS,
      at(-RETRYING_UPDATE_AGE_MS + RETRY_HORIZON_MS),
    ]);
    assert.ok(consumer.scanned + consumer.removed <= 50, JSON.stringify(consumer));
    // Migration 2000_062: only pending retries are indexed.
    assert.ok(
      consumer.indexes.includes("consumer_retry_schedule_pending_idx"),
      JSON.stringify(consumer),
    );
    const events = await measure("outbox", OUTBOX_RETRYING_SUMMARY, [
      RETRYING_UPDATE_ATTEMPTS,
      at(-RETRYING_UPDATE_AGE_MS),
    ]);
    assert.ok(events.scanned + events.removed <= 50, JSON.stringify(events));
    // Either partial index over unpublished events (the dispatch claim index also excludes
    // dead-lettered ones, exactly this read's filter).
    assert.ok(
      events.indexes.some((name) =>
        ["outbox_event_dispatch_claim_idx", "outbox_event_publishable_idx"].includes(name),
      ),
      JSON.stringify(events),
    );
  } finally {
    await pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

it("warns about order updates still being retried, scoped and bounded under the api role grants", async () => {
  await withIsolatedDatabase({ caseId: "pilot_ops_retrying", root }, prove);
}, 300_000);
