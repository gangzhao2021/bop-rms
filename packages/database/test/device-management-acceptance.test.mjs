import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const id = (n) => `018f9e00-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const at = "2026-08-15T10:00:00.000Z";
const later = "2026-08-15T11:00:00.000Z";
const digest = `sha256:${"a".repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig);
  const role = `wp2180_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_device.device(
        device_id,brand_id,store_id,device_type,device_code,safe_serial_suffix,lifecycle,
        aggregate_version,configuration_version,display_label_code,physical_location_reference,
        network_connection_type_code,adapter_type_code,adapter_version_code,locale,time_zone,
        output_profile_reference,heartbeat_interval_seconds,credential_reference,credential_version,
        credential_status,created_by_reference,created_at,updated_at,data_classification
      ) VALUES($1,$2,$3,'KitchenDisplay','KDS_01','ABCD1234','Draft',1,1,'HOT_KITCHEN',
        $4,'MANAGED_BROWSER','BROWSER_KDS','V1','en-CA','America/Toronto',NULL,60,$5,1,
        'Active',$6,$7,$7,'CredentialMetadata')`,
      [id(10), id(1), id(2), id(11), id(12), id(13), at],
    );
    await admin.query(
      `INSERT INTO rms_device.device_capability_version(
        capability_version_id,brand_id,store_id,device_id,configuration_version,capability_code,
        validated_model_reference,validation_reference,recorded_at,data_classification
      ) VALUES($1,$2,$3,$4,1,'TOUCH_INPUT',$5,$6,$7,'IndirectIdentifier')`,
      [id(14), id(1), id(2), id(10), id(15), id(16), at],
    );
    await admin.query(
      `INSERT INTO rms_device.device_assignment(
        assignment_record_id,brand_id,store_id,device_id,assignment_reference,assignment_action,
        station_reference,profile_reference,configuration_source_reference,
        named_operator_session_summary_reference,effective_from,effective_to,aggregate_version,
        recorded_at,data_classification
      ) VALUES($1,$2,$3,$4,$5,'Assigned',$6,NULL,$7,NULL,$8,NULL,2,$8,'Confidential')`,
      [id(17), id(1), id(2), id(10), id(18), id(11), id(19), at],
    );
    await admin.query(
      `INSERT INTO rms_device.device_health_signal(
        signal_id,brand_id,store_id,device_id,health,connectivity,observed_at,last_seen_at,
        heartbeat_due_at,software_version_code,profile_version_code,incident_reference,
        data_classification
      ) VALUES($1,$2,$3,$4,'Unknown','Offline',$5,NULL,$6,'CHROME_140','KDS_PROFILE_V1',NULL,
        'IndirectIdentifier')`,
      [id(20), id(1), id(2), id(10), at, later],
    );
    await admin.query(
      `INSERT INTO rms_device.device_health_current(
        brand_id,store_id,device_id,signal_id,health,connectivity,observed_at,projection_version,
        data_classification
      ) VALUES($1,$2,$3,$4,'Unknown','Offline',$5,1,'IndirectIdentifier')`,
      [id(1), id(2), id(10), id(20), at],
    );
    await admin.query(
      `INSERT INTO rms_device.device_operation(
        operation_id,brand_id,store_id,device_id,command_type,intent_digest,aggregate_version,
        occurred_at,audit_reference,data_classification
      ) VALUES($1,$2,$3,$4,'RegisterDevice',$5,1,$6,$7,'CredentialMetadata')`,
      [id(21), id(1), id(2), id(10), digest, at, id(22)],
    );

    await assert.rejects(
      admin.query(
        `UPDATE rms_device.device SET aggregate_version=3,updated_at=$1 WHERE device_id=$2`,
        [later, id(10)],
      ),
      /device identity or revision is invalid/u,
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_device.device_capability_version SET capability_code='PRINT_TEXT'
         WHERE capability_version_id=$1`,
        [id(14)],
      ),
      /device history is append-only/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_device.device_health_signal(
          signal_id,brand_id,store_id,device_id,health,connectivity,observed_at,last_seen_at,
          heartbeat_due_at,software_version_code,profile_version_code,incident_reference,
          data_classification
        ) VALUES($1,$2,$3,$4,'Healthy','Offline',$5,NULL,$6,'V1','V1',NULL,
          'IndirectIdentifier')`,
        [id(23), id(1), id(2), id(10), at, later],
      ),
      /device_health_signal_shape/u,
    );

    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_device,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_device.device,rms_device.device_assignment,
       rms_device.device_capability_version,rms_device.device_health_signal,
       rms_device.device_health_current,rms_device.device_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_device.device`)).rowCount, 0);
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(1), id(2)],
    );
    assert.equal((await admin.query(`SELECT * FROM rms_device.device`)).rowCount, 1);
    assert.equal((await admin.query(`SELECT * FROM rms_device.device_health_signal`)).rowCount, 1);
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(99)]);
    assert.equal((await admin.query(`SELECT * FROM rms_device.device`)).rowCount, 0);
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces Device revision, append-only history, Health shape and Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "device_management", root }, prove);
}, 120_000);
