import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9911-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const digest = (character) => `sha256:${character.repeat(64)}`;
const at = "2026-08-14T18:00:00.000Z";

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2163_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_reporting.metric_definition(metric_id,tenant_id,brand_id,stable_code,owner_domain_code,business_owner_id,aggregate_version,lifecycle,created_at,created_by_actor_id,updated_at) VALUES($1,$2,$3,'NET_SALES','ORDERING',$4,1,'Draft',$5,$6,$5)`,
      [id(1), id(2), id(3), id(4), at, id(5)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,certification_status,display_name_code,business_definition_code,formula_reference,base_fact_reference,grain_code,time_semantics,timezone,currency_semantics,null_policy,query_expression_reference,last_successful_build_at,data_freshness_seconds,data_quality_status,effective_from,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,1,$5,'Certified','Certified','NET_SALES_NAME','NET_SALES_DEFINITION_V1',$6,$7,'STORE_BUSINESS_DATE_CURRENCY','BusinessDate','America/Toronto','OriginalCurrency','Fail',$8,$9,300,'Pass',$9,$9,$10)`,
      [id(11), id(1), id(2), id(3), digest("a"), id(12), id(13), id(14), at, id(5)],
    );
    await admin.query(
      `UPDATE rms_reporting.metric_definition SET current_version_id=$1,aggregate_version=2,lifecycle='Certified',updated_at=$2 WHERE metric_id=$3`,
      [id(11), at, id(1)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_dimension(metric_version_id,metric_id,tenant_id,brand_id,dimension_code) VALUES($1,$2,$3,$4,'STORE'),($1,$2,$3,$4,'BUSINESS_DATE')`,
      [id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_required_filter(metric_version_id,metric_id,tenant_id,brand_id,filter_code) VALUES($1,$2,$3,$4,'STORE')`,
      [id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_inclusion_rule(metric_version_id,metric_id,tenant_id,brand_id,rule_code) VALUES($1,$2,$3,$4,'COMPLETED_ORDER')`,
      [id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_exclusion_rule(metric_version_id,metric_id,tenant_id,brand_id,rule_code) VALUES($1,$2,$3,$4,'VOIDED_ORDER')`,
      [id(11), id(1), id(2), id(3)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_dataset_reference(metric_version_id,metric_id,tenant_id,brand_id,dataset_version_reference) VALUES($1,$2,$3,$4,$5)`,
      [id(11), id(1), id(2), id(3), id(15)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_transformation_reference(metric_version_id,metric_id,tenant_id,brand_id,transformation_version_reference) VALUES($1,$2,$3,$4,$5)`,
      [id(11), id(1), id(2), id(3), id(16)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_dependency_reference(metric_version_id,metric_id,tenant_id,brand_id,dependency_metric_version_reference) VALUES($1,$2,$3,$4,$5)`,
      [id(11), id(1), id(2), id(3), id(17)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_certification_evidence(certification_id,metric_version_id,metric_id,tenant_id,brand_id,validation_evidence_reference,business_approval_evidence_reference,business_approver_actor_id,data_approval_evidence_reference,data_approver_actor_id,certified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id(18), id(11), id(1), id(2), id(3), id(19), id(20), id(4), id(21), id(22), at],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_operation_record(operation_id,metric_id,metric_version_id,tenant_id,brand_id,action,intent_digest,primary_outbox_event_id,secondary_outbox_event_id,audit_id,occurred_at) VALUES($1,$2,$3,$4,$5,'Certify',$6,$7,$8,$9,$10)`,
      [id(23), id(1), id(11), id(2), id(3), digest("b"), id(24), id(25), id(26), at],
    );
    await admin.query(
      `INSERT INTO rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,certification_status,display_name_code,business_definition_code,formula_reference,base_fact_reference,grain_code,time_semantics,timezone,currency_semantics,null_policy,query_expression_reference,last_successful_build_at,data_freshness_seconds,data_quality_status,effective_from,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,2,$5,'Certified','Certified','NET_SALES_NAME','NET_SALES_DEFINITION_V1',$6,$7,'STORE_BUSINESS_DATE_CURRENCY','BusinessDate','America/Toronto','OriginalCurrency','Fail',$8,$9,300,'Pass',$9,$9,$10)`,
      [id(27), id(1), id(2), id(3), digest("d"), id(12), id(13), id(14), at, id(5)],
    );

    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.metric_version(metric_version_id,metric_id,tenant_id,brand_id,version_number,snapshot_digest,lifecycle,certification_status,display_name_code,business_definition_code,formula_reference,base_fact_reference,grain_code,time_semantics,timezone,currency_semantics,null_policy,query_expression_reference,data_freshness_seconds,data_quality_status,effective_from,created_at,created_by_actor_id) VALUES($1,$2,$3,$4,3,$5,'Certified','Certified','INVALID','INVALID',$6,$7,'STORE','BusinessDate','America/Toronto','None','Fail',$8,300,'Pending',$9,$9,$10)`,
        [id(32), id(1), id(2), id(3), digest("c"), id(12), id(13), id(14), at, id(5)],
      ),
      /metric_version_state_alignment_check/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.metric_certification_evidence(certification_id,metric_version_id,metric_id,tenant_id,brand_id,validation_evidence_reference,business_approval_evidence_reference,business_approver_actor_id,data_approval_evidence_reference,data_approver_actor_id,certified_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$10)`,
        [id(28), id(27), id(1), id(2), id(3), id(29), id(30), id(4), id(31), at],
      ),
      /metric_certification_role_separation/u,
    );
    assert.equal(
      (
        await admin.query(
          `UPDATE rms_reporting.metric_version SET grain_code='ORDER' WHERE metric_version_id=$1`,
          [id(11)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM rms_reporting.metric_dataset_reference WHERE metric_version_id=$1`,
          [id(11)],
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
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.metric_definition`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal(
      (await admin.query(`SELECT stable_code FROM rms_reporting.metric_definition`)).rows[0]
        .stable_code,
      "NET_SALES",
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_reporting.metric_dataset_reference`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.metric_version`)).rowCount, 0);
    await admin.query(`RESET ROLE`);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("keeps Metric Versions, lineage, dual-owner certification and Brand RLS exact", async () => {
  await withIsolatedDatabase({ caseId: "metric_definition", root }, prove);
}, 120_000);
