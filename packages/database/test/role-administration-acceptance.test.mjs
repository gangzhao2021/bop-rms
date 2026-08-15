import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f35-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T15:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig),
    roleName = `wp2195_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_permission.permission_definition VALUES($1,'identity.role.view','Active',1,$2,$2)`,
      [id(1), at],
    );
    await admin.query(
      `INSERT INTO bop_permission.role VALUES($1,$2,NULL,'access_admin','Active',$3,NULL,1,$3,$3)`,
      [id(2), id(3), at],
    );
    await admin.query(
      `INSERT INTO bop_permission.role_administration_version VALUES($1,$2,1,$3,NULL,'access_admin','Access administrator','Synthetic role administration record','Custom','Approved',7,$4,$5,$6,$7,'ROLE_ADMIN_CHANGE',$8,'ConfigurationMetadata')`,
      [id(8), id(2), id(3), id(4), id(5), id(6), id(7), at],
    );
    await admin.query(
      `INSERT INTO bop_permission.role_administration_permission VALUES($1,$2,NULL,$3,1,$4,'identity.role.view','role_admin',false,'[]','ConfigurationMetadata')`,
      [id(9), id(3), id(8), id(1)],
    );
    await admin.query(
      `INSERT INTO bop_permission.role_administration_decision VALUES($1,$2,NULL,$3,1,'Approved',$4,'ROLE_ADMIN_CHANGE',$5,$6,'ConfigurationMetadata')`,
      [id(10), id(3), id(8), id(6), id(7), at],
    );
    await admin.query(
      `INSERT INTO bop_permission.role_administration_operation VALUES($1,$2,NULL,$3,'Approve',1,1,$4,$5,$6,$7,'ConfigurationMetadata')`,
      [id(11), id(3), id(8), `sha256:${"a".repeat(64)}`, id(6), id(12), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_permission.role_administration_version SET display_name='Changed' WHERE administration_reference=$1`,
        [id(8)],
      ),
      /append-only/u,
    );
    await admin.query(
      `CREATE ROLE ${roleName} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA bop_permission,platform_helpers TO ${roleName}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${roleName}`,
    );
    await admin.query(
      `GRANT SELECT ON bop_permission.role_administration_version,bop_permission.role_administration_permission,bop_permission.role_administration_decision,bop_permission.role_administration_operation TO ${roleName}`,
    );
    await admin.query(`SET ROLE ${roleName}`);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_permission.role_administration_version`)).rowCount,
      0,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_permission.role_administration_version`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_permission.role_administration_permission`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(30)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_permission.role_administration_decision`)).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces append-only role administration history and forced Brand RLS", async () => {
  await withIsolatedDatabase({ caseId: "role_admin", root }, prove);
}, 120_000);
