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

/** WP-2423 (2026-10-18 v15 settlement defect): a renewal appends a newer gate version; every
 * as-of read before that version's changed_at must still resolve the version then in force. */
async function proveVersionInForce(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2423_gate_${context.runId}`,
    v1At = "2026-09-20T02:00:00.000Z",
    v1Until = "2026-10-20T02:00:00.000Z",
    v2At = "2026-10-18T04:16:28.680Z",
    v2Until = "2026-11-14T02:00:00.000Z";
  await admin.connect();
  try {
    const gate = (version, changedAt) =>
      admin.query(
        "INSERT INTO bop_publishing.live_gate_version VALUES ($1,'SYNTHETIC-RENEWED-GATE',$2,$3,$4,$5,'Production','Approved',$6,$7,$8,$9,$10,$10,'ConfigurationMetadata')",
        [
          id(101),
          id(102),
          id(103),
          id(104),
          version,
          id(105),
          id(106),
          id(107),
          id(109),
          changedAt,
        ],
      );
    const requirement = (n, version, validUntil) =>
      admin.query(
        "INSERT INTO bop_publishing.live_gate_requirement VALUES ($1,$2,$3,$4,$5,'SYNTHETIC','SYNTHETIC_STORE_READY',$6,true,'Accepted',$7,$5,$8,NULL,'ConfigurationMetadata')",
        [id(n), id(103), id(104), id(101), version, id(105), id(110), validUntil],
      );
    await gate(1, v1At);
    await requirement(111, 1, v1Until);
    await gate(2, v2At);
    await requirement(112, 2, v2Until);
    await admin.query(
      `CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT`,
    );
    await admin.query(`GRANT USAGE ON SCHEMA bop_publishing,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    // The pilot read roles: SELECT, plus UPDATE only for the SHARE lock (history triggers refuse updates).
    await admin.query(
      `GRANT SELECT,UPDATE ON bop_publishing.live_gate_version,bop_publishing.live_gate_requirement TO ${role}`,
    );
    const read = createPostgresCurrentLiveGateSource({
      tenantReference: id(102),
      brandReference: id(103),
      storeReference: id(104),
      decisionEvidenceReference: id(109),
      requiredRequirementCodes: ["SYNTHETIC_STORE_READY"],
      authorize: async () => true,
    });
    async function readAt(when) {
      await admin.query("BEGIN");
      try {
        await admin.query("SET LOCAL ROLE " + role);
        return await read({ query: (sql, values) => admin.query(sql, [...values]) }, when);
      } finally {
        await admin.query("ROLLBACK");
      }
    }
    // Earlier business days (settlement backlog, refunds of earlier payments) keep version 1.
    assert.equal((await readAt("2026-09-20T12:00:00.000Z")).version, 1);
    assert.equal((await readAt("2026-10-17T12:00:00.000Z")).version, 1);
    assert.equal((await readAt("2026-10-18T04:16:28.679Z")).version, 1);
    // From the renewal on, version 2 governs, including after version 1's evidence expired.
    assert.equal((await readAt(v2At)).version, 2);
    assert.equal((await readAt("2026-10-25T12:00:00.000Z")).version, 2);
    // Before any version existed there is no gate in force.
    await assert.rejects(readAt("2026-09-20T01:59:59.999Z"), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    // Past version 2's evidence the gate is blocked again (fail-closed, no fallback to history).
    await assert.rejects(readAt(v2Until), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    // A version numbered after another but recorded before it has no defined version in force.
    await gate(3, "2026-10-01T00:00:00.000Z");
    await requirement(113, 3, v2Until);
    await assert.rejects(readAt("2026-10-25T12:00:00.000Z"), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    await assert.rejects(readAt("2026-10-05T12:00:00.000Z"), /LIVE_GATE_CURRENT_UNAVAILABLE/u);
    // Row security: another Store sees no gate.
    await assert.rejects(
      (async () => {
        await admin.query("BEGIN");
        try {
          await admin.query("SET LOCAL ROLE " + role);
          return await createPostgresCurrentLiveGateSource({
            tenantReference: id(102),
            brandReference: id(103),
            storeReference: id(140),
            decisionEvidenceReference: id(109),
            requiredRequirementCodes: ["SYNTHETIC_STORE_READY"],
            authorize: async () => true,
          })({ query: (sql, values) => admin.query(sql, [...values]) }, "2026-10-17T12:00:00.000Z");
        } finally {
          await admin.query("ROLLBACK");
        }
      })(),
      /LIVE_GATE_CURRENT_UNAVAILABLE/u,
    );
  } finally {
    await admin.query("ROLLBACK").catch(() => undefined);
    await admin.query(`DROP OWNED BY ${role}`).catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("reads the Live Gate version in force at the as-of instant, not only the newest", async () => {
  await withIsolatedDatabase({ caseId: "wp2423_gate_in_force", root }, proveVersionInForce);
}, 120_000);
