import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f6100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T18:01:00.000Z";

async function prove(context) {
  const client = new Client(context.clientConfig);
  await client.connect();
  try {
    const forced = await client.query(
      `SELECT relname,relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_ordering.order_header'::regclass,
         'rms_ordering.order_submission_record'::regclass,
         'rms_ordering.order_batch'::regclass,
         'rms_ordering.order_item'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 4);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at)
       VALUES ($1,$2,'2026-08-02',2,$3)`,
      [id(1), id(2), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_number_allocation
       (order_id,brand_id,store_id,business_date,sequence,order_number,allocated_at,
        business_date_configuration_id,business_date_configuration_version,
        business_date_content_digest,time_zone,business_day_start,business_date_boundary_at,
        boundary_disambiguation)
       VALUES ($1,$2,$3,'2026-08-02',1,'1',$4,$5,1,$6,
        'America/Toronto','04:00:00','2026-08-02T08:00:00.000Z','Exact')`,
      [id(10), id(1), id(2), at, id(3), `sha256:${"a".repeat(64)}`],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_header
       (order_id,brand_id,store_id,business_date,order_number,order_type,source_channel,
        created_by_actor_id,submitted_by_actor_id,aggregate_version,canonical_phase,
        closure_status,payment_status,created_at)
       VALUES ($1,$2,$3,'2026-08-02','1','Pickup','Qr',$4,$4,1,'Submitted','Open',
        'NotReported',$5)`,
      [id(10), id(1), id(2), id(4), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_submission_record
       (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,
        source_cart_id,source_cart_version,quote_id,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,5,$8,$9)`,
      [id(11), id(1), id(2), id(10), id(4), `sha256:${"b".repeat(64)}`, id(12), id(13), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_batch
       (order_batch_id,brand_id,store_id,order_id,submission_id,source_cart_id,
        source_cart_version,checkout_validation_id,quote_id,submitted_by_actor_id,submitted_at)
       VALUES ($1,$2,$3,$4,$5,$6,5,$7,$8,$9,$10)`,
      [id(14), id(1), id(2), id(10), id(11), id(12), id(15), id(13), id(4), at],
    );
    await client.query(
      `INSERT INTO rms_ordering.order_item
       (order_item_id,brand_id,store_id,order_id,order_batch_id,source_cart_line_id,quantity,
        catalog_snapshot_digest,quote_input_digest,transaction_snapshot_json,snapshot_captured_at)
       VALUES ($1,$2,$3,$4,$5,$6,2,$7,$8,$9::jsonb,$10)`,
      [
        id(16),
        id(1),
        id(2),
        id(10),
        id(14),
        id(17),
        `sha256:${"c".repeat(64)}`,
        `sha256:${"d".repeat(64)}`,
        JSON.stringify({
          catalog: { localizedNames: { "en-CA": "Synthetic item" }, options: [] },
          pricing: { total: { amountMinor: "1130", currencyCode: "CAD" } },
        }),
        at,
      ],
    );
    await client.query("COMMIT");

    const snapshot = await client.query(
      `SELECT header.order_number,submission.submission_id,item.transaction_snapshot_json
       FROM rms_ordering.order_header AS header
       JOIN rms_ordering.order_submission_record AS submission USING (order_id,brand_id,store_id)
       JOIN rms_ordering.order_item AS item USING (order_id,brand_id,store_id)
       WHERE header.order_id=$1`,
      [id(10)],
    );
    assert.equal(snapshot.rowCount, 1);
    assert.equal(snapshot.rows[0].order_number, "1");
    assert.equal(snapshot.rows[0].transaction_snapshot_json.pricing.total.amountMinor, "1130");

    await assert.rejects(
      client.query(
        `INSERT INTO rms_ordering.order_submission_record
         (submission_id,brand_id,store_id,order_id,guest_session_id,intent_digest,
          source_cart_id,source_cart_version,quote_id,created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,5,$8,$9)`,
        [id(11), id(1), id(2), id(18), id(4), `sha256:${"e".repeat(64)}`, id(12), id(13), at],
      ),
      /order_submission_record_pkey/u,
    );
    await client.query(
      `UPDATE rms_ordering.order_header SET order_number='999' WHERE order_id=$1`,
      [id(10)],
    );
    assert.equal(
      (
        await client.query(`SELECT order_number FROM rms_ordering.order_header WHERE order_id=$1`, [
          id(10),
        ])
      ).rows[0].order_number,
      "1",
    );
    await client.query(`DELETE FROM rms_ordering.order_header WHERE order_id=$1`, [id(10)]);
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_header WHERE order_id=$1`,
          [id(10)],
        )
      ).rows[0].count,
      1,
    );
    await client.query(`DELETE FROM rms_ordering.order_item WHERE order_item_id=$1`, [id(16)]);
    assert.equal(
      (await client.query(`SELECT count(*)::integer AS count FROM rms_ordering.order_item`)).rows[0]
        .count,
      1,
    );

    await client.query("BEGIN");
    await client.query(
      `INSERT INTO rms_ordering.order_number_counter
       (brand_id,store_id,business_date,next_sequence,updated_at)
       VALUES ($1,$2,'2026-08-03',2,$3)`,
      [id(1), id(2), at],
    );
    await client.query("ROLLBACK");
    assert.equal(
      (
        await client.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.order_number_counter
           WHERE business_date='2026-08-03'`,
        )
      ).rows[0].count,
      0,
    );
  } finally {
    await client.end();
  }
}

it("persists one immutable, idempotent Order submission atomically", async () => {
  await withIsolatedDatabase({ caseId: "order_submission", root }, prove);
}, 180_000);
