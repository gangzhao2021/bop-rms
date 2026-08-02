import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f8000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const until = "2026-09-02T16:00:00.000Z";
const digest = (character) => `sha256:${character.repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp1101_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_pricing.tax_configuration
       (tax_configuration_id,brand_id,store_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at)
       VALUES ($1,$2,$3,'PILOT_STORE_TAX',1,$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_configuration_version
       (tax_configuration_version_id,tax_configuration_id,brand_id,store_id,version_number,snapshot_digest,lifecycle,
        jurisdiction_code,currency_code,currency_metadata_version,currency_metadata_version_id,currency_metadata_digest,
        effective_from,effective_until,effective_time_zone,registration_applicability_id,operating_entity_tax_reference_id,
        jurisdiction_profile_id,registration_evidence_valid_until,professional_evidence_id,professional_review_reference_id,
        fixture_suite_reference_id,fixture_suite_digest,professional_evidence_valid_until,created_at)
       VALUES ($1,$2,$3,$4,1,$5,'Published','CA-ON','CAD',1,$6,$7,$8,$9,'America/Toronto',$10,$11,$12,$9,$13,$14,$15,$16,$9,$8)`,
      [
        id(5),
        id(1),
        id(2),
        id(3),
        digest("a"),
        id(6),
        digest("b"),
        at,
        until,
        id(7),
        id(8),
        id(9),
        id(10),
        id(11),
        id(12),
        digest("c"),
      ],
    );
    await admin.query(
      `UPDATE rms_pricing.tax_configuration SET current_version_id=$1,aggregate_version=2,updated_at=$2
       WHERE tax_configuration_id=$3`,
      [id(5), "2026-08-02T16:01:00.000Z", id(1)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_configuration_rule
       (tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,
        tax_classification_id,order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,
        rounding_mode,calculation_order,compound_on_prior_tax,receipt_presentation_code)
       VALUES ($1,$2,$3,$4,$5,$6,'Pickup','Sellable','SYNTHETIC_COMPONENT','Taxable',0.13,'Exclusive','HalfUp',1,false,'SYNTHETIC_RECEIPT_LINE')`,
      [id(13), id(5), id(1), id(2), id(3), id(14)],
    );
    await admin.query(
      `INSERT INTO rms_pricing.tax_configuration_operation_record
       (operation_id,tax_configuration_id,brand_id,store_id,action_code,intent_digest,result_aggregate_version,result_version_id,occurred_at)
       VALUES ($1,$2,$3,$4,'Publish',$5,2,$6,$7)`,
      [id(15), id(1), id(2), id(3), digest("d"), id(5), at],
    );

    await admin.query(
      `UPDATE rms_pricing.tax_configuration_rule SET tax_rate=0.15 WHERE tax_configuration_rule_id=$1`,
      [id(13)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT tax_rate::text FROM rms_pricing.tax_configuration_rule WHERE tax_configuration_rule_id=$1`,
          [id(13)],
        )
      ).rows[0].tax_rate,
      "0.130000000000",
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_pricing.tax_configuration_version WHERE tax_configuration_version_id=$1`,
          [id(5)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_pricing.tax_configuration_operation_record WHERE operation_id=$1`,
          [id(15)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_pricing.tax_configuration_rule
         (tax_configuration_rule_id,tax_configuration_version_id,tax_configuration_id,brand_id,store_id,tax_classification_id,
          order_type,charge_type,tax_component_code,treatment,tax_rate,price_inclusion,rounding_mode,calculation_order,
          compound_on_prior_tax,receipt_presentation_code)
         VALUES ($1,$2,$3,$4,$5,$6,'DineIn','Tip','INVALID_EXEMPT','Exempt',0,'Exclusive','HalfUp',1,false,'INVALID')`,
        [id(16), id(5), id(1), id(2), id(3), id(17)],
      ),
      /tax_configuration_rule_treatment_evidence_check/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_pricing, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_pricing TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.tax_configuration`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.tax_configuration`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(3)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.tax_configuration`)).rowCount, 1);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_pricing.tax_configuration_rule`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_pricing.tax_configuration`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("pins Store Tax Configuration evidence, immutable versions and exact Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "tax_configuration", root }, prove);
}, 120_000);
