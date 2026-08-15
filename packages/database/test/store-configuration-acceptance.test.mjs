import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";

const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f30-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z",
  digest = `sha256:${"a".repeat(64)}`;

async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2192_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_store.store_configuration_version(configuration_id,brand_id,store_id,configuration_version,lifecycle,configuration_source,brand_base_version_reference,default_locale,currency_code,time_zone,business_day_start_local_time,address_reference,contact_reference,receipt_reference,tax_configuration_reference,payment_configuration_reference,capacity_configuration_reference,enabled_service_modes,effective_from,effective_until,supersedes_configuration_reference,reason_code,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,live_gate_evidence_reference,created_at,updated_at,data_classification) VALUES($1,$2,$3,1,'Published','StoreOverride',$4,'en-CA','CAD','America/Toronto','04:00:00',$5,$6,$7,$8,$9,NULL,ARRAY['DineIn','Pickup'],$10,NULL,NULL,'PILOT_CONFIGURATION',$11,$12,$13,$14,$15,$10,$10,'ConfigurationMetadata')`,
      [
        id(1),
        id(2),
        id(3),
        id(4),
        id(5),
        id(6),
        id(7),
        id(8),
        id(9),
        at,
        id(10),
        id(11),
        id(12),
        id(13),
        id(14),
      ],
    );
    await admin.query(
      `INSERT INTO rms_store.store_weekly_service_period VALUES($1,$2,$3,$4,1,1,'09:00:00','22:00:00',false,ARRAY['DineIn','Pickup'],900,1200,'ConfigurationMetadata')`,
      [id(20), id(2), id(3), id(1)],
    );
    await admin.query(
      `INSERT INTO rms_store.store_service_exception VALUES($1,$2,$3,$4,'2026-12-25','Holiday',$5,'ConfigurationMetadata')`,
      [id(21), id(2), id(3), id(1), digest],
    );
    await admin.query(
      `INSERT INTO rms_store.store_configuration_operation VALUES($1,$2,$3,$4,'Publish',$5,0,1,$6,'STORE.CONFIGURATION',$7,$8,'ConfigurationMetadata')`,
      [id(22), id(2), id(3), id(1), digest, id(11), id(23), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE rms_store.store_configuration_version SET reason_code='CHANGED' WHERE configuration_id=$1`,
        [id(1)],
      ),
      /append-only/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_store.store_service_exception VALUES($1,$2,$3,$4,'2026-12-25','Override',$5,'ConfigurationMetadata')`,
        [id(24), id(2), id(3), id(1), digest],
      ),
      /store_service_exception_date_unique/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_store,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA rms_store TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_configuration_version`)).rowCount,
      0,
    );
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(2), id(3)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_configuration_version`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_weekly_service_period`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(30)]);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_store.store_configuration_operation`)).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}

it("enforces append-only Store configuration, unique exceptions and forced Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "store_configuration", root }, prove);
}, 120_000);
