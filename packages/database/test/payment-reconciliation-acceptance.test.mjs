import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `0198a107-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const scheduledAt = "2026-08-03T18:00:00.000Z";
const checkedAt = "2026-08-03T18:01:00.000Z";

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_payment.payment_reconciliation_run'::regclass,
         'rms_payment.payment_reconciliation_exception'::regclass,
         'rms_payment.payment_reconciliation_record'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 3);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );
    const retrievalShape = await client.query(
      `SELECT column_name,is_nullable FROM information_schema.columns
       WHERE table_schema='rms_payment' AND table_name='payment_terminal_fact'
         AND column_name IN ('causation_id','provider_event_id','webhook_receipt_id')
       ORDER BY column_name`,
    );
    assert.deepEqual(retrievalShape.rows, [
      { column_name: "causation_id", is_nullable: "NO" },
      { column_name: "provider_event_id", is_nullable: "YES" },
      { column_name: "webhook_receipt_id", is_nullable: "YES" },
    ]);

    await client.query(
      `INSERT INTO rms_payment.payment_reconciliation_run
       (reconciliation_run_id,brand_id,store_id,mode,actor_id,purpose,scheduled_at,cutoff_at,
        max_candidates,completed_at,matched_count,healed_count,unresolved_count,
        unavailable_count,difference_count)
       VALUES ($1,$2,$3,'Operational',NULL,'ReconcilePayments',$4,
        '2026-08-03T17:59:00.000Z',10,$5,0,0,0,0,1)`,
      [id(1), id(2), id(3), scheduledAt, checkedAt],
    );
    await client.query(
      `INSERT INTO rms_payment.payment_reconciliation_exception
       (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at)
       VALUES ($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)`,
      [id(5), id(2), id(3), id(4), checkedAt],
    );
    await client.query(
      `INSERT INTO rms_payment.payment_reconciliation_record
       (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
        payment_intent_id,settlement_reference,outcome,difference_reason,internal_status,
        provider_status,internal_captured_minor,provider_captured_minor,internal_refunded_minor,
        provider_refunded_minor,currency_code,reconciliation_exception_id,safe_code,checked_at)
       VALUES ($1,$2,$3,$4,$5,'Operational',$6,NULL,'Difference','AmountMismatch','Pending',
        'Captured',0,1250,0,0,'CAD',$7,NULL,$8)`,
      [id(6), id(1), id(4), id(2), id(3), id(7), id(5), checkedAt],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_reconciliation_exception
         (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at)
         VALUES ($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)`,
        [id(8), id(2), id(3), id(4), checkedAt],
      ),
      /payment_reconciliation_exception_stable_unique/u,
    );
    await client.query(
      `INSERT INTO rms_payment.payment_reconciliation_exception
       (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at)
       VALUES ($1,$2,$3,$4,'StateMismatch','Error','Open',$5)`,
      [id(11), id(2), id(3), id(10), checkedAt],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_reconciliation_record
         (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
          payment_intent_id,outcome,difference_reason,internal_status,provider_status,
          internal_captured_minor,provider_captured_minor,internal_refunded_minor,
          provider_refunded_minor,currency_code,reconciliation_exception_id,checked_at)
         VALUES ($1,$2,$3,$4,$5,'Operational',$6,'Difference','StateMismatch','Pending','Captured',
          0,1250,0,0,'CAD',$7,$8)`,
        [id(12), id(1), id(13), id(2), id(3), id(14), id(11), checkedAt],
      ),
      /payment_reconciliation_record_exception_fk/u,
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_reconciliation_record
         (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
          payment_intent_id,outcome,internal_captured_minor,provider_captured_minor,
          internal_refunded_minor,provider_refunded_minor,currency_code,checked_at)
         VALUES ($1,$2,$3,$4,$5,'DailySettlement',NULL,'Matched',1250,1250,0,0,'CAD',$6)`,
        [id(9), id(1), id(10), id(2), id(3), checkedAt],
      ),
      /payment_reconciliation_record_mode_shape_check/u,
    );
    await client.query(
      `UPDATE rms_payment.payment_reconciliation_record SET internal_captured_minor=9999
       WHERE reconciliation_check_id=$1`,
      [id(6)],
    );
    await client.query(
      `DELETE FROM rms_payment.payment_reconciliation_exception
       WHERE reconciliation_exception_id=$1`,
      [id(5)],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT internal_captured_minor::text FROM rms_payment.payment_reconciliation_record
           WHERE reconciliation_check_id=$1`,
          [id(6)],
        )
      ).rows,
      [{ internal_captured_minor: "0" }],
    );
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_payment.payment_reconciliation_exception
           WHERE reconciliation_exception_id=$1`,
          [id(5)],
        )
      ).rows[0].count,
      1,
    );
    const grants = await client.query(
      `SELECT count(*)::integer AS count FROM information_schema.table_privileges
       WHERE table_schema='rms_payment'
         AND table_name LIKE 'payment_reconciliation_%' AND grantee='PUBLIC'`,
    );
    assert.equal(grants.rows[0].count, 0);
  } finally {
    await client.end();
  }
}

it("persists immutable Store-scoped Payment reconciliation runs, checks and exceptions", async () => {
  await withIsolatedDatabase({ caseId: "payment_recon", root }, prove);
}, 180_000);
