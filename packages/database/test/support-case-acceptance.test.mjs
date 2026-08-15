import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { it } from "vitest";
import { withIsolatedDatabase } from "../test-support/isolated-database.mjs";
const { Client } = pg,
  root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../.."),
  id = (n) => `018f9916-0000-7000-8000-${n.toString(16).padStart(12, "0")}`,
  at = "2026-08-15T16:00:00.000Z";
async function prove(context) {
  const admin = new Client(context.clientConfig),
    role = `wp2198_${context.runId}`;
  await admin.connect();
  try {
    await admin.query(
      `INSERT INTO bop_task.support_case_version
       (case_id,version_id,version,status,tenant_id,store_id,case_type,purpose_code,requester_actor_reference,requester_verification_evidence_reference,assigned_role_reference,due_at,supersedes_version_id,reason_code,created_at,updated_at,data_classification)
       VALUES($1,$2,1,'Open',$3,$4,'DIAGNOSTIC','AUTHORIZED_SUPPORT',$5,$6,NULL,$7,NULL,'SUPPORT_REQUEST',$8,$8,'ConfidentialMetadata')`,
      [id(1), id(10), id(2), id(3), id(4), id(5), "2026-08-16T16:00:00.000Z", at],
    );
    await admin.query(
      `INSERT INTO bop_task.support_case_version
       (case_id,version_id,version,status,tenant_id,store_id,case_type,purpose_code,requester_actor_reference,requester_verification_evidence_reference,assigned_role_reference,due_at,supersedes_version_id,reason_code,created_at,updated_at,data_classification)
       VALUES($1,$2,2,'AccessGranted',$3,$4,'DIAGNOSTIC','AUTHORIZED_SUPPORT',$5,$6,$7,$8,$9,'ACCESS_APPROVED',$10,$10,'ConfidentialMetadata')`,
      [id(1), id(11), id(2), id(3), id(4), id(5), id(6), "2026-08-16T16:00:00.000Z", id(10), at],
    );
    await admin.query(
      `INSERT INTO bop_task.diagnostic_access_grant
       (case_id,grant_id,tenant_id,store_id,support_actor_reference,requested_by_reference,approved_by_reference,approval_evidence_reference,recent_mfa_evidence_reference,purpose_code,delegated_permissions,masking_policy_reference,granted_at,expires_at,data_classification)
       VALUES($1,$2,$3,$4,$5,$5,$6,$7,$8,'AUTHORIZED_SUPPORT',ARRAY['tenant.diagnostics'],$9,$10,$11,'RestrictedAccessMetadata')`,
      [
        id(1),
        id(20),
        id(2),
        id(3),
        id(4),
        id(7),
        id(8),
        id(9),
        id(21),
        at,
        "2026-08-15T16:15:00.000Z",
      ],
    );
    await admin.query(
      `INSERT INTO bop_task.support_action_record VALUES($1,$2,$3,$4,'tenant.diagnostics','TENANT_HEALTH',$5,'INVESTIGATE_INCIDENT',$6,$7,'RestrictedAccessMetadata')`,
      [id(1), id(30), id(20), id(4), id(31), id(32), at],
    );
    await admin.query(
      `INSERT INTO bop_task.support_case_operation VALUES($1,$2,$3,'GrantAccess',1,$4,$5,'AUTHORIZED_SUPPORT',$6,$7,'RestrictedAccessMetadata')`,
      [id(1), id(40), id(11), `sha256:${"a".repeat(64)}`, id(7), id(41), at],
    );
    await assert.rejects(
      admin.query(`UPDATE bop_task.diagnostic_access_grant SET expires_at=$1 WHERE grant_id=$2`, [
        "2026-08-15T16:14:00.000Z",
        id(20),
      ]),
      /append-only/u,
    );
    await assert.rejects(
      admin.query(
        `INSERT INTO bop_task.diagnostic_access_grant
         (case_id,grant_id,tenant_id,support_actor_reference,requested_by_reference,approved_by_reference,approval_evidence_reference,recent_mfa_evidence_reference,purpose_code,delegated_permissions,masking_policy_reference,granted_at,expires_at,data_classification)
         VALUES($1,$2,$3,$4,$4,$5,$6,$7,'AUTHORIZED_SUPPORT',ARRAY['tenant.diagnostics'],$8,$9,$10,'RestrictedAccessMetadata')`,
        [id(1), id(22), id(2), id(4), id(7), id(8), id(9), id(21), at, "2026-08-15T16:15:00.001Z"],
      ),
      /diagnostic_access_expiry/u,
    );
    await admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT`);
    await admin.query(`GRANT USAGE ON SCHEMA bop_task TO ${role}`);
    await admin.query(
      `GRANT SELECT ON bop_task.support_case_version,bop_task.diagnostic_access_grant,bop_task.diagnostic_access_revocation,bop_task.support_action_record,bop_task.support_case_operation TO ${role}`,
    );
    await admin.query(`SET ROLE ${role}`);
    assert.equal((await admin.query(`SELECT * FROM bop_task.support_case_version`)).rowCount, 0);
    await admin.query(
      `SELECT set_config('bop.platform_actor_id',$1,false),set_config('bop.platform_purpose','AUTHORIZED_SUPPORT',false),set_config('bop.platform_support_case_id',$2,false)`,
      [id(4), id(99)],
    );
    assert.equal((await admin.query(`SELECT * FROM bop_task.support_case_version`)).rowCount, 0);
    await admin.query(`SELECT set_config('bop.platform_support_case_id',$1,false)`, [id(1)]);
    assert.equal((await admin.query(`SELECT * FROM bop_task.support_case_version`)).rowCount, 2);
    assert.equal((await admin.query(`SELECT * FROM bop_task.support_action_record`)).rowCount, 1);
    await admin.query("RESET ROLE");
  } finally {
    await admin.query("RESET ROLE").catch(() => undefined);
    await admin.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
    await admin.end();
  }
}
it("enforces exact Case-bound Platform context, append-only history and fifteen-minute grants", async () => {
  await withIsolatedDatabase({ caseId: "support_case", root }, prove);
}, 120_000);
