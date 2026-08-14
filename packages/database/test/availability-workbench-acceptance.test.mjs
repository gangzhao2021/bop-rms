import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fd100-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T18:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Synthetic" });

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2101_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_catalog.product (product_id,brand_id,internal_code,product_type,lifecycle,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'PRODUCT','PreparedFood','Active',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO rms_catalog.bundle (bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'BUNDLE','Draft',1,$3,$4,$5,$4)`,
      [id(6), id(2), id(7), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_version (bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,localized_descriptions_json,price_mode,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Computed',$5,$5)`,
      [id(7), id(6), id(2), names, at],
    );
    await admin.query("COMMIT");
    await admin.query(
      `INSERT INTO rms_catalog.availability_rule (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,product_id,bundle_id,sellable_type,store_id,channel_codes_json,order_type_codes_json,effective_from,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'PRODUCT_RULE',1,'Active',NULL,$3,NULL,'Product',$4,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,$5,'Available',10,'CATALOG_ALLOWED',$5,$6,$5)`,
      [id(8), id(2), id(1), id(9), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_rule (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,product_id,bundle_id,sellable_type,channel_codes_json,order_type_codes_json,effective_from,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'BUNDLE_RULE',1,'Draft',NULL,NULL,$3,'Bundle','[]'::jsonb,'[]'::jsonb,$4,'Unavailable',20,'FUTURE_SCHEDULE',$4,$5,$4)`,
      [id(10), id(2), id(6), at, id(3)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.availability_rule (availability_rule_id,brand_id,internal_code,aggregate_version,lifecycle,sku_id,product_id,bundle_id,sellable_type,channel_codes_json,order_type_codes_json,effective_from,decision,priority,reason_code,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'INVALID_RULE',1,'Draft',NULL,$3,$4,'Product','[]'::jsonb,'[]'::jsonb,$5,'Unavailable',20,'INVALID',$5,$6,$5)`,
        [id(11), id(2), id(1), id(6), at, id(3)],
      ),
      /availability_rule_sku_compatibility_check/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_workbench_projection_generation (generation_id,brand_id,projection_version,source_event_sequence,built_at) VALUES ($1,$2,1,3,$3)`,
      [id(12), id(2), at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_workbench_projection (generation_id,brand_id,availability_rule_id,internal_code,aggregate_version,lifecycle,sellable_type,sellable_id,store_id,channel_codes_json,order_type_codes_json,effective_from,decision,priority,reason_code,projected_at) VALUES ($1,$2,$3,'PRODUCT_RULE',1,'Active','Product',$4,$5,'["DINE_IN"]'::jsonb,'["TABLE_SERVICE"]'::jsonb,$6,'Available',10,'CATALOG_ALLOWED',$6)`,
      [id(12), id(2), id(8), id(1), id(9), at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.availability_workbench_projection_checkpoint (brand_id,active_generation_id,projection_version,source_event_sequence,updated_at) VALUES ($1,$2,1,3,$3)`,
      [id(2), id(12), at],
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.availability_workbench_projection")).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.availability_rule")).rowCount, 2);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.availability_workbench_projection")).rowCount,
      1,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces polymorphic Availability rules, rebuildable projection and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "avail_workbench", root }, prove);
}, 120_000);
