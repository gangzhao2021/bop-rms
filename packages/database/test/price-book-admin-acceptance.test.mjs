import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018fd300-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-13T19:00:00.000Z";
const sha = (c) => `sha256:${c.repeat(64)}`;
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2102_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.price_book (price_book_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'CAD_BASE',1,$3,$4,$3)`,
      [id(1), id(2), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_version (price_book_version_id,price_book_id,brand_id,version_number,snapshot_digest,lifecycle,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,created_at) VALUES ($1,$2,$3,2,$4,'Published','CAD',1,$5,$6,$7)`,
      [id(3), id(1), id(2), sha("a"), id(6), sha("b"), at],
    );
    await admin.query(
      `UPDATE rms_pricing.price_book SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE price_book_id=$3`,
      [id(3), at, id(1)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_entry (price_entry_id,price_book_version_id,price_book_id,brand_id,sellable_id,scope_kind,amount_minor,currency_code,effective_from,effective_time_zone,reason_code) VALUES ($1,$2,$3,$4,$5,'Brand',1299,'CAD',$6,'America/Toronto','SYNTHETIC_BASE')`,
      [id(7), id(3), id(1), id(2), id(8), at],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_operation_record (operation_id,price_book_id,brand_id,action_code,intent_digest,result_aggregate_version,result_version_id,outbox_event_id,occurred_at) VALUES ($1,$2,$3,'Publish',$4,2,$5,$6,$7)`,
      [id(9), id(1), id(2), sha("c"), id(3), id(10), at],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_admin_projection_generation (generation_id,brand_id,projection_version,source_event_sequence,built_at) VALUES ($1,$2,1,4,$3)`,
      [id(11), id(2), at],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_admin_projection (generation_id,brand_id,price_book_id,price_book_version_id,stable_code,lifecycle,currency_code,aggregate_version,version_number,entry_count,covered_scenario_count,missing_scenario_count,conflict_scenario_count,effective_from,snapshot_digest,projected_at) VALUES ($1,$2,$3,$4,'CAD_BASE','Published','CAD',2,2,1,1,0,0,$5,$6,$5)`,
      [id(11), id(2), id(1), id(3), at, sha("a")],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_entry_projection (generation_id,brand_id,price_book_id,price_entry_id,sellable_id,sellable_code,scope_kind,amount_minor,currency_code,effective_from,coverage_status,reason_code) VALUES ($1,$2,$3,$4,$5,'SYNTHETIC_SKU','Brand',1299,'CAD',$6,'Covered','SYNTHETIC_BASE')`,
      [id(11), id(2), id(1), id(7), id(8), at],
    );
    await admin.query(
      `INSERT INTO rms_pricing.price_book_admin_projection_checkpoint (brand_id,active_generation_id,projection_version,source_event_sequence,updated_at) VALUES ($1,$2,1,4,$3)`,
      [id(2), id(11), at],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.price_book_entry_projection (generation_id,brand_id,price_book_id,price_entry_id,sellable_id,sellable_code,scope_kind,amount_minor,currency_code,effective_from,coverage_status,reason_code) VALUES ($1,$2,$3,$4,$5,'BAD','Brand',12.5,'CAD',$6,'Covered','BAD')`,
        [id(11), id(2), id(1), id(12), id(8), at],
      ),
      /price_book_entry_projection_amount_minor_check/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing, platform_helpers TO ${role}`);
    await admin.query(`GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id() TO ${role}`);
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_pricing TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query("SELECT * FROM rms_pricing.price_book_admin_projection")).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal(
      (await admin.query("SELECT * FROM rms_pricing.price_book_admin_projection")).rowCount,
      1,
    );
    assert.equal(
      (await admin.query("SELECT * FROM rms_pricing.price_book_entry_projection")).rowCount,
      1,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces exact Price Book admin projection, event linkage and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "price_book_admin", root }, prove);
}, 120_000);
