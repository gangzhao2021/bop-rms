import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a004-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const createdAt = "2026-08-03T15:00:00.000Z";

async function insertIntent(client, overrides = {}) {
  const values = {
    intent: id(1),
    brand: id(2),
    store: id(3),
    operation: id(4),
    order: id(5),
    batch: id(6),
    submission: id(7),
    session: id(8),
    cart: id(9),
    quote: id(10),
    preparation: id(11),
    capacity: id(12),
    orderAllocation: 2000,
    tip: 200,
    total: 2200,
    ...overrides,
  };
  await client.query(
    `INSERT INTO rms_payment.payment_intent
     (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,
      submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,
      capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,
      tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,
      creation_status,prepared_at,capacity_expires_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,3,$10,$11,$12,$13,$14,$15,$16,$17,'CAD',
      'OnlineCard','Automatic',1,'ProviderCreatePending','2026-08-03T14:59:00.000Z',
      '2026-08-03T15:30:00.000Z',$18)`,
    [
      values.intent,
      values.brand,
      values.store,
      values.operation,
      values.order,
      values.batch,
      values.submission,
      values.session,
      values.cart,
      values.quote,
      values.preparation,
      values.capacity,
      sha("a"),
      sha("b"),
      values.orderAllocation,
      values.tip,
      values.total,
      createdAt,
    ],
  );
  return values;
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_payment.payment_intent'::regclass,
         'rms_payment.payment_attempt'::regclass,
         'rms_payment.payment_intent_operation_record'::regclass,
         'rms_payment.payment_provider_observation'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 4);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await client.query("BEGIN");
    const values = await insertIntent(client);
    await client.query(
      `INSERT INTO rms_payment.payment_attempt
       (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,
        provider_environment,provider_idempotency_digest,created_at)
       VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)`,
      [id(20), values.brand, values.store, values.intent, sha("c"), createdAt],
    );
    await client.query(
      `INSERT INTO rms_payment.payment_intent_operation_record
       (payment_operation_id,brand_id,store_id,payment_intent_id,guest_session_id,intent_digest,
        created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [
        values.operation,
        values.brand,
        values.store,
        values.intent,
        values.session,
        sha("a"),
        createdAt,
      ],
    );
    await client.query(
      `INSERT INTO rms_payment.payment_provider_observation
       (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,
        observation_kind,normalized_status,provider_intent_reference,
        provider_transaction_reference,requested_minor,authorized_minor,captured_minor,
        refunded_minor,currency_code,evidence_digest,failure_code,retry_disposition,
        safe_reason_code,provider_observed_at,recorded_at)
       VALUES ($1,$2,$3,$4,$5,'Snapshot','RequiresCustomerAction','pi_SYNTHETIC_1302',NULL,
        2200,0,0,0,'CAD',$6,NULL,NULL,NULL,$7,$7)`,
      [id(21), values.brand, values.store, values.intent, id(20), sha("d"), createdAt],
    );
    await client.query("COMMIT");

    const stored = await client.query(
      `SELECT intent.total_minor::text,attempt.attempt_number,operation.intent_digest,
       observation.normalized_status
       FROM rms_payment.payment_intent AS intent
       JOIN rms_payment.payment_attempt AS attempt USING (payment_intent_id,brand_id,store_id)
       JOIN rms_payment.payment_intent_operation_record AS operation
         USING (payment_intent_id,brand_id,store_id)
       JOIN rms_payment.payment_provider_observation AS observation
         USING (payment_intent_id,brand_id,store_id)
       WHERE intent.payment_intent_id=$1`,
      [values.intent],
    );
    assert.deepEqual(stored.rows, [
      {
        total_minor: "2200",
        attempt_number: 1,
        intent_digest: sha("a"),
        normalized_status: "RequiresCustomerAction",
      },
    ]);

    await assert.rejects(
      insertIntent(client, { intent: id(30), preparation: id(31), total: 2201 }),
      /violates check constraint/u,
    );
    await assert.rejects(
      insertIntent(client, { intent: id(32), preparation: id(33) }),
      /payment_intent_operation_unique/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_provider_observation
         (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,
          observation_kind,failure_code,retry_disposition,safe_reason_code,recorded_at)
         VALUES ($1,$2,$3,$4,$5,'Failure','Unknown','Unknown','raw provider message',$6)`,
        [id(40), values.brand, values.store, values.intent, id(20), createdAt],
      ),
      /safe_reason_code_check/u,
    );
    await client.query(
      `INSERT INTO rms_payment.payment_provider_observation
       (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,
        observation_kind,failure_code,retry_disposition,safe_reason_code,recorded_at)
       VALUES ($1,$2,$3,$4,$5,'Failure','Unknown','Unknown','CREATE_RESULT_UNKNOWN',$6)`,
      [id(41), values.brand, values.store, values.intent, id(20), createdAt],
    );

    await client.query(
      `UPDATE rms_payment.payment_intent SET total_minor=9999 WHERE payment_intent_id=$1`,
      [values.intent],
    );
    assert.equal(
      (
        await client.query(
          `SELECT total_minor::text FROM rms_payment.payment_intent WHERE payment_intent_id=$1`,
          [values.intent],
        )
      ).rows[0].total_minor,
      "2200",
    );
    await client.query(`DELETE FROM rms_payment.payment_attempt WHERE payment_attempt_id=$1`, [
      id(20),
    ]);
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_payment.payment_attempt WHERE payment_attempt_id=$1`,
          [id(20)],
        )
      ).rows[0].count,
      1,
    );

    const prohibitedColumns = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema='rms_payment'
         AND column_name = ANY($1::text[])`,
      [["raw_payload", "client_secret", "pan", "cvv", "card_fingerprint", "provider_message"]],
    );
    assert.deepEqual(prohibitedColumns.rows, []);
    const publicGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_payment' AND grantee='PUBLIC'`,
    );
    assert.equal(publicGrants.rows[0].count, 0);
  } finally {
    await client.end();
  }
}

it("persists one immutable Payment Intent/Attempt claim and normalized observations", async () => {
  await withIsolatedDatabase({ caseId: "payment_intent", root }, prove);
}, 180_000);
