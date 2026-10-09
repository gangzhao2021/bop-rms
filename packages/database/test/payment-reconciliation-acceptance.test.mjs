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
      `INSERT INTO rms_payment.payment_reconciliation_run
       (reconciliation_run_id,brand_id,store_id,mode,actor_id,purpose,scheduled_at,cutoff_at,
        max_candidates,completed_at,matched_count,healed_count,unresolved_count,unavailable_count,difference_count)
       VALUES ($1,$2,$3,'DailySettlement',NULL,'ReconcilePayments',$4,$4,10,$5,1,0,0,0,0)`,
      [id(20), id(2), id(3), scheduledAt, checkedAt],
    );
    await client.query(
      `INSERT INTO rms_payment.payment_reconciliation_record
       (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
        settlement_reference,outcome,internal_captured_minor,provider_captured_minor,
        internal_refunded_minor,provider_refunded_minor,currency_code,checked_at)
       VALUES ($1,$2,$3,$4,$5,'DailySettlement','set_SYNTHETIC_REFUNDONLY','Matched',0,0,1250,1250,'CAD',$6)`,
      [id(21), id(20), id(22), id(2), id(3), checkedAt],
    );
    assert.deepEqual(
      (
        await client.query(
          `SELECT internal_captured_minor::text,internal_refunded_minor::text
       FROM rms_payment.payment_reconciliation_record WHERE reconciliation_check_id=$1`,
          [id(21)],
        )
      ).rows,
      [{ internal_captured_minor: "0", internal_refunded_minor: "1250" }],
    );
    await assert.rejects(
      client.query(
        `INSERT INTO rms_payment.payment_reconciliation_record
       (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
        payment_intent_id,internal_status,provider_status,outcome,internal_captured_minor,
        provider_captured_minor,internal_refunded_minor,provider_refunded_minor,currency_code,checked_at)
       VALUES ($1,$2,$3,$4,$5,'Operational',$6,'Captured','Captured','Matched',0,0,1250,1250,'CAD',$7)`,
        [id(23), id(1), id(24), id(2), id(3), id(25), checkedAt],
      ),
      /payment_reconciliation_record_amount_check/u,
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

it("reads one business day's runs and unmatched checks through the settlement window source", async () => {
  await withIsolatedDatabase({ caseId: "payment_recon_window", root }, async (context) => {
    const { createPostgresPaymentReconciliationWindowSource } =
      await import("../../rms/payment/src/infrastructure/persistence/payment-reconciliation-window-source.ts");
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      const startsAt = "2026-08-03T08:00:00.000Z",
        endsAt = "2026-08-04T08:00:00.000Z";
      const run = (reference, mode, cutoffAt, difference) =>
        client.query(
          `INSERT INTO rms_payment.payment_reconciliation_run
           (reconciliation_run_id,brand_id,store_id,mode,actor_id,purpose,scheduled_at,cutoff_at,
            max_candidates,completed_at,matched_count,healed_count,unresolved_count,unavailable_count,difference_count)
           VALUES ($1,$2,$3,$4,NULL,'ReconcilePayments',$5,$5,10,$5,3,0,0,0,$6)`,
          [reference, id(2), id(3), mode, cutoffAt, difference],
        );
      await run(id(30), "DailySettlement", endsAt, 1);
      await run(id(31), "Operational", "2026-08-04T09:00:00.000Z", 0);
      await client.query(
        `INSERT INTO rms_payment.payment_reconciliation_exception
         (reconciliation_exception_id,brand_id,store_id,candidate_id,reason,severity,status,opened_at)
         VALUES ($1,$2,$3,$4,'RefundMismatch','Error','Open',$5)`,
        [id(32), id(2), id(3), id(33), endsAt],
      );
      await client.query(
        `INSERT INTO rms_payment.payment_reconciliation_record
         (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
          settlement_reference,outcome,difference_reason,internal_captured_minor,provider_captured_minor,
          internal_refunded_minor,provider_refunded_minor,currency_code,reconciliation_exception_id,checked_at)
         VALUES ($1,$2,$3,$4,$5,'DailySettlement','set_SYNTHETIC_DAY','Difference','RefundMismatch',
          1130,1130,0,1130,'CAD',$6,$7)`,
        [id(34), id(30), id(33), id(2), id(3), id(32), endsAt],
      );
      await client.query(
        `INSERT INTO rms_payment.payment_reconciliation_record
         (reconciliation_check_id,reconciliation_run_id,candidate_id,brand_id,store_id,mode,
          settlement_reference,outcome,internal_captured_minor,provider_captured_minor,
          internal_refunded_minor,provider_refunded_minor,currency_code,checked_at)
         VALUES ($1,$2,$3,$4,$5,'DailySettlement','set_SYNTHETIC_DAY_B','Matched',2500,2500,0,0,'CAD',$6)`,
        [id(36), id(30), id(37), id(2), id(3), endsAt],
      );
      const tx = { query: (sql, values) => client.query(sql, values) };
      const read = createPostgresPaymentReconciliationWindowSource({
        scope: { brandReference: id(2), storeReference: id(3) },
        authorize: async () => true,
      });
      const day = await read(tx, { startsAt, endsAt });
      assert.equal(day.runs.length, 1);
      assert.equal(day.runs[0].runReference, id(30));
      assert.deepEqual(day.runs[0].counts, {
        Matched: 3,
        Healed: 0,
        Unresolved: 0,
        Unavailable: 0,
        Difference: 1,
      });
      assert.equal(day.differences.length, 1);
      assert.deepEqual(
        {
          outcome: day.differences[0].outcome,
          reason: day.differences[0].differenceReason,
          settlement: day.differences[0].settlementReference,
          providerRefunded: day.differences[0].providerRefundedMinor,
          exception: day.differences[0].exceptionReference,
        },
        {
          outcome: "Difference",
          reason: "RefundMismatch",
          settlement: "set_SYNTHETIC_DAY",
          providerRefunded: "1130",
          exception: id(32),
        },
      );
      const next = await read(tx, { startsAt: endsAt, endsAt: "2026-08-05T08:00:00.000Z" });
      assert.equal(next.runs.length, 1);
      assert.equal(next.runs[0].mode, "Operational");
      assert.equal(next.differences.length, 0);
      const other = createPostgresPaymentReconciliationWindowSource({
        scope: { brandReference: id(2), storeReference: id(9) },
        authorize: async () => true,
      });
      assert.deepEqual((await other(tx, { startsAt, endsAt })).runs, []);
    } finally {
      await client.end();
    }
  });
}, 180_000);

it("retains Provider-only capture evidence with exact exception scope and immutable history", async () => {
  await withIsolatedDatabase({ caseId: "provider_capture", root }, async (context) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query(
        "INSERT INTO rms_payment.payment_reconciliation_exception VALUES($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)",
        [id(101), id(102), id(103), id(104), checkedAt],
      );
      const sql =
        "INSERT INTO rms_payment.provider_capture_exception_evidence VALUES($1,$2,$3,$4,$5,$6,'Test','pi_demo001',$7,$8,$9,$10,'CAD',$11,$12,$13)";
      const values = [
        id(104),
        id(101),
        id(105),
        id(102),
        id(103),
        id(106),
        "ch_demo001",
        id(107),
        id(108),
        "2260",
        scheduledAt,
        checkedAt,
        "sha256:" + "a".repeat(64),
      ];
      await client.query(sql, values);
      assert.equal(
        (
          await client.query(
            "SELECT amount_minor::text AS amount FROM rms_payment.provider_capture_exception_evidence",
          )
        ).rows[0].amount,
        "2260",
      );
      await assert.rejects(client.query(sql, values), (error) => error.code === "23505");
      for (const statement of [
        "UPDATE rms_payment.provider_capture_exception_evidence SET amount_minor=1",
        "DELETE FROM rms_payment.provider_capture_exception_evidence",
        "TRUNCATE rms_payment.provider_capture_exception_evidence",
      ])
        await assert.rejects(client.query(statement), (error) => error.code === "55000");
      await client.query(
        "INSERT INTO rms_payment.payment_reconciliation_exception VALUES($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)",
        [id(111), id(102), id(103), id(114), checkedAt],
      );
      const next = [...values];
      next[0] = id(114);
      next[1] = id(111);
      next[6] = "ch_demo002";
      for (const [index, value, code] of [
        [4, id(999), "23503"],
        [9, "-1", "23514"],
        [10, "2026-08-04T00:00:00.000Z", "23514"],
      ]) {
        const invalid = [...next];
        invalid[index] = value;
        await assert.rejects(client.query(sql, invalid), (error) => error.code === code);
      }
      next[6] = "ch_demo001";
      await assert.rejects(client.query(sql, next), (error) => error.code === "23505");
      const flags = (
        await client.query(
          "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_payment.provider_capture_exception_evidence'::regclass",
        )
      ).rows[0];
      assert.deepEqual(flags, { relrowsecurity: true, relforcerowsecurity: true });
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_schema='rms_payment' AND table_name='provider_capture_exception_evidence' AND grantee='PUBLIC'",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await client.end();
    }
  });
}, 180000);

it("persists append-only reconciliation follow-up versions bound to original exception scope", async () => {
  await withIsolatedDatabase({ caseId: "recon_followup", root }, async (context) => {
    const client = new Client(context.clientConfig);
    await client.connect();
    try {
      await client.query(
        "INSERT INTO rms_payment.payment_reconciliation_exception VALUES($1,$2,$3,$4,'AmountMismatch','Error','Open',$5)",
        [id(201), id(202), id(203), id(204), checkedAt],
      );
      const sql =
        "INSERT INTO rms_payment.reconciliation_follow_up_history VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)";
      const values = [
        id(205),
        id(202),
        id(203),
        id(201),
        id(204),
        2,
        id(206),
        id(207),
        "Acknowledge",
        checkedAt,
        JSON.stringify({ command: {}, before: {}, after: {} }),
      ];
      await client.query(sql, values);
      await assert.rejects(client.query(sql, values), (e) => e.code === "23505");
      for (const [index, value, code] of [
        [6, id(208), "23505"],
        [3, id(299), "23503"],
        [5, 1, "23514"],
        [8, "Resolve", "23514"],
        [10, "{}", "23514"],
      ]) {
        const changed = [...values];
        changed[5] = 3;
        changed[6] = id(209);
        changed[index] = value;
        if (index === 6) changed[5] = 2;
        await assert.rejects(client.query(sql, changed), (e) => e.code === code);
      }
      for (const action of [
        "UPDATE rms_payment.reconciliation_follow_up_history SET version=3",
        "DELETE FROM rms_payment.reconciliation_follow_up_history",
        "TRUNCATE rms_payment.reconciliation_follow_up_history",
      ])
        await assert.rejects(client.query(action), (e) => e.code === "55000");
      assert.deepEqual(
        (
          await client.query(
            "SELECT relrowsecurity,relforcerowsecurity FROM pg_class WHERE oid='rms_payment.reconciliation_follow_up_history'::regclass",
          )
        ).rows,
        [{ relrowsecurity: true, relforcerowsecurity: true }],
      );
      assert.equal(
        (
          await client.query(
            "SELECT count(*)::int AS n FROM information_schema.table_privileges WHERE table_schema='rms_payment' AND table_name='reconciliation_follow_up_history' AND grantee='PUBLIC'",
          )
        ).rows[0].n,
        0,
      );
    } finally {
      await client.end();
    }
  });
}, 180000);
