import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9816-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T16:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2197_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_tenant.brand VALUES($1,'TENANT_A','Tenant A','en-CA','CAD','Draft',1,$2,$2)`,
      [id(1), at],
    );
    await admin.query(
      `INSERT INTO bop_tenant.tenant_administration_version VALUES($1,$2,1,'Draft','CA-ON','Production',$3,$4,$5,$6,NULL,NULL,NULL,NULL,NULL,'PLATFORM_ADMIN',$7,$7,'ConfigurationMetadata')`,
      [id(10), id(1), id(2), id(3), id(4), id(5), at],
    );
    await admin.query(
      `INSERT INTO bop_tenant.tenant_capability_metadata_reference VALUES($1,$2,$3,'ConfigurationMetadata')`,
      [id(1), id(10), id(6)],
    );
    await admin.query(
      `INSERT INTO bop_tenant.tenant_administration_operation VALUES($1,$2,$3,'CreateDraft',$4,$5,'AUTHORIZED_SUPPORT',$6,$7,$8,'ConfigurationMetadata')`,
      [id(20), id(1), id(10), `sha256:${"a".repeat(64)}`, id(5), id(30), id(31), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_tenant.tenant_administration_version SET region_code='CA-QC' WHERE tenant_id=$1`,
        [id(1)],
      ),
      /append-only/u,
    );
    assert.equal(
      (
        await admin.query(
          `DELETE FROM bop_tenant.tenant_capability_metadata_reference WHERE tenant_id=$1`,
          [id(1)],
        )
      ).rowCount,
      0,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.tenant_capability_metadata_reference`)).rowCount,
      1,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_tenant TO ${role}`);
    await admin.query(
      `GRANT SELECT ON bop_tenant.tenant_administration_version,bop_tenant.tenant_capability_metadata_reference,bop_tenant.tenant_administration_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.tenant_administration_version`)).rowCount,
      0,
    );
    await admin.query(
      `SELECT set_config('bop.platform_actor_id',$1,false),set_config('bop.platform_purpose','AUTHORIZED_SUPPORT',false),set_config('bop.platform_support_case_id',$2,false)`,
      [id(5), id(30)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.tenant_administration_version`)).rowCount,
      1,
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_tenant.tenant_administration_operation`)).rowCount,
      1,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces Platform context, append-only Tenant administration and normalized capability metadata", async () => {
  await withIsolatedDatabase({ caseId: "platform_tenant", root }, prove);
}, 120_000);
