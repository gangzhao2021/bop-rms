import { createPostgresCurrentLiveGateSource } from "../../bop/publishing/src/index.ts";
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
    await admin.query(
      "GRANT UPDATE ON bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO " +
        role,
    );
    await admin.query(
      "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'STORE-LIVE-GATE-CA-ON-TOR-001',$2,$3,$4,2,'Production','Approved',$5,$6,$7,$8,$9,$9,'ConfigurationMetadata')",
      [id(1), id(2), id(3), id(4), id(5), id(6), id(8), id(9), at],
    );
    let authorized = true;
    const options = {
      tenantReference: id(2),
      brandReference: id(3),
      storeReference: id(4),
      decisionEvidenceReference: id(9),
      requiredRequirementCodes: ["IDR_0037_PREMISES"],
      authorize: async () => authorized,
    };
    const read = createPostgresCurrentLiveGateSource(options);
    async function readAt(when, source = read) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        return await source({ query: (sql, values) => admin.query(sql, [...values]) }, when);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    await assert.rejects(readAt(at), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    await admin.query(
      "INSERT INTO bop_publishing.live_gate_requirement VALUES ($1,$2,$3,$4,2,'LEGAL_STORE','IDR_0037_PREMISES',$5,true,'Accepted',$6,1,$7,NULL,'ConfigurationMetadata')",
      [id(20), id(3), id(4), id(1), id(5), id(21), "2026-08-15T15:00:00.000Z"],
    );
    assert.equal((await readAt(at)).version, 2);
    await assert.rejects(readAt("2026-08-15T15:00:00.000Z"), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    await assert.rejects(
      readAt(
        at,
        createPostgresCurrentLiveGateSource({
          ...options,
          requiredRequirementCodes: ["IDR_0037_PREMISES", "MISSING_REQUIREMENT"],
        }),
      ),
      /LIVE_GATE_CURRENT_UNAVAILABLE/u,
    );
    await assert.rejects(
      readAt(
        at,
        createPostgresCurrentLiveGateSource({
          ...options,
          storeReference: id(40),
        }),
      ),
      /LIVE_GATE_CURRENT_UNAVAILABLE/u,
    );
    authorized = false;
    await assert.rejects(readAt(at), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    authorized = true;
    await admin.query(
      "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'STORE-LIVE-GATE-CA-ON-TOR-001',$2,$3,$4,3,'Production','Reopened',$5,$6,NULL,NULL,NULL,$7,'ConfigurationMetadata')",
      [id(1), id(2), id(3), id(4), id(5), id(6), "2026-08-15T14:30:00.000Z"],
    );
    await assert.rejects(readAt("2026-08-15T14:30:00.000Z"), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces append-only Live Gate history and forced Store RLS", async () => {
  await withIsolatedDatabase({ caseId: "wp2194_live_gate", root }, prove);
}, 120_000);
