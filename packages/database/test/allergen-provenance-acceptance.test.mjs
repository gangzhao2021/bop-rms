import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f7800-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-02T16:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp1028_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_catalog.menu (menu_id,brand_id,internal_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES ($1,$2,'ALL_DAY',1,$3,$4,$3)`,
      [id(1), id(2), at, id(3)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_version (menu_version_id,menu_id,brand_id,status,default_locale,localized_names_json,created_at,updated_at) VALUES ($1,$2,$3,'Draft','en-CA','{"en-CA":"All Day"}'::jsonb,$4,$4)`,
      [id(4), id(1), id(2), at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.allergen_registry_version (registry_version_id,brand_id,jurisdiction_code,policy_document_digest,reviewed_at,reviewer_actor_id,status) VALUES ($1,$2,'CA',$3,$4,$5,'Approved')`,
      [id(6), id(2), digest, at, id(7)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.allergen_registry_entry (registry_version_id,brand_id,allergen_id,allergen_code,localized_names_json) VALUES ($1,$2,$3,'MILK','{"en-CA":"Milk"}'::jsonb)`,
      [id(6), id(2), id(8)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.allergen_source_evidence (evidence_id,brand_id,subject_id,subject_kind,source_version_id,supplier_id,document_digest,reviewed_at,valid_until,evidence_status) VALUES ($1,$2,$3,'Ingredient',$4,$5,$6,$7,$8,'Approved')`,
      [id(9), id(2), id(10), id(11), id(12), digest, at, "2026-08-03T16:00:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_catalog.allergen_source_assertion (evidence_id,brand_id,registry_version_id,allergen_id,classification) VALUES ($1,$2,$3,$4,'Contains')`,
      [id(9), id(2), id(6), id(8)],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_allergen_validation_evidence (validation_evidence_id,brand_id,menu_id,menu_version_id,snapshot_digest,registry_version_id,checked_at,valid_until,validation_status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'Pass')`,
      [id(13), id(2), id(1), id(4), digest, id(6), at, "2026-08-03T16:00:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_sellable_allergen_disclosure (validation_evidence_id,brand_id,menu_id,menu_version_id,sellable_id,product_version_id,disclosure_json) VALUES ($1,$2,$3,$4,$5,$6,'{"items":[{"code":"MILK","classification":"Contains"}]}'::jsonb)`,
      [id(13), id(2), id(1), id(4), id(14), id(15)],
    );
    await admin.query(
      `UPDATE rms_catalog.allergen_source_evidence SET evidence_status='Invalidated' WHERE evidence_id=$1`,
      [id(9)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT evidence_status FROM rms_catalog.allergen_source_evidence WHERE evidence_id=$1`,
          [id(9)],
        )
      ).rows[0].evidence_status,
      "Approved",
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.allergen_source_assertion (evidence_id,brand_id,registry_version_id,allergen_id,classification) VALUES ($1,$2,$3,$4,'Absent')`,
        [id(9), id(2), id(6), id(16)],
      ),
      /allergen_source_assertion_classification_check/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_catalog.allergen_source_evidence`)).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_catalog.allergen_source_evidence`)).rowCount,
      1,
    );
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("pins allergen provenance, disclosures, append-only evidence and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "allergen_provenance", root }, prove);
}, 120_000);
