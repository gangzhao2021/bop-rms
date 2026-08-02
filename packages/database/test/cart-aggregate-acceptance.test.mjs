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
  const role = `bop_wp1200_${context.runId}`;
  await admin.connect();
  try {
    const tables = await admin.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'rms_ordering' ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows, [{ table_name: "cart" }, { table_name: "cart_line" }]);
    const forced = await admin.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE oid IN ('rms_ordering.cart'::regclass, 'rms_ordering.cart_line'::regclass)
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
        added_by_actor_id,added_at)
       VALUES ($1,$2,$3,$4,$5,2,$6::jsonb,$7,$8)`,
      [
        id(5),
        id(1),
        id(2),
        id(3),
        id(6),
        JSON.stringify([{ optionReference: id(7), quantity: 1 }]),
        id(4),
        "2026-08-02T14:00:00.000Z",
      ],
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
    await admin.query("ROLLBACK");
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces the Store-scoped Cart aggregate persistence contract", async () => {
  await withIsolatedDatabase({ caseId: "wp1200_cart", root }, prove);
});
