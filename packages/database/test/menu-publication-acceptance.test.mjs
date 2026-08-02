import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f7200-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-01T16:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp1024_${context.runId}`;
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
      `INSERT INTO rms_catalog.menu_publication_revision (lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,snapshot_digest,state,validation_evidence_id,approval_evidence_id,changed_at) VALUES ($1,4,$2,$3,$4,$5,'Published',$6,$7,$8)`,
      [id(5), id(1), id(4), id(2), digest, id(6), id(7), at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_publication_release (release_id,lifecycle_id,lifecycle_version,menu_id,menu_version_id,brand_id,release_sequence,release_kind,snapshot_digest,created_at) VALUES ($1,$2,4,$3,$4,$5,1,'Publish',$6,$7)`,
      [id(8), id(5), id(1), id(4), id(2), digest, at],
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_release_effective_period (timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES ($1,$2,$3,$4,'UTC',$5,$6,$7,$8,$5)`,
      [id(9), id(8), id(1), id(2), at, "2026-08-02T00:00:00.000Z", digest, id(7)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_catalog.menu_release_effective_period (timing_version_id,release_id,menu_id,brand_id,time_zone,effective_from,effective_until,period_digest,approval_evidence_id,created_at) VALUES ($1,$2,$3,$4,'UTC',$5,NULL,$6,$7,$5)`,
        [id(10), id(8), id(1), id(2), "2026-08-01T20:00:00.000Z", digest, id(7)],
      ),
      /overlapping menu effective period/u,
    );
    await admin.query(
      `INSERT INTO rms_catalog.menu_publication_operation_record (operation_id,brand_id,menu_id,menu_version_id,action_code,intent_digest,result_lifecycle_version,occurred_at) VALUES ($1,$2,$3,$4,'Publish',$5,4,$6)`,
      [id(11), id(2), id(1), id(4), digest, at],
    );
    await admin.query(
      `UPDATE rms_catalog.menu_publication_operation_record SET result_lifecycle_version=5 WHERE operation_id=$1`,
      [id(11)],
    );
    assert.equal(
      (
        await admin.query(
          `SELECT result_lifecycle_version FROM rms_catalog.menu_publication_operation_record WHERE operation_id=$1`,
          [id(11)],
        )
      ).rows[0].result_lifecycle_version,
      4,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_catalog, platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(), platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_catalog TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_catalog.menu_publication_release`)).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(2)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_catalog.menu_publication_release`)).rowCount,
      1,
    );
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces Menu publication immutability, timing and Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "menu_publication", root }, prove);
}, 120_000);
