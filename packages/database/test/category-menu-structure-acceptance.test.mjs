import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f5100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-07-30T15:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Name" });

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `bop_wp1021_${context.runId}`;
  await admin.connect();
  try {
    const tables = await admin.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'rms_catalog'
         AND table_name IN (
           'category','category_operation_record','menu','menu_operation_record','menu_section',
           'menu_section_category','menu_version','menu_version_channel','menu_version_order_type',
           'menu_version_store','sellable_placement'
         )
       ORDER BY table_name`,
    );
    assert.deepEqual(
      tables.rows.map((row) => row.table_name),
      [
        "category",
        "category_operation_record",
        "menu",
        "menu_operation_record",
        "menu_section",
        "menu_section_category",
        "menu_version",
        "menu_version_channel",
        "menu_version_order_type",
        "menu_version_store",
        "sellable_placement",
      ],
    );
    const forced = await admin.query(
      `SELECT relname, relforcerowsecurity FROM pg_class
       WHERE oid IN (
         'rms_catalog.category'::regclass,
         'rms_catalog.category_operation_record'::regclass,
         'rms_catalog.menu'::regclass,
         'rms_catalog.menu_version'::regclass,
         'rms_catalog.menu_section'::regclass,
         'rms_catalog.sellable_placement'::regclass,
         'rms_catalog.menu_operation_record'::regclass
       ) ORDER BY relname`,
    );
    assert.equal(forced.rows.length, 7);
    assert.equal(
      forced.rows.every((row) => row.relforcerowsecurity),
      true,
    );

    await admin.query(
      `INSERT INTO rms_catalog.category
       (category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,
        localized_names_json,localized_descriptions_json,parent_category_id,tree_level,
        sort_order,store_ids_json,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'ROOT','Active',1,'en-CA',$3::jsonb,'{}'::jsonb,NULL,1,0,
               '[]'::jsonb,$4,$5,$4)`,
      [id(1), id(2), names, at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.category
       (category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,
        localized_names_json,localized_descriptions_json,parent_category_id,tree_level,
        sort_order,store_ids_json,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'CHILD','Active',1,'en-CA',$3::jsonb,'{}'::jsonb,$4,2,0,
               '[]'::jsonb,$5,$6,$5)`,
      [id(4), id(2), names, id(1), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.category
       (category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,
        localized_names_json,localized_descriptions_json,parent_category_id,tree_level,
        sort_order,store_ids_json,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'LEAF','Draft',1,'en-CA',$3::jsonb,'{}'::jsonb,$4,3,0,
               '[]'::jsonb,$5,$6,$5)`,
      [id(5), id(2), names, id(4), at, id(3)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.category
         (category_id,brand_id,internal_code,lifecycle,aggregate_version,default_locale,
          localized_names_json,localized_descriptions_json,parent_category_id,tree_level,
          sort_order,store_ids_json,created_at,created_by_actor_id,updated_at)
         VALUES ($1,$2,'TOO_DEEP','Draft',1,'en-CA',$3::jsonb,'{}'::jsonb,$4,3,1,
                 '[]'::jsonb,$5,$6,$5)`,
        [id(6), id(2), names, id(5), at, id(3)],
      ),
      /invalid category parent or depth/u,
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_catalog.category
         SET parent_category_id = $1, tree_level = 2
         WHERE category_id = $2`,
        [id(5), id(1)],
      ),
      /category cycle/u,
    );

    await admin.query(
      `INSERT INTO rms_catalog.product
       (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,
        created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'TEA','NonAlcoholicBeverage','Active',1,$3,$4,$3)`,
      [id(10), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.product_version
       (product_version_id,product_id,brand_id,status,default_locale,localized_names_json,
        created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$5,$5)`,
      [id(11), id(10), id(2), names, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.sku
       (sku_id,product_id,brand_id,product_version_id,sku_code,lifecycle,
        localized_names_json,variant_selections_json,variant_digest,unit_of_sale,
        unit_quantity,created_at,created_by_actor_id)
       VALUES ($1,$2,$3,$4,'TEA-EACH','Active',$5::jsonb,'[]'::jsonb,$6,'EACH',1,$7,$8)`,
      [id(12), id(10), id(2), id(11), names, `sha256:${"a".repeat(64)}`, at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu
       (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES
       ($1,$2,'BASE',1,$3,$4,$3),
       ($5,$2,'DERIVED',1,$3,$4,$3)`,
      [id(20), id(2), at, id(3), id(21)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_version
       (menu_version_id,menu_id,brand_id,status,base_menu_id,default_locale,
        localized_names_json,created_at,updated_at)
       VALUES
       ($1,$2,$3,'Draft',NULL,'en-CA',$4::jsonb,$5,$5),
       ($6,$7,$3,'Draft',$2,'en-CA',$4::jsonb,$5,$5)`,
      [id(22), id(20), id(2), names, at, id(23), id(21)],
    );
    await assert.rejects(
      admin.query(`UPDATE rms_catalog.menu_version SET base_menu_id = $1 WHERE menu_id = $2`, [
        id(21),
        id(20),
      ]),
      /multi-level menu inheritance/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_section
       (menu_section_id,menu_version_id,menu_id,brand_id,internal_code,localized_names_json,sort_order)
       VALUES ($1,$2,$3,$4,'DRINKS',$5::jsonb,0)`,
      [id(24), id(22), id(20), id(2), names],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_section_category
       (menu_section_id,menu_id,brand_id,category_id)
       VALUES ($1,$2,$3,$4)`,
      [id(24), id(20), id(2), id(1)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.sellable_placement
       (placement_id,menu_section_id,menu_id,brand_id,sku_id,sellable_type,
        presentation_role,sort_order,pinned,localized_name_overrides_json,
        created_at,created_by_actor_id)
       VALUES ($1,$2,$3,$4,$5,'Sku','Standard',0,false,'{}'::jsonb,$6,$7)`,
      [id(25), id(24), id(20), id(2), id(12), at, id(3)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.sellable_placement
         (placement_id,menu_section_id,menu_id,brand_id,sku_id,sellable_type,
          presentation_role,sort_order,pinned,localized_name_overrides_json,
          created_at,created_by_actor_id)
         VALUES ($1,$2,$3,$4,$5,'Sku','Standard',1,false,'{}'::jsonb,$6,$7)`,
        [id(26), id(24), id(20), id(2), id(12), at, id(3)],
      ),
      /sellable_placement_tuple_unique/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.category_operation_record
       (operation_id,brand_id,category_id,action_code,intent_digest,result_aggregate_version,occurred_at)
       VALUES ($1,$2,$3,'Create',$4,1,$5)`,
      [id(30), id(2), id(1), `sha256:${"b".repeat(64)}`, at],
    );
    await admin.query(
      `UPDATE rms_catalog.category_operation_record SET result_aggregate_version = 2
       WHERE operation_id = $1`,
      [id(30)],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT result_aggregate_version FROM rms_catalog.category_operation_record WHERE operation_id=$1",
          [id(30)],
        )
      ).rows[0].result_aggregate_version,
      1,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),
       platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.category")).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.category")).rowCount, 3);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.category")).rowCount, 0);
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Category and Draft Menu persistence boundaries", async () => {
  await withIsolatedDatabase({ caseId: "category_menu", root }, prove);
}, 120_000);
