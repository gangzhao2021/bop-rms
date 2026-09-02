import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9912-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const before = "2026-08-14T17:00:00.000Z";
const at = "2026-08-14T18:00:00.000Z";
const later = "2026-08-14T19:00:00.000Z";

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2164_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_check(check_id,tenant_id,brand_id,aggregate_version,lifecycle,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,1,'Active',$4,$5,$4)`,
      [id(1), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_check_version(check_version_id,check_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,check_kind,dataset_version_reference,partition_code,rule_code,expectation_code,default_severity,owner_id,effective_from,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,1,$5,'Active','Completeness',$6,'BUSINESS_DATE_2026_08_14','ORDER_TOTAL_PRESENT','NULL_COUNT_ZERO','Critical',$7,$8,$9,$10)`,
      [id(5), id(1), id(2), id(3), digest("a"), id(6), id(7), before, at, id(4)],
    );
    await admin.query(
      `UPDATE rms_reporting.data_quality_check SET current_version_id=$1 WHERE check_id=$2`,
      [id(5), id(1)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_result(result_id,execution_id,check_id,check_version_id,tenant_id,brand_id,dataset_version_reference,partition_code,outcome,severity,expected_observation_code,actual_observation_code,publication_disposition,affected_from,affected_until,detected_at) VALUES($1,$2,$3,$4,$5,$6,$7,'BUSINESS_DATE_2026_08_14','Fail','Critical','NULL_COUNT_ZERO','NULL_COUNT_THREE','BlockFormalReporting',$8,$9,$9)`,
      [id(8), id(9), id(1), id(5), id(2), id(3), id(6), before, at],
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_result(result_id,execution_id,check_id,check_version_id,tenant_id,brand_id,dataset_version_reference,partition_code,outcome,severity,expected_observation_code,actual_observation_code,publication_disposition,affected_from,affected_until,detected_at) VALUES($1,$2,$3,$4,$5,$6,$7,'BUSINESS_DATE_2026_08_14','Pass','Critical','NULL_COUNT_ZERO','NULL_COUNT_ZERO','ContinueFormalReporting',$8,$9,$10)`,
      [id(10), id(11), id(1), id(5), id(2), id(3), id(6), before, at, later],
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_issue_action(action_id,result_id,tenant_id,brand_id,sequence,action,rerun_result_id,resolution_code,occurred_at,actor_id) VALUES($1,$2,$3,$4,1,'Resolve',$5,'RERUN_PASSED',$6,$7)`,
      [id(12), id(8), id(2), id(3), id(10), later, id(4)],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.data_quality_issue_action(action_id,result_id,tenant_id,brand_id,sequence,action,resolution_code,occurred_at,actor_id) VALUES($1,$2,$3,$4,2,'Acknowledge','PARTIAL_RESOLUTION',$5,$6)`,
        [id(26), id(8), id(2), id(3), later, id(4)],
      ),
      /data_quality_issue_action_alignment_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.data_quality_result(result_id,execution_id,check_id,check_version_id,tenant_id,brand_id,dataset_version_reference,partition_code,outcome,severity,expected_observation_code,actual_observation_code,publication_disposition,affected_from,affected_until,detected_at) VALUES($1,$2,$3,$4,$5,$6,$7,'BUSINESS_DATE_2026_08_14','Pass','Critical','NULL_COUNT_ZERO','NULL_COUNT_ZERO','BlockFormalReporting',$8,$9,$9)`,
        [id(13), id(14), id(1), id(5), id(2), id(3), id(6), before, at],
      ),
      /data_quality_result_publication_check/u,
    );

    await admin.query(
      `INSERT INTO rms_reporting.reconciliation_run(run_id,tenant_id,brand_id,control,period_from,period_until,left_observation_reference,right_observation_reference,expected_value,actual_value,difference_value,unit_code,outcome,detected_at) VALUES($1,$2,$3,'PaymentLedger',$4,$5,$6,$7,'0.3','0.1','0.2','CAD','Difference',$5)`,
      [id(15), id(2), id(3), before, at, id(16), id(17)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.reconciliation_run(run_id,tenant_id,brand_id,control,period_from,period_until,left_observation_reference,right_observation_reference,expected_value,actual_value,difference_value,unit_code,outcome,detected_at) VALUES($1,$2,$3,'PaymentLedger',$4,$5,$6,$7,'0.3','0.3','0.0','CAD','Matched',$8)`,
      [id(18), id(2), id(3), before, at, id(16), id(17), later],
    );
    await admin.query(
      `INSERT INTO rms_reporting.reconciliation_exception_state(state_id,exception_id,run_id,tenant_id,brand_id,sequence,status,occurred_at,actor_id) VALUES($1,$2,$3,$4,$5,1,'Open',$6,$7)`,
      [id(19), id(20), id(15), id(2), id(3), at, id(4)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.reconciliation_exception_state(state_id,exception_id,run_id,tenant_id,brand_id,sequence,status,owner_id,resolution_code,resolution_rerun_id,occurred_at,actor_id) VALUES($1,$2,$3,$4,$5,2,'Resolved',$6,'RERUN_MATCHED',$7,$8,$6)`,
      [id(21), id(20), id(15), id(2), id(3), id(4), id(18), later],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.reconciliation_run(run_id,tenant_id,brand_id,control,period_from,period_until,left_observation_reference,right_observation_reference,expected_value,actual_value,difference_value,unit_code,outcome,detected_at) VALUES($1,$2,$3,'PaymentLedger',$4,$5,$6,$7,'0.3','0.1','0.2','CAD','Matched',$5)`,
        [id(22), id(2), id(3), before, at, id(16), id(17)],
      ),
      /reconciliation_run_outcome_alignment_check/u,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_reporting.reconciliation_exception_state SET status='Open' WHERE state_id=$1`,
          [id(21)],
        )
      ).rowCount,
      0,
    );
    await admin.query(
      `INSERT INTO rms_reporting.data_quality_operation_record(operation_id,tenant_id,brand_id,action,intent_digest,result_reference,outbox_event_id,event_type,audit_id,occurred_at) VALUES($1,$2,$3,'RecordResult',$4,$5,$6,'DataQualityIssueDetected',$7,$8)`,
      [id(23), id(2), id(3), digest("b"), id(8), id(24), id(25), at],
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.data_quality_operation_record(operation_id,tenant_id,brand_id,action,intent_digest,result_reference,outbox_event_id,event_type,audit_id,occurred_at) VALUES($1,$2,$3,'CreateCheck',$4,$5,$6,'ReconciliationDifferenceDetected',$7,$8)`,
        [id(27), id(2), id(3), digest("c"), id(1), id(28), id(29), at],
      ),
      /data_quality_operation_event_alignment_check/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_reporting,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_reporting TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_reporting.data_quality_result`)).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_reporting.data_quality_result`)).rowCount,
      2,
    );
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.reconciliation_run`)).rowCount, 2);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.data_quality_check`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Data Quality results and Reconciliation history append-only and Brand scoped", async () => {
  await withIsolatedDatabase({ caseId: "dq_reconciliation", root }, prove);
}, 120_000);
