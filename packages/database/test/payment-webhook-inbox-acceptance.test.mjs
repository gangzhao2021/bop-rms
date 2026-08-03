import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a005-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const sha = (character) => `sha256:${character.repeat(64)}`;
const acceptedAt = "2026-04-01T15:00:00.000Z";
const rawExpiresAt = "2026-05-01T15:00:00.000Z";
const dedupeExpiresAt = "2026-06-30T15:00:00.000Z";

async function insertReceipt(client, overrides = {}) {
  const value = {
    receipt: id(1),
    brand: id(2),
    store: id(3),
    account: id(4),
    event: "evt_SYNTHETIC1304",
    digest: sha("a"),
    providerCreatedAt: "2026-04-01T14:55:00.000Z",
    receivedAt: acceptedAt,
    signatureTimestamp: "2026-04-01T14:59:59.000Z",
    rawExpiresAt,
    dedupeExpiresAt,
    ...overrides,
  };
  await client.query(
    `INSERT INTO rms_payment.provider_webhook_record
     (webhook_receipt_id,brand_id,store_id,provider,provider_environment,
     provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,
      signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at)
     VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.succeeded',
      $6,$7,$8,$9,$7,$10,$11)`,
    [
      value.receipt,
      value.brand,
      value.store,
      value.account,
      value.event,
      value.providerCreatedAt,
      value.receivedAt,
      value.signatureTimestamp,
      value.digest,
      value.rawExpiresAt,
      value.dedupeExpiresAt,
    ],
  );
  await client.query(
    `INSERT INTO rms_payment.provider_webhook_raw_evidence
     (webhook_receipt_id,brand_id,store_id,evidence_digest,raw_evidence,expires_at)
     VALUES ($1,$2,$3,$4,decode('7b7d','hex'),$5)`,
    [value.receipt, value.brand, value.store, value.digest, value.rawExpiresAt],
  );
  return value;
}

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_payment.provider_webhook_record'::regclass,
         'rms_payment.provider_webhook_raw_evidence'::regclass,
         'rms_payment.provider_webhook_processing_record'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 3);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await client.query("BEGIN");
    const value = await insertReceipt(client);
    await client.query(
      `INSERT INTO rms_payment.provider_webhook_processing_record
       (webhook_receipt_id,brand_id,store_id,consumer_name,processed_at,result_digest)
       VALUES ($1,$2,$3,'payment.provider-webhook.v1','2026-04-01T15:01:00.000Z',$4)`,
      [value.receipt, value.brand, value.store, sha("b")],
    );
    await client.query("COMMIT");

    const stored = await client.query(
      `SELECT receipt.provider_event_id,octet_length(raw.raw_evidence) AS raw_size,
       processing.consumer_name,receipt.raw_evidence_expires_at - receipt.accepted_at AS raw_ttl,
       receipt.dedupe_expires_at - receipt.accepted_at AS dedupe_ttl
       FROM rms_payment.provider_webhook_record AS receipt
       JOIN rms_payment.provider_webhook_raw_evidence AS raw
         USING (webhook_receipt_id,brand_id,store_id)
       JOIN rms_payment.provider_webhook_processing_record AS processing
         USING (webhook_receipt_id,brand_id,store_id)
       WHERE receipt.webhook_receipt_id=$1`,
      [value.receipt],
    );
    assert.equal(stored.rows.length, 1);
    assert.equal(stored.rows[0].provider_event_id, value.event);
    assert.equal(stored.rows[0].raw_size, 2);
    assert.equal(stored.rows[0].consumer_name, "payment.provider-webhook.v1");
    assert.equal(stored.rows[0].raw_ttl.days, 30);
    assert.equal(stored.rows[0].dedupe_ttl.days, 90);

    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.provider_webhook_record
         (webhook_receipt_id,brand_id,store_id,provider,provider_environment,
          provider_account_id,provider_event_id,provider_event_type,provider_created_at,received_at,
          signature_timestamp,evidence_digest,accepted_at,raw_evidence_expires_at,dedupe_expires_at)
         VALUES ($1,$2,$3,'Stripe','Test',$4,$5,'payment_intent.failed',
          '2026-04-01T14:55:00.000Z',$6,'2026-04-01T14:59:59.000Z',$7,$6,$8,$9)`,
        [
          id(10),
          value.brand,
          value.store,
          value.account,
          value.event,
          acceptedAt,
          sha("c"),
          rawExpiresAt,
          dedupeExpiresAt,
        ],
      ),
      /provider_webhook_record_provider_event_unique/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.provider_webhook_processing_record
         (webhook_receipt_id,brand_id,store_id,consumer_name,processed_at,result_digest)
         VALUES ($1,$2,$3,'payment.provider-webhook.v1','2026-04-01T15:02:00.000Z',$4)`,
        [value.receipt, value.brand, value.store, sha("d")],
      ),
      /provider_webhook_processing_record_pkey/u,
    );

    await client.query(
      `UPDATE rms_payment.provider_webhook_record SET provider_event_type='payment_intent.failed'
       WHERE webhook_receipt_id=$1`,
      [value.receipt],
    );
    assert.equal(
      (
        await client.query(
          `SELECT provider_event_type FROM rms_payment.provider_webhook_record
           WHERE webhook_receipt_id=$1`,
          [value.receipt],
        )
      ).rows[0].provider_event_type,
      "payment_intent.succeeded",
    );
    await client.query(
      `DELETE FROM rms_payment.provider_webhook_processing_record WHERE webhook_receipt_id=$1`,
      [value.receipt],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_payment.provider_webhook_processing_record
           WHERE webhook_receipt_id=$1`,
          [value.receipt],
        )
      ).rows[0].count,
      1,
    );

    await client.query(
      `DELETE FROM rms_payment.provider_webhook_raw_evidence WHERE webhook_receipt_id=$1`,
      [value.receipt],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_payment.provider_webhook_raw_evidence
           WHERE webhook_receipt_id=$1`,
          [value.receipt],
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_payment.provider_webhook_record
           WHERE webhook_receipt_id=$1`,
          [value.receipt],
        )
      ).rows[0].count,
      1,
    );

    const future = await insertReceipt(client, {
      receipt: id(20),
      event: "evt_SYNTHETIC1305",
      digest: sha("e"),
      providerCreatedAt: "2026-08-03T16:55:00.000Z",
      receivedAt: "2026-08-03T17:00:00.000Z",
      signatureTimestamp: "2026-08-03T16:59:59.000Z",
      rawExpiresAt: "2026-09-02T17:00:00.000Z",
      dedupeExpiresAt: "2026-11-01T17:00:00.000Z",
    });
    await client.query(
      `DELETE FROM rms_payment.provider_webhook_raw_evidence WHERE webhook_receipt_id=$1`,
      [future.receipt],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_payment.provider_webhook_raw_evidence
           WHERE webhook_receipt_id=$1`,
          [future.receipt],
        )
      ).rows[0].count,
      1,
    );

    const publicGrants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_payment' AND table_name LIKE 'provider_webhook_%'
         AND grantee='PUBLIC'`,
    );
    assert.equal(publicGrants.rows[0].count, 0);
  } finally {
    await client.end();
  }
}

it("accepts one immutable webhook receipt, dedupe marker and bounded raw evidence", async () => {
  await withIsolatedDatabase({ caseId: "webhook_inbox", root }, prove);
}, 180_000);
