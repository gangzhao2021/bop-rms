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
  const role = `bop_wp1202_${context.runId}`;
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
      { table_name: "cart_line" },
      { table_name: "cart_operation_record" },
    ]);
    const forced = await admin.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_ordering.cart'::regclass,
         'rms_ordering.cart_line'::regclass,
         'rms_ordering.cart_operation_record'::regclass
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

it("enforces Cart command persistence and selection evidence", async () => {
  await withIsolatedDatabase({ caseId: "wp1202_cart", root }, prove);
});
