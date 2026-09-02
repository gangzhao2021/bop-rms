import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9e10-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";
const digest = `sha256:${"b".repeat(64)}`;
async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2181_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_device.device(device_id,brand_id,store_id,device_type,device_code,safe_serial_suffix,lifecycle,aggregate_version,configuration_version,display_label_code,physical_location_reference,network_connection_type_code,adapter_type_code,adapter_version_code,locale,time_zone,output_profile_reference,heartbeat_interval_seconds,credential_reference,credential_version,credential_status,created_by_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,'KitchenDisplay','KDS_02','EFGH5678','Active',1,1,'HOT_KDS',$4,'MANAGED_BROWSER','BROWSER_KDS','V1','en-CA','America/Toronto',NULL,60,$5,1,'Active',$6,$7,$7,'CredentialMetadata')`,
      [id(10), id(1), id(2), id(11), id(12), id(13), at],
    );
    for (const [offset, capability] of [
      [14, "TOUCH_INPUT"],
      [15, "ORDER_ACKNOWLEDGEMENT"],
    ])
      await admin.query(
        `INSERT INTO rms_device.device_capability_version(capability_version_id,brand_id,store_id,device_id,configuration_version,capability_code,validated_model_reference,validation_reference,recorded_at,data_classification) VALUES($1,$2,$3,$4,1,$5,$6,$7,$8,'IndirectIdentifier')`,
        [id(offset), id(1), id(2), id(10), capability, id(16), id(17), at],
      );
    await admin.query(
      `INSERT INTO rms_device.kds_profile(profile_id,brand_id,store_id,lifecycle,aggregate_version,current_version_reference,created_by_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,'Draft',1,$4,$5,$6,$6,'Confidential')`,
      [id(20), id(1), id(2), id(21), id(13), at],
    );
    await admin.query(
      `INSERT INTO rms_device.kds_profile_version(version_id,brand_id,store_id,profile_id,version_number,profile_label_code,browser_family,minimum_logical_width,minimum_logical_height,wake_policy_code,power_policy_code,auto_lock_seconds,visibility_loss_locks,handover_policy,notification_mode,network_procedure_code,replacement_procedure_code,checklist_version_code,created_at,data_classification) VALUES($1,$2,$3,$4,1,'HOT_KDS','ChromiumManaged',1024,768,'STORE_HOURS','MANAGED_AC',120,true,'LockThenRotateNamedSession','VisualAndAudible','KDS-NETWORK-RECOVERY-V1','KDS-REPLACEMENT-V1','KDS_UAT_V1',$5,'Confidential')`,
      [id(21), id(1), id(2), id(20), at],
    );
    await admin.query(
      `INSERT INTO rms_device.kds_profile_assignment(assignment_record_id,brand_id,store_id,profile_id,device_id,station_reference,assignment_action,effective_from,effective_to,aggregate_version,recorded_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,'Assigned',$7,NULL,2,$7,'Confidential')`,
      [id(22), id(1), id(2), id(20), id(10), id(11), at],
    );
    await admin.query(
      `INSERT INTO rms_device.kds_uat_run(run_id,brand_id,store_id,profile_id,profile_version_reference,device_id,station_reference,run_number,checklist_version_code,browser_version_code,logical_width,logical_height,status,due_at,started_at,completed_at,evidence_reference,aggregate_version,recorded_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,1,'KDS_UAT_V1','CHROME_140',1024,768,'Blocked',$8,$9,$9,NULL,3,$9,'Confidential')`,
      [id(23), id(1), id(2), id(20), id(21), id(10), id(11), later, at],
    );
    await admin.query(
      `INSERT INTO rms_device.kds_uat_check_result(result_id,brand_id,store_id,run_id,check_code,outcome,safe_result_code,recorded_at,data_classification) VALUES($1,$2,$3,$4,'NETWORK_LOSS','Blocked','EXTERNAL_EVIDENCE_UNAVAILABLE',$5,'Confidential')`,
      [id(24), id(1), id(2), id(23), at],
    );
    await admin.query(
      `INSERT INTO rms_device.kds_profile_operation(operation_id,brand_id,store_id,profile_id,command_type,intent_digest,aggregate_version,occurred_at,audit_reference,data_classification) VALUES($1,$2,$3,$4,'CreateKdsProfile',$5,1,$6,$7,'Confidential')`,
      [id(25), id(1), id(2), id(20), digest, at, id(26)],
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_device.kds_profile SET aggregate_version=3,updated_at=$1 WHERE profile_id=$2`,
        [later, id(20)],
      ),
      /KDS profile identity or revision is invalid/u,
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_device.kds_profile_version SET auto_lock_seconds=300 WHERE version_id=$1`,
        [id(21)],
      ),
      /device history is append-only/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_device.kds_profile_version(version_id,brand_id,store_id,profile_id,version_number,profile_label_code,browser_family,minimum_logical_width,minimum_logical_height,wake_policy_code,power_policy_code,auto_lock_seconds,visibility_loss_locks,handover_policy,notification_mode,network_procedure_code,replacement_procedure_code,checklist_version_code,created_at,data_classification) VALUES($1,$2,$3,$4,2,'BAD','ChromiumManaged',800,600,'WAKE','POWER',30,false,'LockThenRotateNamedSession','VisualOnly','KDS-NETWORK-RECOVERY-V1','KDS-REPLACEMENT-V1','KDS_UAT_V1',$5,'Confidential')`,
        [id(27), id(1), id(2), id(20), at],
      ),
      /kds_profile_version_/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_device.kds_uat_run(run_id,brand_id,store_id,profile_id,profile_version_reference,device_id,station_reference,run_number,checklist_version_code,browser_version_code,logical_width,logical_height,status,due_at,started_at,completed_at,evidence_reference,aggregate_version,recorded_at,data_classification) VALUES($1,$2,$3,$4,$5,$6,$7,2,'KDS_UAT_V1','CHROME_140',1024,768,'Passed',$8,$9,$9,NULL,4,$9,'Confidential')`,
        [id(28), id(1), id(2), id(20), id(21), id(10), id(11), later, at],
      ),
      /kds_uat_run_shape/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_device,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_device.kds_profile,rms_device.kds_profile_version,rms_device.kds_profile_assignment,rms_device.kds_uat_run,rms_device.kds_uat_check_result,rms_device.kds_profile_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_device.kds_profile`)).rowCount, 0);
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(1), id(2)],
    );
    assert.equal((await admin.query(`SELECT * FROM rms_device.kds_profile`)).rowCount, 1);
    assert.equal((await admin.query(`SELECT * FROM rms_device.kds_uat_check_result`)).rowCount, 1);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_device.kds_profile`)).rowCount, 0);
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces KDS Profile revision, immutable UAT evidence and Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "kds_profile", root }, prove);
}, 120_000);
