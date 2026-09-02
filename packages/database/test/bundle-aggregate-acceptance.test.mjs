import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";

import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fc000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T17:00:00.000Z";
const names = JSON.stringify({ "en-CA": "Synthetic Bundle" });

async function prove(context) {
  const admin = new Client(context.clientConfig);
  await admin.connect();
  const role = `wp2100_${context.runId}`;
  try {
    await admin.query("BEGIN");
    await admin.query(
      `INSERT INTO rms_catalog.bundle
       (bundle_id,brand_id,internal_code,lifecycle,aggregate_version,current_version_id,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,'LUNCH','Draft',1,$3,$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_version
       (bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,
        localized_descriptions_json,price_mode,currency_code,fixed_amount_minor,created_at,updated_at)
       VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Fixed','CAD',1299,$5,$5)`,
      [id(3), id(1), id(2), names, at],
    );
    await admin.query("COMMIT");
    await admin.query(
      `INSERT INTO rms_catalog.bundle_component_group
       (group_id,bundle_version_id,bundle_id,brand_id,stable_code,localized_names_json,
        minimum_selection,maximum_selection,sort_order)
       VALUES ($1,$2,$3,$4,'MAIN',$5::jsonb,1,1,0)`,
      [id(5), id(3), id(1), id(2), names],
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_component_sellable
       (group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type)
       VALUES ($1,$2,$3,$4,$5,'Sku')`,
      [id(5), id(3), id(1), id(2), id(6)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.bundle_component_sellable
         (group_id,bundle_version_id,bundle_id,brand_id,sellable_id,sellable_type)
         VALUES ($1,$2,$3,$4,$5,'Bundle')`,
        [id(5), id(3), id(1), id(2), id(7)],
      ),
      /bundle_component_sellable_sellable_type_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.bundle_version
         (bundle_version_id,bundle_id,brand_id,status,default_locale,localized_names_json,
          localized_descriptions_json,price_mode,fixed_amount_minor,created_at,updated_at)
         VALUES ($1,$2,$3,'Draft','en-CA',$4::jsonb,$4::jsonb,'Fixed',100,$5,$5)`,
        [id(8), id(1), id(2), names, at],
      ),
      /bundle_version_price_shape/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.bundle_operation_record
       (operation_id,brand_id,bundle_id,action_code,intent_digest,result_aggregate_version,outbox_event_id,occurred_at)
       VALUES ($1,$2,$3,'Create',$4,1,$5,$6)`,
      [id(10), id(2), id(1), `sha256:${"a".repeat(64)}`, id(11), at],
    );
    await admin.query(
      "UPDATE rms_catalog.bundle_operation_record SET result_aggregate_version=2 WHERE operation_id=$1",
      [id(10)],
    );
    assert.equal(
      (
        await admin.query(
          "SELECT result_aggregate_version FROM rms_catalog.bundle_operation_record WHERE operation_id=$1",
          [id(10)],
        )
      ).rows[0].result_aggregate_version,
      1,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.bundle")).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query("SELECT * FROM rms_catalog.bundle")).rowCount, 1);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.bundle_component_sellable")).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_catalog.bundle_operation_record")).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Bundle persistence, immutable history and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "bundle", root }, prove);
}, 120_000);
