import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (c) => `sha256:${c.repeat(64)}`;
const at = "2026-08-13T18:00:00.000Z";

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2103_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.tax_config_admin_projection_generation
      (generation_id,brand_id,store_id,projection_version,source_event_sequence,built_at)
      VALUES ($1,$2,$3,1,3,$4)`,
      [id(1), id(2), id(3), at],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_config_admin_projection
      (generation_id,brand_id,store_id,tax_configuration_id,tax_configuration_version_id,stable_code,lifecycle,aggregate_version,jurisdiction_code,currency_code,registration_status,fixture_status,effective_from,snapshot_digest,projected_at)
      VALUES ($1,$2,$3,$4,$5,'PILOT_STORE_TAX','Published',2,'CA-ON','CAD','Verified','Approved',$6,$7,$6)`,
      [id(1), id(2), id(3), id(4), id(5), at, digest("a")],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_config_rule_projection
      (generation_id,brand_id,store_id,tax_configuration_id,tax_configuration_rule_id,tax_classification_id,category_code,treatment,tax_rate,price_inclusion,receipt_presentation_code)
      VALUES ($1,$2,$3,$4,$5,$6,'SYNTHETIC_MEAL','Taxable',0.13,'Exclusive','SYNTHETIC_TAX')`,
      [id(1), id(2), id(3), id(4), id(6), id(7)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_config_receipt_fixture_projection
      (generation_id,brand_id,store_id,tax_configuration_id,fixture_reference_id,fixture_kind,fixture_suite_digest,net_amount_minor,tax_amount_minor,gross_amount_minor,receipt_preview_digest)
      VALUES ($1,$2,$3,$4,$5,'Basket',$6,1000,130,1130,$7)`,
      [id(1), id(2), id(3), id(4), id(8), digest("b"), digest("c")],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_config_admin_projection_checkpoint
      (brand_id,store_id,active_generation_id,projection_version,source_event_sequence,updated_at)
      VALUES ($1,$2,$3,1,3,$4)`,
      [id(2), id(3), id(1), at],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.tax_config_receipt_fixture_projection
      (generation_id,brand_id,store_id,tax_configuration_id,fixture_reference_id,fixture_kind,fixture_suite_digest,net_amount_minor,tax_amount_minor,gross_amount_minor,receipt_preview_digest)
      VALUES ($1,$2,$3,$4,$5,'Refund',$6,-10.5,-1,-11,$7)`,
        [id(1), id(2), id(3), id(4), id(9), digest("b"), digest("d")],
      ),
      /tax_config_fixture_projection_minor_units/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_pricing.tax_config_admin_projection,rms_pricing.tax_config_rule_projection,rms_pricing.tax_config_receipt_fixture_projection TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_pricing.tax_config_admin_projection`)).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(3)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_pricing.tax_config_admin_projection`)).rowCount,
      1,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT tax_amount_minor::text FROM rms_pricing.tax_config_receipt_fixture_projection`,
        )
      ).rows[0].tax_amount_minor,
      "130",
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_pricing.tax_config_admin_projection`)).rowCount,
      0,
    );
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Tax Config projections exact, rebuildable and Store isolated", async () => {
  await withIsolatedDatabase({ caseId: "tax_config_admin", root }, prove);
}, 120_000);
