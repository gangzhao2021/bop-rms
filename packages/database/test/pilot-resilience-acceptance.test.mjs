// WP-2423 pilot resilience (2026-10-15) acceptance on a real isolated PostgreSQL:
//  1. a checked-out connection the server terminates (57P01, 25P03 idle-in-transaction timeout)
//     fails only its own transaction with a connection-loss SQLSTATE; the process keeps running
//     (vitest fails the run on an unhandled 'error') and the pool serves the next transaction;
//  2. the payment Snapshot reads used by receipt coverage and the compensation source stay bounded
//     with 200k append-only observations of one attempt, under a NOBYPASSRLS role.
import assert from "node:assert/strict";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { createTenantTransactionRunner } from "../src/transaction-runner.ts";
import {
  paymentSnapshotCountSql,
  paymentSnapshotMaximumRefundedSql,
} from "../../rms/payment/src/infrastructure/persistence/payment-receipt-coverage-source.ts";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client, Pool } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => "0190fa99-0000-7000-8000-" + String(n).padStart(12, "0");
const brand = id(1),
  store = id(2),
  intent = id(3),
  attempt = id(4);
const digest = "sha256:" + "a".repeat(64);
const OBSERVATIONS = 200_000;
// The receipt coverage head read (payment-receipt-coverage-source.ts), with its bounded maximum.
const headSql =
  "SELECT provider_observation_id,normalized_status,refunded_minor::text," +
  "(" +
  paymentSnapshotMaximumRefundedSql +
  ")::text AS maximum_refunded_minor,provider_observed_at FROM rms_payment.payment_provider_observation " +
  "WHERE brand_id=$1 AND store_id=$2 AND payment_intent_id=$3 AND payment_attempt_id=$4 AND observation_kind='Snapshot' " +
  "ORDER BY provider_observed_at DESC,recorded_at DESC,provider_observation_id DESC LIMIT 2";
const windowSql = headSql.replace(
  "(" + paymentSnapshotMaximumRefundedSql + ")::text",
  "(max(refunded_minor) OVER ())::text",
);

function nodes(plan) {
  return [plan, ...(plan.Plans ?? []).flatMap(nodes)];
}

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_resilience_${context.runId}`;
  await admin.connect();
  const pool = new Pool({
    ...context.clientConfig,
    max: 2,
    connectionTimeoutMillis: 2000,
    query_timeout: 10_000,
  });
  // Only the pool-level idle listener (as before the fix): checked-out clients are the runner's job.
  const poolErrors = [];
  pool.on("error", (error) => poolErrors.push(error.code ?? null));
  try {
    const runner = createTenantTransactionRunner(pool, { brandId: brand, storeId: store });

    // 1a. Backend terminated while the transaction is idle between queries.
    await assert.rejects(
      runner.run(async (tx) => {
        const { rows } = await tx.query("SELECT pg_backend_pid() AS pid", []);
        await admin.query("SELECT pg_terminate_backend($1)", [rows[0].pid]);
        await delay(300); // the FATAL arrives on a checked-out, idle client
        await tx.query("SELECT 1", []);
      }),
      (error) =>
        error.code === "TENANT_DATABASE_TRANSACTION_FAILED" &&
        ["57P01", "08006"].includes(error.diagnostic?.sqlState),
    );
    assert.equal((await runner.run(async (tx) => tx.query("SELECT 1 AS one", []))).rows[0].one, 1);

    // 1b. Idle-in-transaction timeout (25P03) while application code awaits something else.
    await assert.rejects(
      runner.run(async (tx) => {
        await tx.query("SET LOCAL idle_in_transaction_session_timeout = '200ms'", []);
        await delay(700);
        await tx.query("SELECT 1", []);
      }),
      (error) =>
        error.code === "TENANT_DATABASE_TRANSACTION_FAILED" &&
        ["25P03", "08006"].includes(error.diagnostic?.sqlState),
    );
    assert.equal((await runner.run(async (tx) => tx.query("SELECT 2 AS two", []))).rows[0].two, 2);

    // 1c. WP-2423 (v15 2026-10-17): the host stalls after the last query, so the server ends the
    // idle transaction before COMMIT. The COMMIT failure keeps a connection-loss SQLSTATE (it was
    // reported without one and paged staff as "needs a person").
    await assert.rejects(
      runner.run(async (tx) => {
        await tx.query("SET LOCAL idle_in_transaction_session_timeout = '200ms'", []);
        await delay(700);
      }),
      (error) =>
        error.code === "TENANT_DATABASE_TRANSACTION_FAILED" &&
        ["25P03", "08006", "57P01"].includes(error.diagnostic?.sqlState),
    );
    assert.equal(
      (await runner.run(async (tx) => tx.query("SELECT 3 AS three", []))).rows[0].three,
      3,
    );

    // 2. Bounded Snapshot reads with many observations of one attempt.
    const created = "2026-10-01T12:00:00.000Z";
    // Setup writes as the owner, scoped like the owner modules (tables force row-level security).
    await admin.query(
      "SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)",
      [brand, store],
    );
    await admin.query(
      `INSERT INTO rms_payment.payment_intent (payment_intent_id,brand_id,store_id,payment_operation_id,
         order_id,order_batch_id,submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,
         preparation_id,capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,
         tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,creation_status,
         prepared_at,capacity_expires_at,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$13,1000,130,1130,'CAD','OnlineCard',
         'Automatic',1,'ProviderCreatePending',$14,$14::timestamptz + interval '30 minutes',$14)`,
      [
        intent,
        brand,
        store,
        id(5),
        id(6),
        id(7),
        id(8),
        id(9),
        id(10),
        id(11),
        id(12),
        id(13),
        digest,
        created,
      ],
    );
    await admin.query(
      `INSERT INTO rms_payment.payment_attempt (payment_attempt_id,brand_id,store_id,payment_intent_id,
         attempt_number,provider,provider_environment,provider_idempotency_digest,created_at)
       VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)`,
      [attempt, brand, store, intent, digest, created],
    );
    // Rows 1..N one millisecond apart; one middle row carries the highest refunded amount.
    await admin.query(
      `INSERT INTO rms_payment.payment_provider_observation (provider_observation_id,brand_id,store_id,
         payment_intent_id,payment_attempt_id,observation_kind,normalized_status,provider_intent_reference,
         requested_minor,authorized_minor,captured_minor,refunded_minor,currency_code,evidence_digest,
         provider_observed_at,recorded_at)
       SELECT ('0190fa98-0000-7000-8000-' || lpad(to_hex(i),12,'0'))::uuid,$1,$2,$3,$4,'Snapshot','Captured',
         'pi_simulated_resilience',1130,1130,1130,CASE WHEN i = $6 THEN 700 ELSE 0 END,'CAD',$5,
         $7::timestamptz + i * interval '1 millisecond',$7::timestamptz + i * interval '1 millisecond'
       FROM generate_series(1,$8::int) AS i`,
      [brand, store, intent, attempt, digest, 77_777, created, OBSERVATIONS],
    );
    await admin.query("VACUUM ANALYZE rms_payment.payment_provider_observation");
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_payment, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON rms_payment.payment_provider_observation TO ${role}`);

    const asRole = (work) =>
      runner.run(async (tx) => {
        await tx.query(`SET LOCAL ROLE ${role}`, []);
        return work(tx);
      });
    const values = [brand, store, intent, attempt];
    const head = await asRole((tx) => tx.query(headSql, values));
    assert.deepEqual(
      head.rows.map((row) => [row.provider_observation_id, row.maximum_refunded_minor]),
      [
        ["0190fa98-0000-7000-8000-" + OBSERVATIONS.toString(16).padStart(12, "0"), "700"],
        ["0190fa98-0000-7000-8000-" + (OBSERVATIONS - 1).toString(16).padStart(12, "0"), "700"],
      ],
    );
    const count = await asRole((tx) => tx.query(paymentSnapshotCountSql, values));
    assert.equal(Number(count.rows[0].count), OBSERVATIONS);
    // Another Store sees nothing under row-level security.
    const foreign = createTenantTransactionRunner(pool, { brandId: brand, storeId: id(99) });
    const hidden = await foreign.run(async (tx) => {
      await tx.query(`SET LOCAL ROLE ${role}`, []);
      return tx.query(headSql, [brand, id(99), intent, attempt]);
    });
    assert.equal(hidden.rows.length, 0);

    const plan = async (sql) =>
      (await asRole((tx) => tx.query("EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) " + sql, values)))
        .rows[0]["QUERY PLAN"][0].Plan;
    const bounded = nodes(await plan(headSql));
    assert.equal(
      bounded.some((node) => ["WindowAgg", "Sort"].includes(node["Node Type"])),
      false,
    );
    const scanned = bounded
      .filter((node) => /Scan/u.test(node["Node Type"]))
      .reduce((sum, node) => sum + node["Actual Rows"] * (node["Actual Loops"] ?? 1), 0);
    assert.ok(scanned <= 10, `bounded head read scanned ${scanned} rows`);
    assert.ok(
      bounded.some(
        (node) => node["Index Name"] === "payment_provider_observation_snapshot_latest_idx",
      ),
    );
    assert.ok(
      bounded.some(
        (node) => node["Index Name"] === "payment_provider_observation_snapshot_refunded_idx",
      ),
    );
    // The replaced window read had to visit every observation of the attempt.
    const window = nodes(await plan(windowSql));
    assert.ok(window.some((node) => node["Node Type"] === "WindowAgg"));
    assert.ok(
      window.some((node) => /Scan/u.test(node["Node Type"]) && node["Actual Rows"] >= OBSERVATIONS),
    );
    // The compensation source version counts observations (one aggregate, no sort or window);
    // it stays proportional to one attempt's rows, which the receipt repair no longer grows.
    const counted = nodes(await plan(paymentSnapshotCountSql));
    assert.equal(
      counted.some((node) => ["WindowAgg", "Sort"].includes(node["Node Type"])),
      false,
    );
  } finally {
    await pool.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
  }
}

it("survives terminated connections and keeps payment observation reads bounded", async () => {
  await withIsolatedDatabase({ caseId: "pilot_resilience", root }, prove);
}, 300_000);
