import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f5000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_wp1203_${context.runId}`;
  const selectionEvidence = {
    menuVersionReference: id(20),
    productVersionReference: id(21),
    catalogChannelCode: "PILOT_CHANNEL",
    catalogOrderTypeCode: "PILOT_ORDER_TYPE",
    ruleEvidence: [{ bindingReference: id(22), optionSetVersionReference: id(23) }],
    validatedAt: "2026-08-02T14:01:00.000Z",
  };
  await admin.connect();
  try {
    const tables = await admin.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'rms_ordering' ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows, [
      { table_name: "cart" },
      { table_name: "cart_binding_record" },
      { table_name: "cart_lifecycle_operation_record" },
      { table_name: "cart_line" },
      { table_name: "cart_operation_record" },
      { table_name: "cart_quote_attachment" },
      { table_name: "cart_quote_attachment_line" },
      { table_name: "cart_quote_expiry_record" },
      { table_name: "order_amendment" },
      { table_name: "order_amendment_change" },
      { table_name: "order_amendment_operation_record" },
      { table_name: "order_amendment_state_record" },
      { table_name: "order_batch" },
      { table_name: "order_header" },
      { table_name: "order_item" },
      { table_name: "order_number_allocation" },
      { table_name: "order_number_counter" },
      { table_name: "order_status_projection" },
      { table_name: "order_status_projection_generation" },
      { table_name: "order_submission_record" },
    ]);
    const forced = await admin.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_ordering.cart'::regclass,
         'rms_ordering.cart_binding_record'::regclass,
         'rms_ordering.cart_lifecycle_operation_record'::regclass,
         'rms_ordering.cart_line'::regclass,
         'rms_ordering.cart_operation_record'::regclass,
         'rms_ordering.cart_quote_attachment'::regclass,
         'rms_ordering.cart_quote_attachment_line'::regclass
         ,'rms_ordering.order_number_allocation'::regclass
         ,'rms_ordering.order_number_counter'::regclass
       )
       ORDER BY relname`,
    );
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await admin.query(
      `INSERT INTO rms_ordering.cart
       (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,
        aggregate_version,created_at,updated_at)
       VALUES ($1,$2,$3,'Pickup','Qr',$4,1,$5,$5)`,
      [id(1), id(2), id(3), id(4), "2026-08-02T14:00:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_ordering.cart_line
       (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,option_selections_json,
        customer_note,catalog_selection_evidence_json,added_by_actor_id,added_at)
       VALUES ($1,$2,$3,$4,$5,2,$6::jsonb,'Extra napkins',$7::jsonb,$8,$9)`,
      [
        id(5),
        id(1),
        id(2),
        id(3),
        id(6),
        JSON.stringify([{ optionReference: id(7), quantity: 1 }]),
        JSON.stringify(selectionEvidence),
        id(4),
        "2026-08-02T14:00:00.000Z",
      ],
    );
    await admin.query(
      `INSERT INTO rms_ordering.cart_operation_record
       (operation_id,brand_id,store_id,cart_id,cart_line_id,guest_session_id,action_code,
        intent_digest,result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,$6,'Add',$7,2,$8::jsonb,$9,$10)`,
      [
        id(11),
        id(2),
        id(3),
        id(1),
        id(5),
        id(4),
        `sha256:${"a".repeat(64)}`,
        JSON.stringify({ cartReference: id(1), aggregateVersion: 2 }),
        "2026-08-02T14:01:00.000Z",
        "2026-08-03T14:01:00.000Z",
      ],
    );
    await admin.query(
      `INSERT INTO rms_ordering.cart_quote_attachment
       (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,
        quote_id,quote_version,quote_input_digest,currency_code,currency_metadata_version,
        currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,
        line_count,warnings_json,quote_created_at,quote_expires_at,attached_at,idempotency_expires_at)
       VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,'CAD',1,$9,2000,0,260,0,2260,1,
        '["SYNTHETIC_WARNING"]'::jsonb,$10,$11,$10,$12)`,
      [
        id(26),
        id(2),
        id(3),
        id(1),
        id(4),
        `sha256:${"c".repeat(64)}`,
        id(27),
        `sha256:${"d".repeat(64)}`,
        id(28),
        "2026-08-02T14:01:00.000Z",
        "2026-08-02T14:06:00.000Z",
        "2026-08-03T14:01:00.000Z",
      ],
    );
    await admin.query(
      `INSERT INTO rms_ordering.cart_quote_attachment_line
       (operation_id,brand_id,store_id,cart_id,cart_line_id,sellable_id,
        product_version_id,menu_version_id,quantity)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,2)`,
      [id(26), id(2), id(3), id(1), id(5), id(6), id(21), id(20)],
    );
    await admin.query(`DELETE FROM rms_ordering.cart_line WHERE cart_line_id=$1`, [id(5)]);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_quote_attachment_line
           WHERE operation_id=$1`,
          [id(26)],
        )
      ).rows[0].count,
      1,
    );
    await admin.query(
      `UPDATE rms_ordering.cart_quote_attachment SET total_minor=1 WHERE operation_id=$1`,
      [id(26)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT total_minor::text FROM rms_ordering.cart_quote_attachment WHERE operation_id=$1`,
          [id(26)],
        )
      ).rows[0].total_minor,
      "2260",
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.cart_quote_attachment
         (operation_id,brand_id,store_id,cart_id,cart_version,guest_session_id,intent_digest,
          quote_id,quote_version,quote_input_digest,currency_code,currency_metadata_version,
          currency_metadata_version_id,subtotal_minor,discount_minor,tax_minor,fee_minor,total_minor,
          line_count,warnings_json,quote_created_at,quote_expires_at,attached_at,idempotency_expires_at)
         VALUES ($1,$2,$3,$4,2,$5,$6,$7,1,$8,'CAD',1,$9,2000,0,260,0,2261,1,'[]'::jsonb,
          $10,$11,$10,$12)`,
        [
          id(29),
          id(2),
          id(3),
          id(1),
          id(4),
          `sha256:${"e".repeat(64)}`,
          id(30),
          `sha256:${"f".repeat(64)}`,
          id(31),
          "2026-08-02T14:01:00.000Z",
          "2026-08-02T14:06:00.000Z",
          "2026-08-03T14:01:00.000Z",
        ],
      ),
      /cart_quote_attachment_total_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.cart_operation_record
         (operation_id,brand_id,store_id,cart_id,cart_line_id,guest_session_id,action_code,
          intent_digest,result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,'Add',$7,2,'{}'::jsonb,$8,$9)`,
        [
          id(12),
          id(2),
          id(3),
          id(1),
          id(5),
          id(4),
          `sha256:${"b".repeat(64)}`,
          "2026-08-02T14:01:00.000Z",
          "2026-08-03T14:00:59.999Z",
        ],
      ),
      /cart_operation_retention_check/u,
    );
    await admin.query(
      `UPDATE rms_ordering.cart_operation_record
       SET result_aggregate_version = 3 WHERE operation_id = $1`,
      [id(11)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT result_aggregate_version FROM rms_ordering.cart_operation_record
           WHERE operation_id = $1`,
          [id(11)],
        )
      ).rows[0].result_aggregate_version,
      2,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.cart
         (cart_id,brand_id,store_id,order_type,source_channel,created_by_actor_id,
          aggregate_version,created_at,updated_at)
         VALUES ($1,$2,$3,'DineIn','Qr',$4,1,$5,$5)`,
        [id(8), id(2), id(3), id(4), "2026-08-02T14:00:00.000Z"],
      ),
      /cart_dining_context_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.cart_line
         (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,
          option_selections_json,added_by_actor_id,added_at)
         VALUES ($1,$2,$3,$4,$5,0,'[]'::jsonb,$6,$7)`,
        [id(9), id(1), id(2), id(3), id(6), id(4), "2026-08-02T14:00:00.000Z"],
      ),
      /cart_line_quantity_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.cart_line
         (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,
          option_selections_json,customer_note,added_by_actor_id,added_at)
         VALUES ($1,$2,$3,$4,$5,1,'[]'::jsonb,$6,$7,$8)`,
        [
          id(10),
          id(1),
          id(2),
          id(3),
          id(6),
          ` ${"x".repeat(500)}`,
          id(4),
          "2026-08-02T14:00:00.000Z",
        ],
      ),
      /cart_line_customer_note_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_ordering.cart_line
         (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,
          option_selections_json,catalog_selection_evidence_json,added_by_actor_id,added_at)
         VALUES ($1,$2,$3,$4,$5,1,'[]'::jsonb,'{}'::jsonb,$6,$7)`,
        [id(24), id(1), id(2), id(3), id(6), id(4), "2026-08-02T14:00:00.000Z"],
      ),
      /cart_line_catalog_selection_evidence_check/u,
    );
    await admin.query(
      `INSERT INTO rms_ordering.cart_line
       (cart_line_id,cart_id,brand_id,store_id,sellable_id,quantity,
        option_selections_json,catalog_selection_evidence_json,added_by_actor_id,added_at)
       VALUES ($1,$2,$3,$4,$5,1,'[]'::jsonb,NULL,$6,$7)`,
      [id(25), id(1), id(2), id(3), id(6), id(4), "2026-08-02T14:00:00.000Z"],
    );
    await assert.rejects(
      admin.query(`UPDATE rms_ordering.cart SET lifecycle_status='Active' WHERE cart_id=$1`, [
        id(1),
      ]),
      /cart_lifecycle_check/u,
    );
    await admin.query(
      `UPDATE rms_ordering.cart SET
       lifecycle_status='Active', lifecycle_policy_version_id=$2,
       lifecycle_policy_digest=$3, idle_timeout_seconds=3600,
       absolute_timeout_seconds=86400, idle_expires_at=$4, absolute_expires_at=$5
       WHERE cart_id=$1`,
      [
        id(1),
        id(32),
        `sha256:${"1".repeat(64)}`,
        "2026-08-02T15:00:00.000Z",
        "2026-08-03T14:00:00.000Z",
      ],
    );
    await admin.query(
      `INSERT INTO rms_ordering.cart_lifecycle_operation_record
       (operation_id,brand_id,store_id,cart_id,guest_session_id,action_code,intent_digest,
        result_aggregate_version,result_cart_snapshot_json,occurred_at,expires_at)
       VALUES ($1,$2,$3,$4,$5,'Abandon',$6,2,$7::jsonb,$8,$9)`,
      [
        id(33),
        id(2),
        id(3),
        id(1),
        id(4),
        `sha256:${"2".repeat(64)}`,
        JSON.stringify({
          cartReference: id(1),
          aggregateVersion: 2,
          lifecycleStatus: "Abandoned",
        }),
        "2026-08-02T14:02:00.000Z",
        "2026-08-03T14:02:00.000Z",
      ],
    );
    await admin.query(
      `UPDATE rms_ordering.cart SET lifecycle_status='Abandoned', aggregate_version=2,
       updated_at=$2, terminal_at=$2, terminal_reason='CUSTOMER_ABANDONED' WHERE cart_id=$1`,
      [id(1), "2026-08-02T14:02:00.000Z"],
    );
    await admin.query(
      `UPDATE rms_ordering.cart SET lifecycle_status='Active', aggregate_version=3,
       updated_at=$2, terminal_at=NULL, terminal_reason=NULL WHERE cart_id=$1`,
      [id(1), "2026-08-02T14:03:00.000Z"],
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT lifecycle_status,aggregate_version FROM rms_ordering.cart WHERE cart_id=$1`,
          [id(1)],
        )
      ).rows[0],
      { lifecycle_status: "Abandoned", aggregate_version: 2 },
    );
    await admin.query(`DELETE FROM rms_ordering.cart WHERE cart_id=$1`, [id(1)]);
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart WHERE cart_id=$1`,
          [id(1)],
        )
      ).rows[0].count,
      1,
    );

    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA rms_ordering, platform_helpers TO ${role}`);
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_ordering TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    await admin.query("BEGIN");
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)`,
      [id(2), id(3)],
    );
    assert.equal(
      (await admin.query(`SELECT count(*)::integer AS count FROM rms_ordering.cart`)).rows[0].count,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_quote_attachment`,
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_lifecycle_operation_record`,
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_quote_attachment_line`,
        )
      ).rows[0].count,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_operation_record`,
        )
      ).rows[0].count,
      1,
    );
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,true), set_config('bop.store_id',$2,true)`,
      [id(2), id(10)],
    );
    assert.equal(
      (await admin.query(`SELECT count(*)::integer AS count FROM rms_ordering.cart`)).rows[0].count,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_quote_attachment`,
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_lifecycle_operation_record`,
        )
      ).rows[0].count,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT count(*)::integer AS count FROM rms_ordering.cart_operation_record`,
        )
      ).rows[0].count,
      0,
    );
    await admin.query("ROLLBACK");
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Cart command, Quote and lifecycle persistence", async () => {
  await withIsolatedDatabase({ caseId: "wp1204_cart", root }, prove);
});
