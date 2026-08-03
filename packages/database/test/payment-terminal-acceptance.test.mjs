import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a006-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const occurredAt = "2026-08-03T18:00:00.000Z";

async function insertSource(client, offset, eventType) {
  const value = {
    intent: id(offset + 1),
    brand: id(2),
    store: id(3),
    operation: id(offset + 4),
    order: id(offset + 5),
    batch: id(offset + 6),
    submission: id(offset + 7),
    session: id(offset + 8),
    cart: id(offset + 9),
    quote: id(offset + 10),
    preparation: id(offset + 11),
    capacity: id(offset + 12),
    attempt: id(offset + 20),
    observation: id(offset + 21),
    receipt: id(offset + 22),
    account: id(30),
    event: `evt_SYNTHETIC${offset.toString().padStart(8, "0")}`,
  };
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
      value.intent,
      value.brand,
      value.store,
      value.operation,
      value.order,
      value.batch,
      value.submission,
      value.session,
      value.cart,
      value.quote,
      value.preparation,
      value.capacity,
      sha("a"),
      sha("b"),
      occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_attempt
     (payment_attempt_id,brand_id,store_id,payment_intent_id,attempt_number,provider,
      provider_environment,provider_idempotency_digest,created_at)
     VALUES ($1,$2,$3,$4,1,'Stripe','Test',$5,$6)`,
    [value.attempt, value.brand, value.store, value.intent, sha("c"), occurredAt],
  );
  await client.query(
    `INSERT INTO rms_payment.payment_provider_observation
     (provider_observation_id,brand_id,store_id,payment_intent_id,payment_attempt_id,
      observation_kind,normalized_status,provider_intent_reference,
      provider_transaction_reference,requested_minor,authorized_minor,captured_minor,
      refunded_minor,currency_code,evidence_digest,provider_observed_at,recorded_at)
     VALUES ($1,$2,$3,$4,$5,'Snapshot',$6,$7,$8,1250,1250,$9,0,'CAD',$10,$11,$11)`,
    [
      value.observation,
      value.brand,
      value.store,
      value.intent,
      value.attempt,
      eventType === "payment_intent.succeeded" ? "Captured" : "Failed",
      `pi_SYNTHETIC_${offset}`,
      eventType === "payment_intent.succeeded" ? `ch_SYNTHETIC_${offset}` : null,
      eventType === "payment_intent.succeeded" ? 1250 : 0,
      sha("d"),
      occurredAt,
    ],
  );
  await client.query(
    `INSERT INTO rms_payment.provider_webhook_record
     (webhook_receipt_id,brand_id,store_id,provider,provider_environment,provider_account_id,
      provider_event_id,provider_event_type,provider_created_at,received_at,signature_timestamp,
      evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at)
     VALUES ($1,$2,$3,'Stripe','Test',$4,$5,$6,'2026-08-03T17:55:00.000Z',$7,
      '2026-08-03T17:59:59.000Z',$8,$7,'2026-09-02T18:00:00.000Z',
      '2026-11-01T18:00:00.000Z')`,
    [
      value.receipt,
      value.brand,
      value.store,
      value.account,
      value.event,
      eventType,
      occurredAt,
      sha("e"),
    ],
  );
  return value;
}

async function insertFact(client, value, outcome, transaction, event) {
  await client.query(
    `INSERT INTO rms_payment.payment_terminal_fact
     (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,
      webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,
      provider_intent_reference,
      provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,
      failure_reason,retry_disposition,occurred_at,recorded_at,evidence_digest,event_id,causation_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test',$10,$11,'VerifiedWebhook',$12,$13,$14,$15,$16,
      $17,$17,$18,$19,$20)`,
    [
      transaction,
      value.brand,
      value.store,
      value.intent,
      value.attempt,
      value.order,
      value.receipt,
      value.event,
      value.account,
      `pi_SYNTHETIC_${outcome === "Succeeded" ? 100 : 200}`,
      value.observation,
      outcome,
      outcome === "Succeeded" ? 1250 : null,
      outcome === "Succeeded" ? "CAD" : null,
      outcome === "Failed" ? "Declined" : null,
      outcome === "Failed" ? "NewOperation" : null,
      occurredAt,
      sha("f"),
      event,
      value.receipt,
    ],
  );
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relforcerowsecurity FROM pg_class
       WHERE oid='rms_payment.payment_terminal_fact'::regclass`,
    );
    assert.equal(forced.rows[0].relforcerowsecurity, true);

    const success = await insertSource(client, 100, "payment_intent.succeeded");
    await insertFact(client, success, "Succeeded", id(140), id(141));
    const failed = await insertSource(client, 200, "payment_intent.payment_failed");
    await insertFact(client, failed, "Failed", id(240), id(241));

    const stored = await client.query(
      `SELECT terminal_outcome,amount_minor::text,currency_code,failure_reason,retry_disposition
       FROM rms_payment.payment_terminal_fact ORDER BY terminal_outcome`,
    );
    assert.deepEqual(stored.rows, [
      {
        terminal_outcome: "Failed",
        amount_minor: null,
        currency_code: null,
        failure_reason: "Declined",
        retry_disposition: "NewOperation",
      },
      {
        terminal_outcome: "Succeeded",
        amount_minor: "1250",
        currency_code: "CAD",
        failure_reason: null,
        retry_disposition: null,
      },
    ]);

    await assert.rejects(
      insertFact(client, success, "Succeeded", id(142), id(143)),
      /payment_terminal_fact_(?:intent|attempt|observation|receipt)_terminal_unique|payment_terminal_fact_intent_terminal_unique/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_terminal_fact
         (payment_transaction_id,brand_id,store_id,payment_intent_id,payment_attempt_id,order_id,
          webhook_receipt_id,provider_event_id,provider_account_id,provider_environment,
          provider_intent_reference,
          provider_observation_id,authoritative_source,terminal_outcome,amount_minor,currency_code,
          occurred_at,recorded_at,evidence_digest,event_id,causation_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'Test','pi_SYNTHETIC_100',$10,'VerifiedWebhook',
          'Succeeded',1249,'CAD',$11,$11,$12,$13,$7)`,
        [
          id(144),
          success.brand,
          success.store,
          success.intent,
          success.attempt,
          success.order,
          success.receipt,
          success.event,
          success.account,
          success.observation,
          occurredAt,
          sha("f"),
          id(145),
        ],
      ),
      /payment_terminal_fact_/u,
    );

    await client.query(
      `UPDATE rms_payment.payment_terminal_fact SET amount_minor=9999
       WHERE payment_transaction_id=$1`,
      [id(140)],
    );
    await client.query(
      `DELETE FROM rms_payment.payment_terminal_fact WHERE payment_transaction_id=$1`,
      [id(140)],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT amount_minor::text FROM rms_payment.payment_terminal_fact
           WHERE payment_transaction_id=$1`,
          [id(140)],
        )
      ).rows,
      [{ amount_minor: "1250" }],
    );

    const grants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_payment' AND table_name='payment_terminal_fact'
         AND grantee='PUBLIC'`,
    );
    assert.equal(grants.rows[0].count, 0);
  } finally {
    await client.end();
  }
}

it("persists one append-only Store-scoped Payment terminal fact", async () => {
  await withIsolatedDatabase({ caseId: "payment_terminal", root }, prove);
}, 180_000);
