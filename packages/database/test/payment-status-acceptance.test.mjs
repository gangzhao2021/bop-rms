import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a106-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const at = "2026-08-03T18:00:00.000Z";

async function seedTerminalFact(client) {
  await client.query(
    `INSERT INTO rms_payment.payment_intent
     (payment_intent_id,brand_id,store_id,payment_operation_id,order_id,order_batch_id,
      submission_id,guest_session_id,source_cart_id,source_cart_version,quote_id,preparation_id,
      capacity_allocation_id,intent_digest,preparation_source_digest,order_allocation_minor,
      tip_minor,total_minor,currency_code,payment_method,capture_mode,aggregate_version,
      creation_status,prepared_at,capacity_expires_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,1,$10,$11,$12,$13,$14,1200,50,1250,'CAD',
      'OnlineCard','Automatic',1,'ProviderCreatePending','2026-08-03T17:59:00.000Z',
      '2026-08-03T18:30:00.000Z',$15)`,
    [
      id(10),
      id(1),
      id(2),
      id(3),
      id(4),
      id(5),
      id(6),
      id(7),
      id(8),
      id(9),
      id(11),
      id(12),
      sha("a"),
      sha("b"),
      at,
    ],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_attempt
     (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,
      provider_environment,provider_idempotency_digest,created_at)
     VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)`,
    [id(20), id(1), id(2), id(10), sha("c"), at],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_provider_observation
     (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,
      observation_kind,normalized_status,provider_intent_reference,
      provider_transaction_reference,requested_minor,authorized_minor,captured_minor,
      refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at)
     VALUES ($1,$2,$3,$4,$5,'Snapshot','Captured','pi_SYNTHETIC_1306','ch_SYNTHETIC_1306',
      1250,1250,1250,0,'CAD',$6,$7,$7)`,
    [id(21), id(1), id(2), id(10), id(20), sha("d"), at],
  );
  await client.query(
    `INSERT INTO rms_payment.provider_webhook_record
     (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,
      provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,
      evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at)
     VALUES ($1,$2,$3,'Stripe','Test',$4,'evt_SYNTHETIC13060000','payment_intent.succeeded',
      '2026-08-03T17:55:00.000Z',$5,'2026-08-03T17:59:59.000Z',$6,$5,
      '2026-09-02T18:00:00.000Z','2026-11-01T18:00:00.000Z')`,
    [id(22), id(1), id(2), id(23), at, sha("e")],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_terminal_fact
     (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,
      webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,
      provider_intent_reference,provider_observation_id,authoritative_source,terminal_outcome,
      amount_minor,currency_code,occurred_at,recorded_at,evidence_digest,event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'evt_SYNTHETIC13060000',$8,'Test','pi_SYNTHETIC_1306',
      $9,'VerifiedWebhook','Succeeded',1250,'CAD',$10,$10,$11,$12)`,
    [id(30), id(1), id(2), id(10), id(20), id(4), id(22), id(23), id(21), at, sha("f"), id(31)],
  );
}

async function insertProjection(client, generation, active, freshness = "Fresh") {
  await client.query(
    `INSERT INTO rms_payment.payment_status_projection
     (projection_generation_id,brand_id,store_id,payment_intent_id,payment_transaction_id,
      payment_attempt_id,order_id,terminal_status,amount_minor,currency_code,
      terminal_occurred_at,source_event_id,source_aggregate_version,projection_name,
      projection_version,projected_at,last_rebuilt_at,freshness_status,is_active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'Succeeded',1250,'CAD',$8,$9,2,
      'payment_status_v1',1,$8,$8,$10,$11)`,
    [generation, id(1), id(2), id(10), id(30), id(20), id(4), at, id(31), freshness, active],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relforcerowsecurity FROM pg_class
       WHERE oid='rms_payment.payment_status_projection'::regclass`,
    );
    assert.equal(forced.rows[0].relforcerowsecurity, true);
    await seedTerminalFact(client);
    await insertProjection(client, id(40), true);
    await assert.rejects(
      insertProjection(client, id(41), true),
      /payment_status_projection_active_intent_unique/u,
    );
    await insertProjection(client, id(41), false, "Rebuilding");

    await client.query("BEGIN");
    await client.query(
      `UPDATE rms_payment.payment_status_projection SET is_active=false
       WHERE brand_id=$1 AND store_id=$2 AND is_active`,
      [id(1), id(2)],
    );
    await client.query(
      `UPDATE rms_payment.payment_status_projection SET is_active=true,freshness_status='Fresh'
       WHERE projection_generation_id=$1`,
      [id(41)],
    );
    await client.query("COMMIT");
    assert.deepEqual(
      (
        await client.query(
          `SELECT projection_generation_id,freshness_status FROM rms_payment.payment_status_projection
           WHERE is_active`,
        )
      ).rows,
      [{ projection_generation_id: id(41), freshness_status: "Fresh" }],
    );
    await assert.rejects(
      client.query(
        `UPDATE rms_payment.payment_status_projection SET amount_minor=9999
         WHERE projection_generation_id=$1`,
        [id(41)],
      ),
      /payment status projection snapshot is immutable/u,
    );
    const grants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_payment' AND table_name='payment_status_projection'
         AND grantee='PUBLIC'`,
    );
    assert.equal(grants.rows[0].count, 0);
  } finally {
    await client.end();
  }
}

it("persists a Store-scoped shadow generation and atomically switches active status", async () => {
  await withIsolatedDatabase({ caseId: "payment_status", root }, prove);
}, 180_000);
