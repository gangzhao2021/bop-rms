import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9801-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const at = "2026-08-14T16:00:00.000Z";

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2161_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_reporting.report_definition(report_id,tenant_id,brand_id,stable_code,aggregate_version,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'DAILY_OPERATIONS',1,$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,certification_status,report_name_code,purpose_code,owner_reference,visualization,row_limit,default_time_range,timezone,data_freshness_seconds,scope_policy,audience,export_csv,export_json,export_row_limit,effective_from,validation_evidence_id,approval_evidence_id,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,1,$5,'Published','Certified','DAILY_OPERATIONS_NAME','MANAGEMENT_OPERATIONS',$6,'Table',500,'BusinessDate','America/Toronto',300,'Brand','Manager',true,true,500,$7,$8,$9,$7,$10)`,
      [id(11), id(1), id(2), id(3), digest("a"), id(4), at, id(12), id(13), id(14)],
    );
    await admin.query(
      `UPDATE rms_reporting.report_definition SET current_version_id=$1,aggregate_version=2,updated_at=$2 WHERE report_id=$3`,
      [id(11), at, id(1)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_dataset_reference(report_version_id,report_id,tenant_id,brand_id,dataset_version_reference) VALUES($1,$2,$3,$4,$5)`,
      [id(11), id(1), id(2), id(3), id(15)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_metric_reference(report_version_id,report_id,tenant_id,brand_id,metric_version_reference) VALUES($1,$2,$3,$4,$5)`,
      [id(11), id(1), id(2), id(3), id(16)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_dimension(report_version_id,report_id,tenant_id,brand_id,dimension_code) VALUES($1,$2,$3,$4,'STORE')`,
      [id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_filter(report_filter_id,report_version_id,report_id,tenant_id,brand_id,dimension_code,operator,value_codes) VALUES($1,$2,$3,$4,$5,'STORE','Equal',ARRAY['AUTHORIZED_STORE'])`,
      [id(17), id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_sort(report_sort_id,report_version_id,report_id,tenant_id,brand_id,field_code,direction,sequence) VALUES($1,$2,$3,$4,$5,'BUSINESS_DATE','Descending',1)`,
      [id(18), id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_operation_record(operation_id,report_id,report_version_id,tenant_id,brand_id,action_code,intent_digest,result_aggregate_version,outbox_event_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,'Publish',$6,2,$7,$8,$9)`,
      [id(19), id(1), id(11), id(2), id(3), digest("b"), id(20), id(21), at],
    );

    await admin.query(
      `INSERT INTO rms_reporting.report_schedule(schedule_id,report_id,tenant_id,brand_id,aggregate_version,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,1,$5,$6)`,
      [id(22), id(1), id(2), id(3), at, id(14)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_schedule_version(schedule_version_id,schedule_id,report_id,report_version_id,tenant_id,brand_id,version_number,status,cadence,local_time,timezone,format,recipient_scope_reference,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,1,'Active','Daily','06:30','America/Toronto','Csv',$7,$8,$9)`,
      [id(23), id(22), id(1), id(11), id(2), id(3), id(24), at, id(14)],
    );
    await admin.query(
      `UPDATE rms_reporting.report_schedule SET current_version_id=$1,aggregate_version=2 WHERE schedule_id=$2`,
      [id(23), id(22)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.report_schedule_operation_record(operation_id,schedule_id,schedule_version_id,tenant_id,brand_id,intent_digest,outbox_event_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id(25), id(22), id(23), id(2), id(3), digest("c"), id(26), id(27), at],
    );

    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.report_version(report_version_id,report_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,certification_status,report_name_code,purpose_code,owner_reference,visualization,row_limit,default_time_range,timezone,data_freshness_seconds,scope_policy,audience,export_csv,export_json,export_row_limit,effective_from,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,2,$5,'Published','Certified','INVALID_PUBLISH','MANAGEMENT_OPERATIONS',$6,'Table',1,'BusinessDate','America/Toronto',300,'Brand','Manager',false,false,1,$7,$7,$8)`,
        [id(28), id(1), id(2), id(3), digest("d"), id(4), at, id(14)],
      ),
      /report_version_state_alignment_check/u,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_reporting.report_version SET row_limit=1 WHERE report_version_id=$1`,
          [id(11)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_reporting.report_schedule_version SET cadence='Weekly' WHERE schedule_version_id=$1`,
          [id(23)],
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
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.report_definition`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal(
      (await admin.query(`SELECT stable_code FROM rms_reporting.report_definition`)).rows[0]
        .stable_code,
      "DAILY_OPERATIONS",
    );
    assert.equal(
      (
        await admin.query(
          `SELECT metric_version_reference FROM rms_reporting.report_metric_reference`,
        )
      ).rows[0].metric_version_reference,
      id(16),
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.report_definition`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Report versions, certification, schedules and Brand RLS exact", async () => {
  await withIsolatedDatabase({ caseId: "report_definition", root }, prove);
}, 120_000);
