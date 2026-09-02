import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f31-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2193_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_feature_control.control_version(control_id,brand_id,store_id,control_key,control_version,description,owner_reference,purpose_code,source,default_value,configured_value,lifecycle,temporary,effective_from,effective_until,review_at,expires_at,authored_by_reference,approved_by_reference,approval_evidence_reference,publication_reference,created_at,data_classification) VALUES($1,$2,$3,'ordering.delivery.capability',1,'Synthetic delivery capability',$4,'DELIVERY_CAPABILITY','StoreOverride','Disabled','Enabled','Published',true,$5,$6,$7,$6,$8,$9,$10,$11,$5,'ConfigurationMetadata')`,
      [
        id(1),
        id(2),
        id(3),
        id(4),
        at,
        "2026-09-15T14:00:00.000Z",
        "2026-08-20T14:00:00.000Z",
        id(8),
        id(9),
        id(10),
        id(11),
      ],
    );
    await admin.query(
      `INSERT INTO bop_feature_control.control_dependency VALUES($1,$2,$3,$4,1,'RequiresFutureTrigger','delivery.provider.readiness',1,'Satisfied',$5,1,'ConfigurationMetadata')`,
      [id(20), id(2), id(3), id(1), id(21)],
    );
    await admin.query(
      `INSERT INTO bop_feature_control.control_operation VALUES($1,$2,$3,$4,'Publish',0,1,$5,$6,'FEATURE_CONTROL_ADMIN',$7,$8,'ConfigurationMetadata')`,
      [id(22), id(2), id(3), id(1), `sha256:${"a".repeat(64)}`, id(8), id(23), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_feature_control.control_version SET description='Changed' WHERE control_id=$1`,
        [id(1)],
      ),
      /append-only/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_feature_control,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA bop_feature_control TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_feature_control.control_version`)).rowCount,
      0,
    );
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(2), id(3)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_feature_control.control_version`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(30)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_feature_control.control_dependency`)).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces append-only Feature Control administration and forced Brand/Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2193_feature", root }, prove);
}, 120_000);
