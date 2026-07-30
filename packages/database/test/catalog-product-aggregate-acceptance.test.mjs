import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f4000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_wp1020_${context.runId}`;
  await admin.connect();
  try {
    const tables = await admin.query(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'rms_catalog'
        ORDER BY table_name`,
    );
    assert.deepEqual(tables.rows, [
      { table_name: "product" },
      { table_name: "product_operation_record" },
      { table_name: "product_version" },
      { table_name: "sku" },
    ]);
    const policies = await admin.query(
      `SELECT tablename
         FROM pg_policies
        WHERE schemaname = 'rms_catalog'
        ORDER BY tablename`,
    );
    assert.deepEqual(
      policies.rows.map((row) => row.tablename),
      ["product", "product_operation_record", "product_version", "sku"],
    );
    const forced = await admin.query(
      `SELECT relname, relforcerowsecurity
         FROM pg_class
        WHERE oid IN (
          'rms_catalog.product'::regclass,
          'rms_catalog.product_version'::regclass,
          'rms_catalog.sku'::regclass,
          'rms_catalog.product_operation_record'::regclass
        )
        ORDER BY relname`,
    );
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await admin.query(
      `INSERT INTO rms_catalog.product
        (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,
         created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'LATTE','NonAlcoholicBeverage','Draft',1,$3,$4,$3)`,
      [id(1), id(2), "2026-07-30T14:00:00.000Z", id(3)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.product
          (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,
           created_at,created_by_actor_id,updated_at)
         VALUES ($1,$2,'LATTE','PreparedFood','Draft',1,$3,$4,$3)`,
        [id(4), id(2), "2026-07-30T14:00:00.000Z", id(3)],
      ),
      /product_brand_code_unique/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_version
        (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,
         created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)`,
      [id(5), id(1), id(2), JSON.stringify({ "en-CA": "Latte" }), "2026-07-30T14:00:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_catalog.sku
        (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,
         localized_names_json,variant_selections_json,variant_digest,unit_of_sale,
         unit_quantity,created_at,created_by_actor_id)
       VALUES ($1,$2,$3,$4,'LATTE-12','Draft',$5::jsonb,$6::jsonb,$7,'EACH',1,$8,$9)`,
      [
        id(6),
        id(1),
        id(2),
        id(5),
        JSON.stringify({ "en-CA": "Latte 12 oz" }),
        JSON.stringify([]),
        `sha256:${"a".repeat(64)}`,
        "2026-07-30T14:00:00.000Z",
        id(3),
      ],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_operation_record
        (operation_id,brand_id,product_id,action_code,intent_digest,
         result_aggregate_version,occurred_at)
       VALUES ($1,$2,$3,'Create',$4,1,$5)`,
      [id(7), id(2), id(1), `sha256:${"b".repeat(64)}`, "2026-07-30T14:00:00.000Z"],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.sku
          (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,
           localized_names_json,variant_selections_json,variant_digest,unit_of_sale,
           unit_quantity,created_at,created_by_actor_id)
         VALUES ($1,$2,$3,$4,'LATTE-12','Draft',$5::jsonb,$6::jsonb,$7,'EACH',1,$8,$9)`,
        [
          id(8),
          id(1),
          id(2),
          id(5),
          JSON.stringify({ "en-CA": "Duplicate" }),
          JSON.stringify([{ dimensionReference: id(10), valueReference: id(11) }]),
          `sha256:${"c".repeat(64)}`,
          "2026-07-30T14:00:00.000Z",
          id(3),
        ],
      ),
      /sku_brand_code_unique/u,
    );
    const applied = await admin.query(
      `UPDATE rms_catalog.product
          SET lifecycle = 'Active', aggregate_version = 2, updated_at = $2
        WHERE product_id = $1 AND aggregate_version = 1`,
      [id(1), "2026-07-30T14:01:00.000Z"],
    );
    assert.equal(applied.rowCount, 1);
    const stale = await admin.query(
      `UPDATE rms_catalog.product
          SET lifecycle = 'Suspended', aggregate_version = 2, updated_at = $2
        WHERE product_id = $1 AND aggregate_version = 1`,
      [id(1), "2026-07-30T14:02:00.000Z"],
    );
    assert.equal(stale.rowCount, 0);
    await admin.query(
      `UPDATE rms_catalog.product SET internal_code = 'CHANGED' WHERE product_id = $1`,
      [id(1)],
    );
    assert.deepEqual(
      (
        await admin.query(
          `SELECT internal_code, aggregate_version
             FROM rms_catalog.product
            WHERE product_id = $1`,
          [id(1)],
        )
      ).rows,
      [{ internal_code: "LATTE", aggregate_version: 2 }],
    );
    await admin.query(
      `UPDATE rms_catalog.product_operation_record
          SET result_aggregate_version = 2
        WHERE operation_id = $1`,
      [id(7)],
    );
    const operation = await admin.query(
      `SELECT result_aggregate_version
         FROM rms_catalog.product_operation_record
        WHERE operation_id = $1`,
      [id(7)],
    );
    assert.deepEqual(operation.rows, [{ result_aggregate_version: 1 }]);

    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(`GRANT USAGE ON TYPE platform_helpers.uuid_v7 TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION
        platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
    await admin.query("SELECT set_config('bop.store_id','',true)");
    assert.equal((await admin.query("SELECT * FROM rms_catalog.product")).rowCount, 1);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.sku")).rowCount, 1);
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id',$1,true)", [id(12)]);
    await admin.query("SELECT set_config('bop.store_id','',true)");
    assert.equal((await admin.query("SELECT * FROM rms_catalog.product")).rowCount, 0);
    await admin.query("ROLLBACK");
    await admin.query("BEGIN");
    await admin.query("SELECT set_config('bop.brand_id',$1,true)", [id(2)]);
    await admin.query("SELECT set_config('bop.store_id',$1,true)", [id(13)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.product")).rowCount, 0);
    await admin.query("ROLLBACK");
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("proves Catalog tables, constraints, forced RLS and operation history", async () => {
  await withIsolatedDatabase({ caseId: "catalog_product", root }, prove);
});
