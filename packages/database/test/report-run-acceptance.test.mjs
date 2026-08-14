import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9811-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const at = "2026-08-14T16:00:00.000Z";
const completeAt = "2026-08-14T16:02:00.000Z";
const expiresAt = "2026-08-15T16:02:00.000Z";

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2162_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_reporting.report_definition(report_id,tenant_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'DAILY_OPERATIONS',1,$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,certification_status,report_name_code,purpose_code,owner_reference,visualization,row_limit,default_time_range,timezone,data_freshness_seconds,scope_policy,audience,export_csv,export_json,export_row_limit,effective_from,validation_evidence_id,approval_evidence_id,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,1,$5,'Published','Certified','DAILY_OPERATIONS','MANAGEMENT_OPERATIONS',$6,'Table',500,'BusinessDate','America/Toronto',300,'Brand','Manager',true,false,500,$7,$8,$9,$7,$10)`,
      [id(5), id(1), id(2), id(3), digest("a"), id(4), at, id(6), id(7), id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_run(run_id,report_id,report_version_id,tenant_id,brand_id,parameter_snapshot_digest,trigger_kind,triggered_by_actor_id,queued_at) VALUES($1,$2,$3,$4,$5,$6,'Manual',$7,$8)`,
      [id(8), id(1), id(5), id(2), id(3), digest("b"), id(4), at],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_run_metric_reference(run_id,tenant_id,brand_id,metric_version_reference) VALUES($1,$2,$3,$4)`,
      [id(8), id(2), id(3), id(9)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_run_state_record(state_id,run_id,tenant_id,brand_id,sequence,status,occurred_at,actor_id) VALUES($1,$2,$3,$4,1,'Queued',$5,$6)`,
      [id(10), id(8), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_run_state_record(state_id,run_id,tenant_id,brand_id,sequence,status,occurred_at,actor_id,data_as_of,projection_checkpoint,generated_at,duration_milliseconds,row_count,summary_digest) VALUES($1,$2,$3,$4,2,'Completed',$5,$6,$7,'WAREHOUSE_42',$5,120000,42,$8)`,
      [id(11), id(8), id(2), id(3), completeAt, id(4), at, digest("c")],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_artifact(artifact_id,run_id,tenant_id,brand_id,created_at) VALUES($1,$2,$3,$4,$5)`,
      [id(12), id(8), id(2), id(3), completeAt],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_artifact_revision(revision_id,artifact_id,run_id,tenant_id,brand_id,revision_number,output_asset_reference,format,data_classification,created_at,expires_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,1,$6,'Csv','Internal',$7,$8,$9)`,
      [id(13), id(12), id(8), id(2), id(3), id(14), completeAt, expiresAt, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_artifact_revocation(revocation_id,artifact_id,revision_id,tenant_id,brand_id,reason_code,revoked_at,revoked_by_actor_id) VALUES($1,$2,$3,$4,$5,'ACCESS_REVOKED',$6,$7)`,
      [id(15), id(12), id(13), id(2), id(3), completeAt, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_run_operation_record(operation_id,run_id,tenant_id,brand_id,action_code,intent_digest,result_reference,outbox_event_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,'Queue',$5,$6,$7,$8,$9)`,
      [id(16), id(8), id(2), id(3), digest("d"), id(8), id(17), id(18), at],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_artifact_download_record(download_record_id,artifact_id,revision_id,tenant_id,brand_id,actor_id,authorized_at,audit_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,
      [id(19), id(12), id(13), id(2), id(3), id(4), completeAt, id(20)],
    );

    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.report_run_state_record(state_id,run_id,tenant_id,brand_id,sequence,status,occurred_at,actor_id,row_count) VALUES($1,$2,$3,$4,3,'Completed',$5,$6,1)`,
        [id(21), id(8), id(2), id(3), completeAt, id(4)],
      ),
      /report_run_state_result_alignment_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.report_artifact_revision(revision_id,artifact_id,run_id,tenant_id,brand_id,revision_number,output_asset_reference,format,data_classification,created_at,expires_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,2,$6,'Pdf','Restricted',$7,$7,$8)`,
        [id(22), id(12), id(8), id(2), id(3), id(23), completeAt, id(4)],
      ),
      /report_artifact_revision_expiry_check/u,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_reporting.report_run SET trigger_kind='Scheduled' WHERE run_id=$1`,
          [id(8)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_reporting.report_artifact_revision WHERE revision_id=$1`,
          [id(13)],
        )
      ).rowCount,
      0,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_reporting,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_reporting TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.report_run`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal(
      (
        await admin.query(
          `SELECT status FROM rms_reporting.report_run_state_record ORDER BY sequence`,
        )
      ).rowCount,
      2,
    );
    assert.equal(
      (
        await admin.query(
          `SELECT output_asset_reference FROM rms_reporting.report_artifact_revision`,
        )
      ).rows[0].output_asset_reference,
      id(14),
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.report_artifact`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Report Runs, artifacts, revocations and Brand RLS append-only", async () => {
  await withIsolatedDatabase({ caseId: "report_run", root }, prove);
}, 120_000);
