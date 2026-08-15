import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9f32-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T14:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2194_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_publishing.live_gate_version(gate_reference,gate_id,tenant_id,brand_id,store_id,gate_version,environment,state,owner_reference,submitted_by_reference,approved_by_reference,decision_evidence_reference,last_reviewed_at,changed_at,data_classification) VALUES($1,'STORE-LIVE-GATE-CA-ON-TOR-001',$2,$3,$4,1,'Production','Blocked',$5,NULL,NULL,NULL,NULL,$6,'ConfigurationMetadata')`,
      [id(1), id(2), id(3), id(4), id(5), at],
    );
    await admin.query(
      `INSERT INTO bop_publishing.live_gate_requirement VALUES($1,$2,$3,$4,1,'LEGAL_STORE','IDR_0037_PREMISES',$5,true,'Missing',NULL,NULL,NULL,'EXTERNAL_EVIDENCE_MISSING','ConfigurationMetadata')`,
      [id(10), id(3), id(4), id(1), id(5)],
    );
    await admin.query(
      `INSERT INTO bop_publishing.live_gate_operation VALUES($1,$2,$3,$4,'AttachEvidence',1,2,$5,$6,'LIVE_GATE_WORKFLOW',$7,$8,'ConfigurationMetadata')`,
      [id(11), id(3), id(4), id(1), `sha256:${"a".repeat(64)}`, id(6), id(7), at],
    );
    await assert.rejects(
      admin.query(
        `UPDATE bop_publishing.live_gate_version SET state='Approved' WHERE gate_reference=$1`,
        [id(1)],
      ),
      /append-only/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_publishing,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(`GRANT SELECT ON ALL TABLES IN SCHEMA bop_publishing TO ${role}`);
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM bop_publishing.live_gate_version`)).rowCount, 0);
    await admin.query(
      `SELECT set_config('bop.brand_id',$1,false),set_config('bop.store_id',$2,false)`,
      [id(3), id(4)],
    );
    assert.equal(
      (await admin.query(`SELECT * FROM bop_publishing.live_gate_requirement`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.store_id',$1,false)`, [id(40)]);
    assert.equal(
      (await admin.query(`SELECT * FROM bop_publishing.live_gate_operation`)).rowCount,
      0,
    );
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces append-only Live Gate history and forced Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2194_live_gate", root }, prove);
}, 120_000);
