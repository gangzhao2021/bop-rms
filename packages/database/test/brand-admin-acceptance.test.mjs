import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9e80-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z",
  later = "2026-08-15T15:00:00.000Z",
  digest = `sha256:${"d".repeat(64)}`;
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2191_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_tenant.brand VALUES($1,'NORTH','Synthetic North','en-CA','CAD','Active',1,$2,$2)`,
      [id(1), at],
    );
    await admin.query(
      `INSERT INTO bop_tenant.store VALUES($1,$2,'TORONTO_1','Synthetic Toronto','America/Toronto','en-CA','CAD','Active',1,$3,$3)`,
      [id(2), id(1), at],
    );
    await admin.query(
      `INSERT INTO bop_tenant.brand_configuration_version(configuration_version_id,brand_id,configuration_version,lifecycle,default_locale,supported_locales,media_theme_reference,catalog_source_reference,platform_template_reference,override_allowed_field_codes,hard_requirement_field_codes,effective_from,effective_until,supersedes_version_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,updated_at,data_classification)VALUES($1,$2,1,'Published','en-CA',ARRAY['en-CA','fr-CA'],$3,$4,$5,ARRAY['DISPLAY.THEME'],ARRAY['SECURITY.REAUTH'],$6,NULL,NULL,'INITIAL_CONFIGURATION',$7,$8,$9,$10,$6,$6,'ConfigurationMetadata')`,
      [id(10), id(1), id(11), id(12), id(13), at, id(20), id(21), id(22), id(23)],
    );
    await admin.query(
      `INSERT INTO bop_tenant.brand_store_membership_record(membership_record_id,brand_id,store_id,action,effective_at,brand_version,actor_reference,approval_evidence_reference,operation_reference,recorded_at,data_classification)VALUES($1,$2,$3,'Added',$4,1,$5,$6,$7,$4,'ConfigurationMetadata')`,
      [id(14), id(1), id(2), at, id(20), id(22), id(24)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO bop_tenant.brand_store_membership_record(membership_record_id,brand_id,store_id,action,effective_at,brand_version,actor_reference,approval_evidence_reference,operation_reference,recorded_at,data_classification)VALUES($1,$2,$3,'Added',$4,1,$5,$6,$7,$4,'ConfigurationMetadata')`,
        [id(15), id(1), id(2), later, id(20), id(22), id(25)],
      ),
      /membership sequence is invalid/u,
    );
    await admin.query(
      `INSERT INTO bop_tenant.brand_admin_operation(operation_id,brand_id,command_type,intent_digest,brand_version,actor_reference,purpose_code,audit_reference,occurred_at,data_classification)VALUES($1,$2,'PublishConfiguration',$3,1,$4,'BRAND.ADMINISTRATION',$5,$6,'ConfigurationMetadata')`,
      [id(16), id(1), digest, id(21), id(26), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_tenant.brand_configuration_version SET reason_code='CHANGED' WHERE configuration_version_id=$1`,
        [id(10)],
      ),
      /history is append-only/u,
    );
    await assert.rejects(
      admin.query(`UPDATE bop_tenant.brand SET version=3,updated_at=$1 WHERE brand_id=$2`, [
        later,
        id(1),
      ]),
      /identity or revision is invalid/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_tenant,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON bop_tenant.brand_configuration_version,bop_tenant.brand_store_membership_record,bop_tenant.brand_admin_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.brand_configuration_version`)).rowCount,
      0,
    );
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id','',false)`,
      [id(1)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.brand_configuration_version`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.brand_store_membership_record`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(2)]);
    assert.equal((await admin.query(`SELECT * FROM bop_tenant.brand_admin_operation`)).rowCount, 0);
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces immutable Brand configuration, membership sequence, revision and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "brand_admin", root }, prove);
}, 120_000);
