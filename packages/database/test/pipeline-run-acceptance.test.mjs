import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9915-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const before = "2026-08-14T16:00:00.000Z";
const at = "2026-08-14T17:00:00.000Z";
const later = "2026-08-14T18:00:00.000Z";
const latest = "2026-08-14T19:00:00.000Z";

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2165_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_check(check_id,tenant_id,brand_id,aggregate_version,lifecycle,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,'Active',$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_check_version(check_version_id,check_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,check_kind,dataset_version_reference,partition_code,rule_code,expectation_code,default_severity,owner_id,effective_from,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,1,$5,'Active','Completeness',$6,'BUSINESS_DATE_2026_08_14','PIPELINE_OUTPUT_PRESENT','ROW_COUNT_PRESENT','Critical',$7,$8,$9,$7)`,
      [id(5), id(1), id(2), id(3), digest("a"), id(6), id(4), before, at],
    );
    await admin.query(
      `UPDATE rms_reporting.data_quality_check SET current_version_id=$1 WHERE check_id=$2`,
      [id(5), id(1)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_result(result_id,execution_id,check_id,check_version_id,tenant_id,brand_id,dataset_version_reference,partition_code,outcome,severity,expected_observation_code,actual_observation_code,publication_disposition,affected_from,affected_until,detected_at) VALUES($1,$2,$3,$4,$5,$6,$7,'BUSINESS_DATE_2026_08_14','Pass','Critical','ROW_COUNT_PRESENT','ROW_COUNT_PRESENT','ContinueFormalReporting',$8,$9,$9)`,
      [id(7), id(8), id(1), id(5), id(2), id(3), id(6), before, at],
    );
    for (const [run, detected] of [
      [id(9), at],
      [id(10), later],
    ]) {
      await admin.query(
        `INSERT INTO rms_reporting.reconciliation_run(run_id,tenant_id,brand_id,control,period_from,period_until,left_observation_reference,right_observation_reference,expected_value,actual_value,difference_value,unit_code,outcome,detected_at) VALUES($1,$2,$3,'OutputAttempt',$4,$5,$6,$7,'100','100','0','ROW','Matched',$8)`,
        [run, id(2), id(3), before, at, id(11), id(12), detected],
      );
    }
    await admin.query(
      `INSERT INTO rms_reporting.backfill_request(request_id,tenant_id,brand_id,aggregate_version,lifecycle,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,2,'Approved',$4,$5,$6)`,
      [id(13), id(2), id(3), before, id(14), at],
    );
    await admin.query(
      `INSERT INTO rms_reporting.backfill_request_version(request_version_id,request_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,pipeline_reference,pipeline_version_reference,transformation_version_reference,output_dataset_version_reference,output_partition_code,range_from,range_until,reason_code,requested_at,requested_by_actor_id,decided_at,decided_by_actor_id,recorded_at,recorded_by_actor_id) VALUES($1,$2,$3,$4,2,$5,'Approved',$6,$7,$8,$9,'BUSINESS_DATE_2026_08_14',$10,$11,'HISTORICAL_LOAD',$11,$12,$11,$13,$11,$13)`,
      [
        id(15),
        id(13),
        id(2),
        id(3),
        digest("b"),
        id(16),
        id(17),
        id(18),
        id(6),
        before,
        at,
        id(14),
        id(19),
      ],
    );
    await admin.query(
      `UPDATE rms_reporting.backfill_request SET current_version_id=$1 WHERE request_id=$2`,
      [id(15), id(13)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_run(run_id,tenant_id,brand_id,pipeline_reference,pipeline_version_reference,transformation_version_reference,input_checkpoint_reference,output_dataset_version_reference,output_partition_code,environment_code,logical_batch_digest,execution_kind,replay,backfill_request_version_id,pre_reconciliation_run_id,queued_at,requested_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BUSINESS_DATE_2026_08_14','TEST',$9,'Backfill',true,$10,$11,$12,$13)`,
      [
        id(20),
        id(2),
        id(3),
        id(16),
        id(17),
        id(18),
        id(21),
        id(6),
        digest("c"),
        id(15),
        id(9),
        at,
        id(19),
      ],
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_run_state(state_id,run_id,tenant_id,brand_id,sequence,status,occurred_at,actor_id) VALUES($1,$2,$3,$4,1,'Queued',$5,$6),($7,$2,$3,$4,2,'Running',$8,$6)`,
      [id(22), id(20), id(2), id(3), at, id(19), id(23), later],
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_run_state(state_id,run_id,tenant_id,brand_id,sequence,status,watermark_occurred_at,records_read,records_written,records_late,records_rejected,data_quality_result_id,post_reconciliation_run_id,occurred_at,actor_id) VALUES($1,$2,$3,$4,3,'SucceededWithWarning',$5,100,97,2,1,$6,$7,$8,$9)`,
      [id(24), id(20), id(2), id(3), at, id(7), id(10), latest, id(19)],
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_reporting.pipeline_run_state SET records_late=0 WHERE state_id=$1`,
          [id(24)],
        )
      ).rowCount,
      0,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.pipeline_run_state(state_id,run_id,tenant_id,brand_id,sequence,status,records_read,records_written,records_late,records_rejected,occurred_at,actor_id) VALUES($1,$2,$3,$4,4,'Succeeded',1,1,0,0,$5,$6)`,
        [id(25), id(20), id(2), id(3), latest, id(19)],
      ),
      /pipeline_run_state_terminal_alignment_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.pipeline_run(run_id,tenant_id,brand_id,pipeline_reference,pipeline_version_reference,transformation_version_reference,input_checkpoint_reference,output_dataset_version_reference,output_partition_code,environment_code,logical_batch_digest,execution_kind,replay,backfill_request_version_id,pre_reconciliation_run_id,queued_at,requested_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BUSINESS_DATE_2026_08_14','TEST',$9,'Rebuild',true,$10,$11,$12,$13)`,
        [
          id(26),
          id(2),
          id(3),
          id(16),
          id(17),
          id(18),
          id(21),
          id(6),
          digest("c"),
          id(15),
          id(9),
          at,
          id(19),
        ],
      ),
      /pipeline_run_original_logical_batch_unique/u,
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_run(run_id,tenant_id,brand_id,pipeline_reference,pipeline_version_reference,transformation_version_reference,input_checkpoint_reference,output_dataset_version_reference,output_partition_code,environment_code,logical_batch_digest,execution_kind,replay,queued_at,requested_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BUSINESS_DATE_2026_08_14','TEST',$9,'Load',false,$10,$11)`,
      [id(27), id(2), id(3), id(16), id(17), id(18), id(21), id(6), digest("d"), at, id(19)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_run_state(state_id,run_id,tenant_id,brand_id,sequence,status,records_read,records_written,records_late,records_rejected,error_reference,occurred_at,actor_id) VALUES($1,$2,$3,$4,1,'Failed',10,0,0,10,$5,$6,$7)`,
      [id(28), id(27), id(2), id(3), id(29), later, id(19)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_run(run_id,tenant_id,brand_id,pipeline_reference,pipeline_version_reference,transformation_version_reference,input_checkpoint_reference,output_dataset_version_reference,output_partition_code,environment_code,logical_batch_digest,execution_kind,replay,retry_of_run_id,queued_at,requested_by_actor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'BUSINESS_DATE_2026_08_14','TEST',$9,'Retry',true,$10,$11,$12)`,
      [
        id(30),
        id(2),
        id(3),
        id(16),
        id(17),
        id(18),
        id(21),
        id(6),
        digest("d"),
        id(27),
        latest,
        id(19),
      ],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.backfill_request_version(request_version_id,request_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,pipeline_reference,pipeline_version_reference,transformation_version_reference,output_dataset_version_reference,output_partition_code,range_from,range_until,reason_code,requested_at,requested_by_actor_id,decided_at,decided_by_actor_id,recorded_at,recorded_by_actor_id) VALUES($1,$2,$3,$4,3,$5,'Approved',$6,$7,$8,$9,'BUSINESS_DATE_2026_08_14',$10,$11,'HISTORICAL_LOAD',$11,$12,$11,$12,$11,$12)`,
        [
          id(31),
          id(13),
          id(2),
          id(3),
          digest("e"),
          id(16),
          id(17),
          id(18),
          id(6),
          before,
          at,
          id(14),
        ],
      ),
      /backfill_request_approver_check/u,
    );
    await admin.query(
      `INSERT INTO rms_reporting.pipeline_operation_record(operation_id,tenant_id,brand_id,action,intent_digest,result_reference,outbox_event_id,event_type,audit_id,occurred_at) VALUES($1,$2,$3,'AdvanceRun',$4,$5,$6,'AnalyticsBackfillCompleted',$7,$8)`,
      [id(32), id(2), id(3), digest("f"), id(24), id(33), id(34), latest],
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_reporting,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_reporting TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.pipeline_run`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.pipeline_run`)).rowCount, 3);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_reporting.backfill_request_version`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.pipeline_run_state`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Pipeline Runs, late counts and approved Backfills append-only and Brand scoped", async () => {
  await withIsolatedDatabase({ caseId: "pipeline_run", root }, prove);
}, 120_000);
