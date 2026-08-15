import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9816-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T16:00:00.000Z",
  expires = "2026-08-16T16:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2196_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO rms_reporting.export_job VALUES($1,$2,$3,NULL,'ORDER_QUEUE',$4,'ORDER_OPERATIONAL_V1','CHECKPOINT_42',$5,$6,'["ORDER_REFERENCE","STATUS"]','Csv','Internal','OPERATIONS_REVIEW',$7,$8)`,
      [
        id(1),
        id(2),
        id(3),
        id(4),
        `sha256:${"a".repeat(64)}`,
        `sha256:${"b".repeat(64)}`,
        id(5),
        at,
      ],
    );
    await admin.query(
      `INSERT INTO rms_reporting.export_job_state_record VALUES($1,$2,$3,$4,NULL,1,'Completed',$5,$6,42,1024,NULL)`,
      [id(7), id(1), id(2), id(3), at, id(5)],
    );
    await admin.query(
      `INSERT INTO rms_reporting.export_artifact VALUES($1,$2,$3,$4,NULL,$5,$6,'Csv','Internal',true,42,1024,$7,$8)`,
      [id(8), id(1), id(2), id(3), id(9), `sha256:${"c".repeat(64)}`, at, expires],
    );
    await admin.query(
      `INSERT INTO rms_reporting.export_access_grant VALUES($1,$2,$3,$4,NULL,$5,$6,$7)`,
      [id(10), id(8), id(2), id(3), id(5), at, "2026-08-15T16:05:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_reporting.export_grant_consumption VALUES($1,$2,$3,$4,$5,NULL,$6,$7)`,
      [id(11), id(10), id(8), id(2), id(3), id(5), "2026-08-15T16:01:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_reporting.export_revocation VALUES($1,$2,$3,$4,$5,NULL,'ACCESS_REVOKED',$6,$7)`,
      [id(12), id(1), id(8), id(2), id(3), id(5), "2026-08-15T16:02:00.000Z"],
    );
    await admin.query(
      `INSERT INTO rms_reporting.export_operation_record VALUES($1,$2,$3,$4,NULL,'ConsumeGrant',$5,$6,$7,$8,$9)`,
      [
        id(13),
        id(1),
        id(2),
        id(3),
        `sha256:${"d".repeat(64)}`,
        id(11),
        id(5),
        id(14),
        "2026-08-15T16:01:00.000Z",
      ],
    );
    await assert.rejects(
      admin.query(`UPDATE rms_reporting.export_job SET format='CanonicalJson' WHERE job_id=$1`, [
        id(1),
      ]),
      /append-only/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO rms_reporting.export_grant_consumption VALUES($1,$2,$3,$4,$5,NULL,$6,$7)`,
        [id(15), id(10), id(8), id(2), id(3), id(5), "2026-08-15T16:02:00.000Z"],
      ),
      /unique/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA rms_reporting,platform_helpers TO ${role}`);
    await admin.query(
      `GRANT EXECUTE ON FUNCTION platform_helpers.current_brand_id(),platform_helpers.current_store_id() TO ${role}`,
    );
    await admin.query(
      `GRANT SELECT ON rms_reporting.export_job,rms_reporting.export_job_state_record,rms_reporting.export_artifact,rms_reporting.export_access_grant,rms_reporting.export_grant_consumption,rms_reporting.export_revocation,rms_reporting.export_operation_record TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.export_job`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(3)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.export_artifact`)).rowCount, 1);
    assert.equal(
      (await admin.query(`SELECT * FROM rms_reporting.export_grant_consumption`)).rowCount,
      1,
    );
    await admin.query(`SELECT set_config('bop.brand_id',$1,false)`, [id(30)]);
    assert.equal((await admin.query(`SELECT * FROM rms_reporting.export_revocation`)).rowCount, 0);
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces bounded one-time Export grants, append-only history and forced RLS", async () => {
  await withIsolatedDatabase({ caseId: "export_job", root }, prove);
}, 120_000);
